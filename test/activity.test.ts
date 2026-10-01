import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createActivityServer } from '../src/activity/server';
import { KeyedLock, RateLimiter } from '../src/services/antispam';
import { getQty } from '../src/services/inventory';
import { getProfile } from '../src/services/player';
import { G, U, U2, makeWorld, type TestWorld } from './helpers';

const OUTSIDER_GUILD = '999999999999999999';

describe('actividad de granja (API)', () => {
  let w: TestWorld;
  let server: http.Server;
  let base: string;
  let lock: KeyedLock;
  const levelUps: string[] = [];
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valle-act-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>El Valle</title>');

  before(async () => {
    w = makeWorld();
    lock = new KeyedLock();
    server = createActivityServer({
      ctx: w.ctx,
      limiter: new RateLimiter(() => w.clock.t),
      userLock: lock,
      clientId: '123456789012345678',
      staticDir,
      exchangeCode: async (code) => {
        if (code === 'malo') throw new Error('code inválido');
        return `tok-${code}`;
      },
      fetchUser: async (token) => ({ id: token === 'tok-u2' ? U2 : U, username: 'granjera' }),
      isMember: async (guildId) => guildId === G,
      onAction: async (_g, u) => {
        levelUps.push(u);
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(() => server.close());

  async function login(code = 'u1'): Promise<string> {
    const r = await fetch(`${base}/.proxy/api/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(r.status, 200);
    const data = (await r.json()) as { session: string; access_token: string };
    assert.equal(data.access_token, `tok-${code}`);
    return data.session;
  }

  const post = (route: string, session: string | null, body: unknown) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session}` } : {}) },
      body: JSON.stringify(body),
    });

  it('sirve la página y la configuración pública', async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /El Valle/);
    const cfg = (await (await fetch(`${base}/api/config`)).json()) as { clientId: string };
    assert.equal(cfg.clientId, '123456789012345678');
  });

  it('bloquea el acceso a archivos fuera de la carpeta pública', async () => {
    const r = await fetch(`${base}/..%2F..%2Fpackage.json`);
    assert.notEqual(r.status, 200);
  });

  it('una URL mal codificada responde 400 y no tira el proceso (antes era un crash remoto)', async () => {
    for (const bad of ['/%E0%A4%A', '/%', '/.proxy/%ZZ', '/%00']) {
      const r = await fetch(`${base}${bad}`);
      assert.equal(r.status, 400, bad);
    }
    const ok = await fetch(`${base}/`);
    assert.equal(ok.status, 200, 'el servidor sigue respondiendo');
  });

  it('limita los intentos de inicio de sesión por IP', async () => {
    let limited = 0;
    for (let n = 0; n < 12; n++) {
      const r = await fetch(`${base}/api/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'malo' }) });
      if (r.status === 429) limited++;
    }
    assert.ok(limited >= 1, 'después de 10 intentos por minuto responde 429');
    w.clock.advance(61_000);
  });

  it('rechaza un código OAuth inválido y las acciones sin sesión', async () => {
    const bad = await post('/api/token', null, { code: 'malo' });
    assert.equal(bad.status, 401);
    const noSession = await post('/api/farm/harvest', null, { guild: G });
    assert.equal(noSession.status, 401);
    const fake = await post('/api/farm/harvest', 'inventado', { guild: G });
    assert.equal(fake.status, 401);
  });

  it('no permite jugar en un servidor del que no sos miembro', async () => {
    const s = await login();
    const r = await fetch(`${base}/api/farm?guild=${OUTSIDER_GUILD}`, { headers: { Authorization: `Bearer ${s}` } });
    assert.equal(r.status, 403);
    const bad = await fetch(`${base}/api/farm?guild=abc`, { headers: { Authorization: `Bearer ${s}` } });
    assert.equal(bad.status, 400);
  });

  it('devuelve el estado de la granja con el kit inicial', async () => {
    const s = await login();
    const r = await fetch(`${base}/api/farm?guild=${G}`, { headers: { Authorization: `Bearer ${s}` } });
    assert.equal(r.status, 200);
    const { state } = (await r.json()) as { state: { player: { level: number }; zones: { unlocked: boolean }[]; vigor: { max: number } } };
    assert.equal(state.player.level, 1);
    assert.equal(state.zones[0].unlocked, true);
    assert.equal(state.zones[1].unlocked, false);
    assert.equal(state.vigor.max, 100);
  });

  it('cosechar usa las mismas reglas que el bot y un doble clic no cosecha dos veces', async () => {
    const s = await login();
    const [a, b] = await Promise.all([post('/api/farm/harvest', s, { guild: G }), post('/api/farm/harvest', s, { guild: G })]);
    const statuses = [a.status, b.status].sort();
    assert.equal(statuses[0], 200);
    assert.ok([400, 409].includes(statuses[1])); // candado ocupado o espera entre cosechas
    const p = getProfile(w.ctx, G, U)!;
    assert.equal(p.farms_total, 1);
    const ok = (a.status === 200 ? await a.json() : await b.json()) as { event: { xp: number; drops: unknown[] } };
    assert.ok(ok.event.xp > 0);
    assert.ok(ok.event.drops.length > 0);
  });

  it('comparte el candado con el bot: si hay una acción del bot en curso, la Actividad espera', async () => {
    const s = await login();
    w.clock.advance(60_000);
    let release!: () => void;
    const busy = lock.run(`${G}:${U}`, () => new Promise<void>((r) => { release = r; }));
    const r = await post('/api/farm/harvest', s, { guild: G });
    assert.equal(r.status, 409);
    release();
    await busy;
  });

  it('valida zona bloqueada y consumibles igual que el bot', async () => {
    const s = await login();
    const zone = await post('/api/farm/zone', s, { guild: G, zone: 'invernadero' });
    assert.equal(zone.status, 400);
    const bogus = await post('/api/farm/use', s, { guild: G, item: 'no_existe' });
    assert.equal(bogus.status, 400);
    const before = getQty(w.ctx, G, U, 'mate');
    const tooBig = await post('/api/farm/use', s, { guild: G, item: 'x'.repeat(500) });
    assert.equal(tooBig.status, 400);
    assert.equal(getQty(w.ctx, G, U, 'mate'), before);
  });

  it('rechaza cuerpos que no son JSON o son demasiado grandes', async () => {
    const s = await login();
    const notJson = await fetch(`${base}/api/farm/harvest`, { method: 'POST', headers: { Authorization: `Bearer ${s}`, 'Content-Type': 'text/plain' }, body: 'hola' });
    assert.equal(notJson.status, 415);
    const huge = await post('/api/farm/harvest', s, { guild: G, pad: 'x'.repeat(10_000) });
    assert.equal(huge.status, 413);
  });

  it('cada sesión juega solo su propia granja', async () => {
    const s2 = await login('u2');
    w.clock.advance(60_000);
    const r = await post('/api/farm/harvest', s2, { guild: G });
    assert.equal(r.status, 200);
    assert.equal(getProfile(w.ctx, G, U2)!.farms_total, 1);
    assert.equal(getProfile(w.ctx, G, U)!.farms_total, 1);
  });

  it('avisa después de cada acción (distinciones por nivel/actividad y DMs de logros)', async () => {
    const s = await login();
    for (let n = 0; n < 12 && !levelUps.includes(U); n++) {
      w.clock.advance(120_000);
      w.ctx.db.run('UPDATE profiles SET vigor = 100, fatigue = 0 WHERE guild_id = ? AND user_id = ?', G, U);
      const r = await post('/api/farm/harvest', s, { guild: G });
      assert.equal(r.status, 200);
    }
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(levelUps.includes(U));
  });
});

describe('actividad: pesca y ranking (API)', () => {
  let w: TestWorld;
  let server: http.Server;
  let base: string;
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valle-act2-'));

  before(async () => {
    w = makeWorld();
    server = createActivityServer({
      ctx: w.ctx,
      limiter: new RateLimiter(() => w.clock.t),
      userLock: new KeyedLock(),
      clientId: '123456789012345678',
      staticDir,
      exchangeCode: async (code) => `tok-${code}`,
      fetchUser: async (token) => ({ id: token === 'tok-u2' ? U2 : U, username: token }),
      isMember: async (g) => g === G,
      memberNames: async (_g, ids) => Object.fromEntries(ids.map((id) => [id, id === U ? 'Ana' : 'Beto'])),
      roleInfo: async () => ({}),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => server.close());

  async function login(code = 'u1'): Promise<string> {
    const r = await fetch(`${base}/api/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    return ((await r.json()) as { session: string }).session;
  }
  const post = (route: string, s: string, body: unknown) =>
    fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s}` }, body: JSON.stringify(body) });

  it('pescar con un solo botón: gasta carnada, devuelve capturas y el estado nuevo', async () => {
    const s = await login();
    const st = (await (await fetch(`${base}/api/fish?guild=${G}`, { headers: { Authorization: `Bearer ${s}` } })).json()) as { state: { bait: { qty: number }; odds: { chance: number }[]; next: { lines: number } } };
    assert.equal(st.state.bait.qty, 25);
    assert.equal(st.state.odds.length, 6);
    assert.ok(Math.abs(st.state.odds.reduce((x, o) => x + o.chance, 0) - 1) < 1e-9);
    const r = await post('/api/fish/cast', s, { guild: G });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { cast: { lines: number; catches: { name: string }[]; baitUsed: number; achievements: { name: string; badge: string }[] }; state: { bait: { qty: number }; player: { catches: number } } };
    assert.equal(body.cast.catches.length, body.cast.lines);
    // Primer pique: logro con insignia y 10 de carnada de regalo.
    assert.deepEqual(body.cast.achievements.map((a) => a.badge), ['badges/primer_pique.png']);
    assert.equal(body.state.bait.qty, 25 - body.cast.baitUsed + 10);
    assert.equal(body.state.player.catches, 1);
  });

  it('clics simultáneos: sin espera, cada uno pesca (misma regla que el bot)', async () => {
    const s = await login();
    const [a, b] = await Promise.all([post('/api/fish/cast', s, { guild: G }), post('/api/fish/cast', s, { guild: G })]);
    assert.ok([a.status, b.status].includes(200));
  });

  it('las especies sin descubrir no revelan su nombre', async () => {
    const s = await login();
    const st = (await (await fetch(`${base}/api/fish?guild=${G}`, { headers: { Authorization: `Bearer ${s}` } })).json()) as { state: { species: { name: string; found: boolean }[] } };
    assert.ok(st.state.species.filter((x) => !x.found).every((x) => x.name === '???'));
  });

  it('valida la caña: no se puede equipar una que no es tuya ni un id inválido', async () => {
    const s = await login();
    assert.equal((await post('/api/fish/rod', s, { guild: G, rod: 'astro' })).status, 400);
    assert.equal((await post('/api/fish/rod', s, { guild: G, rod: 'x'.repeat(80) })).status, 400);
    assert.equal((await post('/api/fish/rod', s, { guild: G, rod: 'junco' })).status, 200);
    assert.equal((await post('/api/fish/act', s, { guild: G })).status, 404, 'los endpoints del minijuego viejo ya no existen');
  });

  it('el ranking muestra a los jugadores con nombre y tu posición', async () => {
    const s = await login();
    const r = await fetch(`${base}/api/top?guild=${G}&cat=total`, { headers: { Authorization: `Bearer ${s}` } });
    assert.equal(r.status, 200);
    const { top } = (await r.json()) as { top: { entries: { name: string; me: boolean }[]; me: { rank: number } | null } };
    assert.ok(top.entries.some((e) => e.me && e.name === 'Ana'));
    assert.equal(top.me?.rank, 1); // es la única que jugó en este mundo de prueba
    const bad = await fetch(`${base}/api/top?guild=${G}&cat=hackeo`, { headers: { Authorization: `Bearer ${s}` } });
    assert.equal(bad.status, 400);
  });
});

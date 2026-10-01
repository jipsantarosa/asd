import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../src/game/defaults';
import { GameError, createContext } from '../src/services/context';
import { kiss, kissCount, kissPair } from '../src/services/social';
import { mediaHistory, mediaUrl, recordMedia } from '../src/services/userMedia';
import { purgeUserMessages } from '../src/discord/moderation/purge';
import { G, U, U2, makeWorld, seeded } from './helpers';

const U3 = '200000000000000777';
const expectGameError = (fn: () => unknown, re?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));

describe('!kiss', () => {
  it('el primer beso muestra 1 y la cuenta es la misma sin importar quién besa', () => {
    const w = makeWorld();
    assert.equal(kiss(w.ctx, G, U, U2).pair, 1);
    w.clock.advance(6000);
    assert.equal(kiss(w.ctx, G, U2, U).pair, 2, 'el otro lado suma a la misma pareja');
    w.clock.advance(6000);
    const r = kiss(w.ctx, G, U, U2);
    assert.equal(r.pair, 3);
    assert.equal(r.given, 2, 'U dio 2 besos');
    assert.equal(r.received, 2, 'U2 recibió 2 (U2 dio 1)');
    assert.equal(kissCount(w.ctx, G, U2, U), 3);
  });

  it('parejas distintas y servidores distintos no se mezclan', () => {
    const w = makeWorld();
    kiss(w.ctx, G, U, U2);
    w.clock.advance(6000);
    assert.equal(kiss(w.ctx, G, U, U3).pair, 1);
    assert.equal(kiss(w.ctx, '100000000000000999', U2, U).pair, 1);
  });

  it('no se puede besar a uno mismo y el spam choca con la espera sin tocar el contador', () => {
    const w = makeWorld();
    expectGameError(() => kiss(w.ctx, G, U, U), /vos mismo/);
    kiss(w.ctx, G, U, U2);
    expectGameError(() => kiss(w.ctx, G, U, U2), /próximo beso/);
    expectGameError(() => kiss(w.ctx, G, U, U3), /próximo beso/);
    assert.equal(kissCount(w.ctx, G, U, U2), 1);
    assert.equal(kissCount(w.ctx, G, U, U3), 0, 'la transacción fallida no dejó nada a medias');
  });

  it('el contador sobrevive a un reinicio (mismo archivo de base, contexto nuevo)', () => {
    const w = makeWorld();
    kiss(w.ctx, G, U, U2);
    const restarted = createContext({ db: w.ctx.db, baseConfig: structuredClone(DEFAULT_CONFIG), now: () => w.clock.t + 60_000, rng: seeded(3) });
    assert.equal(kiss(restarted, G, U2, U).pair, 2);
  });

  it('muchos besos de ambos lados: el total es exacto (sin duplicados ni pérdidas)', () => {
    const w = makeWorld();
    let last = 0;
    for (let i = 0; i < 50; i++) {
      w.clock.advance(5001);
      last = kiss(w.ctx, G, i % 2 ? U : U2, i % 2 ? U2 : U).pair;
    }
    assert.equal(last, 50);
    assert.equal(kissCount(w.ctx, G, U, U2), 50);
  });

  it('la clave de pareja es canónica y respeta el CHECK de la tabla', () => {
    assert.deepEqual(kissPair('9', '10'), ['10', '9']);
    assert.deepEqual(kissPair('10', '9'), ['10', '9']);
    // IDs de largos distintos (17 y 19 dígitos): el orden de texto es el mismo que usa SQLite.
    const w = makeWorld();
    assert.equal(kiss(w.ctx, G, '99999999999999999', '1000000000000000000').pair, 1);
  });
});

describe('historial de avatares y banners', () => {
  const H1 = 'a'.repeat(32);
  const H2 = 'a_' + 'b'.repeat(32);

  it('guarda solo imágenes distintas, sin duplicar, y actualiza "visto por última vez"', () => {
    const w = makeWorld();
    assert.equal(recordMedia(w.ctx, U, 'avatar', H1, G), true);
    assert.equal(recordMedia(w.ctx, U, 'avatar', H1, G), false);
    w.clock.advance(60_000);
    assert.equal(recordMedia(w.ctx, U, 'avatar', H2, G), true);
    w.clock.advance(60_000);
    recordMedia(w.ctx, U, 'avatar', H1, G); // vuelve a la primera imagen
    const h = mediaHistory(w.ctx, U, 'avatar');
    assert.deepEqual(h.map((x) => x.hash), [H1, H2], 'la más reciente primero');
    assert.ok(h[0].lastSeenAt > h[0].firstSeenAt);
  });

  it('ignora avatares por defecto, hashes inválidos e IDs raros (nunca inventa historial)', () => {
    const w = makeWorld();
    assert.equal(recordMedia(w.ctx, U, 'avatar', null), false);
    assert.equal(recordMedia(w.ctx, U, 'avatar', undefined), false);
    assert.equal(recordMedia(w.ctx, U, 'avatar', '../../x'), false);
    assert.equal(recordMedia(w.ctx, 'no-es-id', 'avatar', H1), false);
    assert.equal(mediaHistory(w.ctx, U, 'avatar').length, 0);
  });

  it('avatares y banners van por separado, y los animados usan GIF', () => {
    const w = makeWorld();
    recordMedia(w.ctx, U, 'banner', H2);
    assert.equal(mediaHistory(w.ctx, U, 'avatar').length, 0);
    assert.equal(mediaHistory(w.ctx, U, 'banner')[0].url, `https://cdn.discordapp.com/banners/${U}/${H2}.gif?size=1024`);
    assert.equal(mediaUrl('avatar', U, H1), `https://cdn.discordapp.com/avatars/${U}/${H1}.png?size=1024`);
  });
});

// ── Canal simulado con las reglas de la API: páginas de 100, bulkDelete ≤100 y solo < 14 días ──
class Coll<V> extends Map<string, V> {
  lastKey(): string | undefined {
    return [...this.keys()].pop();
  }
}

function fakeChannel(msgs: { id: string; author: string; ageMs: number; pinned?: boolean }[]) {
  const now = Date.now();
  const store = msgs.map((m) => ({ ...m, deleted: false }));
  const calls = { fetch: 0, bulk: [] as number[], single: 0 };
  const asMessage = (m: (typeof store)[number]) => ({
    id: m.id, author: { id: m.author }, createdTimestamp: now - m.ageMs, pinned: !!m.pinned,
    delete: async () => { m.deleted = true; calls.single += 1; },
  });
  const channel = {
    id: '300000000000000001',
    messages: {
      async fetch(o: { limit: number; before?: string }) {
        calls.fetch += 1;
        const live = store.filter((m) => !m.deleted); // del más nuevo al más viejo
        const start = o.before ? live.findIndex((m) => m.id === o.before) + 1 : 0;
        const page = new Coll<ReturnType<typeof asMessage>>();
        for (const m of live.slice(start, start + o.limit)) page.set(m.id, asMessage(m));
        return page;
      },
    },
    async bulkDelete(ids: string[], filterOld: boolean) {
      assert.ok(ids.length >= 2 && ids.length <= 100, `bulkDelete con ${ids.length}`);
      assert.equal(filterOld, true);
      calls.bulk.push(ids.length);
      const out = new Coll<boolean>();
      for (const id of ids) {
        const m = store.find((x) => x.id === id)!;
        if (m.ageMs < 14 * 86_400_000) { m.deleted = true; out.set(id, true); }
      }
      return out;
    },
  };
  return { channel, store, calls };
}

describe('!m (borrar mensajes de un usuario)', () => {
  const day = 86_400_000;
  // 600 mensajes: alterna autores; los más viejos están al final.
  const build = (n: number, ageStep: number) => Array.from({ length: n }, (_, i) => ({
    id: String(10_000 - i), author: i % 3 === 0 ? 'objetivo' : 'otro', ageMs: i * ageStep,
  }));

  it('borra solo del usuario indicado y respeta la cantidad pedida', async () => {
    const f = fakeChannel(build(600, 60_000));
    const r = await purgeUserMessages(f.channel as never, 'objetivo', 150);
    assert.equal(r.deleted, 150);
    assert.ok(f.store.filter((m) => m.deleted).every((m) => m.author === 'objetivo'));
    assert.ok(f.calls.bulk.every((n) => n <= 100));
  });

  it('se detiene en los mensajes de más de 14 días y los informa', async () => {
    const f = fakeChannel(build(300, day / 10)); // del mensaje 140 en adelante tienen > 14 días
    const r = await purgeUserMessages(f.channel as never, 'objetivo', 1000);
    assert.ok(r.stoppedByAge);
    assert.ok(r.tooOld >= 1);
    assert.ok(f.store.filter((m) => m.deleted).every((m) => m.ageMs < 14 * day));
  });

  it('nunca borra fijados ni el mensaje del comando; un solo mensaje se borra de a uno', async () => {
    const f = fakeChannel([
      { id: '5', author: 'objetivo', ageMs: 0 },
      { id: '4', author: 'objetivo', ageMs: 1000, pinned: true },
      { id: '3', author: 'otro', ageMs: 2000 },
      { id: '2', author: 'objetivo', ageMs: 3000 },
    ]);
    const r = await purgeUserMessages(f.channel as never, 'objetivo', 10, new Set(['5']));
    assert.equal(r.deleted, 1);
    assert.equal(f.calls.single, 1);
    assert.deepEqual(f.store.filter((m) => m.deleted).map((m) => m.id), ['2']);
  });

  it('la cantidad se limita a 1000 y el recorrido tiene tope', async () => {
    const f = fakeChannel(Array.from({ length: 2500 }, (_, i) => ({ id: String(100_000 - i), author: 'objetivo', ageMs: i * 1000 })));
    const r = await purgeUserMessages(f.channel as never, 'objetivo', 99_999);
    assert.equal(r.deleted, 1000);
    assert.ok(f.calls.bulk.length <= 11);
  });
});

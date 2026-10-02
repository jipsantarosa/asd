import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runMigrations } from '../src/db/migrations';
import { createContext, GameError } from '../src/services/context';
import { getSettings, setPrefix } from '../src/services/guildSettings';
import { planSetup, LOG_CHANNELS, type ExistingChannel, type LogConfig } from '../src/services/logConfig';
import { addRolesToGroup, createGroup, eligibleRewards, getGroup, listGroups, listRewards, removeReward, setReward } from '../src/services/roles';
import { RateLimiter } from '../src/services/antispam';
import { canPlayIn, forgetChannel, getCasinoGuild, setAnnounceChannel, setGameChannels } from '../src/casino/guilds';
import { G, makeWorld } from './helpers';

function expectGameError(fn: () => unknown, re?: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));
}

describe('base de datos y ajustes', () => {
  it('las migraciones son idempotentes', () => {
    const w = makeWorld();
    assert.deepEqual(runMigrations(w.ctx.db), []);
  });

  it('el prefijo persiste tras un "reinicio" (contexto nuevo sobre la misma BD)', () => {
    const w = makeWorld();
    assert.equal(getSettings(w.ctx, G).prefix, '!');
    setPrefix(w.ctx, G, '?v');
    const restarted = createContext({ db: w.ctx.db });
    assert.equal(getSettings(restarted, G).prefix, '?v');
    expectGameError(() => setPrefix(w.ctx, G, 'con espacio'));
    expectGameError(() => setPrefix(w.ctx, G, '@@'));
    expectGameError(() => setPrefix(w.ctx, G, 'demasiado'));
  });

  it('canales del casino por servidor: anuncios, canales de juego y canales borrados', () => {
    const w = makeWorld();
    const C1 = '300000000000000001';
    const C2 = '300000000000000002';
    assert.ok(canPlayIn(getCasinoGuild(w.ctx, G), C1, null), 'sin canales configurados se juega en cualquiera');
    setGameChannels(w.ctx, G, [C1, C1, 'basura']);
    setAnnounceChannel(w.ctx, G, C2);
    const g = getCasinoGuild(w.ctx, G);
    assert.deepEqual(g.gameChannels, [C1]);
    assert.ok(canPlayIn(g, C1, null));
    assert.ok(!canPlayIn(g, C2, null));
    assert.ok(canPlayIn(g, '300000000000000009', C1), 'un hilo hereda el permiso de su canal');
    forgetChannel(w.ctx, G, C2);
    assert.equal(getCasinoGuild(w.ctx, G).announceChannelId, null);
    assert.equal(getCasinoGuild(w.ctx, 'otro').gameChannels.length, 0, 'aislado por servidor');
  });
});

describe('roles', () => {
  it('los grupos están aislados por servidor (IDs manipulados no cruzan servidores)', () => {
    const w = makeWorld();
    const g = createGroup(w.ctx, G, 'Colores', 'Elegí tu color', 0);
    addRolesToGroup(w.ctx, G, g.id, ['300000000000000001', 'no-es-un-id']);
    assert.deepEqual(getGroup(w.ctx, G, g.id).roles, ['300000000000000001']);
    expectGameError(() => getGroup(w.ctx, 'otro', g.id), /no existe/);
    assert.equal(listGroups(w.ctx, 'otro').length, 0);
  });

  it('las distinciones van por nivel del casino y validan el rango', () => {
    const w = makeWorld();
    setReward(w.ctx, G, '300000000000000001', 10);
    setReward(w.ctx, G, '300000000000000002', 25);
    setReward(w.ctx, G, '300000000000000001', 5);
    expectGameError(() => setReward(w.ctx, G, '300000000000000003', 0));
    expectGameError(() => setReward(w.ctx, G, '300000000000000003', 501));
    const rewards = listRewards(w.ctx, G);
    assert.deepEqual(rewards.map((r) => r.level), [5, 25]);
    assert.deepEqual(eligibleRewards(rewards, 7).map((r) => r.role_id), ['300000000000000001']);
    removeReward(w.ctx, G, '300000000000000001');
    assert.equal(listRewards(w.ctx, G).length, 1);
  });
});

describe('planificador de /setup', () => {
  const empty: LogConfig = { categoryId: null, staffRoleId: null, logSentMessages: true, channels: {} };

  it('servidor limpio: crea categoría y todos los canales', () => {
    const plan = planSetup(empty, []);
    assert.equal(plan.category.kind, 'create');
    assert.ok(plan.steps.every((s) => s.kind === 'create'));
    assert.equal(plan.steps.length, LOG_CHANNELS.length);
  });

  it('configuración intacta: no crea nada (sin duplicados al repetir /setup)', () => {
    const existing: ExistingChannel[] = [{ id: 'cat', name: '📋 Registros', type: 'category', parentId: null }];
    const channels: LogConfig['channels'] = {};
    LOG_CHANNELS.forEach((c, i) => {
      existing.push({ id: `c${i}`, name: c.name, type: 'text', parentId: 'cat' });
      channels[c.key] = `c${i}`;
    });
    const plan = planSetup({ ...empty, categoryId: 'cat', channels }, existing);
    assert.equal(plan.category.kind, 'keep');
    assert.ok(plan.steps.every((s) => s.kind === 'keep'));
  });

  it('canal borrado se recrea, canal movido se reubica, canal renombrado se conserva por ID', () => {
    const existing: ExistingChannel[] = [
      { id: 'cat', name: '📋 Registros', type: 'category', parentId: null },
      { id: 'c1', name: 'renombrado-por-alguien', type: 'text', parentId: 'cat' },
      { id: 'c2', name: '🗑️・eliminados', type: 'text', parentId: 'otra-categoria' },
    ];
    const plan = planSetup({ ...empty, categoryId: 'cat', channels: { mensajes: 'c1', eliminados: 'c2', adjuntos: 'borrado' } }, existing);
    const byKey = Object.fromEntries(plan.steps.map((s) => [s.key, s.kind]));
    assert.equal(byKey.mensajes, 'keep');
    assert.equal(byKey.eliminados, 'reparent');
    assert.equal(byKey.adjuntos, 'create');
  });

  it('si se perdió la BD, adopta canales existentes por nombre dentro de la categoría', () => {
    const existing: ExistingChannel[] = [
      { id: 'cat', name: '📋 Registros', type: 'category', parentId: null },
      { id: 'x', name: '🔨・baneos', type: 'text', parentId: 'cat' },
      { id: 'y', name: '🔨・baneos', type: 'text', parentId: null },
    ];
    const plan = planSetup(empty, existing);
    assert.deepEqual(plan.category, { kind: 'adopt', id: 'cat' });
    assert.deepEqual(plan.steps.find((s) => s.key === 'baneos'), { kind: 'adopt', key: 'baneos', channelId: 'x' });
  });

  it('dos claves apuntando al mismo canal no comparten canal', () => {
    const existing: ExistingChannel[] = [
      { id: 'cat', name: '📋 Registros', type: 'category', parentId: null },
      { id: 'dup', name: 'x', type: 'text', parentId: 'cat' },
    ];
    const plan = planSetup({ ...empty, categoryId: 'cat', channels: { mensajes: 'dup', eliminados: 'dup' } }, existing);
    const kinds = plan.steps.filter((s) => s.key === 'mensajes' || s.key === 'eliminados').map((s) => s.kind);
    assert.deepEqual(kinds, ['keep', 'create']);
  });
});

describe('antispam', () => {
  it('limita ráfagas y marca abuso reiterado una sola vez', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    const results: string[] = [];
    for (let i = 0; i < 20; i++) results.push(rl.check('u', 5, 10_000, 3));
    assert.equal(results.filter((r) => r === 'ok').length, 5);
    assert.equal(results.filter((r) => r === 'flag').length, 1);
    t += 11_000;
    assert.equal(rl.check('u', 5, 10_000, 3), 'ok');
  });
});


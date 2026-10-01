import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../src/game/defaults';
import { activeBuffs } from '../src/services/buffs';
import { GameError, createContext } from '../src/services/context';
import { getCoins } from '../src/services/economy';
import {
  closeEvent, dueClosures, dueGuilds, getEventConfig, joinEvent, openEvent, orphanEvents, planEvent, setEventChannel, setEventsEnabled,
} from '../src/services/events';
import { setTunable } from '../src/services/guildSettings';
import { getQty } from '../src/services/inventory';
import { ensureProfile } from '../src/services/player';
import { G, makeWorld, seeded } from './helpers';

const CH = '300000000000000009';
const users = Array.from({ length: 8 }, (_, i) => `2000000000000001${String(i).padStart(2, '0')}`);
const expectGameError = (fn: () => unknown, re?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));

function world(seed = 5, boostChance = 0) {
  const w = makeWorld({}, seed);
  setTunable(w.ctx, G, 'events.boostChance', boostChance);
  setEventChannel(w.ctx, G, CH);
  for (const u of users) {
    ensureProfile(w.ctx, G, u);
    w.ctx.db.run('UPDATE profiles SET farm_level = 5 WHERE guild_id = ? AND user_id = ?', G, u);
  }
  return w;
}

describe('eventos automáticos', () => {
  it('no se programan sin canal; al activarse, el próximo cae dentro del intervalo aleatorio', () => {
    const w = makeWorld();
    expectGameError(() => setEventsEnabled(w.ctx, G, true), /canal/);
    setEventChannel(w.ctx, G, CH);
    const conf = setEventsEnabled(w.ctx, G, true);
    const wait = conf.next_at! - w.clock.t;
    assert.ok(wait >= 100 * 60_000 && wait <= 140 * 60_000, `espera ${wait / 60_000} min`);
    assert.deepEqual(dueGuilds(w.ctx), []);
    w.clock.advance(141 * 60_000);
    assert.deepEqual(dueGuilds(w.ctx), [G]);
  });

  it('dos ticks simultáneos (o dos procesos) crean UN solo evento', () => {
    const w = world();
    setEventsEnabled(w.ctx, G, true);
    w.clock.advance(141 * 60_000);
    const a = planEvent(w.ctx, G);
    const b = planEvent(w.ctx, G);
    assert.ok(a);
    assert.equal(b, null);
    assert.equal(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events')!.n, 1);
  });

  it('nunca hay dos sorteos abiertos a la vez (índice único), ni lanzándolos a mano', () => {
    const w = world();
    planEvent(w.ctx, G, true);
    expectGameError(() => planEvent(w.ctx, G, true), /Ya hay un sorteo abierto/);
    assert.throws(() => w.ctx.db.run(
      "INSERT INTO events (guild_id, channel_id, kind, reward_json, winners, state, created_at, ends_at) VALUES (?, ?, 'sorteo', '{}', 1, 'open', 0, 0)", G, CH,
    ));
  });

  it('participar: una vez por persona, solo mientras está abierto y con nivel mínimo', () => {
    const w = world();
    const e = planEvent(w.ctx, G, true)!;
    assert.equal(joinEvent(w.ctx, e.id, G, users[0]).participants, 1);
    expectGameError(() => joinEvent(w.ctx, e.id, G, users[0]), /Ya estás participando/);
    const novato = '200000000000000999';
    ensureProfile(w.ctx, G, novato);
    expectGameError(() => joinEvent(w.ctx, e.id, G, novato), /nivel total/);
    expectGameError(() => joinEvent(w.ctx, e.id, '100000000000000077', users[1]), /no existe/);
    w.clock.advance(301_000);
    expectGameError(() => joinEvent(w.ctx, e.id, G, users[1]), /terminó/);
  });

  it('cerrar dos veces (dos ticks, reinicio a mitad) entrega los premios UNA sola vez', () => {
    const w = world();
    const e = planEvent(w.ctx, G, true)!;
    for (const u of users) joinEvent(w.ctx, e.id, G, u);
    assert.equal(closeEvent(w.ctx, e.id), null, 'todavía no venció');
    w.clock.advance(301_000);
    assert.deepEqual(dueClosures(w.ctx), [e.id]);
    const res = closeEvent(w.ctx, e.id)!;
    assert.equal(closeEvent(w.ctx, e.id), null);
    assert.equal(res.winners.length, e.winners);
    assert.equal(new Set(res.winners.map((x) => x.userId)).size, res.winners.length, 'sin ganadores repetidos');
    assert.equal(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM event_wins WHERE event_id = ?', e.id)!.n, res.winners.length);
    assert.equal(openEvent(w.ctx, G), undefined);
  });

  it('un reinicio del bot no pierde el sorteo: la nueva instancia lo cierra y paga', () => {
    const w = world();
    const e = planEvent(w.ctx, G, true)!;
    for (const u of users.slice(0, 3)) joinEvent(w.ctx, e.id, G, u);
    // "Reinicio": contexto nuevo sobre la MISMA base de datos, con otro RNG.
    const restarted = createContext({ db: w.ctx.db, baseConfig: structuredClone(DEFAULT_CONFIG), now: () => w.clock.t + 600_000, rng: seeded(99) });
    assert.deepEqual(dueClosures(restarted), [e.id]);
    const res = closeEvent(restarted, e.id)!;
    assert.ok(res.winners.length >= 1);
  });

  it('tope diario de victorias: la misma persona no puede ganar todo', () => {
    const w = world(11);
    setTunable(w.ctx, G, 'events.dailyWinCap', 1);
    setTunable(w.ctx, G, 'events.maxWinners', 1);
    const solo = users[0];
    let wins = 0;
    for (let i = 0; i < 3; i++) {
      const e = planEvent(w.ctx, G, true)!;
      joinEvent(w.ctx, e.id, G, solo);
      w.clock.advance(301_000);
      wins += closeEvent(w.ctx, e.id)!.winners.length;
    }
    assert.equal(wins, 1);
  });

  it('los premios se entregan de verdad (monedas, carnada, buffs…)', () => {
    const w = world(21);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const e = planEvent(w.ctx, G, true)!;
      const u = users[i % users.length];
      const coins = getCoins(w.ctx, G, u);
      const bait = getQty(w.ctx, G, u, 'lombriz');
      const buffs = activeBuffs(w.ctx, G, u).length;
      joinEvent(w.ctx, e.id, G, u);
      w.clock.advance(301_000);
      const res = closeEvent(w.ctx, e.id)!;
      w.ctx.db.run('DELETE FROM event_wins');
      if (!res.winners.length) continue;
      seen.add(res.reward.kind);
      if (res.reward.kind === 'coins') assert.ok(getCoins(w.ctx, G, u) > coins);
      if (res.reward.kind === 'bait') assert.ok(getQty(w.ctx, G, u, 'lombriz') > bait);
      if (res.reward.kind === 'buff') assert.ok(activeBuffs(w.ctx, G, u).length >= buffs);
    }
    assert.ok(seen.size >= 3, `variedad de premios: ${[...seen].join(', ')}`);
  });

  it('marea dorada: bonus de servidor sin sorteo y sin dejar eventos abiertos', () => {
    const w = world(5, 1);
    const e = planEvent(w.ctx, G, true)!;
    assert.equal(e.kind, 'marea');
    assert.equal(e.state, 'closed');
    assert.equal(activeBuffs(w.ctx, G, users[3]).some((b) => b.guildWide && b.def.id === 'marea_dorada'), true);
    assert.equal(openEvent(w.ctx, G), undefined);
  });

  it('eventos huérfanos (el bot se cortó antes de publicarlos) se detectan para cancelarlos', () => {
    const w = world();
    const e = planEvent(w.ctx, G, true)!;
    assert.deepEqual(orphanEvents(w.ctx), []);
    w.clock.advance(121_000);
    assert.deepEqual(orphanEvents(w.ctx), [e.id]);
  });

  it('desactivar los eventos detiene la programación', () => {
    const w = world();
    setEventsEnabled(w.ctx, G, true);
    setEventsEnabled(w.ctx, G, false);
    w.clock.advance(10 * 3_600_000);
    assert.deepEqual(dueGuilds(w.ctx), []);
    assert.equal(getEventConfig(w.ctx, G).enabled, 0);
  });
});

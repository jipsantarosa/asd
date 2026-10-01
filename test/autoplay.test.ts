import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../src/game/defaults';
import { AUTOPLAY_INTERVAL_MS, dueAutoplay, getAutoplay, runAutoplay, setAutoplay } from '../src/services/autoplay';
import { GameError, createContext } from '../src/services/context';
import { getQty, removeItem } from '../src/services/inventory';
import { getProfile } from '../src/services/player';
import { getPremium, grantPremium, revokePremium, setBotSlots } from '../src/services/premium';
import { G, U, makeWorld, seeded } from './helpers';

const OWNER = '200000000000000100';
const expectGameError = (fn: () => unknown, re?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));

describe('!autoplay', () => {
  it('pide Tier 2 para activarse; desactivar siempre se puede', () => {
    const w = makeWorld();
    expectGameError(() => setAutoplay(w.ctx, G, U, true), /Tier 2/);
    grantPremium(w.ctx, U, 1, OWNER, null);
    expectGameError(() => setAutoplay(w.ctx, G, U, true), /Tier 2/);
    grantPremium(w.ctx, U, 2, OWNER, null);
    assert.equal(setAutoplay(w.ctx, G, U, true)!.enabled, 1);
    assert.equal(setAutoplay(w.ctx, G, U, false)!.enabled, 0);
  });

  it('cada turno cosecha y pesca una vez, y espera 10 minutos para el siguiente', () => {
    const w = makeWorld();
    grantPremium(w.ctx, U, 2, OWNER, null);
    setAutoplay(w.ctx, G, U, true);
    assert.deepEqual(dueAutoplay(w.ctx), [{ guildId: G, userId: U }]);
    const r = runAutoplay(w.ctx, G, U)!;
    assert.ok(r.farm, 'cosechó');
    assert.ok(r.fish, 'pescó');
    assert.equal(getProfile(w.ctx, G, U)!.farms_total, 1);
    assert.equal(runAutoplay(w.ctx, G, U), null, 'el mismo turno no corre dos veces');
    assert.deepEqual(dueAutoplay(w.ctx), []);
    w.clock.advance(AUTOPLAY_INTERVAL_MS);
    assert.ok(runAutoplay(w.ctx, G, U));
    assert.equal(getAutoplay(w.ctx, G, U)!.runs, 2);
  });

  it('respeta los recursos: sin carnada solo cosecha, y no se rompe', () => {
    const w = makeWorld();
    grantPremium(w.ctx, U, 3, OWNER, null);
    setAutoplay(w.ctx, G, U, true);
    removeItem(w.ctx, G, U, 'lombriz', getQty(w.ctx, G, U, 'lombriz'));
    const r = runAutoplay(w.ctx, G, U)!;
    assert.ok(r.farm);
    assert.equal(r.fish, null);
    assert.ok(r.notes.some((n) => /carnada/.test(n)));
  });

  it('si el premium vence, se apaga solo en el siguiente turno', () => {
    const w = makeWorld();
    grantPremium(w.ctx, U, 2, OWNER, null);
    setAutoplay(w.ctx, G, U, true);
    revokePremium(w.ctx, U);
    const r = runAutoplay(w.ctx, G, U)!;
    assert.equal(r.stopped, true);
    assert.equal(getAutoplay(w.ctx, G, U)!.enabled, 0);
    assert.equal(getProfile(w.ctx, G, U)!.farms_total, 0, 'no jugó');
  });

  it('sobrevive a un reinicio (el estado está en la base) sin repetir el turno', () => {
    const w = makeWorld();
    grantPremium(w.ctx, U, 2, OWNER, null);
    setAutoplay(w.ctx, G, U, true);
    runAutoplay(w.ctx, G, U);
    const restarted = createContext({ db: w.ctx.db, baseConfig: structuredClone(DEFAULT_CONFIG), now: () => w.clock.t + 60_000, rng: seeded(5) });
    assert.equal(runAutoplay(restarted, G, U), null, 'todavía no tocaba');
    const later = createContext({ db: w.ctx.db, baseConfig: structuredClone(DEFAULT_CONFIG), now: () => w.clock.t + AUTOPLAY_INTERVAL_MS, rng: seeded(6) });
    assert.ok(runAutoplay(later, G, U));
  });
});

describe('premium global y servidores de !botperfil', () => {
  it('el premium es por persona: vale en cualquier servidor', () => {
    const w = makeWorld();
    grantPremium(w.ctx, U, 4, OWNER, null);
    // No depende del servidor: la misma consulta sirve en todos.
    assert.equal(getPremium(w.ctx, U)!.tier, 4);
    setAutoplay(w.ctx, '100000000000000999', U, true);
    assert.equal(getAutoplay(w.ctx, '100000000000000999', U)!.enabled, 1);
  });

  it('el dueño elige cuántos servidores (3 por defecto) y se conserva al renovar', () => {
    const w = makeWorld();
    grantPremium(w.ctx, U, 4, OWNER, null);
    assert.equal(getPremium(w.ctx, U)!.bot_slots, 3);
    setBotSlots(w.ctx, U, 5);
    grantPremium(w.ctx, U, 4, OWNER, 30); // renovar no pisa la cantidad
    assert.equal(getPremium(w.ctx, U)!.bot_slots, 5);
    expectGameError(() => setBotSlots(w.ctx, U, 0), /entre 1 y 100/);
    expectGameError(() => setBotSlots(w.ctx, '200000000000000555', 5), /no tiene premium/);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claimNotices, finishNotices, achievementProgress, pendingNotices, recoverStuckNotices } from '../src/services/achievements';
import { applyBuff } from '../src/services/buffs';
import { GameError } from '../src/services/context';
import { getCoins } from '../src/services/economy';
import { fish } from '../src/services/fishing';
import { setTunable } from '../src/services/guildSettings';
import { addItem, getQty } from '../src/services/inventory';
import { leaderboard } from '../src/services/leaderboard';
import { sellBulk, sellItem } from '../src/services/market';
import { ensureProfile, getProfile } from '../src/services/player';
import { eligibleRewards, setReward, listRewards } from '../src/services/roles';
import { getOffer, listOffers, purchase } from '../src/services/shop';
import { loadBaseConfig } from '../src/game/config';
import { G, U, U2, makeWorld } from './helpers';

const expectGameError = (fn: () => unknown, re?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));

function setup(seed = 42) {
  const w = makeWorld({}, seed);
  ensureProfile(w.ctx, G, U);
  return w;
}
const set = (w: ReturnType<typeof makeWorld>, cols: string, ...vals: unknown[]) =>
  w.ctx.db.run(`UPDATE profiles SET ${cols} WHERE guild_id = ? AND user_id = ?`, ...vals, G, U);
const unlocked = (w: ReturnType<typeof makeWorld>, u = U) =>
  w.ctx.db.all<{ achievement_id: string }>('SELECT achievement_id FROM achievements_unlocked WHERE guild_id = ? AND user_id = ?', G, u).map((r) => r.achievement_id);

describe('tienda unificada', () => {
  it('hay más de 10 cañas y su progresión es creciente y sin saltos bruscos', () => {
    const rods = loadBaseConfig().fishing.rods;
    assert.ok(rods.length > 10);
    for (let i = 1; i < rods.length; i++) {
      assert.ok(rods[i].price > rods[i - 1].price, `${rods[i].id}: precio creciente`);
      assert.ok(rods[i].fishLevel > rods[i - 1].fishLevel, `${rods[i].id}: nivel creciente`);
      assert.ok(rods[i].lines - rods[i - 1].lines <= 1);
      assert.ok(rods[i].luck - rods[i - 1].luck <= 0.08 + 1e-9);
      // Ningún salto de precio mayor a ×3: la progresión no tiene paredes.
      if (i > 1) assert.ok(rods[i].price / rods[i - 1].price <= 3, `${rods[i].id}: salto ×${(rods[i].price / rods[i - 1].price).toFixed(2)}`);
    }
  });

  it('el precio que se muestra es exactamente el que se cobra (también con rebaja)', () => {
    const w = setup();
    set(w, 'coins = 100000, fish_level = 10');
    w.ctx.db.transaction(() => applyBuff(w.ctx, G, U, 'rebaja', 'test'));
    const offer = getOffer(w.ctx, G, U, 'rod:tejedora');
    assert.equal(offer.state, 'available');
    assert.equal(offer.price, Math.round(6000 * 0.85));
    const r = purchase(w.ctx, G, U, 'rod:tejedora');
    assert.equal(r.cost, offer.price);
    // + 300 del logro "Buena madera" (segunda caña), entregado en la misma compra.
    assert.deepEqual(r.outcome.achievements.map((a) => a.def.id), ['segunda_cana']);
    assert.equal(getCoins(w.ctx, G, U), 100000 - offer.price + 300);
  });

  it('doble clic en comprar: se cobra una sola vez', () => {
    const w = setup();
    set(w, 'coins = 10000, fish_level = 5');
    purchase(w.ctx, G, U, 'rod:sauce');
    w.clock.advance(5000);
    expectGameError(() => purchase(w.ctx, G, U, 'rod:sauce'), /Ya tenés/);
    assert.equal(getCoins(w.ctx, G, U), 10000 - 2000 + 300, 'una sola compra (+ logro Buena madera)');
  });

  it('valida en el servidor: bloqueados, cantidades y ids manipulados', () => {
    const w = setup();
    expectGameError(() => purchase(w.ctx, G, U, 'rod:astro'), /nivel de pesca/);
    expectGameError(() => purchase(w.ctx, G, U, 'rod:../../etc'), /no existe/);
    expectGameError(() => purchase(w.ctx, G, U, 'hack:x'), /no existe/);
    expectGameError(() => purchase(w.ctx, G, U, 'rod:sauce', 3), /de a uno/);
    expectGameError(() => purchase(w.ctx, G, U, 'supply:lombriz', 0), /Cantidad/);
    assert.equal(getCoins(w.ctx, G, U), 150, 'nada se cobró');
  });

  it('suministros en cantidad: costo = precio × cantidad y respeta el tope diario', () => {
    const w = setup();
    set(w, 'coins = 1000000, farm_level = 20, fish_level = 20');
    const o = getOffer(w.ctx, G, U, 'supply:lombriz');
    const r = purchase(w.ctx, G, U, 'supply:lombriz', 10);
    assert.equal(r.cost, o.price * 10);
    const buff = getOffer(w.ctx, G, U, 'supply:cebo_brillante');
    w.clock.advance(5000);
    purchase(w.ctx, G, U, 'supply:cebo_brillante', buff.dailyLimit!);
    w.clock.advance(5000);
    expectGameError(() => purchase(w.ctx, G, U, 'supply:cebo_brillante', 1), /Límite diario/);
    assert.equal(getOffer(w.ctx, G, U, 'supply:cebo_brillante').state, 'locked');
  });

  it('cada sección lista sus ofertas con estado coherente', () => {
    const w = setup();
    const rods = listOffers(w.ctx, G, U, 'canas');
    assert.equal(rods.length, 12);
    assert.equal(rods[0].state, 'equipped');
    assert.equal(rods[1].state, 'locked');
    for (const s of ['equipo', 'suministros', 'permisos', 'mejoras'] as const) assert.ok(listOffers(w.ctx, G, U, s).length > 0);
  });
});

describe('vender (correcciones)', () => {
  it('vender la mitad y todo; la cantidad se resuelve con el inventario real', () => {
    const w = setup();
    addItem(w.ctx, G, U, 'papa', 9);
    const half = sellItem(w.ctx, G, U, 'papa', 'half');
    assert.equal(half.qty, 4);
    w.clock.advance(1000);
    const all = sellItem(w.ctx, G, U, 'papa', 'all');
    assert.equal(all.qty, 5);
    assert.equal(getQty(w.ctx, G, U, 'papa'), 0);
    // + 25 del logro "Primera venta".
    assert.equal(getCoins(w.ctx, G, U), 150 + half.quote.total + all.quote.total + 25, 'saldo = ventas exactas + logro');
    const ledger = w.ctx.db.all<{ delta: number }>("SELECT delta FROM ledger WHERE user_id = ? AND reason LIKE 'venta %'", U);
    assert.deepEqual(ledger.map((l) => l.delta), [half.quote.total, all.quote.total], 'persistido en el libro contable');
  });

  it('doble clic en "Vender todo": la segunda no vende nada ni cobra', () => {
    const w = setup();
    addItem(w.ctx, G, U, 'papa', 20);
    const r = sellItem(w.ctx, G, U, 'papa', 'all');
    const coins = getCoins(w.ctx, G, U);
    w.clock.advance(1000);
    expectGameError(() => sellItem(w.ctx, G, U, 'papa', 'all'), /Ya no tenés/);
    assert.equal(getCoins(w.ctx, G, U), coins);
    assert.equal(r.qty, 20);
  });

  it('un panel desactualizado no vende de más', () => {
    const w = setup();
    addItem(w.ctx, G, U, 'papa', 3);
    expectGameError(() => sellItem(w.ctx, G, U, 'papa', 5), /Solo tenés 3/);
    assert.equal(getQty(w.ctx, G, U, 'papa'), 3);
  });

  it('"todo" funciona aunque tengas más de 9.999', () => {
    const w = setup();
    addItem(w.ctx, G, U, 'papa', 12000);
    assert.equal(sellItem(w.ctx, G, U, 'papa', 'all').qty, 12000);
  });

  it('venta en lote: nunca vende Épicos+, carnada ni materiales de cañas', () => {
    const w = setup();
    addItem(w.ctx, G, U, 'mojarra', 5);
    addItem(w.ctx, G, U, 'trucha_arcoiris', 2);
    addItem(w.ctx, G, U, 'anguila_plateada', 1);
    addItem(w.ctx, G, U, 'celacanto', 1);
    sellBulk(w.ctx, G, U, 'peces');
    assert.equal(getQty(w.ctx, G, U, 'mojarra'), 0);
    assert.equal(getQty(w.ctx, G, U, 'trucha_arcoiris'), 0);
    assert.equal(getQty(w.ctx, G, U, 'anguila_plateada'), 1);
    assert.equal(getQty(w.ctx, G, U, 'celacanto'), 1);
    assert.equal(getQty(w.ctx, G, U, 'lombriz'), 25);
  });
});

describe('actividad', () => {
  it('pescar, farmear, vender y comprar suman puntos; lo chico no suma', () => {
    const w = setup();
    set(w, 'vigor = 500, vigor_updated_at = ?', w.clock.t);
    const r = fish(w.ctx, G, U);
    assert.ok(r.outcome.activity >= 2);
    addItem(w.ctx, G, U, 'papa', 1);
    w.clock.advance(1000);
    const small = sellItem(w.ctx, G, U, 'papa', 1);
    const fromAch = small.outcome.achievements.reduce((s, a) => s + a.activity, 0);
    assert.equal(small.outcome.activity - fromAch, 0, 'venta chica: la venta en sí no suma (solo el logro "Primera venta")');
    addItem(w.ctx, G, U, 'trucha_arcoiris', 3);
    w.clock.advance(1000);
    assert.equal(sellItem(w.ctx, G, U, 'trucha_arcoiris', 'all').outcome.activity, 1, 'venta de 150: suma');
  });

  it('tope diario: el spam no sube la actividad sin límite y al día siguiente se renueva', () => {
    const w = setup();
    setTunable(w.ctx, G, 'activity.dailyCapFish', 10);
    addItem(w.ctx, G, U, 'lombriz', 500);
    const before = getProfile(w.ctx, G, U)!.activity_points;
    for (let i = 0; i < 20; i++) {
      set(w, 'vigor = 500, vigor_updated_at = ?, fatigue = 0', w.clock.t);
      w.clock.advance(15_000);
      fish(w.ctx, G, U);
    }
    const fromFish = getProfile(w.ctx, G, U)!.activity_points - before
      - w.ctx.db.all<{ achievement_id: string }>('SELECT achievement_id FROM achievements_unlocked WHERE user_id = ?', U).length * 0;
    const achPoints = achievementProgress(w.ctx, G, U).filter((a) => a.unlocked).reduce((s, a) => s + a.def.activity, 0);
    assert.equal(fromFish - achPoints, 10, 'la pesca aportó exactamente el tope');
    w.clock.advance(86_400_000);
    set(w, 'vigor = 500, vigor_updated_at = ?, fatigue = 0', w.clock.t);
    assert.ok(fish(w.ctx, G, U).outcome.activity >= 2, 'nuevo día');
  });

  it('las distinciones por actividad se calculan con los puntos', () => {
    const w = setup();
    setReward(w.ctx, G, '900000000000000001', 'actividad', 100);
    setReward(w.ctx, G, '900000000000000002', 'pesca', 5);
    expectGameError(() => setReward(w.ctx, G, '900000000000000003', 'actividad', 0));
    set(w, 'activity_points = 120');
    const ids = eligibleRewards(listRewards(w.ctx, G), getProfile(w.ctx, G, U)!).map((r) => r.role_id);
    assert.deepEqual(ids, ['900000000000000001']);
  });

  it('el ranking tiene la categoría actividad', () => {
    const w = setup();
    ensureProfile(w.ctx, G, U2);
    w.ctx.db.run('UPDATE profiles SET activity_points = ?, farms_total = 1 WHERE user_id = ?', 50, U);
    w.ctx.db.run('UPDATE profiles SET activity_points = ?, farms_total = 1 WHERE user_id = ?', 80, U2);
    assert.deepEqual(leaderboard(w.ctx, G, 'actividad', 5).map((e) => e.userId), [U2, U]);
  });
});

describe('logros', () => {
  it('se desbloquean una sola vez y la recompensa se paga una sola vez', () => {
    const w = setup();
    addItem(w.ctx, G, U, 'papa', 5);
    sellItem(w.ctx, G, U, 'papa', 1);
    assert.ok(unlocked(w).includes('primera_venta'));
    const coins = getCoins(w.ctx, G, U);
    w.clock.advance(1000);
    const again = sellItem(w.ctx, G, U, 'papa', 1);
    assert.equal(again.outcome.achievements.length, 0);
    assert.equal(getCoins(w.ctx, G, U), coins + again.quote.total, 'no volvió a pagar el logro');
  });

  it('comprar una caña desbloquea "Buena madera" (logros conectados con la tienda)', () => {
    const w = setup();
    set(w, 'coins = 5000, fish_level = 3');
    const r = purchase(w.ctx, G, U, 'rod:corcho');
    assert.deepEqual(r.outcome.achievements.map((a) => a.def.id), ['segunda_cana']);
    assert.equal(getQty(w.ctx, G, U, 'lombriz'), 25 + 20);
  });

  it('avisos por DM: se reservan una sola vez, los MD cerrados no se reintentan y los fallos sí (hasta 3)', () => {
    const w = setup();
    addItem(w.ctx, G, U, 'papa', 5);
    sellItem(w.ctx, G, U, 'papa', 1);
    const pend = pendingNotices(w.ctx, { guildId: G, userId: U });
    assert.equal(pend.length, 1);
    const a = claimNotices(w.ctx, pend);
    const b = claimNotices(w.ctx, pend);
    assert.equal(a.length, 1);
    assert.equal(b.length, 0, 'dos entregas simultáneas no mandan el mismo DM');
    finishNotices(w.ctx, a, 'bloqueado');
    assert.equal(pendingNotices(w.ctx, { guildId: G, userId: U }).length, 0);
    assert.equal(achievementProgress(w.ctx, G, U).find((x) => x.def.id === 'primera_venta')!.dmStatus, 'bloqueado');

    // Un logro con fallo transitorio vuelve a la cola hasta 3 intentos.
    set(w, 'coins = 5000, fish_level = 3');
    purchase(w.ctx, G, U, 'rod:corcho');
    for (let i = 0; i < 3; i++) {
      const c = claimNotices(w.ctx, pendingNotices(w.ctx, { guildId: G, userId: U }));
      assert.equal(c.length, 1);
      finishNotices(w.ctx, c, 'reintentar');
    }
    assert.equal(pendingNotices(w.ctx, { guildId: G, userId: U }).length, 0);
    assert.equal(achievementProgress(w.ctx, G, U).find((x) => x.def.id === 'segunda_cana')!.dmStatus, 'fallido');
  });

  it('tras un reinicio, los avisos que quedaron "enviando" vuelven a la cola', () => {
    const w = setup();
    addItem(w.ctx, G, U, 'papa', 5);
    sellItem(w.ctx, G, U, 'papa', 1);
    claimNotices(w.ctx, pendingNotices(w.ctx, { guildId: G, userId: U }));
    assert.equal(pendingNotices(w.ctx, { guildId: G, userId: U }).length, 0);
    recoverStuckNotices(w.ctx);
    assert.equal(pendingNotices(w.ctx, { guildId: G, userId: U }).length, 1);
  });

  it('cada logro tiene su insignia generada', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const a of loadBaseConfig().achievements) {
      assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'badges', `${a.id}.png`)), `falta la insignia de ${a.id}`);
    }
    for (const r of loadBaseConfig().fishing.rods) {
      assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'rods', `${r.sprite}.png`)), `falta la imagen de ${r.id}`);
    }
  });
});

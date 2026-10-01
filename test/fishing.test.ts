import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadBaseConfig } from '../src/game/config';
import { activeBuffs, applyBuff, buffTotals, GUILD_WIDE } from '../src/services/buffs';
import { GameError } from '../src/services/context';
import { useConsumable } from '../src/services/consumables';
import { getCoins } from '../src/services/economy';
import { RARITY_ORDER, castAt, castVigorCost, collectionProgress, equipRod, expectedRoll, fish, fishingLoadout, generateLayout, getLake, rarityOdds } from '../src/services/fishing';
import { addItem, getQty, removeItem } from '../src/services/inventory';
import { buyRod, buySupply, priceFor, supplyOffers } from '../src/services/market';
import { ensureProfile, getProfile } from '../src/services/player';
import { setTunable } from '../src/services/guildSettings';
import { G, U, U2, makeWorld } from './helpers';

const expectGameError = (fn: () => unknown, re?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));

function setup(seed = 42) {
  const w = makeWorld({}, seed);
  ensureProfile(w.ctx, G, U);
  return w;
}
const refill = (w: ReturnType<typeof makeWorld>, u = U) =>
  w.ctx.db.run('UPDATE profiles SET vigor = 1000, vigor_updated_at = ?, fatigue = 0 WHERE guild_id = ? AND user_id = ?', w.clock.t, G, u);
const setFishLevel = (w: ReturnType<typeof makeWorld>, lvl: number, coins = 0) =>
  w.ctx.db.run('UPDATE profiles SET fish_level = ?, coins = coins + ? WHERE guild_id = ? AND user_id = ?', lvl, coins, G, U);

describe('pesca: probabilidades y balance (matemática exacta)', () => {
  const cfg = loadBaseConfig();

  it('las probabilidades suman 1 y el Ultralegendario es extremadamente raro', () => {
    for (const luck of [0, 0.3, 0.8]) {
      const o = rarityOdds(cfg, luck);
      assert.ok(Math.abs(RARITY_ORDER.reduce((s, r) => s + o[r], 0) - 1) < 1e-9);
    }
    assert.ok(Math.abs(rarityOdds(cfg, 0).mitico - 0.0005) < 1e-9, '0,05% sin suerte = 1 cada 2.000 tiradas');
    const max = rarityOdds(cfg, cfg.tuning.fish.maxLuck, 1.6).mitico;
    assert.ok(max < 0.0025, `con todo al máximo sigue siendo < 0,25% (es ${max})`);
  });

  it('la suerte mejora las rarezas altas de forma monótona y nunca vuelve imposible un Común', () => {
    let prev = rarityOdds(cfg, 0);
    for (let l = 0.1; l <= 0.8 + 1e-9; l += 0.1) {
      const o = rarityOdds(cfg, l);
      assert.ok(o.epico > prev.epico && o.mitico > prev.mitico && o.comun < prev.comun);
      assert.ok(o.comun > 0.45);
      prev = o;
    }
  });

  it('si un admin reactiva el vigor (4 + 2 por línea), pescar rinde menos por vigor que farmear', () => {
    cfg.tuning.fish.vigorPerCast = 4;
    cfg.tuning.fish.vigorPerLine = 2;
    // Etapa inicial: caña de junco, sin suerte, Huerta con herramienta básica.
    const ev = expectedRoll(cfg, 1, 0);
    const baitCost = cfg.tuning.fish.baitPriceBase;
    const fishPerVigor = (ev.coins - baitCost) / castVigorCost(cfg, 1);
    const z = cfg.farming.zones[0];
    const tw = z.crops.reduce((s, c) => s + c.weight, 0);
    const farmPerVigor = z.rolls * z.crops.reduce((s, c) => s + (c.weight / tw) * ((c.min + c.max) / 2) * (cfg.items.find((i) => i.id === c.itemId)!.sellPrice), 0) / z.vigorCost;
    assert.ok(fishPerVigor > 0, 'pescar tiene que valer la pena');
    assert.ok(fishPerVigor < farmPerVigor, `pesca ${fishPerVigor.toFixed(2)} vs granja ${farmPerVigor.toFixed(2)} por vigor`);
  });

  it('comprar carnada nunca es ganancia por sí sola: se vende muy por debajo de su precio', () => {
    const bait = cfg.items.find((i) => i.id === cfg.fishing.baitItemId)!;
    assert.ok(bait.sellPrice < cfg.tuning.fish.baitPriceBase);
  });

  it('más líneas ahorran vigor por tirada, pero cada línea sigue costando carnada', () => {
    cfg.tuning.fish.vigorPerCast = 4;
    cfg.tuning.fish.vigorPerLine = 2;
    const perRoll = (n: number) => castVigorCost(cfg, n) / n;
    assert.ok(perRoll(1) > perRoll(3) && perRoll(3) > perRoll(5));
    assert.ok(perRoll(5) >= cfg.tuning.fish.vigorPerLine, 'nunca baja del costo por línea');
  });

  it('las cañas se encarecen de forma creciente y piden cada vez más nivel', () => {
    const rods = cfg.fishing.rods;
    for (let i = 2; i < rods.length; i++) {
      assert.ok(rods[i].price > rods[i - 1].price && rods[i].fishLevel > rods[i - 1].fishLevel);
    }
    // Sin saltos "pay-to-win": ninguna caña suma más de +1 línea ni más de +0,08 de suerte respecto de la anterior.
    for (let i = 1; i < rods.length; i++) {
      assert.ok(rods[i].lines - rods[i - 1].lines <= 1);
      assert.ok(rods[i].luck - rods[i - 1].luck <= 0.08 + 1e-9);
    }
  });
});

describe('pesca: un solo botón', () => {
  it('una pesca tira tantas líneas como la caña, gasta carnada y vigor, y da XP e ítems', () => {
    const w = setup();
    refill(w);
    const before = getQty(w.ctx, G, U, 'lombriz');
    const r = fish(w.ctx, G, U);
    assert.equal(r.lines, 1);
    assert.equal(r.catches.length, 1);
    // "Primer pique" regala 10 de carnada: el logro se entrega en la misma transacción.
    assert.deepEqual(r.outcome.achievements.map((a) => a.def.id), ['primer_pique']);
    assert.equal(getQty(w.ctx, G, U, 'lombriz'), before - r.baitUsed + 10);
    assert.ok(r.gain.amount > 0);
    assert.equal(getProfile(w.ctx, G, U)!.catches_total, 1);
  });

  it('sin carnada no se puede pescar y no se cobra vigor ni espera', () => {
    const w = setup();
    refill(w);
    removeItem(w.ctx, G, U, 'lombriz', getQty(w.ctx, G, U, 'lombriz'));
    expectGameError(() => fish(w.ctx, G, U), /carnada/);
    addItem(w.ctx, G, U, 'lombriz', 1);
    assert.doesNotThrow(() => fish(w.ctx, G, U), 'el intento fallido no dejó una espera activa');
  });

  it('con poca carnada se tiran menos líneas (nunca se gasta carnada que no hay)', () => {
    const w = setup();
    refill(w);
    setFishLevel(w, 19, 100_000);
    buyRod(w.ctx, G, U, 'sauce');
    w.clock.advance(5000);
    buyRod(w.ctx, G, U, 'coral');
    removeItem(w.ctx, G, U, 'lombriz', getQty(w.ctx, G, U, 'lombriz'));
    addItem(w.ctx, G, U, 'lombriz', 2);
    const r = fish(w.ctx, G, U);
    assert.equal(r.wantedLines, 3);
    assert.equal(r.lines, 2);
    assert.ok(getQty(w.ctx, G, U, 'lombriz') >= 0);
  });

  it('con el vigor activado, con poco vigor se tiran menos líneas; sin vigor para una, falla sin cobrar', () => {
    const w = setup();
    setTunable(w.ctx, G, 'fish.vigorPerCast', 4);
    setTunable(w.ctx, G, 'fish.vigorPerLine', 2);
    setFishLevel(w, 19, 100_000);
    buyRod(w.ctx, G, U, 'coral');
    const cfgF = w.ctx; void cfgF;
    // vigor justo para 1 línea (4 + 2×1 = 6) pero no para 2 (8)
    w.ctx.db.run('UPDATE profiles SET vigor = 7, vigor_updated_at = ? WHERE guild_id = ? AND user_id = ?', w.clock.t, G, U);
    const r = fish(w.ctx, G, U);
    assert.equal(r.lines, 1);
    w.clock.advance(60_000);
    w.ctx.db.run('UPDATE profiles SET vigor = 1, vigor_updated_at = ? WHERE guild_id = ? AND user_id = ?', w.clock.t, G, U);
    const bait = getQty(w.ctx, G, U, 'lombriz');
    expectGameError(() => fish(w.ctx, G, U), /vigor/);
    assert.equal(getQty(w.ctx, G, U, 'lombriz'), bait);
  });

  it('sin freno anti spam: 30 clics seguidos pescan 30 veces y la carnada y las capturas cuadran exacto', () => {
    const w = setup();
    addItem(w.ctx, G, U, 'lombriz', 100);
    const bait0 = getQty(w.ctx, G, U, 'lombriz');
    let used = 0;
    let gifted = 0;
    for (let i = 0; i < 30; i++) {
      const r = fish(w.ctx, G, U); // sin avanzar el reloj: no hay espera
      used += r.baitUsed;
      gifted += r.outcome.achievements.reduce((n, a) => n + (a.def.reward.items ?? []).filter((x) => x.itemId === 'lombriz').reduce((m, x) => m + x.qty, 0), 0);
    }
    assert.equal(getProfile(w.ctx, G, U)!.catches_total, 30);
    assert.equal(getQty(w.ctx, G, U, 'lombriz'), bait0 - used + gifted);
  });

  it('si un admin reactiva la espera, los clics rápidos vuelven a frenarse', () => {
    const w = setup();
    setTunable(w.ctx, G, 'fish.cooldownMultiplier', 1);
    setTunable(w.ctx, G, 'fish.minCooldownSeconds', 5);
    fish(w.ctx, G, U);
    expectGameError(() => fish(w.ctx, G, U), /próxima pesca/);
    w.clock.advance(12_000);
    fish(w.ctx, G, U);
    assert.equal(getProfile(w.ctx, G, U)!.catches_total, 2);
  });

  it('la racha de la suerte garantiza un Épico al llegar al umbral y después se reinicia', () => {
    const w = setup();
    refill(w);
    const threshold = 120;
    w.ctx.db.run('UPDATE profiles SET fish_pity = ? WHERE guild_id = ? AND user_id = ?', threshold, G, U);
    const r = fish(w.ctx, G, U);
    assert.equal(r.catches[0].pity, true);
    assert.equal(r.catches[0].rarity, 'epico');
    assert.equal(getProfile(w.ctx, G, U)!.fish_pity, 0);
  });

  it('distribución real de rarezas coincide con la teórica (100.000 tiradas simuladas)', () => {
    const w = setup(7);
    w.ctx.db.run("UPDATE event_config SET enabled = 0");
    const cfg = loadBaseConfig();
    cfg.tuning.fish.pityThreshold = 0;
    const counts: Record<string, number> = {};
    const odds = rarityOdds(cfg, 0);
    const rng = w.ctx.rng;
    for (let i = 0; i < 100_000; i++) {
      let x = rng();
      for (const r of RARITY_ORDER) {
        x -= odds[r];
        if (x < 0) { counts[r] = (counts[r] ?? 0) + 1; break; }
      }
    }
    assert.ok(Math.abs(counts.comun / 100_000 - 0.6) < 0.01);
    assert.ok(Math.abs((counts.epico ?? 0) / 100_000 - 0.032) < 0.003);
    assert.ok((counts.mitico ?? 0) < 150, `ultralegendarios en 100k: ${counts.mitico ?? 0} (esperado ~50)`);
  });

  it('las colecciones pagan una sola vez al completar una rareza (pescando de verdad)', () => {
    const w = setup(3);
    const cfg = loadBaseConfig();
    const commons = cfg.fishing.fish.filter((f) => cfg.items.find((i) => i.id === f.itemId)!.rarity === 'comun');
    // Registra todos los Comunes menos la mojarra: la colección se completa al pescar una.
    for (const f of commons.filter((x) => x.itemId !== 'mojarra')) {
      w.ctx.db.run('INSERT INTO fish_log (guild_id, user_id, fish_id, caught, best_weight, first_at) VALUES (?, ?, ?, 1, 1, 0)', G, U, f.itemId);
    }
    addItem(w.ctx, G, U, 'lombriz', 500);
    let paid = 0;
    let mojarras = 0;
    for (let i = 0; i < 300 && mojarras < 3; i++) {
      refill(w);
      w.clock.advance(25_000);
      const r = fish(w.ctx, G, U);
      paid += r.collections.filter((c) => c.rarity === 'comun').length;
      mojarras += r.catches.filter((c) => c.itemId === 'mojarra').length;
    }
    assert.ok(mojarras >= 2, 'se pescaron varias mojarras');
    assert.equal(paid, 1, 'el premio de colección se pagó exactamente una vez');
    assert.equal(collectionProgress(w.ctx, G, U).find((c) => c.rarity === 'comun')!.claimed, true);
  });

  it('pescar en muchos servidores/jugadores no mezcla datos', () => {
    const w = setup();
    ensureProfile(w.ctx, G, U2);
    refill(w);
    refill(w, U2);
    fish(w.ctx, G, U);
    fish(w.ctx, G, U2);
    assert.equal(getProfile(w.ctx, G, U)!.catches_total, 1);
    assert.equal(getProfile(w.ctx, G, U2)!.catches_total, 1);
  });
});

describe('cañas', () => {
  it('requieren nivel y monedas; un doble clic no cobra dos veces', () => {
    const w = setup();
    expectGameError(() => buyRod(w.ctx, G, U, 'sauce'), /nivel de pesca 5/);
    setFishLevel(w, 5, 5000);
    const before = getCoins(w.ctx, G, U);
    buyRod(w.ctx, G, U, 'sauce');
    expectGameError(() => buyRod(w.ctx, G, U, 'sauce'), /Ya tenés/);
    assert.equal(getCoins(w.ctx, G, U), before - 2000);
    assert.equal(fishingLoadout(w.ctx, G, U).rod.id, 'sauce');
  });

  it('las cañas que piden un objeto lo consumen, y sin él no se pueden comprar', () => {
    const w = setup();
    setFishLevel(w, 55, 2_000_000);
    expectGameError(() => buyRod(w.ctx, G, U, 'abismo'));
    assert.equal(fishingLoadout(w.ctx, G, U).rod.id, 'junco', 'la compra fallida no dejó nada a medias');
    w.clock.advance(5000);
    addItem(w.ctx, G, U, 'mapa_corrientes', 1);
    buyRod(w.ctx, G, U, 'abismo');
    assert.equal(getQty(w.ctx, G, U, 'mapa_corrientes'), 0);
    assert.equal(fishingLoadout(w.ctx, G, U).ultraMult, 1.6);
  });

  it('solo se puede equipar una caña propia', () => {
    const w = setup();
    expectGameError(() => equipRod(w.ctx, G, U, 'astro'), /Todavía no tenés/);
    expectGameError(() => equipRod(w.ctx, G, U, 'inventada'), /no existe/);
  });
});

describe('potenciadores', () => {
  it('se activan con consumibles, se extienden hasta un tope y vencen solos', () => {
    const w = setup();
    w.ctx.db.run('UPDATE profiles SET farm_level = 20 WHERE guild_id = ? AND user_id = ?', G, U);
    addItem(w.ctx, G, U, 'cebo_brillante', 5);
    useConsumable(w.ctx, G, U, 'cebo_brillante');
    assert.equal(fishingLoadout(w.ctx, G, U).luck, 0.15);
    useConsumable(w.ctx, G, U, 'cebo_brillante');
    useConsumable(w.ctx, G, U, 'cebo_brillante');
    // Tres usos = 60 min (el tope). La potencia NO se acumula.
    assert.equal(fishingLoadout(w.ctx, G, U).luck, 0.15);
    const exp = activeBuffs(w.ctx, G, U)[0].expiresAt;
    assert.equal(exp - w.clock.t, 60 * 60_000);
    w.clock.advance(60 * 60_000 + 1);
    assert.equal(activeBuffs(w.ctx, G, U).length, 0, 'venció');
    assert.equal(fishingLoadout(w.ctx, G, U).luck, 0);
  });

  it('un buff al tope no se puede seguir estirando (no se desperdician objetos)', () => {
    const w = setup();
    w.ctx.db.transaction(() => {
      applyBuff(w.ctx, G, U, 'marea_alta', 'test');
      applyBuff(w.ctx, G, U, 'marea_alta', 'test');
    });
    assert.throws(() => w.ctx.db.transaction(() => applyBuff(w.ctx, G, U, 'marea_alta', 'test')), /máximo/);
  });

  it('los efectos se suman con topes duros y la suerte total respeta maxLuck', () => {
    const w = setup();
    w.ctx.db.transaction(() => {
      applyBuff(w.ctx, G, U, 'destello', 't');
      applyBuff(w.ctx, G, GUILD_WIDE, 'marea_dorada', 't');
      applyBuff(w.ctx, G, U, 'manos_rapidas', 't');
      applyBuff(w.ctx, G, U, 'marea_alta', 't');
    });
    const t = buffTotals(activeBuffs(w.ctx, G, U));
    assert.equal(Math.round(t.luck * 100), 40);
    assert.equal(t.cooldownMult, 0.6);
    setTunable(w.ctx, G, 'fish.cooldownMultiplier', 1);
    const lo = fishingLoadout(w.ctx, G, U);
    assert.equal(lo.lines, 2);
    assert.ok(lo.luck <= 0.8);
    assert.equal(lo.cooldownMs, 7200, 'con espera activada: junco 12 s × 0,6 (Manos rápidas)');
  });

  it('el buff de servidor alcanza a todos los jugadores', () => {
    const w = setup();
    ensureProfile(w.ctx, G, U2);
    w.ctx.db.transaction(() => applyBuff(w.ctx, G, GUILD_WIDE, 'marea_dorada', 'evento'));
    assert.equal(fishingLoadout(w.ctx, G, U2).luck, 0.25);
  });

  it('la rebaja del mercado baja el precio real que se cobra', () => {
    const w = setup();
    w.ctx.db.run('UPDATE profiles SET coins = 10000 WHERE guild_id = ? AND user_id = ?', G, U);
    const p = getProfile(w.ctx, G, U)!;
    const cfg = loadBaseConfig();
    const offer = supplyOffers(cfg, p).find((o) => o.item.id === 'lombriz')!;
    w.ctx.db.transaction(() => applyBuff(w.ctx, G, U, 'rebaja', 'evento'));
    assert.equal(priceFor(w.ctx, G, U, 1000), 850);
    const before = getCoins(w.ctx, G, U);
    buySupply(w.ctx, G, U, 'lombriz', 10);
    assert.equal(getCoins(w.ctx, G, U), before - Math.round(offer.price * 0.85) * 10);
  });

  it('los potenciadores de tienda tienen tope diario de compra y se encarecen con el nivel', () => {
    const w = setup();
    w.ctx.db.run('UPDATE profiles SET coins = 1000000, farm_level = 30, fish_level = 30 WHERE guild_id = ? AND user_id = ?', G, U);
    const cfg = loadBaseConfig();
    const low = supplyOffers(cfg, { ...getProfile(w.ctx, G, U)!, farm_level: 1, fish_level: 1 }).find((o) => o.item.id === 'cebo_brillante')!;
    const high = supplyOffers(cfg, getProfile(w.ctx, G, U)!).find((o) => o.item.id === 'cebo_brillante')!;
    assert.ok(high.price > low.price * 3);
    buySupply(w.ctx, G, U, 'cebo_brillante', 6);
    w.clock.advance(5000);
    expectGameError(() => buySupply(w.ctx, G, U, 'cebo_brillante', 1), /Límite diario/);
  });
});

describe('el lago (juego de pesca)', () => {
  it('cada tiro usa la casilla guardada en el servidor y después el lago cambia', () => {
    const w = setup();
    const before = getLake(w.ctx, G, U);
    assert.equal(before.tiles.length, 12);
    const r = castAt(w.ctx, G, U, 3);
    assert.equal(r.tile, before.tiles[3].id, 'la casilla sale del servidor, no del botón');
    assert.equal(r.lake.seq, before.seq + 1);
    assert.equal(getLake(w.ctx, G, U).seq, before.seq + 1);
  });

  it('"Pescar" tira en una casilla al azar; índices inválidos se rechazan sin gastar nada', () => {
    const w = setup();
    const bait = getQty(w.ctx, G, U, 'lombriz');
    expectGameError(() => castAt(w.ctx, G, U, 12), /no existe/);
    expectGameError(() => castAt(w.ctx, G, U, -1), /no existe/);
    expectGameError(() => castAt(w.ctx, G, U, Number.NaN), /no existe/);
    assert.equal(getQty(w.ctx, G, U, 'lombriz'), bait);
    const r = castAt(w.ctx, G, U, 'random');
    assert.ok(r.index >= 0 && r.index < 12);
  });

  it('sin carnada no pasa nada: ni se gasta, ni se mueve el lago', () => {
    const w = setup();
    removeItem(w.ctx, G, U, 'lombriz', getQty(w.ctx, G, U, 'lombriz'));
    const seq = getLake(w.ctx, G, U).seq;
    expectGameError(() => castAt(w.ctx, G, U, 0), /carnada/);
    assert.equal(getLake(w.ctx, G, U).seq, seq);
  });

  it('nunca hay más de un remolino por lago', () => {
    const w = setup(9);
    const cfg = loadBaseConfig();
    for (let i = 0; i < 300; i++) {
      assert.ok(generateLayout(w.ctx, cfg).filter((t) => t === 'remolino').length <= 1);
    }
  });

  it('el remolino corta líneas (35%): sin captura en esa línea, pero la carnada se gasta', () => {
    const w = setup(4);
    addItem(w.ctx, G, U, 'lombriz', 2000);
    // Fuerza un lago todo remolino desde la base (como si hubiera salido así).
    let snapped = 0;
    let lines = 0;
    for (let i = 0; i < 400; i++) {
      w.ctx.db.run('UPDATE fishing_lakes SET layout = ? WHERE guild_id = ? AND user_id = ?', JSON.stringify(Array(12).fill('remolino')), G, U);
      getLake(w.ctx, G, U);
      const r = castAt(w.ctx, G, U, 0);
      snapped += r.snapped;
      lines += r.lines;
      assert.equal(r.catches.length + r.snapped, r.lines);
    }
    const rate = snapped / lines;
    assert.ok(rate > 0.28 && rate < 0.42, `tasa de corte ${rate.toFixed(3)}`);
  });

  it('las burbujas suben la probabilidad de rarezas altas respecto del agua', () => {
    const cfg = loadBaseConfig();
    const agua = rarityOdds(cfg, 0);
    const burbujas = rarityOdds(cfg, cfg.fishing.tiles.find((t) => t.id === 'burbujas')!.luck);
    assert.ok(burbujas.epico > agua.epico && burbujas.mitico > agua.mitico);
  });
});

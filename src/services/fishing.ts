import { getItem, getRod } from '../game/config';
import type { ChanceDrop, FishDef, GameConfig, LakeTileDef, Rarity, RodDef } from '../game/types';
import { activeBuffs, buffTotals, type ActiveBuff } from './buffs';
import { GameError, weightedPick, type GameContext } from './context';
import { grantReward } from './rewards';
import { gameConfig } from './guildSettings';
import { addItem, getQty, removeItem } from './inventory';
import { recordAction, startAction, type ActionOutcome } from './actions';
import { ensureProfile, getUpgradeLevels, luckBonus, vigorState, type ProfileRow } from './player';
import { addXp, type XpGain } from './progression';

export const RARITY_ORDER: Rarity[] = ['comun', 'poco_comun', 'raro', 'epico', 'legendario', 'mitico'];

// ───────────────────────── Probabilidades (funciones puras) ─────────────────────────

/**
 * Probabilidad de cada rareza para una tirada.
 * peso(r) = base(r) × (1 + suerte × factor(r)); el Ultralegendario además se multiplica por `ultraMult`.
 * Con suerte 0: 60 / 26 / 10 / 3,2 / 0,75 / 0,05 %.
 */
export function rarityOdds(cfg: GameConfig, luck: number, ultraMult = 1): Record<Rarity, number> {
  const f = cfg.fishing;
  const w = {} as Record<Rarity, number>;
  let total = 0;
  for (const r of RARITY_ORDER) {
    w[r] = f.rarityWeights[r] * (1 + luck * f.luckScaling[r]) * (r === 'mitico' ? ultraMult : 1);
    total += w[r];
  }
  for (const r of RARITY_ORDER) w[r] = total > 0 ? w[r] / total : 0;
  return w;
}

/** Peces disponibles para un nivel. Si una rareza no tiene ninguno, se usa la rareza inferior más cercana. */
export function fishPool(cfg: GameConfig, level: number, rarity: Rarity): FishDef[] {
  for (let i = RARITY_ORDER.indexOf(rarity); i >= 0; i--) {
    const pool = cfg.fishing.fish.filter((f) => f.minLevel <= level && getItem(cfg, f.itemId)?.rarity === RARITY_ORDER[i]);
    if (pool.length) return pool;
  }
  throw new Error('fishPool: catálogo de pesca vacío');
}

export function baitPrice(cfg: GameConfig, fishLevel: number): number {
  const f = cfg.tuning.fish;
  return Math.max(1, Math.round((f.baitPriceBase + f.baitPricePerLevel * (fishLevel - 1)) * cfg.tuning.market.buyMultiplier));
}

export function castVigorCost(cfg: GameConfig, lines: number): number {
  return cfg.tuning.fish.vigorPerCast + cfg.tuning.fish.vigorPerLine * lines;
}

/**
 * Valor esperado de UNA tirada (monedas de venta base y XP base), sin saturación de mercado.
 * Lo usan los tests de balance y el informe matemático del README.
 */
export function expectedRoll(cfg: GameConfig, level: number, luck: number, ultraMult = 1): { coins: number; xp: number; odds: Record<Rarity, number> } {
  const odds = rarityOdds(cfg, luck, ultraMult);
  let coins = 0;
  let xp = 0;
  for (const r of RARITY_ORDER) {
    const pool = fishPool(cfg, level, r);
    const tw = pool.reduce((s, f) => s + f.weight, 0);
    for (const f of pool) {
      const p = odds[r] * (f.weight / tw);
      coins += p * (getItem(cfg, f.itemId)?.sellPrice ?? 0);
      xp += p * f.xp;
    }
  }
  return { coins, xp, odds };
}

// ───────────────────────── Cañas ─────────────────────────

export function ownedRodIds(ctx: GameContext, guildId: string, userId: string): Set<string> {
  const cfg = gameConfig(ctx, guildId);
  const ids = new Set(cfg.fishing.rods.filter((r) => r.price === 0 && r.requires.length === 0).map((r) => r.id));
  for (const row of ctx.db.all<{ rod_id: string }>('SELECT rod_id FROM rods_owned WHERE guild_id = ? AND user_id = ?', guildId, userId)) {
    if (getRod(cfg, row.rod_id)) ids.add(row.rod_id);
  }
  return ids;
}

export function currentRod(cfg: GameConfig, p: ProfileRow, owned: Set<string>): RodDef {
  const rod = getRod(cfg, p.rod_id);
  return rod && owned.has(rod.id) ? rod : cfg.fishing.rods[0];
}

export function equipRod(ctx: GameContext, guildId: string, userId: string, rodId: string): RodDef {
  return ctx.db.transaction(() => {
    ensureProfile(ctx, guildId, userId);
    const cfg = gameConfig(ctx, guildId);
    const rod = getRod(cfg, rodId);
    if (!rod) throw new GameError('Esa caña no existe.');
    if (!ownedRodIds(ctx, guildId, userId).has(rod.id)) throw new GameError(`Todavía no tenés ${rod.emoji} ${rod.name}.`);
    ctx.db.run('UPDATE profiles SET rod_id = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?', rod.id, ctx.now(), guildId, userId);
    return rod;
  });
}

// ───────────────────────── Equipamiento efectivo ─────────────────────────

export interface FishingLoadout {
  rod: RodDef;
  lines: number;
  luck: number;
  baitSave: number;
  cooldownMs: number;
  xpMult: number;
  ultraMult: number;
  echoChance: number;
  buffs: ActiveBuff[];
}

/** Caña + mejora "Buena estrella" + potenciadores, con todos los topes aplicados. */
export function fishingLoadout(ctx: GameContext, guildId: string, userId: string, p?: ProfileRow): FishingLoadout {
  const cfg = gameConfig(ctx, guildId);
  const profile = p ?? ensureProfile(ctx, guildId, userId);
  const t = cfg.tuning.fish;
  const rod = currentRod(cfg, profile, ownedRodIds(ctx, guildId, userId));
  const buffs = activeBuffs(ctx, guildId, userId);
  const b = buffTotals(buffs);
  const luck = Math.min(t.maxLuck, (rod.luck + luckBonus(cfg, getUpgradeLevels(ctx, guildId, userId)) + b.luck) * t.luckMultiplier);
  return {
    rod,
    lines: Math.max(1, Math.min(t.maxLines, rod.lines + b.extraLines)),
    luck: Math.max(0, luck),
    baitSave: Math.min(0.6, rod.baitSave + b.baitSave),
    cooldownMs: Math.round(Math.max(t.minCooldownSeconds, rod.cooldownSeconds * t.cooldownMultiplier * b.cooldownMult) * 1000),
    xpMult: t.xpMultiplier * (1 + b.xpMult),
    ultraMult: rod.special?.kind === 'abismo' ? rod.special.ultraMult : 1,
    echoChance: rod.special?.kind === 'eco' ? rod.special.chance : 0,
    buffs,
  };
}

// ───────────────────────── Pescar ─────────────────────────

export interface CatchResult {
  itemId: string;
  rarity: Rarity;
  weight: number;
  xp: number;
  newSpecies: boolean;
  newRecord: boolean;
  /** Garantizado por la racha de la suerte. */
  pity: boolean;
  /** La caña trajo un segundo ejemplar (efecto eco). */
  echo: boolean;
}

export interface FishResult {
  outcome: ActionOutcome;
  /** Líneas cortadas por un remolino. */
  snapped: number;
  /** Casilla del lago donde se tiró (null = pesca sin lago, p. ej. desde la Actividad). */
  tile: string | null;
  lines: number;
  /** Líneas que permitía la caña (si hubo menos carnada o vigor, se tiraron menos). */
  wantedLines: number;
  baitUsed: number;
  baitSaved: number;
  baitLeft: number;
  vigorSpent: number;
  catches: CatchResult[];
  extras: { itemId: string; qty: number }[];
  gain: XpGain;
  collections: { rarity: Rarity; coins: number }[];
  pity: number;
  readyAt: number;
  rod: RodDef;
}

function rollKg(ctx: GameContext, f: FishDef): number {
  // Sesgo hacia pesos bajos: los ejemplares enormes son raros.
  const r = Math.pow(ctx.rng(), 1.8);
  return Math.round((f.minKg + (f.maxKg - f.minKg) * r) * 100) / 100;
}

function rollExtra(ctx: GameContext, cfg: GameConfig, d: ChanceDrop, luck: number): boolean {
  const rank = cfg.rarities[getItem(cfg, d.itemId)!.rarity].rank;
  return ctx.rng() < d.chance * (rank >= 2 ? 1 + luck : 1);
}

/**
 * Un "Pescar": tira tantas líneas como permita la caña (y los buffs), limitado por la carnada
 * y el vigor disponibles. Cada línea gasta 1 carnada (salvo ahorro) y hace una tirada de rareza.
 * Todo ocurre en una transacción: la espera se reserva primero, así que dos clics simultáneos
 * no pueden pescar dos veces.
 */
export function fish(ctx: GameContext, guildId: string, userId: string): FishResult {
  return ctx.db.transaction(() => fishWith(ctx, guildId, userId, null));
}

/** Pesca con los modificadores de una casilla del lago (o sin casilla). Debe correr dentro de una transacción. */
function fishWith(ctx: GameContext, guildId: string, userId: string, tile: LakeTileDef | null): FishResult {
  {
    const p = ensureProfile(ctx, guildId, userId);
    const cfg = gameConfig(ctx, guildId);
    const t = cfg.tuning.fish;
    const lo = fishingLoadout(ctx, guildId, userId, p);
    if (tile) {
      // La casilla suma su suerte DESPUÉS del tope normal: por eso el remolino vale el riesgo.
      lo.luck = Math.max(0, lo.luck + tile.luck);
      lo.ultraMult *= tile.ultraMult ?? 1;
      lo.xpMult *= tile.xpMult ?? 1;
    }
    const baitId = cfg.fishing.baitItemId;
    const bait = getQty(ctx, guildId, userId, baitId);
    if (bait < 1) {
      throw new GameError('Te quedaste sin carnada 🪱. Conseguila farmeando, en el Mercado (Suministros) o ganando eventos.');
    }

    // Líneas: caña/buffs → limitadas por carnada → limitadas por vigor (mínimo 1).
    const vigor = vigorState(cfg, p, getUpgradeLevels(ctx, guildId, userId), ctx.now()).current;
    const byVigor = t.vigorPerLine > 0 ? Math.floor((vigor + 1e-9 - t.vigorPerCast) / t.vigorPerLine) : lo.lines;
    const lines = Math.max(1, Math.min(lo.lines, bait, byVigor));
    const vigorCost = castVigorCost(cfg, lines);

    // Sin espera ni vigor por defecto (se configuran en /ajustes → Pesca si se quieren volver a usar).
    const fatigueMult = lo.cooldownMs > 0 || vigorCost > 0
      ? startAction(ctx, p, { cooldownKey: 'fish', cooldownMs: lo.cooldownMs, cooldownLabel: 'La próxima pesca', vigor: vigorCost })
      : 1;

    const odds = rarityOdds(cfg, lo.luck, lo.ultraMult);
    const log = getFishLog(ctx, guildId, userId);
    const catches: CatchResult[] = [];
    let pity = p.fish_pity;
    let baitUsed = 0;
    let xpTotal = 0;

    let snapped = 0;
    for (let i = 0; i < lines; i++) {
      if (ctx.rng() >= lo.baitSave) baitUsed++;
      // Remolino: la línea puede cortarse (se pierde la carnada de esa línea y la captura).
      if (tile?.snapChance && ctx.rng() < tile.snapChance) {
        snapped++;
        continue;
      }

      const forced = t.pityThreshold > 0 && pity >= t.pityThreshold;
      const rarity = forced ? 'epico' : weightedPick(ctx.rng, RARITY_ORDER, (r) => odds[r]);
      const pool = fishPool(cfg, p.fish_level, rarity);
      const def = weightedPick(ctx.rng, pool, (f) => f.weight);
      const realRarity = getItem(cfg, def.itemId)!.rarity;
      pity = cfg.rarities[realRarity].rank >= 3 ? 0 : pity + 1;

      const kg = rollKg(ctx, def);
      const prev = log.get(def.itemId);
      const echo = lo.echoChance > 0 && ctx.rng() < lo.echoChance;
      const qty = echo ? 2 : 1;
      addItem(ctx, guildId, userId, def.itemId, qty);
      ctx.db.run(
        `INSERT INTO fish_log (guild_id, user_id, fish_id, caught, best_weight, first_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, user_id, fish_id) DO UPDATE SET caught = caught + excluded.caught, best_weight = MAX(best_weight, excluded.best_weight)`,
        guildId, userId, def.itemId, qty, kg, ctx.now(),
      );
      log.set(def.itemId, { caught: (prev?.caught ?? 0) + qty, best: Math.max(prev?.best ?? 0, kg) });
      xpTotal += def.xp * qty;
      catches.push({
        itemId: def.itemId, rarity: realRarity, weight: kg, xp: def.xp * qty,
        newSpecies: !prev, newRecord: !!prev && kg > prev.best, pity: forced, echo,
      });
    }

    if (baitUsed > 0) removeItem(ctx, guildId, userId, baitId, baitUsed);

    const extras: { itemId: string; qty: number }[] = [];
    for (const d of [...cfg.fishing.extraDrops, ...(tile?.extraDrops ?? [])]) {
      if (rollExtra(ctx, cfg, d, lo.luck)) {
        addItem(ctx, guildId, userId, d.itemId, 1);
        extras.push({ itemId: d.itemId, qty: 1 });
      }
    }

    const gain = addXp(ctx, p, 'pesca', xpTotal * lo.xpMult * fatigueMult);
    ctx.db.run('UPDATE profiles SET catches_total = catches_total + ?, fish_pity = ? WHERE guild_id = ? AND user_id = ?',
      catches.length, pity, guildId, userId);

    // Colecciones: premio único por registrar todas las especies de una rareza.
    const collections: { rarity: Rarity; coins: number }[] = [];
    for (const rarity of new Set(catches.filter((c) => c.newSpecies).map((c) => c.rarity))) {
      const all = cfg.fishing.fish.filter((f) => getItem(cfg, f.itemId)?.rarity === rarity);
      if (!all.every((f) => log.has(f.itemId))) continue;
      const r = ctx.db.run('INSERT OR IGNORE INTO milestones (guild_id, user_id, milestone_id, claimed_at) VALUES (?, ?, ?, ?)',
        guildId, userId, `coleccion:${rarity}`, ctx.now());
      const coins = cfg.fishing.collectionRewards[rarity] ?? 0;
      if (r.changes === 1 && coins > 0) {
        grantReward(ctx, guildId, userId, { coins }, `colección completa: ${rarity}`);
        collections.push({ rarity, coins });
      }
    }

    const rank = (c: CatchResult) => cfg.rarities[c.rarity].rank;
    const count = (min: number) => catches.filter((c) => rank(c) >= min).reduce((n, c) => n + (c.echo ? 2 : 1), 0);
    const outcome = recordAction(ctx, guildId, userId, 'fish', {
      stats: { 'stat:rare_caught': count(2), 'stat:epic_caught': count(3), 'stat:legend_caught': count(4), 'stat:ultra_caught': count(5) },
    });

    return {
      outcome, snapped, tile: tile?.id ?? null, lines, wantedLines: lo.lines, baitUsed, baitSaved: lines - baitUsed, baitLeft: bait - baitUsed,
      vigorSpent: vigorCost, catches, extras, gain, collections, pity, readyAt: ctx.now() + lo.cooldownMs, rod: lo.rod,
    };
  }
}

// ───────────────────────── El lago (juego de pesca) ─────────────────────────

export interface LakeState {
  tiles: LakeTileDef[];
  seq: number;
}

/** Arma un lago nuevo al azar respetando el máximo por lago de cada tipo de casilla. */
export function generateLayout(ctx: GameContext, cfg: GameConfig): string[] {
  const counts = new Map<string, number>();
  const out: string[] = [];
  for (let i = 0; i < cfg.fishing.lakeSize; i++) {
    const allowed = cfg.fishing.tiles.filter((t) => !t.maxPerLake || (counts.get(t.id) ?? 0) < t.maxPerLake);
    const t = weightedPick(ctx.rng, allowed, (x) => x.weight);
    counts.set(t.id, (counts.get(t.id) ?? 0) + 1);
    out.push(t.id);
  }
  return out;
}

function saveLake(ctx: GameContext, guildId: string, userId: string, layout: string[], seq: number): void {
  ctx.db.run(
    `INSERT INTO fishing_lakes (guild_id, user_id, layout, seq, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET layout = excluded.layout, seq = excluded.seq, updated_at = excluded.updated_at`,
    guildId, userId, JSON.stringify(layout), seq, ctx.now(),
  );
}

/** El lago actual del jugador (se crea si no existe o si la configuración de casillas cambió). */
export function getLake(ctx: GameContext, guildId: string, userId: string): LakeState {
  const cfg = gameConfig(ctx, guildId);
  const byId = new Map(cfg.fishing.tiles.map((t) => [t.id, t]));
  const row = ctx.db.get<{ layout: string; seq: number }>('SELECT layout, seq FROM fishing_lakes WHERE guild_id = ? AND user_id = ?', guildId, userId);
  let layout: string[] | null = null;
  try {
    layout = row ? (JSON.parse(row.layout) as string[]) : null;
  } catch {
    layout = null;
  }
  if (!layout || layout.length !== cfg.fishing.lakeSize || layout.some((id) => !byId.has(id))) {
    layout = generateLayout(ctx, cfg);
    saveLake(ctx, guildId, userId, layout, (row?.seq ?? 0) + 1);
    return { tiles: layout.map((id) => byId.get(id)!), seq: (row?.seq ?? 0) + 1 };
  }
  return { tiles: layout.map((id) => byId.get(id)!), seq: row!.seq };
}

export interface CastResult extends FishResult {
  index: number;
  lake: LakeState;
}

/**
 * Tira en una casilla del lago (o en una al azar). La casilla se lee del servidor: un botón
 * modificado no puede inventarse un remolino. Después de cada tiro los peces se mueven (lago nuevo).
 * Todo en una transacción: sin carnada no cambia nada.
 */
export function castAt(ctx: GameContext, guildId: string, userId: string, index: number | 'random'): CastResult {
  return ctx.db.transaction(() => {
    ensureProfile(ctx, guildId, userId);
    const cfg = gameConfig(ctx, guildId);
    const lake = getLake(ctx, guildId, userId);
    const i = index === 'random' ? Math.floor(ctx.rng() * lake.tiles.length) : index;
    if (!Number.isInteger(i) || i < 0 || i >= lake.tiles.length) throw new GameError('Esa casilla no existe.');
    const r = fishWith(ctx, guildId, userId, lake.tiles[i]);
    const layout = generateLayout(ctx, cfg);
    saveLake(ctx, guildId, userId, layout, lake.seq + 1);
    const byId = new Map(cfg.fishing.tiles.map((t) => [t.id, t]));
    return { ...r, index: i, lake: { tiles: layout.map((id) => byId.get(id)!), seq: lake.seq + 1 } };
  });
}

// ───────────────────────── Colección ─────────────────────────

export function getFishLog(ctx: GameContext, guildId: string, userId: string): Map<string, { caught: number; best: number }> {
  const rows = ctx.db.all<{ fish_id: string; caught: number; best_weight: number }>(
    'SELECT fish_id, caught, best_weight FROM fish_log WHERE guild_id = ? AND user_id = ?', guildId, userId,
  );
  return new Map(rows.map((r) => [r.fish_id, { caught: r.caught, best: r.best_weight }]));
}

export interface CollectionProgress {
  rarity: Rarity;
  found: number;
  total: number;
  reward: number;
  claimed: boolean;
}

export function collectionProgress(ctx: GameContext, guildId: string, userId: string): CollectionProgress[] {
  const cfg = gameConfig(ctx, guildId);
  const log = getFishLog(ctx, guildId, userId);
  const claimed = new Set(ctx.db.all<{ milestone_id: string }>(
    "SELECT milestone_id FROM milestones WHERE guild_id = ? AND user_id = ? AND milestone_id LIKE 'coleccion:%'", guildId, userId,
  ).map((r) => r.milestone_id));
  return RARITY_ORDER.map((rarity) => {
    const all = cfg.fishing.fish.filter((f) => getItem(cfg, f.itemId)?.rarity === rarity);
    return {
      rarity,
      found: all.filter((f) => log.has(f.itemId)).length,
      total: all.length,
      reward: cfg.fishing.collectionRewards[rarity] ?? 0,
      claimed: claimed.has(`coleccion:${rarity}`),
    };
  });
}

import { getEquipLine, getItem, getZone } from '../game/config';
import type { FarmZone } from '../game/types';
import { GameError, randInt, stochasticRound, weightedPick, type GameContext } from './context';
import { gameConfig } from './guildSettings';
import { addItem } from './inventory';
import { recordAction, startAction, type ActionOutcome } from './actions';
import {
  ensureProfile, equipStats, getEquipTiers, getProfile, getUpgradeLevels, isUnlocked, luckBonus, vigorState,
} from './player';
import { addXp, levelGapMultiplier, type XpGain } from './progression';

export interface Drop {
  itemId: string;
  qty: number;
  /** true si es un hallazgo especial (rareza rara o superior). */
  special: boolean;
}

export interface FarmResult {
  outcome: ActionOutcome;
  zone: FarmZone;
  drops: Drop[];
  golden: boolean;
  fertilized: boolean;
  fatigueMult: number;
  vigorCost: number;
  vigorLeft: number;
  gain: XpGain;
}

export interface LastFarm {
  at: number;
  zoneId: string;
  drops: Drop[];
  golden: boolean;
  fertilized: boolean;
  xp: number;
  fatigueMult: number;
}

/** Costo de vigor real de una zona para este jugador (aplica descuentos del equipo). */
export function farmVigorCost(zone: FarmZone, vigorDiscount: number): number {
  return Math.max(1, Math.ceil(zone.vigorCost * (1 - vigorDiscount)));
}

/**
 * La acción principal: "Farmear". Todo ocurre en una única transacción:
 * validación → cooldown → vigor → tiradas → inventario → XP. Si algo falla, no se aplica nada.
 */
export function farm(ctx: GameContext, guildId: string, userId: string): FarmResult {
  return ctx.db.transaction(() => {
    const p = ensureProfile(ctx, guildId, userId);
    const cfg = gameConfig(ctx, guildId);
    const zone = getZone(cfg, p.farm_zone) ?? cfg.farming.zones[0];
    if (!isUnlocked(ctx, guildId, userId, 'zona', zone.id)) {
      throw new GameError(`Todavía no tenés el permiso para ${zone.emoji} ${zone.name}.`);
    }
    const tiers = getEquipTiers(ctx, guildId, userId);
    if (tiers.herramienta < zone.minToolTier) {
      const needed = getEquipLine(cfg, 'herramienta').tiers[zone.minToolTier];
      throw new GameError(`${zone.name} requiere al menos ${needed.emoji} ${needed.name}.`);
    }

    const levels = getUpgradeLevels(ctx, guildId, userId);
    const stats = equipStats(cfg, tiers, ['herramienta', 'accesorio']);
    const vigorCost = farmVigorCost(zone, stats.vigorDiscount);
    const fatigueMult = startAction(ctx, p, {
      cooldownKey: 'farm', cooldownMs: cfg.tuning.farm.cooldownSeconds * 1000, cooldownLabel: 'La próxima cosecha', vigor: vigorCost,
    });
    const vigorLeft = vigorState(cfg, getProfile(ctx, guildId, userId)!, levels, ctx.now()).current;

    const golden = ctx.rng() < cfg.tuning.farm.goldenChance;
    const fertilized = p.fertilizer > 0;
    const yieldMult = stats.yieldMult * cfg.tuning.farm.yieldMultiplier * fatigueMult
      * (fertilized ? 1 + cfg.tuning.farm.fertilizerBonus : 1) * (golden ? 2 : 1);

    const totals = new Map<string, number>();
    const add = (id: string, q: number) => q > 0 && totals.set(id, (totals.get(id) ?? 0) + q);

    const rolls = zone.rolls + stats.extraRolls;
    for (let i = 0; i < rolls; i++) {
      const crop = weightedPick(ctx.rng, zone.crops, (c) => c.weight);
      add(crop.itemId, stochasticRound(ctx.rng, randInt(ctx.rng, crop.min, crop.max) * yieldMult));
    }

    const rareMult = cfg.tuning.farm.rareMultiplier * (1 + stats.rareBonus + luckBonus(cfg, levels)) * fatigueMult;
    for (const r of zone.rareDrops) {
      const item = getItem(cfg, r.itemId)!;
      const rank = cfg.rarities[item.rarity].rank;
      const chance = rank > 0 ? r.chance * rareMult : r.chance;
      if (ctx.rng() < chance) add(r.itemId, golden && rank === 0 ? 2 : 1);
    }

    const drops: Drop[] = [...totals.entries()].map(([itemId, qty]) => {
      addItem(ctx, guildId, userId, itemId, qty);
      return { itemId, qty, special: cfg.rarities[getItem(cfg, itemId)!.rarity].rank >= 2 };
    });

    if (fertilized) {
      ctx.db.run('UPDATE profiles SET fertilizer = fertilizer - 1 WHERE guild_id = ? AND user_id = ? AND fertilizer > 0', guildId, userId);
    }

    const xp = zone.baseXp * levelGapMultiplier(cfg, p.farm_level, zone.level) * fatigueMult
      * cfg.tuning.farm.xpMultiplier * (golden ? 2 : 1);
    const gain = addXp(ctx, p, 'granja', xp);

    const last: LastFarm = { at: ctx.now(), zoneId: zone.id, drops, golden, fertilized, xp: gain.amount, fatigueMult };
    ctx.db.run('UPDATE profiles SET farms_total = farms_total + 1, last_farm_json = ? WHERE guild_id = ? AND user_id = ?',
      JSON.stringify(last), guildId, userId);

    const outcome = recordAction(ctx, guildId, userId, 'farm', { stats: golden ? { 'stat:golden_harvests': 1 } : undefined });
    return { zone, drops, golden, fertilized, fatigueMult, vigorCost, vigorLeft, gain, outcome };
  });
}

export function setFarmZone(ctx: GameContext, guildId: string, userId: string, zoneId: string): FarmZone {
  const cfg = gameConfig(ctx, guildId);
  const zone = getZone(cfg, zoneId);
  if (!zone) throw new GameError('Esa zona no existe.');
  ensureProfile(ctx, guildId, userId);
  if (!isUnlocked(ctx, guildId, userId, 'zona', zone.id)) {
    throw new GameError(`${zone.emoji} ${zone.name} está bloqueada. Conseguí el permiso en el Mercado → Permisos.`);
  }
  ctx.db.run('UPDATE profiles SET farm_zone = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?', zone.id, ctx.now(), guildId, userId);
  return zone;
}

export function parseLastFarm(raw: string | null): LastFarm | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LastFarm;
  } catch {
    return null;
  }
}

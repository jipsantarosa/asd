import { getEquipLine, getItem, getZone } from '../game/config';
import type { GameConfig, ItemDef } from '../game/types';
import type { GameContext } from '../services/context';
import { farmVigorCost, parseLastFarm, type FarmResult } from '../services/farming';
import { gameConfig } from '../services/guildSettings';
import { listInventory } from '../services/inventory';
import { buyPrice } from '../services/market';
import { getReadyAt } from '../services/limits';
import {
  currentFatigue, ensureProfile, equipStats, fatigueMultiplier, getEquipTiers, getUpgradeLevels, isUnlocked, totalLevel, vigorState,
} from '../services/player';
import { xpToNext } from '../services/progression';
import type { DropView, FarmState, HarvestEvent, ZoneView } from './types';

export type { DropView, FarmState, HarvestEvent, ZoneView } from './types';

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

export function dropView(cfg: GameConfig, itemId: string, qty: number, special: boolean): DropView {
  const it: ItemDef | undefined = getItem(cfg, itemId);
  const rarity = it ? cfg.rarities[it.rarity] : cfg.rarities.comun;
  return {
    id: itemId,
    name: it?.name ?? itemId,
    emoji: it?.emoji ?? '❔',
    qty,
    rarity: it?.rarity ?? 'comun',
    rarityLabel: rarity.label,
    color: hex(rarity.color),
    special,
  };
}

export function harvestEvent(cfg: GameConfig, r: FarmResult): HarvestEvent {
  return {
    drops: r.drops.map((d) => dropView(cfg, d.itemId, d.qty, d.special)),
    golden: r.golden,
    fertilized: r.fertilized,
    xp: r.gain.amount,
    fatigueMult: r.fatigueMult,
    levelUp: r.gain.levelUp ? { to: r.gain.levelUp.to, coins: r.gain.levelUp.coins, reachedMax: r.gain.levelUp.reachedMax } : null,
    achievements: r.outcome.achievements.map((a) => ({ name: a.def.name, emoji: a.def.emoji, badge: `badges/${a.def.id}.png` })),
    activity: r.outcome.activity,
  };
}

export function buildFarmState(ctx: GameContext, guildId: string, userId: string): FarmState {
  const p = ensureProfile(ctx, guildId, userId);
  const cfg = gameConfig(ctx, guildId);
  const now = ctx.now();
  const tiers = getEquipTiers(ctx, guildId, userId);
  const stats = equipStats(cfg, tiers, ['herramienta', 'accesorio']);
  const vigor = vigorState(cfg, p, getUpgradeLevels(ctx, guildId, userId), now);
  const currentZone = getZone(cfg, p.farm_zone) ?? cfg.farming.zones[0];
  const toolLine = getEquipLine(cfg, 'herramienta');
  const maxLevel = cfg.tuning.progression.maxLevel;
  const fatigueMult = fatigueMultiplier(cfg, currentFatigue(cfg, p, now));

  const inventory = listInventory(ctx, guildId, userId);
  const zones: ZoneView[] = cfg.farming.zones.map((z) => {
    const unlocked = isUnlocked(ctx, guildId, userId, 'zona', z.id);
    const tool = toolLine.tiers[z.minToolTier];
    const requirements = unlocked ? [] : [
      { label: `Granja nivel ${z.level}`, ok: p.farm_level >= z.level },
      { label: `${tool.emoji} ${tool.name}`, ok: tiers.herramienta >= z.minToolTier },
      ...(z.unlockCost ? [{ label: `${cfg.currency.emoji} ${buyPrice(cfg, z.unlockCost).toLocaleString('es-AR')}`, ok: p.coins >= buyPrice(cfg, z.unlockCost) }] : []),
      ...z.unlockItems.map((c) => {
        const it = getItem(cfg, c.itemId);
        const have = inventory.find((r) => r.item_id === c.itemId)?.quantity ?? 0;
        return { label: `${it?.emoji ?? ''} ${it?.name ?? c.itemId} ×${c.qty}`, ok: have >= c.qty };
      }),
    ];
    return {
      id: z.id,
      name: z.name,
      emoji: z.emoji,
      description: z.description,
      level: z.level,
      vigorCost: farmVigorCost(z, stats.vigorDiscount),
      baseXp: z.baseXp,
      unlocked,
      current: z.id === currentZone.id,
      requirements,
      crops: z.crops.map((c) => getItem(cfg, c.itemId)).filter((x): x is ItemDef => !!x).map((x) => ({ name: x.name, emoji: x.emoji })),
    };
  });

  const barn = inventory
    .map((r) => ({ r, it: getItem(cfg, r.item_id) }))
    .filter((x): x is { r: typeof x.r; it: ItemDef } => !!x.it && (x.it.category === 'cultivo' || x.it.category === 'reliquia'))
    .sort((a, b) => cfg.rarities[b.it.rarity].rank - cfg.rarities[a.it.rarity].rank || b.r.quantity - a.r.quantity)
    .map(({ r, it }) => ({ id: it.id, name: it.name, emoji: it.emoji, qty: r.quantity, color: hex(cfg.rarities[it.rarity].color) }));

  const consumables = inventory
    .map((r) => ({ r, def: cfg.consumables.find((c) => c.itemId === r.item_id), it: getItem(cfg, r.item_id) }))
    .filter((x) => x.def && x.it)
    .map(({ r, def, it }) => ({
      id: it!.id,
      name: it!.name,
      emoji: it!.emoji,
      qty: r.quantity,
      effect: def!.effect.type === 'vigor' ? `+${def!.effect.amount} vigor`
        : def!.effect.type === 'abono' ? `+${def!.effect.charges} cosechas abonadas`
          : cfg.buffs.find((b) => b.id === (def!.effect as { buffId: string }).buffId)?.description ?? 'Potenciador',
      limit: def!.dailyUseLimit,
    }));

  const last = parseLastFarm(p.last_farm_json);
  const fatigueLabel = fatigueMult >= 1 ? 'Descansado' : fatigueMult > 0.7 ? 'Cansado' : 'Agotado';

  return {
    serverNow: now,
    currency: { ...cfg.currency },
    player: {
      coins: p.coins,
      level: p.farm_level,
      xp: p.farm_xp,
      need: p.farm_level >= maxLevel ? 0 : xpToNext(cfg, p.farm_level),
      maxLevel,
      atMax: p.farm_level >= maxLevel,
      totalLevel: totalLevel(p),
      farmsTotal: p.farms_total,
    },
    vigor: { current: vigor.current, max: vigor.max, regenMs: vigor.regenMs, cost: farmVigorCost(currentZone, stats.vigorDiscount) },
    readyAt: getReadyAt(ctx, guildId, userId, 'farm'),
    cooldownMs: cfg.tuning.farm.cooldownSeconds * 1000,
    fatigue: { multiplier: fatigueMult, label: fatigueLabel },
    fertilizer: p.fertilizer,
    zone: zones.find((z) => z.current)!,
    zones,
    equipment: (['herramienta', 'accesorio'] as const).map((slot) => {
      const t = getEquipLine(cfg, slot).tiers[tiers[slot]];
      return { slot: getEquipLine(cfg, slot).label, name: t.name, emoji: t.emoji };
    }),
    bonuses: { yield: stats.yieldMult, vigorDiscount: stats.vigorDiscount },
    toolOk: tiers.herramienta >= currentZone.minToolTier,
    barn,
    consumables,
    last: last ? { at: last.at, drops: last.drops.map((d) => dropView(cfg, d.itemId, d.qty, d.special)), golden: last.golden, fertilized: last.fertilized, xp: last.xp } : null,
  };
}

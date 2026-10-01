import { getEquipLine, getItem, getRod, requireItem } from '../game/config';
import type { ConsumableDef, EquipSlot, EquipTier, GameConfig, ItemDef, RodDef, UpgradeDef } from '../game/types';
import { shopDiscount } from './buffs';
import { baitPrice, ownedRodIds } from './fishing';
import { GameError, fmt, type GameContext } from './context';
import { addCoins } from './economy';
import { gameConfig } from './guildSettings';
import { addItem, getQty, listInventory, removeItem } from './inventory';
import { consumeCooldown, consumeDaily } from './limits';
import { recordAction, type ActionOutcome } from './actions';
import {
  ensureProfile, getEquipTiers, getUpgradeLevels, isUnlocked, sellBonus, totalLevel, unlockTarget,
  type ProfileRow, type UnlockKind, type UpgradeId,
} from './player';

export const MAX_TRADE_QTY = 9999;

export function buyPrice(cfg: GameConfig, base: number): number {
  return Math.max(1, Math.round(base * cfg.tuning.market.buyMultiplier));
}

/** Precio final para un jugador: aplica la "Rebaja del mercado" si la tiene activa. */
export function priceFor(ctx: GameContext, guildId: string, userId: string, price: number): number {
  const { discount } = shopDiscount(ctx, guildId, userId);
  return discount > 0 ? Math.max(1, Math.round(price * (1 - discount))) : price;
}

// ───────────────────────── Equipo (líneas de mejora) ─────────────────────────

export function nextTier(cfg: GameConfig, slot: EquipSlot, current: number): EquipTier | undefined {
  return getEquipLine(cfg, slot).tiers[current + 1];
}

export function buyEquipment(ctx: GameContext, guildId: string, userId: string, slot: EquipSlot): EquipTier {
  return ctx.db.transaction(() => {
    const p = ensureProfile(ctx, guildId, userId);
    const cfg = gameConfig(ctx, guildId);
    const current = getEquipTiers(ctx, guildId, userId)[slot];
    const next = nextTier(cfg, slot, current);
    if (!next) throw new GameError('Ya tenés el mejor equipo de esa línea.');
    const level = next.skill === 'granja' ? p.farm_level : p.fish_level;
    if (level < next.level) throw new GameError(`${next.emoji} ${next.name} requiere nivel de ${next.skill} ${next.level}.`);
    consumeCooldown(ctx, guildId, userId, 'buy', 1200, 'La próxima compra');

    // Update condicional sobre el tier anterior: un doble clic no puede comprar dos veces.
    const r = ctx.db.run(
      `INSERT INTO equipment (guild_id, user_id, slot, tier) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id, slot) DO UPDATE SET tier = excluded.tier WHERE equipment.tier = ?`,
      guildId, userId, slot, next.tier, current,
    );
    if (r.changes !== 1) throw new GameError('Esa mejora ya se procesó.');
    addCoins(ctx, guildId, userId, -priceFor(ctx, guildId, userId, buyPrice(cfg, next.price)), `equipo ${slot} t${next.tier}`);
    return next;
  });
}

// ───────────────────────── Suministros (carnada, potenciadores y consumibles) ─────────────────────────

export interface SupplyOffer {
  item: ItemDef;
  /** Precio unitario antes de descuentos. */
  price: number;
  requirement: { kind: 'total' | 'pesca'; level: number };
  kind: 'carnada' | 'potenciador' | 'consumible';
  /** Compras máximas por día (null = sin límite). */
  dailyLimit: number | null;
}

/** Precio de un consumible: los potenciadores se encarecen con el nivel total. */
export function consumablePrice(cfg: GameConfig, def: ConsumableDef, p: ProfileRow): number {
  return buyPrice(cfg, Math.round((def.buyPrice ?? 0) * (1 + (def.levelScaling ?? 0) * totalLevel(p))));
}

export function supplyOffers(cfg: GameConfig, p: ProfileRow): SupplyOffer[] {
  const out: SupplyOffer[] = [
    { item: requireItem(cfg, cfg.fishing.baitItemId), price: baitPrice(cfg, p.fish_level), requirement: { kind: 'pesca', level: 1 }, kind: 'carnada', dailyLimit: null },
  ];
  for (const c of cfg.consumables) {
    if (c.buyPrice === null) continue;
    out.push({
      item: requireItem(cfg, c.itemId),
      price: consumablePrice(cfg, c, p),
      requirement: { kind: 'total', level: c.minTotalLevel },
      kind: c.effect.type === 'buff' ? 'potenciador' : 'consumible',
      // Los potenciadores tampoco se pueden acaparar: se compran como mucho el doble de su uso diario.
      dailyLimit: c.effect.type === 'buff' && c.dailyUseLimit !== null ? c.dailyUseLimit * 2 : null,
    });
  }
  return out;
}

export function buySupply(ctx: GameContext, guildId: string, userId: string, itemId: string, qty: number): { offer: SupplyOffer; qty: number; cost: number } {
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_TRADE_QTY) throw new GameError(`La cantidad debe estar entre 1 y ${MAX_TRADE_QTY}.`);
  return ctx.db.transaction(() => {
    const p = ensureProfile(ctx, guildId, userId);
    const cfg = gameConfig(ctx, guildId);
    const offer = supplyOffers(cfg, p).find((o) => o.item.id === itemId);
    if (!offer) throw new GameError('Ese artículo no está a la venta.');
    const lvl = offer.requirement.kind === 'pesca' ? p.fish_level : totalLevel(p);
    if (lvl < offer.requirement.level) {
      throw new GameError(`Requiere nivel ${offer.requirement.kind === 'pesca' ? 'de pesca' : 'total'} ${offer.requirement.level}.`);
    }
    if (offer.dailyLimit !== null) consumeDaily(ctx, guildId, userId, `compra:${itemId}`, offer.dailyLimit, qty, `compras de ${offer.item.name}`);
    consumeCooldown(ctx, guildId, userId, 'buy', 1200, 'La próxima compra');
    const cost = priceFor(ctx, guildId, userId, offer.price) * qty;
    addCoins(ctx, guildId, userId, -cost, `compra ${qty}x ${itemId}`);
    addItem(ctx, guildId, userId, itemId, qty);
    return { offer, qty, cost };
  });
}

// ───────────────────────── Cañas de pescar ─────────────────────────

export function buyRod(ctx: GameContext, guildId: string, userId: string, rodId: string): RodDef {
  return ctx.db.transaction(() => {
    const p = ensureProfile(ctx, guildId, userId);
    const cfg = gameConfig(ctx, guildId);
    const rod = getRod(cfg, rodId);
    if (!rod) throw new GameError('Esa caña no existe.');
    if (ownedRodIds(ctx, guildId, userId).has(rod.id)) throw new GameError(`Ya tenés ${rod.emoji} ${rod.name}.`);
    if (p.fish_level < rod.fishLevel) throw new GameError(`${rod.emoji} ${rod.name} requiere nivel de pesca ${rod.fishLevel}.`);
    consumeCooldown(ctx, guildId, userId, 'buy', 1200, 'La próxima compra');
    // INSERT OR IGNORE + comprobación: un doble clic nunca cobra dos veces.
    const r = ctx.db.run('INSERT OR IGNORE INTO rods_owned (guild_id, user_id, rod_id, acquired_at) VALUES (?, ?, ?, ?)', guildId, userId, rod.id, ctx.now());
    if (r.changes !== 1) throw new GameError('Esa compra ya se procesó.');
    for (const c of rod.requires) removeItem(ctx, guildId, userId, c.itemId, c.qty);
    addCoins(ctx, guildId, userId, -priceFor(ctx, guildId, userId, buyPrice(cfg, rod.price)), `caña ${rod.id}`);
    ctx.db.run('UPDATE profiles SET rod_id = ? WHERE guild_id = ? AND user_id = ?', rod.id, guildId, userId);
    return rod;
  });
}

// ───────────────────────── Permisos (zonas de cultivo) ─────────────────────────

export function buyUnlock(ctx: GameContext, guildId: string, userId: string, kind: UnlockKind, id: string): string {
  return ctx.db.transaction(() => {
    const p = ensureProfile(ctx, guildId, userId);
    const cfg = gameConfig(ctx, guildId);
    const target = unlockTarget(cfg, kind, id);
    if (!target) throw new GameError('Ese permiso no existe.');
    if (isUnlocked(ctx, guildId, userId, kind, id)) throw new GameError('Ya tenés ese permiso.');
    if (p.farm_level < target.level) throw new GameError(`Requiere nivel de granja ${target.level}.`);
    const tiers = getEquipTiers(ctx, guildId, userId);
    if (tiers.herramienta < target.minToolTier) {
      const t = getEquipLine(cfg, 'herramienta').tiers[target.minToolTier];
      throw new GameError(`Primero necesitás ${t.emoji} ${t.name}.`);
    }
    consumeCooldown(ctx, guildId, userId, 'buy', 1200, 'La próxima compra');
    const r = ctx.db.run('INSERT OR IGNORE INTO unlocks (guild_id, user_id, unlock_id, unlocked_at) VALUES (?, ?, ?, ?)',
      guildId, userId, `${kind}:${id}`, ctx.now());
    if (r.changes !== 1) throw new GameError('Ese permiso ya se procesó.');
    for (const c of target.unlockItems) removeItem(ctx, guildId, userId, c.itemId, c.qty);
    addCoins(ctx, guildId, userId, -priceFor(ctx, guildId, userId, buyPrice(cfg, target.unlockCost)), `permiso ${kind}:${id}`);
    ctx.db.run('UPDATE profiles SET farm_zone = ? WHERE guild_id = ? AND user_id = ?', id, guildId, userId);
    return `${target.emoji} ${target.name}`;
  });
}

// ───────────────────────── Mejoras permanentes ─────────────────────────

export function upgradeCost(cfg: GameConfig, def: UpgradeDef, currentLevel: number): number {
  return buyPrice(cfg, Math.round(def.baseCost * Math.pow(def.costGrowth, currentLevel)));
}

export function upgradeRequirement(def: UpgradeDef, currentLevel: number): number {
  return def.baseTotalLevel + def.totalLevelPerStep * currentLevel;
}

export function buyUpgrade(ctx: GameContext, guildId: string, userId: string, id: UpgradeId): { def: UpgradeDef; level: number } {
  return ctx.db.transaction(() => {
    const p = ensureProfile(ctx, guildId, userId);
    const cfg = gameConfig(ctx, guildId);
    const def = cfg.upgrades.find((u) => u.id === id);
    if (!def) throw new GameError('Esa mejora no existe.');
    const current = getUpgradeLevels(ctx, guildId, userId)[id];
    if (current >= def.maxLevel) throw new GameError(`${def.name} ya está al máximo.`);
    const req = upgradeRequirement(def, current);
    if (totalLevel(p) < req) throw new GameError(`El siguiente nivel de ${def.name} requiere nivel total ${req}.`);
    consumeCooldown(ctx, guildId, userId, 'buy', 1200, 'La próxima compra');
    const r = ctx.db.run(
      `INSERT INTO upgrades (guild_id, user_id, upgrade_id, level) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id, upgrade_id) DO UPDATE SET level = excluded.level WHERE upgrades.level = ?`,
      guildId, userId, id, current + 1, current,
    );
    if (r.changes !== 1) throw new GameError('Esa mejora ya se procesó.');
    addCoins(ctx, guildId, userId, -priceFor(ctx, guildId, userId, upgradeCost(cfg, def, current)), `mejora ${id} ${current + 1}`);
    return { def, level: current + 1 };
  });
}

// ───────────────────────── Venta con demanda dinámica ─────────────────────────
// Cada servidor tiene un mercado compartido: vender mucho de lo mismo baja su precio
// y la demanda se recupera con el tiempo (vida media configurable). Desalienta el
// "farmeo y vuelco" de un único objeto y vuelve interesante diversificar.

function currentSupply(ctx: GameContext, cfg: GameConfig, guildId: string, itemId: string): number {
  const row = ctx.db.get<{ units: number; updated_at: number }>(
    'SELECT units, updated_at FROM market_supply WHERE guild_id = ? AND item_id = ?', guildId, itemId,
  );
  if (!row) return 0;
  const hours = Math.max(0, ctx.now() - row.updated_at) / 3_600_000;
  return row.units * Math.pow(0.5, hours / cfg.tuning.market.saturationHalfLifeHours);
}

export interface SellQuote {
  unitBase: number;
  multiplier: number;
  total: number;
  demand: 'alta' | 'normal' | 'baja' | 'saturada';
}

export function quoteSell(ctx: GameContext, guildId: string, userId: string, item: ItemDef, qty: number): SellQuote {
  const cfg = gameConfig(ctx, guildId);
  const scale = cfg.rarities[item.rarity].marketScale;
  const supply = currentSupply(ctx, cfg, guildId, item.id);
  const multiplier = Math.max(cfg.tuning.market.minPriceMultiplier, 1 / (1 + (supply + qty / 2) / scale));
  const unitBase = item.sellPrice * cfg.tuning.market.sellMultiplier * (1 + sellBonus(cfg, getUpgradeLevels(ctx, guildId, userId)));
  const current = 1 / (1 + supply / scale);
  const demand = current > 0.95 ? 'alta' : current > 0.8 ? 'normal' : current > 0.6 ? 'baja' : 'saturada';
  return { unitBase, multiplier, total: Math.max(qty > 0 ? 1 : 0, Math.floor(unitBase * multiplier * qty)), demand };
}

export function isSellable(item: ItemDef): boolean {
  return item.sellPrice > 0;
}

function sellInTx(ctx: GameContext, guildId: string, userId: string, item: ItemDef, qty: number): SellQuote {
  const cfg = gameConfig(ctx, guildId);
  const quote = quoteSell(ctx, guildId, userId, item, qty);
  removeItem(ctx, guildId, userId, item.id, qty);
  addCoins(ctx, guildId, userId, quote.total, `venta ${qty}x ${item.id}`);
  const supply = currentSupply(ctx, cfg, guildId, item.id) + qty;
  ctx.db.run(
    `INSERT INTO market_supply (guild_id, item_id, units, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, item_id) DO UPDATE SET units = excluded.units, updated_at = excluded.updated_at`,
    guildId, item.id, supply, ctx.now(),
  );
  return quote;
}

export interface SellResult {
  item: ItemDef;
  qty: number;
  quote: SellQuote;
  outcome: ActionOutcome;
}

/**
 * Vende una cantidad exacta, "half" (la mitad, redondeada hacia abajo, mínimo 1) o "all".
 * La cantidad se resuelve DENTRO de la transacción contra el inventario real: un panel desactualizado
 * o un doble clic nunca venden de más (el segundo clic encuentra 0 y falla sin tocar nada).
 */
export function sellItem(ctx: GameContext, guildId: string, userId: string, itemId: string, qty: number | 'all' | 'half'): SellResult {
  return ctx.db.transaction(() => {
    ensureProfile(ctx, guildId, userId);
    const cfg = gameConfig(ctx, guildId);
    const item = getItem(cfg, itemId);
    if (!item || !isSellable(item)) throw new GameError('Ese objeto no se puede vender.');
    const owned = getQty(ctx, guildId, userId, itemId);
    if (owned < 1) throw new GameError(`Ya no tenés ${item.emoji} ${item.name}.`);
    const amount = qty === 'all' ? owned : qty === 'half' ? Math.max(1, Math.floor(owned / 2)) : qty;
    if (!Number.isSafeInteger(amount) || amount < 1 || (typeof qty === 'number' && qty > MAX_TRADE_QTY)) throw new GameError('Cantidad inválida.');
    if (amount > owned) throw new GameError(`Solo tenés ${fmt(owned)} ${item.emoji} ${item.name}.`);
    consumeCooldown(ctx, guildId, userId, 'sell', 800, 'La próxima venta');
    const quote = sellInTx(ctx, guildId, userId, item, amount);
    const outcome = recordAction(ctx, guildId, userId, 'sell', {
      value: quote.total, stats: { 'stat:items_sold': amount, 'stat:coins_from_sales': quote.total },
    });
    return { item, qty: amount, quote, outcome };
  });
}

export type BulkFilter = 'comunes' | 'cultivos' | 'peces';

/** Objetos que se usan para fabricar o desbloquear algo: nunca se venden en lote por accidente. */
export function craftingItems(cfg: GameConfig): Set<string> {
  return new Set([
    ...cfg.fishing.rods.flatMap((r) => r.requires.map((c) => c.itemId)),
    ...cfg.farming.zones.flatMap((z) => z.unlockItems.map((c) => c.itemId)),
    cfg.fishing.baitItemId,
  ]);
}

export function matchesBulk(cfg: GameConfig, item: ItemDef, filter: BulkFilter): boolean {
  // Nunca en lote: reliquias, cebos, consumibles, materiales de fabricación ni nada Épico o superior.
  if (!isSellable(item) || item.category === 'reliquia' || item.category === 'cebo' || item.category === 'consumible') return false;
  if (craftingItems(cfg).has(item.id) || cfg.rarities[item.rarity].rank >= 3) return false;
  if (filter === 'comunes') return cfg.rarities[item.rarity].rank === 0;
  if (filter === 'cultivos') return item.category === 'cultivo';
  return item.category === 'pez' || item.category === 'chatarra';
}

export function sellBulk(ctx: GameContext, guildId: string, userId: string, filter: BulkFilter): { lines: { item: ItemDef; qty: number; total: number }[]; total: number; outcome: ActionOutcome } {
  return ctx.db.transaction(() => {
    ensureProfile(ctx, guildId, userId);
    const cfg = gameConfig(ctx, guildId);
    consumeCooldown(ctx, guildId, userId, 'sell', 3000, 'La próxima venta');
    const lines: { item: ItemDef; qty: number; total: number }[] = [];
    for (const row of listInventory(ctx, guildId, userId)) {
      const item = getItem(cfg, row.item_id);
      if (!item || !matchesBulk(cfg, item, filter)) continue;
      const q = sellInTx(ctx, guildId, userId, item, row.quantity);
      lines.push({ item, qty: row.quantity, total: q.total });
    }
    if (lines.length === 0) throw new GameError('No tenés nada para vender con ese filtro.');
    const total = lines.reduce((s, l) => s + l.total, 0);
    const outcome = recordAction(ctx, guildId, userId, 'sell', {
      value: total, stats: { 'stat:items_sold': lines.reduce((s, l) => s + l.qty, 0), 'stat:coins_from_sales': total },
    });
    return { lines, total, outcome };
  });
}

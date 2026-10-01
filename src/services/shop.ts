import { getEquipLine, getItem } from '../game/config';
import type { EquipSlot, GameConfig, RodDef } from '../game/types';
import { recordAction, type ActionOutcome } from './actions';
import { GameError, fmt, type GameContext } from './context';
import { getCoins } from './economy';
import { currentRod, ownedRodIds } from './fishing';
import { gameConfig } from './guildSettings';
import { getQty } from './inventory';
import { getDailyCount } from './limits';
import {
  buyEquipment, buyPrice, buyRod, buySupply, buyUnlock, buyUpgrade, nextTier, priceFor, supplyOffers, upgradeCost, upgradeRequirement,
} from './market';
import { ensureProfile, getEquipTiers, getUpgradeLevels, isUnlocked, SLOTS, totalLevel, type ProfileRow, type UpgradeId } from './player';

/**
 * Tienda unificada. Cada tipo de artículo es un "proveedor" con dos funciones: listar ofertas y comprar.
 * El panel de Discord y la Actividad solo hablan con listOffers/purchase, así que:
 *  - el precio que se muestra es exactamente el que se cobra (mismo cálculo, descuentos incluidos);
 *  - toda compra pasa por el mismo camino (actividad, logros, estadísticas);
 *  - agregar un tipo de artículo nuevo es agregar un proveedor, sin tocar la interfaz.
 */
export type ShopSection = 'canas' | 'equipo' | 'suministros' | 'permisos' | 'mejoras';

export interface Requirement {
  label: string;
  ok: boolean;
}

export type OfferState = 'available' | 'locked' | 'owned' | 'equipped' | 'maxed';

export interface ShopOffer {
  /** "<proveedor>:<clave>", p. ej. rod:sauce, supply:lombriz, equip:herramienta. */
  id: string;
  section: ShopSection;
  name: string;
  emoji: string;
  description: string;
  /** Resumen corto de estadísticas o efecto. */
  stats: string;
  /** Precio unitario final (con rebajas activas). */
  price: number;
  basePrice: number;
  requirements: Requirement[];
  state: OfferState;
  /** Se puede comprar en cantidad (suministros). */
  bulk: boolean;
  dailyLimit: number | null;
  boughtToday: number;
  /** Imagen en assets/rods (solo cañas). */
  sprite?: string;
  /** Solo cañas: estadísticas numéricas para comparar con la equipada. */
  rod?: RodDef;
}

interface Provider {
  section: ShopSection;
  list(ctx: GameContext, cfg: GameConfig, p: ProfileRow): ShopOffer[];
  buy(ctx: GameContext, guildId: string, userId: string, key: string, qty: number): string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function rodStats(r: RodDef): string {
  const special = r.special?.kind === 'eco' ? ` · eco ${pct(r.special.chance)}` : r.special?.kind === 'abismo' ? ` · ultra ×${r.special.ultraMult}` : '';
  return `${r.lines} ${r.lines === 1 ? 'línea' : 'líneas'} · suerte +${pct(r.luck)} · ahorro ${pct(r.baitSave)} · ${r.cooldownSeconds} s${special}`;
}

export function equipStatsText(s: Partial<import('../game/types').EquipStats>): string {
  const parts: string[] = [];
  if (s.yieldMult && s.yieldMult !== 1) parts.push(`×${s.yieldMult} cosecha`);
  if (s.extraRolls) parts.push(`+${s.extraRolls} tirada${s.extraRolls > 1 ? 's' : ''}`);
  if (s.vigorDiscount) parts.push(`−${pct(s.vigorDiscount)} vigor`);
  if (s.rareBonus) parts.push(`+${pct(s.rareBonus)} hallazgos raros`);
  return parts.join(' · ') || 'Sin bonus';
}

function finalState(reqs: Requirement[]): OfferState {
  return reqs.every((r) => r.ok) ? 'available' : 'locked';
}

const PROVIDERS: Record<string, Provider> = {
  rod: {
    section: 'canas',
    list(ctx, cfg, p) {
      const owned = ownedRodIds(ctx, p.guild_id, p.user_id);
      const equipped = currentRod(cfg, p, owned).id;
      return cfg.fishing.rods.map((r) => {
        const price = priceFor(ctx, p.guild_id, p.user_id, buyPrice(cfg, r.price));
        const reqs: Requirement[] = [
          { label: `Pesca nv. ${r.fishLevel}`, ok: p.fish_level >= r.fishLevel },
          ...r.requires.map((c) => {
            const it = getItem(cfg, c.itemId);
            return { label: `${it?.emoji ?? ''} ${it?.name ?? c.itemId} ×${c.qty}`, ok: getQty(ctx, p.guild_id, p.user_id, c.itemId) >= c.qty };
          }),
          { label: `${cfg.currency.emoji} ${fmt(price)}`, ok: p.coins >= price },
        ];
        const state: OfferState = r.id === equipped ? 'equipped' : owned.has(r.id) ? 'owned' : finalState(reqs);
        return {
          id: `rod:${r.id}`, section: 'canas', name: r.name, emoji: r.emoji, description: r.description, stats: rodStats(r),
          price, basePrice: buyPrice(cfg, r.price), requirements: reqs, state, bulk: false, dailyLimit: null, boughtToday: 0, sprite: r.sprite, rod: r,
        };
      });
    },
    buy(ctx, g, u, key) {
      const rod = buyRod(ctx, g, u, key);
      return `🎉 Compraste y equipaste ${rod.emoji} **${rod.name}**.`;
    },
  },

  equip: {
    section: 'equipo',
    list(ctx, cfg, p) {
      const tiers = getEquipTiers(ctx, p.guild_id, p.user_id);
      return SLOTS.map((slot: EquipSlot) => {
        const line = getEquipLine(cfg, slot);
        const cur = line.tiers[tiers[slot]];
        const next = nextTier(cfg, slot, tiers[slot]);
        if (!next) {
          return {
            id: `equip:${slot}`, section: 'equipo' as const, name: cur.name, emoji: cur.emoji, description: `${line.label}: nivel máximo.`, stats: '',
            price: 0, basePrice: 0, requirements: [], state: 'maxed' as const, bulk: false, dailyLimit: null, boughtToday: 0,
          };
        }
        const price = priceFor(ctx, p.guild_id, p.user_id, buyPrice(cfg, next.price));
        const skillLevel = next.skill === 'granja' ? p.farm_level : p.fish_level;
        const reqs: Requirement[] = [
          { label: `${next.skill === 'granja' ? 'Granja' : 'Pesca'} nv. ${next.level}`, ok: skillLevel >= next.level },
          { label: `${cfg.currency.emoji} ${fmt(price)}`, ok: p.coins >= price },
        ];
        return {
          id: `equip:${slot}`, section: 'equipo' as const, name: next.name, emoji: next.emoji,
          description: `${line.label}: reemplaza a ${cur.emoji} ${cur.name}.`, stats: equipStatsText(next.stats),
          price, basePrice: buyPrice(cfg, next.price), requirements: reqs, state: finalState(reqs), bulk: false, dailyLimit: null, boughtToday: 0,
        };
      });
    },
    buy(ctx, g, u, key) {
      const slot = SLOTS.find((s) => s === key);
      if (!slot) throw new GameError('Ese equipo no existe.');
      const t = buyEquipment(ctx, g, u, slot);
      return `🛠️ Ahora tenés ${t.emoji} **${t.name}**.`;
    },
  },

  supply: {
    section: 'suministros',
    list(ctx, cfg, p) {
      return supplyOffers(cfg, p).map((o) => {
        const lvl = o.requirement.kind === 'pesca' ? p.fish_level : totalLevel(p);
        const price = priceFor(ctx, p.guild_id, p.user_id, o.price);
        const boughtToday = o.dailyLimit !== null ? getDailyCount(ctx, p.guild_id, p.user_id, `compra:${o.item.id}`) : 0;
        const def = cfg.consumables.find((c) => c.itemId === o.item.id);
        const buff = def?.effect.type === 'buff' ? cfg.buffs.find((b) => b.id === (def.effect as { buffId: string }).buffId) : undefined;
        const stats = buff ? `${buff.description} · ${buff.minutes} min` : def?.effect.type === 'vigor' ? `+${def.effect.amount} vigor` : 'Cada línea de pesca usa una';
        const reqs: Requirement[] = [
          { label: `Nivel ${o.requirement.kind === 'pesca' ? 'de pesca' : 'total'} ${o.requirement.level}`, ok: lvl >= o.requirement.level },
          ...(o.dailyLimit !== null ? [{ label: `Hoy ${boughtToday}/${o.dailyLimit}`, ok: boughtToday < o.dailyLimit }] : []),
          { label: `${cfg.currency.emoji} ${fmt(price)} c/u`, ok: p.coins >= price },
        ];
        return {
          id: `supply:${o.item.id}`, section: 'suministros' as const, name: o.item.name, emoji: o.item.emoji, description: o.item.description,
          stats, price, basePrice: o.price, requirements: reqs, state: finalState(reqs), bulk: true, dailyLimit: o.dailyLimit, boughtToday,
        };
      });
    },
    buy(ctx, g, u, key, qty) {
      const r = buySupply(ctx, g, u, key, qty);
      return `✅ Compraste ${fmt(r.qty)}× ${r.offer.item.emoji} **${r.offer.item.name}**.`;
    },
  },

  zone: {
    section: 'permisos',
    list(ctx, cfg, p) {
      const tiers = getEquipTiers(ctx, p.guild_id, p.user_id);
      return cfg.farming.zones.map((z) => {
        const open = isUnlocked(ctx, p.guild_id, p.user_id, 'zona', z.id);
        const price = priceFor(ctx, p.guild_id, p.user_id, buyPrice(cfg, z.unlockCost));
        const tool = getEquipLine(cfg, 'herramienta').tiers[z.minToolTier];
        const reqs: Requirement[] = open ? [] : [
          { label: `Granja nv. ${z.level}`, ok: p.farm_level >= z.level },
          { label: `${tool.emoji} ${tool.name}`, ok: tiers.herramienta >= z.minToolTier },
          ...z.unlockItems.map((c) => {
            const it = getItem(cfg, c.itemId);
            return { label: `${it?.emoji ?? ''} ${it?.name ?? c.itemId} ×${c.qty}`, ok: getQty(ctx, p.guild_id, p.user_id, c.itemId) >= c.qty };
          }),
          { label: `${cfg.currency.emoji} ${fmt(price)}`, ok: p.coins >= price },
        ];
        return {
          id: `zone:${z.id}`, section: 'permisos' as const, name: z.name, emoji: z.emoji, description: z.description,
          stats: `${z.rolls} tiradas · ${z.vigorCost} vigor`, price, basePrice: buyPrice(cfg, z.unlockCost), requirements: reqs,
          state: open ? 'owned' : finalState(reqs), bulk: false, dailyLimit: null, boughtToday: 0,
        };
      });
    },
    buy(ctx, g, u, key) {
      const name = buyUnlock(ctx, g, u, 'zona', key);
      return `📜 Desbloqueaste **${name}**.`;
    },
  },

  upgrade: {
    section: 'mejoras',
    list(ctx, cfg, p) {
      const levels = getUpgradeLevels(ctx, p.guild_id, p.user_id);
      return cfg.upgrades.map((u) => {
        const lvl = levels[u.id];
        if (lvl >= u.maxLevel) {
          return {
            id: `upgrade:${u.id}`, section: 'mejoras' as const, name: u.name, emoji: u.emoji, description: u.description, stats: `Nivel ${lvl}/${u.maxLevel}`,
            price: 0, basePrice: 0, requirements: [], state: 'maxed' as const, bulk: false, dailyLimit: null, boughtToday: 0,
          };
        }
        const price = priceFor(ctx, p.guild_id, p.user_id, upgradeCost(cfg, u, lvl));
        const need = upgradeRequirement(u, lvl);
        const reqs: Requirement[] = [
          { label: `Nivel total ${need}`, ok: totalLevel(p) >= need },
          { label: `${cfg.currency.emoji} ${fmt(price)}`, ok: p.coins >= price },
        ];
        return {
          id: `upgrade:${u.id}`, section: 'mejoras' as const, name: u.name, emoji: u.emoji, description: u.description,
          stats: `Nivel ${lvl} → ${lvl + 1} de ${u.maxLevel}`, price, basePrice: upgradeCost(cfg, u, lvl), requirements: reqs,
          state: finalState(reqs), bulk: false, dailyLimit: null, boughtToday: 0,
        };
      });
    },
    buy(ctx, g, u, key) {
      const cfg = gameConfig(ctx, g);
      const def = cfg.upgrades.find((x) => x.id === key);
      if (!def) throw new GameError('Esa mejora no existe.');
      const r = buyUpgrade(ctx, g, u, def.id as UpgradeId);
      return `⬆️ ${r.def.emoji} **${r.def.name}** subió a nivel ${r.level}.`;
    },
  },
};

export const SECTION_PROVIDER: Record<ShopSection, string> = {
  canas: 'rod', equipo: 'equip', suministros: 'supply', permisos: 'zone', mejoras: 'upgrade',
};

export function listOffers(ctx: GameContext, guildId: string, userId: string, section: ShopSection): ShopOffer[] {
  const p = ensureProfile(ctx, guildId, userId);
  const cfg = gameConfig(ctx, guildId);
  return PROVIDERS[SECTION_PROVIDER[section]].list(ctx, cfg, p);
}

export function getOffer(ctx: GameContext, guildId: string, userId: string, offerId: string): ShopOffer {
  const [prov] = offerId.split(':');
  const provider = PROVIDERS[prov];
  if (!provider) throw new GameError('Ese artículo no existe.');
  const offer = listOffers(ctx, guildId, userId, provider.section).find((o) => o.id === offerId);
  if (!offer) throw new GameError('Ese artículo no existe.');
  return offer;
}

export interface PurchaseResult {
  offer: ShopOffer;
  qty: number;
  cost: number;
  message: string;
  outcome: ActionOutcome;
}

/**
 * Único camino de compra. Valida de nuevo del lado del servidor (el panel puede estar desactualizado),
 * cobra, registra actividad y revisa logros, todo en una transacción.
 */
export function purchase(ctx: GameContext, guildId: string, userId: string, offerId: string, qty = 1): PurchaseResult {
  if (!Number.isSafeInteger(qty) || qty < 1) throw new GameError('Cantidad inválida.');
  const [prov, key = ''] = offerId.split(':');
  const provider = PROVIDERS[prov];
  if (!provider || !/^[a-z0-9_]{1,40}$/.test(key)) throw new GameError('Ese artículo no existe.');
  return ctx.db.transaction(() => {
    ensureProfile(ctx, guildId, userId);
    const offer = getOffer(ctx, guildId, userId, offerId);
    if (!offer.bulk && qty !== 1) throw new GameError('Ese artículo se compra de a uno.');
    if (offer.state === 'owned' || offer.state === 'equipped') throw new GameError(`Ya tenés ${offer.emoji} ${offer.name}.`);
    if (offer.state === 'maxed') throw new GameError('Ya está al máximo.');
    const before = getCoins(ctx, guildId, userId);
    const message = provider.buy(ctx, guildId, userId, key, qty);
    // El costo real se mide sobre el saldo: imposible que difiera de lo cobrado.
    const cost = before - getCoins(ctx, guildId, userId);
    const cfg = gameConfig(ctx, guildId);
    const counts = cost >= cfg.tuning.activity.minTradeValue;
    const outcome = recordAction(ctx, guildId, userId, 'buy', {
      value: cost, stats: { 'stat:purchases': counts ? 1 : 0, 'stat:coins_spent': cost },
    });
    return { offer, qty, cost, message, outcome };
  });
}

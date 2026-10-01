import { getItem } from '../game/config';
import type { GameConfig } from '../game/types';
import type { GameContext } from '../services/context';
import {
  RARITY_ORDER, baitPrice, castVigorCost, collectionProgress, fishingLoadout, getFishLog, ownedRodIds, rarityOdds, type FishResult,
} from '../services/fishing';
import { gameConfig } from '../services/guildSettings';
import { getQty } from '../services/inventory';
import { getReadyAt } from '../services/limits';
import { buyPrice } from '../services/market';
import { ensureProfile, getUpgradeLevels, vigorState } from '../services/player';
import { xpToNext } from '../services/progression';
import type { CastView, FishState } from './types';

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

export function buildFishState(ctx: GameContext, guildId: string, userId: string): FishState {
  const p = ensureProfile(ctx, guildId, userId);
  const cfg = gameConfig(ctx, guildId);
  const now = ctx.now();
  const lo = fishingLoadout(ctx, guildId, userId, p);
  const vigor = vigorState(cfg, p, getUpgradeLevels(ctx, guildId, userId), now);
  const baitItem = getItem(cfg, cfg.fishing.baitItemId)!;
  const bait = getQty(ctx, guildId, userId, baitItem.id);
  const lines = Math.max(1, Math.min(lo.lines, Math.max(1, bait)));
  const owned = ownedRodIds(ctx, guildId, userId);
  const log = getFishLog(ctx, guildId, userId);
  const odds = rarityOdds(cfg, lo.luck, lo.ultraMult);
  const maxLevel = cfg.tuning.progression.maxLevel;

  return {
    serverNow: now,
    currency: { ...cfg.currency },
    player: {
      level: p.fish_level, xp: p.fish_xp, need: p.fish_level >= maxLevel ? 0 : xpToNext(cfg, p.fish_level),
      atMax: p.fish_level >= maxLevel, catches: p.catches_total, coins: p.coins,
    },
    vigor: { current: vigor.current, max: vigor.max, regenMs: vigor.regenMs },
    bait: { qty: bait, emoji: baitItem.emoji, price: baitPrice(cfg, p.fish_level) },
    next: { lines, vigorCost: castVigorCost(cfg, lines) },
    loadout: { lines: lo.lines, luck: lo.luck, baitSave: lo.baitSave, cooldownMs: lo.cooldownMs },
    readyAt: getReadyAt(ctx, guildId, userId, 'fish'),
    pity: { current: p.fish_pity, threshold: cfg.tuning.fish.pityThreshold },
    odds: RARITY_ORDER.map((r) => ({ rarity: r, label: cfg.rarities[r].label, emoji: cfg.rarities[r].emoji, color: hex(cfg.rarities[r].color), chance: odds[r] })),
    rods: cfg.fishing.rods.map((r) => ({
      id: r.id, name: r.name, emoji: r.emoji, description: r.description, lines: r.lines, luck: r.luck, baitSave: r.baitSave,
      cooldownSeconds: r.cooldownSeconds,
      special: r.special?.kind === 'eco' ? `Eco ${Math.round(r.special.chance * 100)}%` : r.special?.kind === 'abismo' ? `Ultra ×${r.special.ultraMult}` : null,
      price: buyPrice(cfg, r.price), fishLevel: r.fishLevel, owned: owned.has(r.id), equipped: r.id === lo.rod.id,
      image: r.sprite ? `rods/${r.sprite}.png` : null,
    })),
    buffs: lo.buffs.map((b) => ({ name: b.def.name, emoji: b.def.emoji, description: b.def.description, expiresAt: b.expiresAt, guildWide: b.guildWide })),
    collections: collectionProgress(ctx, guildId, userId).map((c) => ({
      label: cfg.rarities[c.rarity].label, emoji: cfg.rarities[c.rarity].emoji, color: hex(cfg.rarities[c.rarity].color),
      found: c.found, total: c.total, reward: c.reward, claimed: c.claimed,
    })),
    species: cfg.fishing.fish.map((f) => {
      const it = getItem(cfg, f.itemId)!;
      const e = log.get(f.itemId);
      // Las especies sin descubrir no revelan nombre ni ícono.
      return { name: e ? it.name : '???', emoji: e ? it.emoji : '❔', color: hex(cfg.rarities[it.rarity].color), found: !!e, caught: e?.caught ?? 0, best: e?.best ?? 0, minLevel: f.minLevel };
    }),
  };
}

export function castView(cfg: GameConfig, r: FishResult): CastView {
  return {
    lines: r.lines,
    wantedLines: r.wantedLines,
    baitUsed: r.baitUsed,
    baitSaved: r.baitSaved,
    vigorSpent: r.vigorSpent,
    xp: r.gain.amount,
    catches: r.catches.map((c) => {
      const it = getItem(cfg, c.itemId)!;
      return {
        name: it.name, emoji: it.emoji, rarityLabel: cfg.rarities[c.rarity].label, color: hex(cfg.rarities[c.rarity].color),
        weight: c.weight, newSpecies: c.newSpecies, newRecord: c.newRecord, echo: c.echo, pity: c.pity,
      };
    }),
    extras: r.extras.map((e) => { const it = getItem(cfg, e.itemId)!; return { name: it.name, emoji: it.emoji }; }),
    collections: r.collections.map((c) => ({ label: cfg.rarities[c.rarity].label, coins: c.coins })),
    levelUp: r.gain.levelUp ? { to: r.gain.levelUp.to, coins: r.gain.levelUp.coins, reachedMax: r.gain.levelUp.reachedMax } : null,
    achievements: r.outcome.achievements.map((a) => ({ name: a.def.name, emoji: a.def.emoji, badge: `badges/${a.def.id}.png` })),
    activity: r.outcome.activity,
  };
}

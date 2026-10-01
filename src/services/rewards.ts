import { getBuff, getItem } from '../game/config';
import type { ItemCost } from '../game/types';
import { applyBuff } from './buffs';
import { GameError, fmt, type GameContext } from './context';
import { addCoins } from './economy';
import { gameConfig } from './guildSettings';
import { addItem } from './inventory';
import { ensureProfile } from './player';
import { addXp, xpToNext } from './progression';

/**
 * Recompensa genérica. Todos los sistemas que regalan cosas (logros, sorteos, colecciones)
 * pasan por acá, así una misma recompensa siempre se entrega y se describe igual.
 */
export interface RewardSpec {
  coins?: number;
  items?: ItemCost[];
  buffId?: string;
  /** Fracción de la XP que falta para el próximo nivel de pesca (0.2 = 20%). */
  fishXpFraction?: number;
}

export interface GrantedReward {
  lines: string[];
  levelUp: boolean;
}

/** Entrega una recompensa. Debe llamarse dentro de una transacción. */
export function grantReward(ctx: GameContext, guildId: string, userId: string, reward: RewardSpec, reason: string): GrantedReward {
  const cfg = gameConfig(ctx, guildId);
  const lines: string[] = [];
  let levelUp = false;
  if (reward.coins && reward.coins > 0) {
    const amount = Math.round(reward.coins);
    addCoins(ctx, guildId, userId, amount, reason);
    lines.push(`${cfg.currency.emoji} ${fmt(amount)} ${cfg.currency.name}`);
  }
  for (const c of reward.items ?? []) {
    const item = getItem(cfg, c.itemId);
    if (!item || c.qty < 1) continue;
    addItem(ctx, guildId, userId, item.id, c.qty);
    lines.push(`${item.emoji} ${item.name} ×${fmt(c.qty)}`);
  }
  if (reward.buffId) {
    const buff = getBuff(cfg, reward.buffId);
    if (buff) {
      try {
        const until = applyBuff(ctx, guildId, userId, buff.id, reason);
        lines.push(`${buff.emoji} ${buff.name} (hasta <t:${Math.ceil(until / 1000)}:t>)`);
      } catch (err) {
        // Ya estaba al tope de duración: se informa, sin romper el resto de la entrega.
        if (!(err instanceof GameError)) throw err;
        lines.push(`${buff.emoji} ${buff.name} (ya estaba al máximo)`);
      }
    }
  }
  if (reward.fishXpFraction && reward.fishXpFraction > 0) {
    const p = ensureProfile(ctx, guildId, userId);
    const need = p.fish_level >= cfg.tuning.progression.maxLevel ? 0 : xpToNext(cfg, p.fish_level);
    const gain = addXp(ctx, p, 'pesca', need * reward.fishXpFraction);
    levelUp = !!gain.levelUp;
    lines.push(`✨ ${fmt(gain.amount)} XP de pesca${gain.levelUp ? ` (¡nivel ${gain.levelUp.to}!)` : ''}`);
  }
  return { lines, levelUp };
}

export function describeReward(ctx: GameContext, guildId: string, reward: RewardSpec): string {
  const cfg = gameConfig(ctx, guildId);
  const parts: string[] = [];
  if (reward.coins) parts.push(`${cfg.currency.emoji} ${fmt(reward.coins)}`);
  for (const c of reward.items ?? []) {
    const it = getItem(cfg, c.itemId);
    if (it) parts.push(`${it.emoji} ${it.name} ×${fmt(c.qty)}`);
  }
  return parts.join(' · ') || '—';
}

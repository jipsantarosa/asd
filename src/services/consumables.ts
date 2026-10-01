import { getItem } from '../game/config';
import type { ConsumableDef } from '../game/types';
import { GameError, type GameContext } from './context';
import { gameConfig } from './guildSettings';
import { removeItem } from './inventory';
import { consumeDaily } from './limits';
import { ensureProfile, restoreVigor, totalLevel } from './player';
import { applyBuff } from './buffs';
import { getBuff } from '../game/config';

export interface UseResult {
  def: ConsumableDef;
  message: string;
}

export function useConsumable(ctx: GameContext, guildId: string, userId: string, itemId: string): UseResult {
  return ctx.db.transaction(() => {
    const p = ensureProfile(ctx, guildId, userId);
    const cfg = gameConfig(ctx, guildId);
    const def = cfg.consumables.find((c) => c.itemId === itemId);
    const item = getItem(cfg, itemId);
    if (!def || !item) throw new GameError('Ese objeto no se puede usar.');
    if (totalLevel(p) < def.minTotalLevel) throw new GameError(`Necesitás nivel total ${def.minTotalLevel} para usar ${item.name}.`);
    if (def.dailyUseLimit !== null) consumeDaily(ctx, guildId, userId, `uso:${itemId}`, def.dailyUseLimit, 1, item.name);

    let message: string;
    if (def.effect.type === 'vigor') {
      const now = restoreVigor(ctx, p, def.effect.amount);
      message = `${item.emoji} Recuperaste vigor: ahora tenés **${Math.floor(now)}**.`;
    } else if (def.effect.type === 'buff') {
      const buff = getBuff(cfg, def.effect.buffId)!;
      const until = applyBuff(ctx, guildId, userId, buff.id, `uso de ${itemId}`);
      message = `${buff.emoji} **${buff.name}** activo hasta <t:${Math.ceil(until / 1000)}:t>: ${buff.description}`;
    } else {
      if (p.fertilizer >= cfg.maxFertilizerCharges) throw new GameError('Tu tierra ya está todo lo abonada que puede estar.');
      const next = Math.min(cfg.maxFertilizerCharges, p.fertilizer + def.effect.charges);
      ctx.db.run('UPDATE profiles SET fertilizer = ? WHERE guild_id = ? AND user_id = ?', next, guildId, userId);
      message = `${item.emoji} Abonaste la tierra: **${next}** cosechas potenciadas.`;
    }
    removeItem(ctx, guildId, userId, itemId, 1);
    return { def, message };
  });
}

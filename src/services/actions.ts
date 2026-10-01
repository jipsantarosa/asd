import { checkAchievements, type AchievementUnlock } from './achievements';
import { awardActivity, type ActivityKind } from './activity';
import type { GameContext } from './context';
import { consumeCooldown } from './limits';
import { addFatigue, spendVigor, type ProfileRow } from './player';
import { bumpStats, type StatDelta } from './stats';

/**
 * Canal común de toda acción de juego (farmear, pescar, vender, comprar, ganar un sorteo).
 * Antes cada sistema repetía su propio cooldown/vigor/cansancio y nadie registraba actividad ni logros;
 * ahora todas pasan por acá, en la misma transacción que la acción.
 */
export interface ActionOutcome {
  /** Puntos de actividad ganados (ya con topes diarios). */
  activity: number;
  achievements: AchievementUnlock[];
}

/** Paso 1 de farmear/pescar: reserva la espera, cobra vigor y suma cansancio. Devuelve el multiplicador de cansancio. */
export function startAction(ctx: GameContext, p: ProfileRow, spec: { cooldownKey: string; cooldownMs: number; cooldownLabel: string; vigor: number }): number {
  consumeCooldown(ctx, p.guild_id, p.user_id, spec.cooldownKey, spec.cooldownMs, spec.cooldownLabel);
  spendVigor(ctx, p, spec.vigor);
  return addFatigue(ctx, p);
}

/** Paso final: estadísticas, puntos de actividad y logros. */
export function recordAction(ctx: GameContext, guildId: string, userId: string, kind: Exclude<ActivityKind, 'achievement'>, opts: { stats?: StatDelta; value?: number } = {}): ActionOutcome {
  if (opts.stats) bumpStats(ctx, guildId, userId, opts.stats);
  const activity = awardActivity(ctx, guildId, userId, kind, { value: opts.value });
  const achievements = checkAchievements(ctx, guildId, userId);
  return { activity: activity + achievements.reduce((s, a) => s + a.activity, 0), achievements };
}

export const NO_OUTCOME: ActionOutcome = { activity: 0, achievements: [] };

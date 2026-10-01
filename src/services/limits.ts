import { GameError, dayKey, type GameContext } from './context';
import { gameConfig } from './guildSettings';

export function getReadyAt(ctx: GameContext, guildId: string, userId: string, action: string): number {
  return ctx.db.get<{ ready_at: number }>(
    'SELECT ready_at FROM cooldowns WHERE guild_id = ? AND user_id = ? AND action = ?', guildId, userId, action,
  )?.ready_at ?? 0;
}

/** Comprueba y reserva un cooldown en la misma transacción: dos clics simultáneos no pueden pasar ambos. */
export function consumeCooldown(ctx: GameContext, guildId: string, userId: string, action: string, ms: number, label: string): void {
  const now = ctx.now();
  const readyAt = getReadyAt(ctx, guildId, userId, action);
  if (readyAt > now) {
    throw new GameError(`${label} estará disponible <t:${Math.ceil(readyAt / 1000)}:R>.`, readyAt);
  }
  ctx.db.run(
    `INSERT INTO cooldowns (guild_id, user_id, action, ready_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id, action) DO UPDATE SET ready_at = excluded.ready_at`,
    guildId, userId, action, now + ms,
  );
}

export function getDailyCount(ctx: GameContext, guildId: string, userId: string, counter: string): number {
  const cfg = gameConfig(ctx, guildId);
  return ctx.db.get<{ count: number }>(
    'SELECT count FROM daily_counters WHERE guild_id = ? AND user_id = ? AND counter = ? AND day = ?',
    guildId, userId, counter, dayKey(ctx.now(), cfg.timezoneOffsetMinutes),
  )?.count ?? 0;
}

export function consumeDaily(ctx: GameContext, guildId: string, userId: string, counter: string, limit: number, amount: number, label: string): void {
  const cfg = gameConfig(ctx, guildId);
  const day = dayKey(ctx.now(), cfg.timezoneOffsetMinutes);
  const used = getDailyCount(ctx, guildId, userId, counter);
  if (used + amount > limit) {
    throw new GameError(`Límite diario de ${label}: ${used}/${limit}. Se reinicia a medianoche.`);
  }
  ctx.db.run(
    `INSERT INTO daily_counters (guild_id, user_id, counter, day, count) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id, counter, day) DO UPDATE SET count = count + excluded.count`,
    guildId, userId, counter, day, amount,
  );
}

/** Limpieza periódica de datos efímeros. */
export function pruneEphemeral(ctx: GameContext): void {
  const now = ctx.now();
  const oldDay = dayKey(now - 3 * 86_400_000, 0);
  ctx.db.run('DELETE FROM daily_counters WHERE day < ?', oldDay);
  ctx.db.run('DELETE FROM cooldowns WHERE ready_at < ?', now - 86_400_000);
}

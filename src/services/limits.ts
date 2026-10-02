import { GameError, type GameContext } from './context';

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

/** Limpieza periódica de datos efímeros. */
export function pruneEphemeral(ctx: GameContext): void {
  const now = ctx.now();
  ctx.db.run('DELETE FROM cooldowns WHERE ready_at < ?', now - 86_400_000);
  ctx.cache.cooldowns.forEach((t, k) => { if (t < now) ctx.cache.cooldowns.delete(k); });
}

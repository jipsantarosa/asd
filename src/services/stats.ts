import type { GameContext } from './context';

/** Contadores acumulados por jugador que usan los logros. Solo se incrementan desde acciones reales. */
export type StatKey =
  | 'stat:rare_caught' | 'stat:epic_caught' | 'stat:legend_caught' | 'stat:ultra_caught' | 'stat:golden_harvests'
  | 'stat:items_sold' | 'stat:coins_from_sales' | 'stat:purchases' | 'stat:coins_spent' | 'stat:events_won';

export type StatDelta = Partial<Record<StatKey, number>>;

/** Suma a los contadores. Debe llamarse dentro de la transacción de la acción. */
export function bumpStats(ctx: GameContext, guildId: string, userId: string, delta: StatDelta): void {
  for (const [stat, v] of Object.entries(delta)) {
    if (!v || !Number.isFinite(v) || v <= 0) continue;
    ctx.db.run(
      `INSERT INTO player_stats (guild_id, user_id, stat, value) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id, stat) DO UPDATE SET value = value + excluded.value`,
      guildId, userId, stat, Math.round(v),
    );
  }
}

export function getStats(ctx: GameContext, guildId: string, userId: string): Map<string, number> {
  return new Map(ctx.db.all<{ stat: string; value: number }>(
    'SELECT stat, value FROM player_stats WHERE guild_id = ? AND user_id = ?', guildId, userId,
  ).map((r) => [r.stat, r.value]));
}

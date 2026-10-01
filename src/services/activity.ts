import { type GameContext } from './context';
import { gameConfig } from './guildSettings';
import { getDailyCount } from './limits';
import { dayKey } from './context';

export type ActivityKind = 'fish' | 'farm' | 'sell' | 'buy' | 'event' | 'achievement';

function addDaily(ctx: GameContext, guildId: string, userId: string, counter: string, amount: number): void {
  const cfg = gameConfig(ctx, guildId);
  ctx.db.run(
    `INSERT INTO daily_counters (guild_id, user_id, counter, day, count) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id, counter, day) DO UPDATE SET count = count + excluded.count`,
    guildId, userId, counter, dayKey(ctx.now(), cfg.timezoneOffsetMinutes), amount,
  );
}

/**
 * Suma puntos de actividad por una acción real, respetando topes diarios por tipo y un tope total.
 * Anti spam: el cooldown y el vigor ya limitan la frecuencia; además las compras/ventas chicas no suman
 * y ninguna acción repetida puede pasar su tope del día. Los logros suman sin tope (son únicos).
 * Debe llamarse dentro de la transacción de la acción. Devuelve los puntos otorgados.
 */
export function awardActivity(ctx: GameContext, guildId: string, userId: string, kind: ActivityKind, opts: { value?: number; points?: number } = {}): number {
  const t = gameConfig(ctx, guildId).tuning.activity;
  let points = 0;
  let cap = Infinity;
  let bucket = '';
  switch (kind) {
    case 'fish': points = t.fishPoints; cap = t.dailyCapFish; bucket = 'act:fish'; break;
    case 'farm': points = t.farmPoints; cap = t.dailyCapFarm; bucket = 'act:farm'; break;
    case 'sell':
    case 'buy':
      if ((opts.value ?? 0) < t.minTradeValue) return 0;
      points = kind === 'sell' ? t.sellPoints : t.buyPoints; cap = t.dailyCapTrade; bucket = 'act:trade'; break;
    case 'event': points = t.eventPoints; break;
    case 'achievement': points = Math.max(0, Math.round(opts.points ?? 0)); break;
  }
  if (points <= 0) return 0;
  if (kind !== 'achievement') {
    const used = bucket ? getDailyCount(ctx, guildId, userId, bucket) : 0;
    const total = getDailyCount(ctx, guildId, userId, 'act:total');
    points = Math.min(points, cap - used, t.dailyCapTotal - total);
    if (points <= 0) return 0;
    if (bucket) addDaily(ctx, guildId, userId, bucket, points);
    addDaily(ctx, guildId, userId, 'act:total', points);
  }
  ctx.db.run('UPDATE profiles SET activity_points = activity_points + ? WHERE guild_id = ? AND user_id = ?', points, guildId, userId);
  return points;
}

export function activityToday(ctx: GameContext, guildId: string, userId: string): { today: number; cap: number } {
  const t = gameConfig(ctx, guildId).tuning.activity;
  return { today: getDailyCount(ctx, guildId, userId, 'act:total'), cap: t.dailyCapTotal };
}

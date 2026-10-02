import { GameError, type GameContext } from '../services/context';
import { checkAchievements, type Unlocked } from './achievements';
import { casinoDay, casinoDayStart, getCasinoConfig } from './config';
import { applyTx, ensureCasinoUser, getBalance } from './economy';
import { assertNotBlocked, getCasinoUser } from './users';

/**
 * Bonos gratuitos. Las esperas son por persona (no por servidor): tener muchos servidores no multiplica nada.
 * Cada cobro marca la fecha con un UPDATE condicional dentro de la misma transacción que paga: dos clics o dos
 * servidores a la vez no pueden cobrar dos veces.
 */

export interface BonusResult {
  amount: number;
  balance: number;
  /** Cuándo se puede volver a cobrar. */
  nextAt: number;
  streak: number;
  achievements: Unlocked[];
}

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** Monto del diario con la racha (la racha 1 cobra el monto base). */
export function dailyAmount(base: number, streak: number, pct: number, maxDays: number): number {
  return Math.floor(base * (1 + (Math.min(Math.max(0, streak - 1), maxDays) * pct) / 100));
}

/** Diario: uno por día del casino. Cobrarlo el día siguiente mantiene la racha; saltear un día la reinicia. */
export function claimDaily(ctx: GameContext, userId: string, guildId: string | null): BonusResult {
  return ctx.db.transaction(() => {
    ensureCasinoUser(ctx, userId);
    assertNotBlocked(ctx, userId);
    const cfg = getCasinoConfig(ctx);
    const now = ctx.now();
    const today = casinoDay(cfg, now);
    const tomorrow = casinoDayStart(cfg, now) + DAY;
    const u = getCasinoUser(ctx, userId)!;
    const last = u.lastDailyAt !== null ? casinoDay(cfg, u.lastDailyAt) : null;
    if (last === today) throw new GameError(`Ya cobraste el diario de hoy. Volvé <t:${Math.ceil(tomorrow / 1000)}:R>.`, tomorrow);
    const yesterday = casinoDay(cfg, now - DAY);
    const streak = last === yesterday ? u.dailyStreak + 1 : 1;
    const amount = dailyAmount(cfg.daily.amount, streak, cfg.daily.streakPct, cfg.daily.streakMaxDays);
    const upd = ctx.db.run('UPDATE casino_users SET last_daily_at = ?, daily_streak = ?, last_active_at = ? WHERE user_id = ? AND last_daily_at IS ?',
      now, streak, now, userId, u.lastDailyAt);
    if (upd.changes !== 1) throw new GameError('Ya cobraste el diario de hoy.');
    if (amount > 0) applyTx(ctx, { userId, amount, type: 'BONUS', guildId, key: `daily:${userId}:${today}`, meta: { bonus: 'daily', streak } });
    const achievements = checkAchievements(ctx, userId, { kind: 'daily', streak });
    achievements.push(...checkAchievements(ctx, userId, { kind: 'balance', balance: getBalance(ctx, userId) }));
    return { amount, balance: getBalance(ctx, userId), nextAt: tomorrow, streak, achievements };
  });
}

/** Semanal: cada 7 días desde el último cobro. */
export function claimWeekly(ctx: GameContext, userId: string, guildId: string | null): BonusResult {
  return ctx.db.transaction(() => {
    ensureCasinoUser(ctx, userId);
    assertNotBlocked(ctx, userId);
    const cfg = getCasinoConfig(ctx);
    const now = ctx.now();
    const u = getCasinoUser(ctx, userId)!;
    const ready = u.lastWeeklyAt === null ? 0 : u.lastWeeklyAt + WEEK;
    if (ready > now) throw new GameError(`Ya cobraste el semanal. Volvé <t:${Math.ceil(ready / 1000)}:R>.`, ready);
    const upd = ctx.db.run('UPDATE casino_users SET last_weekly_at = ?, last_active_at = ? WHERE user_id = ? AND (last_weekly_at IS NULL OR last_weekly_at <= ?)',
      now, now, userId, now - WEEK);
    if (upd.changes !== 1) throw new GameError('Ya cobraste el semanal.');
    const amount = cfg.weekly.amount;
    if (amount > 0) applyTx(ctx, { userId, amount, type: 'BONUS', guildId, key: `weekly:${userId}:${now}`, meta: { bonus: 'weekly' } });
    const achievements = checkAchievements(ctx, userId, { kind: 'balance', balance: getBalance(ctx, userId) });
    return { amount, balance: getBalance(ctx, userId), nextAt: now + WEEK, streak: 0, achievements };
  });
}

/**
 * Rescate: para quien se quedó casi sin nada (saldo menor al umbral y sin partidas abiertas, que podrían
 * devolverle dinero). Tiene espera propia, así no sirve para "farmear".
 */
export function claimRescue(ctx: GameContext, userId: string, guildId: string | null): BonusResult {
  return ctx.db.transaction(() => {
    ensureCasinoUser(ctx, userId);
    assertNotBlocked(ctx, userId);
    const cfg = getCasinoConfig(ctx);
    const now = ctx.now();
    const balance = getBalance(ctx, userId);
    if (balance >= cfg.rescue.below) throw new GameError(`El rescate es solo para saldos menores a 🪙 ${cfg.rescue.below.toLocaleString('es-AR')}.`);
    const open = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM casino_rounds WHERE user_id = ? AND status = 'active'", userId)!.n;
    if (open) throw new GameError('Terminá tus partidas abiertas antes de pedir el rescate.');
    const u = getCasinoUser(ctx, userId)!;
    const wait = cfg.rescue.cooldownHours * 3_600_000;
    const ready = u.lastRescueAt === null ? 0 : u.lastRescueAt + wait;
    if (ready > now) throw new GameError(`Ya usaste el rescate. Volvé <t:${Math.ceil(ready / 1000)}:R>.`, ready);
    const upd = ctx.db.run('UPDATE casino_users SET last_rescue_at = ?, last_active_at = ? WHERE user_id = ? AND (last_rescue_at IS NULL OR last_rescue_at <= ?)',
      now, now, userId, now - wait);
    if (upd.changes !== 1) throw new GameError('Ya usaste el rescate.');
    const amount = cfg.rescue.amount;
    if (amount > 0) applyTx(ctx, { userId, amount, type: 'BONUS', guildId, key: `rescue:${userId}:${now}`, meta: { bonus: 'rescue' } });
    return { amount, balance: getBalance(ctx, userId), nextAt: now + wait, streak: 0, achievements: [] };
  });
}

/** Estado de los tres bonos (para !balance y el lobby). */
export function bonusStatus(ctx: GameContext, userId: string): { dailyAt: number; weeklyAt: number; rescueAt: number | null; dailyStreak: number } {
  const cfg = getCasinoConfig(ctx);
  const now = ctx.now();
  const u = getCasinoUser(ctx, userId);
  if (!u) return { dailyAt: 0, weeklyAt: 0, rescueAt: null, dailyStreak: 0 };
  const today = casinoDay(cfg, now);
  const dailyAt = u.lastDailyAt !== null && casinoDay(cfg, u.lastDailyAt) === today ? casinoDayStart(cfg, now) + DAY : 0;
  const weeklyAt = u.lastWeeklyAt === null ? 0 : Math.max(0, u.lastWeeklyAt + WEEK);
  const eligible = u.balance < cfg.rescue.below;
  const rescueAt = eligible ? (u.lastRescueAt === null ? 0 : u.lastRescueAt + cfg.rescue.cooldownHours * 3_600_000) : null;
  // La racha sigue viva si el último diario fue hoy o ayer.
  const last = u.lastDailyAt !== null ? casinoDay(cfg, u.lastDailyAt) : null;
  const alive = last === today || last === casinoDay(cfg, now - DAY);
  return { dailyAt, weeklyAt, rescueAt, dailyStreak: alive ? u.dailyStreak : 0 };
}

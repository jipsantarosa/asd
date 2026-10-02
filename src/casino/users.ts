import { GameError, type GameContext } from '../services/context';
import type { GameId } from './config';
import { COINS, ensureCasinoUser } from './economy';

/** Perfil del jugador y estadísticas. Las actualizaciones se hacen dentro de la transacción de la liquidación. */

export const FLAG_HIDDEN = 1;
export const FLAG_BLOCKED = 2;

export interface CasinoUser {
  userId: string;
  balance: number;
  totalWagered: number;
  totalPayout: number;
  /** Ganancia neta sumada de las rondas ganadas. */
  totalWon: number;
  /** Pérdida neta sumada de las rondas perdidas (incluye pérdidas parciales, como un 0,5x). */
  totalLost: number;
  /** totalWon − totalLost (= retorno − apostado). */
  netProfit: number;
  rounds: number;
  wins: number;
  losses: number;
  pushes: number;
  biggestBet: number;
  biggestPayout: number;
  biggestMultiplier: number;
  currentStreak: number;
  bestStreak: number;
  tournamentsPlayed: number;
  tournamentsWon: number;
  bonusTotal: number;
  levelRewarded: number;
  dailyStreak: number;
  lastDailyAt: number | null;
  lastWeeklyAt: number | null;
  lastRescueAt: number | null;
  activityStreak: number;
  lastActivityDay: string | null;
  lastActivityRewardAt: number | null;
  flags: number;
  createdAt: number;
  lastActiveAt: number;
}

interface RawUser {
  user_id: string; balance: number | null; total_wagered: number; total_payout: number; total_won: number; total_lost: number; net_profit: number;
  rounds: number; wins: number; losses: number; pushes: number; biggest_bet: number; biggest_payout: number; biggest_multiplier: number;
  current_streak: number; best_streak: number; tournaments_played: number; tournaments_won: number; bonus_total: number; level_rewarded: number;
  daily_streak: number; last_daily_at: number | null; last_weekly_at: number | null; last_rescue_at: number | null; activity_streak: number;
  last_activity_day: string | null; last_activity_reward_at: number | null; flags: number; created_at: number; last_active_at: number;
}

const toUser = (r: RawUser): CasinoUser => ({
  userId: r.user_id, balance: r.balance ?? 0, totalWagered: r.total_wagered, totalPayout: r.total_payout, totalWon: r.total_won,
  totalLost: r.total_lost, netProfit: r.net_profit, rounds: r.rounds, wins: r.wins, losses: r.losses, pushes: r.pushes,
  biggestBet: r.biggest_bet, biggestPayout: r.biggest_payout, biggestMultiplier: r.biggest_multiplier, currentStreak: r.current_streak,
  bestStreak: r.best_streak, tournamentsPlayed: r.tournaments_played, tournamentsWon: r.tournaments_won, bonusTotal: r.bonus_total,
  levelRewarded: r.level_rewarded, dailyStreak: r.daily_streak, lastDailyAt: r.last_daily_at, lastWeeklyAt: r.last_weekly_at,
  lastRescueAt: r.last_rescue_at, activityStreak: r.activity_streak, lastActivityDay: r.last_activity_day,
  lastActivityRewardAt: r.last_activity_reward_at, flags: r.flags, createdAt: r.created_at, lastActiveAt: r.last_active_at,
});

export function getCasinoUser(ctx: GameContext, userId: string): CasinoUser | null {
  const r = ctx.db.get<RawUser>(
    `SELECT u.*, w.balance FROM casino_users u LEFT JOIN casino_wallets w ON w.user_id = u.user_id AND w.currency = ? WHERE u.user_id = ?`,
    COINS, userId,
  );
  return r ? toUser(r) : null;
}

/** Perfil (creándolo con el saldo inicial si hace falta). */
export function loadUser(ctx: GameContext, userId: string): CasinoUser {
  ensureCasinoUser(ctx, userId);
  return getCasinoUser(ctx, userId)!;
}

/** Marca actividad y en qué servidor se vio a la persona (para el top del servidor). */
export function touchUser(ctx: GameContext, userId: string, guildId: string | null): void {
  ensureCasinoUser(ctx, userId);
  const now = ctx.now();
  ctx.db.run('UPDATE casino_users SET last_active_at = ? WHERE user_id = ?', now, userId);
  if (guildId) {
    ctx.db.run(`INSERT INTO casino_user_guilds (user_id, guild_id, last_seen) VALUES (?, ?, ?)
                ON CONFLICT (user_id, guild_id) DO UPDATE SET last_seen = excluded.last_seen`, userId, guildId, now);
  }
}

export function hasFlag(ctx: GameContext, userId: string, flag: number): boolean {
  const f = ctx.db.get<{ flags: number }>('SELECT flags FROM casino_users WHERE user_id = ?', userId)?.flags ?? 0;
  return (f & flag) !== 0;
}

export function setFlag(ctx: GameContext, userId: string, flag: number, on: boolean): void {
  ensureCasinoUser(ctx, userId);
  ctx.db.run(`UPDATE casino_users SET flags = ${on ? 'flags | ?' : 'flags & ~?'} WHERE user_id = ?`, flag, userId);
}

export function assertNotBlocked(ctx: GameContext, userId: string): void {
  if (hasFlag(ctx, userId, FLAG_BLOCKED)) throw new GameError('🚫 Tu cuenta del casino está suspendida. Hablá con el dueño del bot.');
}

// ───────────────────────── Niveles y rangos ─────────────────────────

/** El nivel sale de lo apostado: nivel n requiere 2.500 × (n − 1)² Coins apostadas en total. */
export const LEVEL_UNIT = 2_500;
export const MAX_LEVEL = 500;

export function levelFromWagered(wagered: number): number {
  return Math.min(MAX_LEVEL, Math.floor(Math.sqrt(Math.max(0, wagered) / LEVEL_UNIT)) + 1);
}

export function wageredForLevel(level: number): number {
  return LEVEL_UNIT * (level - 1) ** 2;
}

export interface Rank {
  minLevel: number;
  name: string;
  emoji: string;
  color: number;
}

export const RANKS: Rank[] = [
  { minLevel: 1, name: 'Bronce', emoji: '🥉', color: 0xcd7f32 },
  { minLevel: 10, name: 'Plata', emoji: '🥈', color: 0xc0c7d0 },
  { minLevel: 20, name: 'Oro', emoji: '🥇', color: 0xf1c40f },
  { minLevel: 35, name: 'Platino', emoji: '💠', color: 0x5dade2 },
  { minLevel: 50, name: 'Diamante', emoji: '💎', color: 0x9b59b6 },
  { minLevel: 75, name: 'Leyenda', emoji: '👑', color: 0xe74c3c },
];

export function rankFor(level: number): Rank {
  return [...RANKS].reverse().find((r) => level >= r.minLevel) ?? RANKS[0];
}

export function levelProgress(wagered: number): { level: number; from: number; to: number; pct: number } {
  const level = levelFromWagered(wagered);
  const from = wageredForLevel(level);
  const to = wageredForLevel(level + 1);
  return { level, from, to, pct: level >= MAX_LEVEL ? 1 : Math.min(1, (wagered - from) / (to - from)) };
}

// ───────────────────────── Estadísticas de una ronda ─────────────────────────

export type Outcome = 'win' | 'loss' | 'push';

export function outcomeOf(totalBet: number, payout: number): Outcome {
  return payout > totalBet ? 'win' : payout === totalBet ? 'push' : 'loss';
}

/**
 * Suma una ronda liquidada a las estadísticas globales y del juego. Racha: una victoria suma,
 * una derrota la corta y un empate no la cambia. El mayor multiplicador solo cuenta en rondas ganadas.
 */
export function recordRoundStats(ctx: GameContext, r: { userId: string; game: GameId; totalBet: number; payout: number; multiplier: number; at: number }): CasinoUser {
  const outcome = outcomeOf(r.totalBet, r.payout);
  const won = Math.max(0, r.payout - r.totalBet);
  const lost = Math.max(0, r.totalBet - r.payout);
  const mult = outcome === 'win' ? r.multiplier : 0;
  const w = outcome === 'win' ? 1 : 0;
  const l = outcome === 'loss' ? 1 : 0;
  const p = outcome === 'push' ? 1 : 0;
  ctx.db.run(
    `UPDATE casino_users SET
       total_wagered = total_wagered + ?, total_payout = total_payout + ?, total_won = total_won + ?, total_lost = total_lost + ?,
       net_profit = net_profit + ?, rounds = rounds + 1, wins = wins + ?, losses = losses + ?, pushes = pushes + ?,
       biggest_bet = MAX(biggest_bet, ?), biggest_payout = MAX(biggest_payout, ?), biggest_multiplier = MAX(biggest_multiplier, ?),
       current_streak = CASE ? WHEN 'win' THEN current_streak + 1 WHEN 'loss' THEN 0 ELSE current_streak END,
       best_streak = MAX(best_streak, CASE ? WHEN 'win' THEN current_streak + 1 ELSE 0 END),
       last_active_at = ?, updated_at = ?
     WHERE user_id = ?`,
    r.totalBet, r.payout, won, lost, r.payout - r.totalBet, w, l, p, r.totalBet, r.payout, mult, outcome, outcome, r.at, r.at, r.userId,
  );
  ctx.db.run(
    `INSERT INTO casino_game_stats (user_id, game, rounds, wins, losses, pushes, wagered, payout, won, lost, biggest_payout, biggest_multiplier, biggest_bet, last_played_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, game) DO UPDATE SET rounds = rounds + 1, wins = wins + excluded.wins, losses = losses + excluded.losses,
       pushes = pushes + excluded.pushes, wagered = wagered + excluded.wagered, payout = payout + excluded.payout, won = won + excluded.won,
       lost = lost + excluded.lost, biggest_payout = MAX(biggest_payout, excluded.biggest_payout),
       biggest_multiplier = MAX(biggest_multiplier, excluded.biggest_multiplier), biggest_bet = MAX(biggest_bet, excluded.biggest_bet),
       last_played_at = excluded.last_played_at`,
    r.userId, r.game, w, l, p, r.totalBet, r.payout, won, lost, r.payout, mult, r.totalBet, r.at,
  );
  return getCasinoUser(ctx, r.userId)!;
}

export interface GameStats {
  game: GameId;
  rounds: number;
  wins: number;
  losses: number;
  pushes: number;
  wagered: number;
  payout: number;
  won: number;
  lost: number;
  profit: number;
  biggestPayout: number;
  biggestMultiplier: number;
  biggestBet: number;
  lastPlayedAt: number | null;
}

export function gameStats(ctx: GameContext, userId: string): GameStats[] {
  return ctx.db.all<{
    game: GameId; rounds: number; wins: number; losses: number; pushes: number; wagered: number; payout: number; won: number; lost: number;
    biggest_payout: number; biggest_multiplier: number; biggest_bet: number; last_played_at: number | null;
  }>('SELECT * FROM casino_game_stats WHERE user_id = ? ORDER BY rounds DESC', userId).map((r) => ({
    game: r.game, rounds: r.rounds, wins: r.wins, losses: r.losses, pushes: r.pushes, wagered: r.wagered, payout: r.payout, won: r.won,
    lost: r.lost, profit: r.payout - r.wagered, biggestPayout: r.biggest_payout, biggestMultiplier: r.biggest_multiplier,
    biggestBet: r.biggest_bet, lastPlayedAt: r.last_played_at,
  }));
}

/** Juego favorito = el más jugado. */
export function favoriteGame(ctx: GameContext, userId: string): GameId | null {
  return gameStats(ctx, userId)[0]?.game ?? null;
}

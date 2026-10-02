import type { GameContext } from '../services/context';
import type { GameId } from './config';
import { applyTx, COINS } from './economy';
import type { CasinoUser } from './users';

/**
 * Logros del casino. El catálogo vive en el código; en la base solo se guarda quién desbloqueó qué.
 * La recompensa se paga con una clave única por persona y logro: nunca se cobra dos veces.
 */

export type AchievementEvent =
  | { kind: 'round'; game: GameId; totalBet: number; payout: number; multiplier: number; flags: string[]; user: CasinoUser; balance: number }
  | { kind: 'balance'; balance: number }
  | { kind: 'tournament_win' }
  | { kind: 'daily'; streak: number };

export interface AchievementDef {
  id: string;
  emoji: string;
  name: string;
  description: string;
  reward: number;
  /** Lo puede ver todo el mundo antes de conseguirlo (los ocultos se muestran como ❔). */
  hidden?: boolean;
  test(ev: AchievementEvent, ctx: GameContext, userId: string): boolean;
}

const won = (ev: AchievementEvent): ev is Extract<AchievementEvent, { kind: 'round' }> => ev.kind === 'round' && ev.payout > ev.totalBet;
const flag = (f: string) => (ev: AchievementEvent) => ev.kind === 'round' && ev.flags.includes(f);
const balanceOf = (ev: AchievementEvent): number | null => (ev.kind === 'round' || ev.kind === 'balance' ? ev.balance : null);

/** ¿Está entre los primeros N por saldo? (cuenta a lo sumo N filas: barato aunque haya miles de jugadores). */
function inTop(ctx: GameContext, userId: string, balance: number, n: number): boolean {
  if (balance <= 0) return false;
  const above = ctx.db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM (SELECT 1 FROM casino_wallets w JOIN casino_users u ON u.user_id = w.user_id
     WHERE w.currency = ? AND w.balance > ? AND (u.flags & 1) = 0 AND w.user_id <> ? LIMIT ?)`,
    COINS, balance, userId, n,
  )!.c;
  return above < n;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_bet', emoji: '🎲', name: 'Primera apuesta', description: 'Jugá tu primera ronda.', reward: 25, test: (ev) => ev.kind === 'round' },
  { id: 'rounds_100', emoji: '🎰', name: 'Habitué', description: 'Jugá 100 rondas.', reward: 100, test: (ev) => ev.kind === 'round' && ev.user.rounds >= 100 },
  { id: 'rounds_1000', emoji: '🏛️', name: 'Vida de casino', description: 'Jugá 1.000 rondas.', reward: 1_000, test: (ev) => ev.kind === 'round' && ev.user.rounds >= 1_000 },
  { id: 'first_million', emoji: '💰', name: 'Primer millón', description: 'Llegá a 1.000.000 de saldo.', reward: 1_000, test: (ev) => (balanceOf(ev) ?? 0) >= 1_000_000 },
  { id: 'wagered_1m', emoji: '💸', name: 'Gran apostador', description: 'Apostá 1.000.000 en total.', reward: 500, test: (ev) => ev.kind === 'round' && ev.user.totalWagered >= 1_000_000 },
  { id: 'streak_10', emoji: '🔥', name: 'Imparable', description: 'Ganá 10 rondas seguidas.', reward: 500, test: (ev) => ev.kind === 'round' && ev.user.currentStreak >= 10 },
  { id: 'big_100x', emoji: '⚡', name: 'Golpe de suerte', description: 'Ganá con un multiplicador de 100x o más.', reward: 500, test: (ev) => won(ev) && ev.multiplier >= 100 },
  { id: 'crash_10x', emoji: '🚀', name: 'Despegue', description: 'Retirá en 10x o más en Crash.', reward: 250, test: (ev) => won(ev) && ev.game === 'crash' && ev.multiplier >= 10 },
  { id: 'crash_100x', emoji: '🌌', name: 'A la luna', description: 'Retirá en 100x o más en Crash.', reward: 1_000, hidden: true, test: (ev) => won(ev) && ev.game === 'crash' && ev.multiplier >= 100 },
  { id: 'tower_complete', emoji: '🐉', name: 'Domador de dragones', description: 'Completá la Dragon Tower.', reward: 500, test: flag('tower_complete') },
  { id: 'tower_expert', emoji: '🐲', name: 'Leyenda de la torre', description: 'Completá la Dragon Tower en Experto.', reward: 2_500, hidden: true, test: flag('tower_expert') },
  { id: 'mines_extreme', emoji: '💣', name: 'Desactivador', description: 'Ganá en Minas con 20 minas o más.', reward: 500, test: flag('mines_extreme') },
  { id: 'plinko_max', emoji: '🔵', name: 'Borde dorado', description: 'Caé en el multiplicador máximo de Plinko.', reward: 500, test: flag('plinko_max') },
  { id: 'slots_jackpot', emoji: '🎰', name: 'Jackpot', description: 'Ganá el jackpot de Slots.', reward: 1_000, hidden: true, test: flag('jackpot') },
  { id: 'bj_natural', emoji: '🃏', name: 'Blackjack natural', description: 'Sacá un blackjack de entrada.', reward: 100, test: flag('bj_natural') },
  { id: 'hilo_10', emoji: '🔮', name: 'Lectura de cartas', description: 'Acertá 10 cartas seguidas en Hilo.', reward: 250, test: flag('hilo_10') },
  { id: 'chicken_complete', emoji: '🐔', name: 'Cruzó la ruta', description: 'Llevá al pollo hasta el final.', reward: 500, test: flag('chicken_complete') },
  { id: 'balloons_complete', emoji: '🎈', name: 'Sin una aguja', description: 'Completá todos los niveles de Globos.', reward: 500, test: flag('balloons_complete') },
  { id: 'roulette_straight', emoji: '🎡', name: 'Pleno', description: 'Acertá un número en la ruleta.', reward: 100, test: flag('roulette_straight') },
  { id: 'top10', emoji: '👑', name: 'Élite', description: 'Entrá al top 10 de los más ricos.', reward: 500, test: (ev, ctx, uid) => { const b = balanceOf(ev); return b !== null && b >= 10_000 && inTop(ctx, uid, b, 10); } },
  { id: 'tournament_win', emoji: '🏆', name: 'Campeón', description: 'Ganá un torneo.', reward: 1_000, test: (ev) => ev.kind === 'tournament_win' },
  { id: 'daily_7', emoji: '📅', name: 'Constancia', description: 'Cobrá el bono diario 7 días seguidos.', reward: 200, test: (ev) => ev.kind === 'daily' && ev.streak >= 7 },
];

export interface Unlocked {
  def: AchievementDef;
  reward: number;
}

/** Revisa y desbloquea logros para un evento. Se llama dentro de la transacción que lo produjo. */
export function checkAchievements(ctx: GameContext, userId: string, ev: AchievementEvent, roundId: number | null = null): Unlocked[] {
  const have = new Set(ctx.db.all<{ achievement_id: string }>('SELECT achievement_id FROM casino_achievements WHERE user_id = ?', userId).map((r) => r.achievement_id));
  const out: Unlocked[] = [];
  for (const def of ACHIEVEMENTS) {
    if (have.has(def.id) || !def.test(ev, ctx, userId)) continue;
    const inserted = ctx.db.run('INSERT OR IGNORE INTO casino_achievements (user_id, achievement_id, reward, unlocked_at) VALUES (?, ?, ?, ?)',
      userId, def.id, def.reward, ctx.now()).changes === 1;
    if (!inserted) continue;
    if (def.reward > 0) applyTx(ctx, { userId, amount: def.reward, type: 'ACHIEVEMENT_REWARD', roundId, key: `ach:${userId}:${def.id}`, meta: { achievement: def.id } });
    out.push({ def, reward: def.reward });
  }
  return out;
}

export function unlockedAchievements(ctx: GameContext, userId: string): Map<string, number> {
  return new Map(ctx.db.all<{ achievement_id: string; unlocked_at: number }>(
    'SELECT achievement_id, unlocked_at FROM casino_achievements WHERE user_id = ?', userId,
  ).map((r) => [r.achievement_id, r.unlocked_at]));
}

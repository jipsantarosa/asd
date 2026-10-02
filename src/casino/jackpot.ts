import type { GameContext } from '../services/context';
import { getCasinoConfig } from './config';
import { applyTx } from './economy';

/**
 * Jackpot progresivo de Slots. El pozo crece con un % de cada apuesta (no se crea de la nada:
 * solo el monto inicial se emite al arrancar el pozo y al reponerlo después de un premio).
 * Para cobrarlo entero hay que apostar al menos `fullBet`; con menos se cobra la parte proporcional,
 * así nadie caza el pozo con la apuesta mínima.
 */

export const SLOTS_POOL = 'slots_jackpot';

export function jackpotAmount(ctx: GameContext): number {
  const row = ctx.db.get<{ amount: number }>('SELECT amount FROM casino_pools WHERE pool = ?', SLOTS_POOL);
  if (row) return row.amount;
  const seed = getCasinoConfig(ctx).jackpot.seed;
  ctx.db.run('INSERT OR IGNORE INTO casino_pools (pool, amount, updated_at) VALUES (?, ?, ?)', SLOTS_POOL, seed, ctx.now());
  return seed;
}

/** Aporte de una apuesta al pozo. Se llama dentro de la transacción de la apuesta. */
export function contributeJackpot(ctx: GameContext, bet: number): number {
  const pct = getCasinoConfig(ctx).jackpot.contributionPct;
  const amount = Math.floor((bet * pct) / 100);
  if (amount <= 0) return 0;
  jackpotAmount(ctx);
  ctx.db.run('UPDATE casino_pools SET amount = amount + ?, updated_at = ? WHERE pool = ?', amount, ctx.now(), SLOTS_POOL);
  return amount;
}

/** Fracción del pozo que corresponde a una apuesta (1 = entero). */
export function jackpotShare(ctx: GameContext, bet: number): number {
  const full = getCasinoConfig(ctx).jackpot.fullBet;
  return Math.min(1, bet / full);
}

/** Paga el jackpot (o su parte) y repone el pozo al monto inicial si quedó por debajo. Devuelve lo pagado. */
export function payJackpot(ctx: GameContext, userId: string, share: number, roundId: number): number {
  const pool = jackpotAmount(ctx);
  const amount = Math.floor(pool * Math.min(1, Math.max(0, share)));
  if (amount <= 0) return 0;
  applyTx(ctx, { userId, amount, type: 'JACKPOT', game: 'slots', roundId, key: `jackpot:${roundId}`, meta: { share, pool } });
  const seed = getCasinoConfig(ctx).jackpot.seed;
  ctx.db.run('UPDATE casino_pools SET amount = MAX(?, amount - ?), updated_at = ? WHERE pool = ?', seed, amount, ctx.now(), SLOTS_POOL);
  return amount;
}

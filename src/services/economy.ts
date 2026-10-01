import { GameError, fmt, type GameContext } from './context';
import { gameConfig } from './guildSettings';

export function getCoins(ctx: GameContext, guildId: string, userId: string): number {
  return ctx.db.get<{ coins: number }>('SELECT coins FROM profiles WHERE guild_id = ? AND user_id = ?', guildId, userId)?.coins ?? 0;
}

/**
 * Suma o resta monedas de forma atómica y deja registro en el libro contable.
 * Una resta que dejaría el saldo negativo no se aplica.
 */
export function addCoins(ctx: GameContext, guildId: string, userId: string, delta: number, reason: string): number {
  if (!Number.isSafeInteger(delta)) throw new Error(`addCoins: delta inválido ${delta}`);
  if (delta === 0) return getCoins(ctx, guildId, userId);
  const now = ctx.now();
  const r = ctx.db.run(
    'UPDATE profiles SET coins = coins + ?, updated_at = ? WHERE guild_id = ? AND user_id = ? AND coins + ? >= 0',
    delta, now, guildId, userId, delta,
  );
  if (r.changes !== 1) {
    const cfg = gameConfig(ctx, guildId);
    throw new GameError(`No te alcanza: necesitás ${cfg.currency.emoji} ${fmt(-delta)} y tenés ${fmt(getCoins(ctx, guildId, userId))}.`);
  }
  const balance = getCoins(ctx, guildId, userId);
  ctx.db.run(
    'INSERT INTO ledger (guild_id, user_id, delta, balance, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    guildId, userId, delta, balance, reason.slice(0, 120), now,
  );
  return balance;
}

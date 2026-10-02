import { GameError, type GameContext } from '../services/context';
import { getCasinoConfig, saveCasinoConfig } from './config';
import { applyTx, assertCoins, getBalance } from './economy';
import { assertNotBlocked } from './users';

/**
 * Eventos del casino (los lanza el dueño del bot):
 * - Lluvia de monedas: un botón en un canal; las primeras N personas cobran un monto fijo, una vez cada una.
 *   Las cuentas de Discord muy nuevas no pueden cobrar (anti cuentas alternativas).
 * - Boost de actividad: multiplica las Coins por mensajes durante unas horas.
 */

export interface Drop {
  id: number;
  guildId: string;
  channelId: string;
  messageId: string | null;
  amountEach: number;
  maxClaims: number;
  claims: number;
  minAccountDays: number;
  status: 'open' | 'closed';
  createdBy: string;
  createdAt: number;
  expiresAt: number;
}

interface RawDrop {
  id: number; guild_id: string; channel_id: string; message_id: string | null; amount_each: number; max_claims: number; claims: number;
  min_account_days: number; status: 'open' | 'closed'; created_by: string; created_at: number; expires_at: number;
}

const toDrop = (r: RawDrop): Drop => ({
  id: r.id, guildId: r.guild_id, channelId: r.channel_id, messageId: r.message_id, amountEach: r.amount_each, maxClaims: r.max_claims,
  claims: r.claims, minAccountDays: r.min_account_days, status: r.status, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at,
});

export const DROP_LIMITS = { maxAmountEach: 1_000_000, maxClaims: 100, minMinutes: 1, maxMinutes: 1_440 } as const;

export function getDrop(ctx: GameContext, id: number): Drop | null {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const r = ctx.db.get<RawDrop>('SELECT * FROM casino_drops WHERE id = ?', id);
  return r ? toDrop(r) : null;
}

export function createDrop(ctx: GameContext, d: { guildId: string; channelId: string; amountEach: number; maxClaims: number; minutes: number; createdBy: string; minAccountDays?: number }): Drop {
  assertCoins(d.amountEach, 'El monto');
  if (d.amountEach < 1 || d.amountEach > DROP_LIMITS.maxAmountEach) throw new GameError(`El monto por persona va de 1 a ${DROP_LIMITS.maxAmountEach.toLocaleString('es-AR')}.`);
  if (!Number.isSafeInteger(d.maxClaims) || d.maxClaims < 1 || d.maxClaims > DROP_LIMITS.maxClaims) throw new GameError(`Pueden cobrar de 1 a ${DROP_LIMITS.maxClaims} personas.`);
  if (!Number.isSafeInteger(d.minutes) || d.minutes < DROP_LIMITS.minMinutes || d.minutes > DROP_LIMITS.maxMinutes) throw new GameError('La duración va de 1 a 1.440 minutos.');
  const now = ctx.now();
  const r = ctx.db.run(
    `INSERT INTO casino_drops (guild_id, channel_id, amount_each, max_claims, min_account_days, status, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    d.guildId, d.channelId, d.amountEach, d.maxClaims, d.minAccountDays ?? 7, d.createdBy, now, now + d.minutes * 60_000,
  );
  return getDrop(ctx, Number(r.lastInsertRowid))!;
}

export function setDropMessage(ctx: GameContext, id: number, messageId: string): void {
  ctx.db.run('UPDATE casino_drops SET message_id = ? WHERE id = ?', messageId, id);
}

/** Cobro de una lluvia: una vez por persona, hasta agotar los lugares o el tiempo. */
export function claimDrop(ctx: GameContext, id: number, userId: string, accountCreatedAt: number): { drop: Drop; amount: number; balance: number } {
  return ctx.db.transaction(() => {
    const d = getDrop(ctx, id);
    if (!d) throw new GameError('Esa lluvia de monedas ya no existe.');
    const now = ctx.now();
    if (d.status !== 'open' || d.expiresAt <= now || d.claims >= d.maxClaims) throw new GameError('🌧️ Llegaste tarde: esta lluvia de monedas ya terminó.');
    if (now - accountCreatedAt < d.minAccountDays * 86_400_000) throw new GameError(`Tu cuenta de Discord tiene que tener al menos ${d.minAccountDays} días para cobrar.`);
    assertNotBlocked(ctx, userId);
    const inserted = ctx.db.run('INSERT OR IGNORE INTO casino_drop_claims (drop_id, user_id, amount, claimed_at) VALUES (?, ?, ?, ?)', id, userId, d.amountEach, now).changes === 1;
    if (!inserted) throw new GameError('Ya cobraste esta lluvia de monedas.');
    const upd = ctx.db.run("UPDATE casino_drops SET claims = claims + 1, status = CASE WHEN claims + 1 >= max_claims THEN 'closed' ELSE status END WHERE id = ? AND status = 'open' AND claims < max_claims", id);
    if (upd.changes !== 1) throw new GameError('🌧️ Llegaste tarde: esta lluvia de monedas ya terminó.');
    applyTx(ctx, { userId, amount: d.amountEach, type: 'DROP', guildId: d.guildId, key: `drop:${id}:${userId}`, meta: { drop: id } });
    return { drop: getDrop(ctx, id)!, amount: d.amountEach, balance: getBalance(ctx, userId) };
  });
}

export function dropClaimers(ctx: GameContext, id: number, limit = 20): string[] {
  return ctx.db.all<{ user_id: string }>('SELECT user_id FROM casino_drop_claims WHERE drop_id = ? ORDER BY claimed_at LIMIT ?', id, limit).map((r) => r.user_id);
}

/** Cierra las lluvias vencidas y devuelve las que hay que actualizar en Discord. */
export function closeExpiredDrops(ctx: GameContext): Drop[] {
  const now = ctx.now();
  const due = ctx.db.all<RawDrop>("SELECT * FROM casino_drops WHERE status = 'open' AND expires_at <= ?", now).map(toDrop);
  for (const d of due) ctx.db.run("UPDATE casino_drops SET status = 'closed' WHERE id = ? AND status = 'open'", d.id);
  return due.map((d) => ({ ...d, status: 'closed' as const }));
}

/** Boost de Coins por actividad (×1 a ×5) durante unas horas. */
export function setActivityBoost(ctx: GameContext, multiplier: number, hours: number, actorId: string): { multiplier: number; until: number } {
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 5) throw new GameError('El boost va de 1x a 5x.');
  if (!Number.isFinite(hours) || hours <= 0 || hours > 72) throw new GameError('La duración del boost va de 1 a 72 horas.');
  const cfg = structuredClone(getCasinoConfig(ctx));
  cfg.boost = { activity: Math.round(multiplier * 10) / 10, until: ctx.now() + Math.round(hours * 3_600_000) };
  const saved = saveCasinoConfig(ctx, cfg, actorId);
  return { multiplier: saved.boost.activity, until: saved.boost.until };
}

import { GameError, type GameContext } from '../services/context';
import { applyTx, assertCoins, ensureCasinoUser, getBalance, type TxRecord } from './economy';

/**
 * Acciones del dueño del bot sobre la economía. Todo ajuste de saldo es una transacción ADMIN_ADJUSTMENT
 * (queda en el historial de la persona con quién lo hizo y por qué) y además se anota en el registro administrativo.
 */

export interface AdminLogEntry {
  id: number;
  actorId: string;
  action: string;
  targetId: string | null;
  details: string | null;
  guildId: string | null;
  createdAt: number;
}

export function logAdmin(ctx: GameContext, e: { actorId: string; action: string; targetId?: string | null; details?: unknown; guildId?: string | null }): void {
  const details = e.details === undefined || e.details === null ? null : typeof e.details === 'string' ? e.details : JSON.stringify(e.details);
  ctx.db.run('INSERT INTO casino_admin_log (actor_id, action, target_id, details, guild_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    e.actorId, e.action.slice(0, 64), e.targetId ?? null, details?.slice(0, 1000) ?? null, e.guildId ?? null, ctx.now());
}

export function adminLog(ctx: GameContext, limit = 15, targetId?: string): AdminLogEntry[] {
  const rows = targetId
    ? ctx.db.all<{ id: number; actor_id: string; action: string; target_id: string | null; details: string | null; guild_id: string | null; created_at: number }>(
      'SELECT * FROM casino_admin_log WHERE target_id = ? ORDER BY id DESC LIMIT ?', targetId, Math.max(1, Math.min(50, limit)))
    : ctx.db.all<{ id: number; actor_id: string; action: string; target_id: string | null; details: string | null; guild_id: string | null; created_at: number }>(
      'SELECT * FROM casino_admin_log ORDER BY id DESC LIMIT ?', Math.max(1, Math.min(50, limit)));
  return rows.map((r) => ({ id: r.id, actorId: r.actor_id, action: r.action, targetId: r.target_id, details: r.details, guildId: r.guild_id, createdAt: r.created_at }));
}

export type AdjustMode = 'add' | 'remove' | 'set';

/** Suma, resta o fija el saldo de alguien. Restar más de lo que tiene es un error (nunca deja saldo negativo). */
export function adjustBalance(ctx: GameContext, a: { actorId: string; targetId: string; mode: AdjustMode; amount: number; reason: string; guildId: string | null }): { tx: TxRecord | null; before: number; after: number } {
  assertCoins(a.amount, 'La cantidad');
  const reason = a.reason.trim().slice(0, 200) || 'sin motivo';
  return ctx.db.transaction(() => {
    ensureCasinoUser(ctx, a.targetId);
    const before = getBalance(ctx, a.targetId);
    const delta = a.mode === 'add' ? a.amount : a.mode === 'remove' ? -a.amount : a.amount - before;
    if (a.mode !== 'set' && a.amount === 0) throw new GameError('La cantidad tiene que ser mayor a 0.');
    if (before + delta < 0) throw new GameError(`No se puede: le quedaría saldo negativo (tiene 🪙 ${before.toLocaleString('es-AR')}).`);
    const tx = delta === 0 ? null : applyTx(ctx, {
      userId: a.targetId, amount: delta, type: 'ADMIN_ADJUSTMENT', guildId: a.guildId, meta: { by: a.actorId, mode: a.mode, reason },
    });
    logAdmin(ctx, { actorId: a.actorId, action: `balance.${a.mode}`, targetId: a.targetId, details: { amount: a.amount, delta, before, after: before + delta, reason }, guildId: a.guildId });
    return { tx, before, after: before + delta };
  });
}

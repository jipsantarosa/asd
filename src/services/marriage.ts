import { GameError, type GameContext } from './context';

/**
 * Casamientos: una pareja por persona (en todos los servidores). Se propone con !marry y la otra persona
 * acepta o rechaza con botones. Cada respuesta es un UPDATE condicional y la base no permite dos parejas
 * para la misma persona (índices únicos): dos aceptaciones a la vez no pueden casar a nadie dos veces.
 */

export const PROPOSAL_TTL_MS = 10 * 60_000;
const SNOWFLAKE = /^\d{17,20}$/;

export interface Marriage {
  partnerId: string;
  since: number;
  guildId: string | null;
}

export interface Proposal {
  id: number;
  guildId: string;
  proposerId: string;
  targetId: string;
  status: 'open' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
  createdAt: number;
}

const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export function getMarriage(ctx: GameContext, userId: string): Marriage | null {
  const r = ctx.db.get<{ user_a: string; user_b: string; married_at: number; guild_id: string | null }>(
    'SELECT * FROM marriages WHERE user_a = ? OR user_b = ?', userId, userId,
  );
  return r ? { partnerId: r.user_a === userId ? r.user_b : r.user_a, since: r.married_at, guildId: r.guild_id } : null;
}

export function getProposal(ctx: GameContext, id: number): Proposal | null {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const r = ctx.db.get<{ id: number; guild_id: string; proposer_id: string; target_id: string; status: Proposal['status']; created_at: number }>(
    'SELECT * FROM marriage_proposals WHERE id = ?', id,
  );
  return r ? { id: r.id, guildId: r.guild_id, proposerId: r.proposer_id, targetId: r.target_id, status: r.status, createdAt: r.created_at } : null;
}

/** Vence las propuestas abiertas viejas (se llama antes de leer o crear). */
function expireOld(ctx: GameContext): void {
  ctx.db.run("UPDATE marriage_proposals SET status = 'expired', answered_at = ? WHERE status = 'open' AND created_at <= ?", ctx.now(), ctx.now() - PROPOSAL_TTL_MS);
}

export function propose(ctx: GameContext, guildId: string, proposerId: string, targetId: string): Proposal {
  if (!SNOWFLAKE.test(proposerId) || !SNOWFLAKE.test(targetId)) throw new GameError('Usuario inválido.');
  if (proposerId === targetId) throw new GameError('No te podés casar con vos mismo. 💍');
  return ctx.db.transaction(() => {
    expireOld(ctx);
    if (getMarriage(ctx, proposerId)) throw new GameError('Ya estás casado/a. Primero usá `divorce`.');
    if (getMarriage(ctx, targetId)) throw new GameError('Esa persona ya está casada.');
    const open = ctx.db.get<{ id: number }>("SELECT id FROM marriage_proposals WHERE proposer_id = ? AND status = 'open'", proposerId);
    if (open) throw new GameError('Ya tenés una propuesta esperando respuesta. Esperá a que la contesten (o que venza en 10 minutos).');
    const r = ctx.db.run("INSERT INTO marriage_proposals (guild_id, proposer_id, target_id, status, created_at) VALUES (?, ?, ?, 'open', ?)",
      guildId, proposerId, targetId, ctx.now());
    return getProposal(ctx, Number(r.lastInsertRowid))!;
  });
}

/** Responde una propuesta. Solo la persona a la que se le propuso; una sola vez. */
export function answerProposal(ctx: GameContext, id: number, userId: string, accept: boolean): Proposal {
  return ctx.db.transaction(() => {
    expireOld(ctx);
    const p = getProposal(ctx, id);
    if (!p) throw new GameError('Esa propuesta ya no existe.');
    if (p.targetId !== userId) throw new GameError('Esta propuesta no es para vos. 💍');
    if (p.status === 'expired') throw new GameError('Esa propuesta venció.');
    if (p.status !== 'open') throw new GameError('Esa propuesta ya fue respondida.');
    if (accept) {
      if (getMarriage(ctx, p.proposerId)) throw new GameError('Quien te propuso ya se casó con otra persona.');
      if (getMarriage(ctx, p.targetId)) throw new GameError('Ya estás casado/a.');
    }
    const upd = ctx.db.run("UPDATE marriage_proposals SET status = ?, answered_at = ? WHERE id = ? AND status = 'open'", accept ? 'accepted' : 'rejected', ctx.now(), id);
    if (upd.changes !== 1) throw new GameError('Esa propuesta ya fue respondida.');
    if (accept) {
      const [a, b] = pair(p.proposerId, p.targetId);
      ctx.db.run('INSERT INTO marriages (user_a, user_b, guild_id, married_at) VALUES (?, ?, ?, ?)', a, b, p.guildId, ctx.now());
    }
    return getProposal(ctx, id)!;
  });
}

export function cancelProposal(ctx: GameContext, id: number, userId: string): void {
  const upd = ctx.db.run("UPDATE marriage_proposals SET status = 'cancelled', answered_at = ? WHERE id = ? AND proposer_id = ? AND status = 'open'", ctx.now(), id, userId);
  if (upd.changes !== 1) throw new GameError('Esa propuesta ya no está abierta.');
}

export function divorce(ctx: GameContext, userId: string): Marriage {
  return ctx.db.transaction(() => {
    const m = getMarriage(ctx, userId);
    if (!m) throw new GameError('No estás casado/a.');
    const [a, b] = pair(userId, m.partnerId);
    ctx.db.run('DELETE FROM marriages WHERE user_a = ? AND user_b = ?', a, b);
    return m;
  });
}

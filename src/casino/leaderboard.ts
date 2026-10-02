import type { GameContext } from '../services/context';
import { COINS } from './economy';
import { FLAG_BLOCKED, FLAG_HIDDEN } from './users';

/**
 * Rankings del casino. El principal es "💰 Más ricos" (saldo actual); los demás son categorías secundarias.
 * Alcance: global (todos los servidores) o solo quienes jugaron en un servidor. Las cuentas ocultas o
 * suspendidas por el dueño no aparecen. Los empates se ordenan por antigüedad de la cuenta (y luego por ID),
 * con el mismo criterio en la lista y en la posición personal: los números siempre coinciden.
 */

export const TOP_CATEGORIES = ['richest', 'profit', 'wagered', 'won', 'biggest', 'multiplier', 'streak', 'tournaments', 'rounds'] as const;
export type TopCategory = (typeof TOP_CATEGORIES)[number];

export interface TopMeta {
  label: string;
  emoji: string;
  title: string;
  /** Expresión SQL del valor (sobre casino_users u y casino_wallets w). */
  sql: string;
  kind: 'coins' | 'multiplier' | 'count';
  aliases: string[];
  /** Solo valores > 0 (en ganancia neta también aparecen los negativos). */
  positiveOnly: boolean;
}

export const TOP_META: Record<TopCategory, TopMeta> = {
  richest: { label: 'Más ricos', emoji: '💰', title: '💰 Richest Players', sql: 'COALESCE(w.balance, 0)', kind: 'coins', aliases: ['ricos', 'saldo', 'balance', 'rich', 'dinero', 'coins'], positiveOnly: true },
  profit: { label: 'Beneficio neto', emoji: '📈', title: '📈 Mayor beneficio histórico', sql: 'u.net_profit', kind: 'coins', aliases: ['beneficio', 'ganancia', 'neto', 'profit'], positiveOnly: false },
  wagered: { label: 'Más apostado', emoji: '💸', title: '💸 Los que más apostaron', sql: 'u.total_wagered', kind: 'coins', aliases: ['apostado', 'apuestas', 'nivel', 'wagered'], positiveOnly: true },
  won: { label: 'Total ganado', emoji: '🏦', title: '🏦 Los que más ganaron', sql: 'u.total_won', kind: 'coins', aliases: ['ganado', 'ganancias', 'won'], positiveOnly: true },
  biggest: { label: 'Mayor premio', emoji: '💎', title: '💎 Mayor premio en una ronda', sql: 'u.biggest_payout', kind: 'coins', aliases: ['premio', 'mayor', 'biggest', 'win'], positiveOnly: true },
  multiplier: { label: 'Mayor multiplicador', emoji: '✖️', title: '✖️ Mayor multiplicador', sql: 'u.biggest_multiplier', kind: 'multiplier', aliases: ['multi', 'multiplicador', 'x'], positiveOnly: true },
  streak: { label: 'Mejor racha', emoji: '🔥', title: '🔥 Mejor racha de victorias', sql: 'u.best_streak', kind: 'count', aliases: ['racha', 'streak'], positiveOnly: true },
  tournaments: { label: 'Torneos ganados', emoji: '🏆', title: '🏆 Campeones de torneos', sql: 'u.tournaments_won', kind: 'count', aliases: ['torneos', 'tournaments', 'campeones'], positiveOnly: true },
  rounds: { label: 'Más partidas', emoji: '🎲', title: '🎲 Los que más jugaron', sql: 'u.rounds', kind: 'count', aliases: ['partidas', 'rondas', 'rounds', 'jugadas'], positiveOnly: true },
};

export function parseTopCategory(raw: string | null | undefined): TopCategory | null {
  if (!raw) return null;
  const v = raw.toLowerCase();
  for (const id of TOP_CATEGORIES) if (id === v || TOP_META[id].aliases.includes(v)) return id;
  return null;
}

export const TOP_PAGE_SIZE = 10;

export interface TopRow {
  rank: number;
  userId: string;
  value: number;
}

export interface TopPage {
  rows: TopRow[];
  total: number;
  page: number;
  pages: number;
}

function scope(guildId: string | null): { sql: string; args: string[] } {
  return guildId
    ? { sql: 'AND u.user_id IN (SELECT user_id FROM casino_user_guilds WHERE guild_id = ?)', args: [guildId] }
    : { sql: '', args: [] };
}

const FROM = `FROM casino_users u LEFT JOIN casino_wallets w ON w.user_id = u.user_id AND w.currency = '${COINS}'`;
const VISIBLE = `(u.flags & ${FLAG_HIDDEN | FLAG_BLOCKED}) = 0`;

/** Página del ranking (0 = primera). */
export function topPage(ctx: GameContext, cat: TopCategory, opts: { guildId?: string | null; page?: number; size?: number } = {}): TopPage {
  const m = TOP_META[cat];
  const size = Math.max(1, Math.min(25, opts.size ?? TOP_PAGE_SIZE));
  const sc = scope(opts.guildId ?? null);
  const where = `WHERE ${VISIBLE} ${m.positiveOnly ? `AND ${m.sql} > 0` : 'AND u.rounds > 0'} ${sc.sql}`;
  const total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n ${FROM} ${where}`, ...sc.args)!.n;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(0, Math.floor(opts.page ?? 0)), pages - 1);
  const rows = ctx.db.all<{ user_id: string; value: number }>(
    `SELECT u.user_id, ${m.sql} AS value ${FROM} ${where} ORDER BY value DESC, u.created_at ASC, u.user_id ASC LIMIT ? OFFSET ?`,
    ...sc.args, size, page * size,
  );
  return { rows: rows.map((r, i) => ({ rank: page * size + i + 1, userId: r.user_id, value: r.value })), total, page, pages };
}

/** Posición de una persona en un ranking (null si no figura: oculta, sin partidas o con valor 0). */
export function rankOf(ctx: GameContext, cat: TopCategory, userId: string, guildId: string | null = null): { rank: number | null; value: number; total: number } {
  const m = TOP_META[cat];
  const sc = scope(guildId);
  const me = ctx.db.get<{ value: number; created_at: number; flags: number; rounds: number }>(
    `SELECT ${m.sql} AS value, u.created_at, u.flags, u.rounds ${FROM} WHERE u.user_id = ?`, userId,
  );
  const where = `WHERE ${VISIBLE} ${m.positiveOnly ? `AND ${m.sql} > 0` : 'AND u.rounds > 0'} ${sc.sql}`;
  const total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n ${FROM} ${where}`, ...sc.args)!.n;
  if (!me) return { rank: null, value: 0, total };
  const listed = (me.flags & (FLAG_HIDDEN | FLAG_BLOCKED)) === 0 && (m.positiveOnly ? me.value > 0 : me.rounds > 0)
    && (!guildId || !!ctx.db.get('SELECT 1 FROM casino_user_guilds WHERE user_id = ? AND guild_id = ?', userId, guildId));
  if (!listed) return { rank: null, value: me.value, total };
  const ahead = ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n ${FROM} ${where} AND (${m.sql} > ? OR (${m.sql} = ? AND (u.created_at < ? OR (u.created_at = ? AND u.user_id < ?))))`,
    ...sc.args, me.value, me.value, me.created_at, me.created_at, userId,
  )!.n;
  return { rank: ahead + 1, value: me.value, total };
}

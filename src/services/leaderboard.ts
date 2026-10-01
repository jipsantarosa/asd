import type { GameContext } from './context';

export type TopCategory = 'total' | 'actividad' | 'granja' | 'pesca' | 'monedas' | 'coleccion';
export const TOP_CATEGORIES: TopCategory[] = ['total', 'actividad', 'granja', 'pesca', 'monedas', 'coleccion'];

export const TOP_META: Record<TopCategory, { label: string; emoji: string; unit: string }> = {
  total: { label: 'Nivel total', emoji: '⭐', unit: 'nv.' },
  actividad: { label: 'Actividad', emoji: '🔥', unit: 'pts' },
  granja: { label: 'Granja', emoji: '🌾', unit: 'nv.' },
  pesca: { label: 'Pesca', emoji: '🎣', unit: 'nv.' },
  monedas: { label: 'Fortuna', emoji: '🪙', unit: '' },
  coleccion: { label: 'Colección', emoji: '📖', unit: 'especies' },
};

export interface TopEntry {
  rank: number;
  userId: string;
  value: number;
  /** Desempate / dato secundario (XP acumulada en la categoría, cosechas, etc.). */
  detail: number;
}

/** Valor y desempate de cada categoría, en SQL (solo expresiones fijas, nunca texto del usuario). */
const EXPR: Record<TopCategory, { value: string; tie: string }> = {
  total: { value: 'p.farm_level + p.fish_level', tie: 'p.farm_xp + p.fish_xp' },
  actividad: { value: 'p.activity_points', tie: 'p.farms_total + p.catches_total' },
  granja: { value: 'p.farm_level', tie: 'p.farm_xp' },
  pesca: { value: 'p.fish_level', tie: 'p.fish_xp' },
  monedas: { value: 'p.coins', tie: 'p.farms_total + p.catches_total' },
  coleccion: { value: '(SELECT COUNT(*) FROM fish_log f WHERE f.guild_id = p.guild_id AND f.user_id = p.user_id)', tie: 'p.catches_total' },
};

function rankedSql(cat: TopCategory): string {
  const e = EXPR[cat];
  return `WITH ranked AS (
    SELECT p.user_id AS userId, ${e.value} AS value, ${e.tie} AS detail,
           ROW_NUMBER() OVER (ORDER BY ${e.value} DESC, ${e.tie} DESC, p.created_at ASC) AS rank
    FROM profiles p
    WHERE p.guild_id = ? AND (p.farms_total > 0 OR p.catches_total > 0)
  )`;
}

function check(cat: string): TopCategory {
  if (!(TOP_CATEGORIES as string[]).includes(cat)) throw new Error(`Categoría de ranking inválida: ${cat}`);
  return cat as TopCategory;
}

/** Los mejores jugadores del servidor en una categoría. Solo cuenta a quien jugó al menos una vez. */
export function leaderboard(ctx: GameContext, guildId: string, category: string, limit = 10): TopEntry[] {
  const cat = check(category);
  const n = Math.max(1, Math.min(50, Math.floor(limit)));
  return ctx.db.all<TopEntry>(`${rankedSql(cat)} SELECT userId, value, detail, rank FROM ranked ORDER BY rank LIMIT ?`, guildId, n);
}

/** Posición de un jugador (null si todavía no jugó). */
export function rankOf(ctx: GameContext, guildId: string, userId: string, category: string): TopEntry | null {
  const cat = check(category);
  return ctx.db.get<TopEntry>(`${rankedSql(cat)} SELECT userId, value, detail, rank FROM ranked WHERE userId = ?`, guildId, userId) ?? null;
}

export function playerCount(ctx: GameContext, guildId: string): number {
  return ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM profiles WHERE guild_id = ? AND (farms_total > 0 OR catches_total > 0)', guildId)!.n;
}

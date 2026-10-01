import type { GameContext } from './context';
import { isGhost } from './premium';

export type ViewKind = 'avatar' | 'banner' | 'names' | 'tags';

/**
 * Registra que alguien miró el historial de otra persona (para !mstats).
 * No se registra: mirarse a uno mismo, ni a quien tiene !ghostmode activo (Tier 4).
 * Para no inflar el contador, la misma persona mirando lo mismo cuenta una vez cada 10 minutos.
 */
export function logView(ctx: GameContext, viewerId: string, targetId: string, kind: ViewKind, guildId: string | null): boolean {
  if (viewerId === targetId || isGhost(ctx, viewerId)) return false;
  const recent = ctx.db.get<{ id: number }>(
    'SELECT id FROM history_views WHERE target_id = ? AND viewer_id = ? AND kind = ? AND viewed_at > ?',
    targetId, viewerId, kind, ctx.now() - 600_000,
  );
  if (recent) return false;
  ctx.db.run('INSERT INTO history_views (target_id, viewer_id, kind, guild_id, viewed_at) VALUES (?, ?, ?, ?, ?)', targetId, viewerId, kind, guildId, ctx.now());
  return true;
}

export interface ViewStats {
  /** Personas distintas que miraron alguno de tus historiales. */
  people: number;
  total: number;
  byKind: Record<ViewKind, number>;
  /** Últimas 10 personas (la vista más reciente de cada una). Solo para Tier 3+. */
  recent: { viewerId: string; kind: ViewKind; viewedAt: number }[];
}

export function viewStats(ctx: GameContext, targetId: string): ViewStats {
  const people = ctx.db.get<{ n: number }>('SELECT COUNT(DISTINCT viewer_id) AS n FROM history_views WHERE target_id = ?', targetId)!.n;
  const total = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM history_views WHERE target_id = ?', targetId)!.n;
  const byKind = { avatar: 0, banner: 0, names: 0, tags: 0 } as Record<ViewKind, number>;
  for (const r of ctx.db.all<{ kind: ViewKind; n: number }>('SELECT kind, COUNT(DISTINCT viewer_id) AS n FROM history_views WHERE target_id = ? GROUP BY kind', targetId)) byKind[r.kind] = r.n;
  const recent = ctx.db.all<{ viewer_id: string; kind: ViewKind; viewed_at: number }>(
    `SELECT h.viewer_id, h.kind, h.viewed_at FROM history_views h
     JOIN (SELECT viewer_id, MAX(viewed_at) AS last FROM history_views WHERE target_id = ? GROUP BY viewer_id) l
       ON l.viewer_id = h.viewer_id AND l.last = h.viewed_at
     WHERE h.target_id = ? ORDER BY h.viewed_at DESC LIMIT 10`,
    targetId, targetId,
  ).map((r) => ({ viewerId: r.viewer_id, kind: r.kind, viewedAt: r.viewed_at }));
  return { people, total, byKind, recent };
}

/** Si un usuario activa ghostmode, sus vistas anteriores también dejan de mostrarse. */
export function hideViewsOf(ctx: GameContext, viewerId: string): number {
  return ctx.db.run('DELETE FROM history_views WHERE viewer_id = ?', viewerId).changes;
}

import type { GameContext } from './context';

export type NameKind = 'username' | 'display' | 'nick' | 'tag';

export interface NameEntry {
  kind: NameKind;
  scope: string;
  value: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

/**
 * Registra un nombre visto (usuario, nombre visible, apodo en un servidor o tag de servidor).
 * UPSERT: sin duplicados; si vuelve a usar uno anterior, se actualiza "visto por última vez".
 * Solo lo que el bot ve: nunca historial inventado. Devuelve true si es nuevo.
 */
export function recordName(ctx: GameContext, userId: string, kind: NameKind, value: string | null | undefined, scope = ''): boolean {
  const v = value?.trim();
  if (!v || v.length > 64 || !/^\d{17,20}$/.test(userId)) return false;
  const now = ctx.now();
  const r = ctx.db.run(
    `INSERT INTO user_names (user_id, kind, scope, value, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, kind, scope, value) DO NOTHING`,
    userId, kind, scope, v, now, now,
  );
  if (r.changes === 1) return true;
  ctx.db.run('UPDATE user_names SET last_seen_at = ? WHERE user_id = ? AND kind = ? AND scope = ? AND value = ? AND last_seen_at < ?', now, userId, kind, scope, v, now);
  return false;
}

export function nameHistory(ctx: GameContext, userId: string, kinds: NameKind[], scope?: string, limit = 50): NameEntry[] {
  const marks = kinds.map(() => '?').join(', ');
  const rows = ctx.db.all<{ kind: NameKind; scope: string; value: string; first_seen_at: number; last_seen_at: number }>(
    `SELECT kind, scope, value, first_seen_at, last_seen_at FROM user_names
     WHERE user_id = ? AND kind IN (${marks}) ${scope !== undefined ? 'AND scope = ?' : ''}
     ORDER BY last_seen_at DESC, first_seen_at DESC LIMIT ?`,
    userId, ...kinds, ...(scope !== undefined ? [scope] : []), Math.max(1, Math.min(200, limit)),
  );
  return rows.map((r) => ({ kind: r.kind, scope: r.scope, value: r.value, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at }));
}

/** Borra el historial propio de nombres o tags. Devuelve cuántos registros se borraron. */
export function clearNames(ctx: GameContext, userId: string, kinds: NameKind[]): number {
  const marks = kinds.map(() => '?').join(', ');
  return ctx.db.run(`DELETE FROM user_names WHERE user_id = ? AND kind IN (${marks})`, userId, ...kinds).changes;
}

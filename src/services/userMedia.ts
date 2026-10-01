import type { GameContext } from './context';

export type MediaKind = 'avatar' | 'banner';

export interface MediaEntry {
  hash: string;
  url: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

const HASH = /^(a_)?[0-9a-f]{32}$/;

/** URL de la CDN de Discord para un hash (GIF si es animado). */
export function mediaUrl(kind: MediaKind, userId: string, hash: string, size = 1024): string {
  const ext = hash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/${kind === 'avatar' ? 'avatars' : 'banners'}/${userId}/${hash}.${ext}?size=${size}`;
}

/**
 * Registra una imagen vista. Es un UPSERT: la misma imagen no se duplica y, si vuelve a usarse,
 * solo se actualiza "vista por última vez". Devuelve true si es una imagen nueva para el historial.
 * Nunca se inventa historial: solo se guarda lo que el bot ve.
 */
export function recordMedia(ctx: GameContext, userId: string, kind: MediaKind, hash: string | null | undefined, guildId: string | null = null): boolean {
  if (!hash || !HASH.test(hash) || !/^\d{17,20}$/.test(userId)) return false;
  const now = ctx.now();
  const r = ctx.db.run(
    `INSERT INTO user_media (user_id, kind, hash, url, guild_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, kind, hash) DO NOTHING`,
    userId, kind, hash, mediaUrl(kind, userId, hash), guildId, now, now,
  );
  if (r.changes === 1) return true;
  ctx.db.run('UPDATE user_media SET last_seen_at = ? WHERE user_id = ? AND kind = ? AND hash = ? AND last_seen_at < ?', now, userId, kind, hash, now);
  return false;
}

/** Historial, del más reciente al más antiguo (por última vez visto). */
export function mediaHistory(ctx: GameContext, userId: string, kind: MediaKind, limit = 50): MediaEntry[] {
  return ctx.db.all<{ hash: string; url: string; first_seen_at: number; last_seen_at: number }>(
    'SELECT hash, url, first_seen_at, last_seen_at FROM user_media WHERE user_id = ? AND kind = ? ORDER BY last_seen_at DESC, first_seen_at DESC LIMIT ?',
    userId, kind, Math.max(1, Math.min(200, limit)),
  ).map((r) => ({ hash: r.hash, url: r.url, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at }));
}

/** Desde cuándo registra el bot (primera fila guardada de cualquier usuario). */
export function trackingSince(ctx: GameContext): number | null {
  return ctx.db.get<{ t: number | null }>('SELECT MIN(first_seen_at) AS t FROM user_media')?.t ?? null;
}

/** Borra el historial propio de avatares y/o banners (premium). Devuelve cuántas imágenes se borraron. */
export function clearMedia(ctx: GameContext, userId: string, kinds: MediaKind[]): number {
  const marks = kinds.map(() => '?').join(', ');
  return ctx.db.run(`DELETE FROM user_media WHERE user_id = ? AND kind IN (${marks})`, userId, ...kinds).changes;
}

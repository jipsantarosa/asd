import type { GameContext } from './context';
import type { MediaKind } from './userMedia';

/**
 * Archivo de imágenes del historial de avatares y banners (tabla user_media_files).
 * Discord borra de su CDN la imagen vieja cuando alguien cambia de avatar: por eso se guarda la imagen misma.
 */

export const MAX_ATTEMPTS = 5;
/** Tamaño máximo por imagen guardada (un GIF animado grande no se guarda entero). */
export const MAX_FILE_BYTES = 4_000_000;

export interface StoredMedia {
  png: Buffer | null;
  gif: Buffer | null;
}

const buf = (v: unknown): Buffer | null => (v == null ? null : Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v) : null);

export function getMediaFile(ctx: GameContext, userId: string, kind: MediaKind, hash: string): StoredMedia | null {
  const r = ctx.db.get<{ png: unknown; gif: unknown }>("SELECT png, gif FROM user_media_files WHERE user_id = ? AND kind = ? AND hash = ? AND status = 'ok'", userId, kind, hash);
  if (!r) return null;
  const png = buf(r.png);
  return png ? { png, gif: buf(r.gif) } : null;
}

export function mediaFileStatus(ctx: GameContext, userId: string, kind: MediaKind, hash: string): 'ok' | 'pending' | 'gone' | null {
  return ctx.db.get<{ status: 'ok' | 'pending' | 'gone' }>('SELECT status FROM user_media_files WHERE user_id = ? AND kind = ? AND hash = ?', userId, kind, hash)?.status ?? null;
}

export function saveMediaFile(ctx: GameContext, userId: string, kind: MediaKind, hash: string, png: Buffer, gif: Buffer | null): void {
  ctx.db.run(
    `INSERT INTO user_media_files (user_id, kind, hash, status, png, gif, attempts, saved_at) VALUES (?, ?, ?, 'ok', ?, ?, 0, ?)
     ON CONFLICT (user_id, kind, hash) DO UPDATE SET status = 'ok', png = excluded.png, gif = excluded.gif, saved_at = excluded.saved_at`,
    userId, kind, hash, png, gif && gif.length <= MAX_FILE_BYTES ? gif : null, ctx.now(),
  );
}

/** Un intento fallido: después de MAX_ATTEMPTS (o si Discord dijo "no existe"), queda como 'gone'. */
export function markMediaFailed(ctx: GameContext, userId: string, kind: MediaKind, hash: string, gone: boolean): void {
  ctx.db.run(
    `INSERT INTO user_media_files (user_id, kind, hash, status, attempts, saved_at) VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT (user_id, kind, hash) DO UPDATE SET attempts = attempts + 1,
       status = CASE WHEN user_media_files.status = 'ok' THEN 'ok' WHEN ? OR user_media_files.attempts + 1 >= ? THEN 'gone' ELSE 'pending' END,
       saved_at = excluded.saved_at`,
    userId, kind, hash, gone ? 'gone' : 'pending', ctx.now(), gone ? 1 : 0, MAX_ATTEMPTS,
  );
}

/** Imágenes del historial que todavía no se guardaron (ni se sabe que desaparecieron). */
export function unarchivedMedia(ctx: GameContext, limit = 200): { userId: string; kind: MediaKind; hash: string; url: string }[] {
  return ctx.db.all<{ user_id: string; kind: MediaKind; hash: string; url: string }>(
    `SELECT m.user_id, m.kind, m.hash, m.url FROM user_media m
     LEFT JOIN user_media_files f ON f.user_id = m.user_id AND f.kind = m.kind AND f.hash = m.hash
     WHERE f.status IS NULL OR f.status = 'pending'
     ORDER BY m.last_seen_at DESC LIMIT ?`, Math.max(1, Math.min(1000, limit)),
  ).map((r) => ({ userId: r.user_id, kind: r.kind, hash: r.hash, url: r.url }));
}

export function archiveStats(ctx: GameContext): { ok: number; pending: number; gone: number; bytes: number } {
  const rows = ctx.db.all<{ status: string; n: number; bytes: number | null }>(
    'SELECT status, COUNT(*) AS n, SUM(COALESCE(LENGTH(png), 0) + COALESCE(LENGTH(gif), 0)) AS bytes FROM user_media_files GROUP BY status',
  );
  const out = { ok: 0, pending: 0, gone: 0, bytes: 0 };
  for (const r of rows) {
    if (r.status === 'ok' || r.status === 'pending' || r.status === 'gone') out[r.status] = r.n;
    out.bytes += r.bytes ?? 0;
  }
  return out;
}

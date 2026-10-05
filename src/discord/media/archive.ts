import { logger } from '../../logger';
import type { GameContext } from '../../services/context';
import { getMediaFile, markMediaFailed, MAX_FILE_BYTES, mediaFileStatus, saveMediaFile, unarchivedMedia } from '../../services/mediaArchive';
import { mediaUrl, type MediaKind } from '../../services/userMedia';
import { thumbUrl } from './collage';

/**
 * Guarda en la base una copia de cada avatar/banner apenas el bot lo ve (cuando el enlace de Discord todavía
 * funciona). Cola chica (2 descargas a la vez) para no molestar a la CDN; lo que falla se reintenta después.
 */

export interface FetchResult {
  status: number;
  body: Buffer | null;
}
export type Fetcher = (url: string) => Promise<FetchResult>;

/** Tamaño guardado: suficiente para verlo en grande sin llenar el disco. */
const SIZE: Record<MediaKind, number> = { avatar: 512, banner: 600 };

export const httpFetcher: Fetcher = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { status: res.status, body: null };
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_FILE_BYTES) return { status: 413, body: null };
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: body.length <= MAX_FILE_BYTES ? body : null };
  } catch {
    return { status: 0, body: null };
  }
};

export interface ArchiveItem {
  userId: string;
  kind: MediaKind;
  hash: string;
}

/** Baja y guarda una imagen. 'gone' = Discord ya no la tiene (404); 'retry' = error de red, se reintenta. */
export async function archiveOne(ctx: GameContext, it: ArchiveItem, fetcher: Fetcher = httpFetcher): Promise<'ok' | 'gone' | 'retry'> {
  const url = mediaUrl(it.kind, it.userId, it.hash, SIZE[it.kind]);
  const png = await fetcher(thumbUrl(url, SIZE[it.kind]));
  if (!png.body) {
    const gone = png.status === 404 || png.status === 403 || png.status === 410;
    markMediaFailed(ctx, it.userId, it.kind, it.hash, gone);
    return gone ? 'gone' : 'retry';
  }
  // Los animados además se guardan como GIF (para verlos animados en grande); si falla, queda el PNG.
  const gif = it.hash.startsWith('a_') ? (await fetcher(url.replace(/\.(gif|png|webp)(\?.*)?$/, `.gif?size=${SIZE[it.kind]}`))).body : null;
  saveMediaFile(ctx, it.userId, it.kind, it.hash, png.body, gif);
  return 'ok';
}

export class MediaArchiver {
  private readonly queue: ArchiveItem[] = [];
  private readonly queued = new Set<string>();
  private running = 0;

  constructor(private readonly ctx: GameContext, private readonly fetcher: Fetcher = httpFetcher, private readonly concurrency = 2) {}

  /** Encola la imagen si todavía no está guardada (ni se sabe que desapareció). */
  ensure(userId: string, kind: MediaKind, hash: string | null | undefined): void {
    if (!hash || !/^(a_)?[0-9a-f]{32}$/.test(hash)) return;
    const key = `${userId}:${kind}:${hash}`;
    if (this.queued.has(key) || this.queue.length > 5_000) return;
    const st = mediaFileStatus(this.ctx, userId, kind, hash);
    if (st === 'ok' || st === 'gone') return;
    this.queued.add(key);
    this.queue.push({ userId, kind, hash });
    this.pump();
  }

  /** Imágenes del historial que quedaron sin guardar (reinicios, errores de red, historial viejo). */
  backfill(limit = 200): number {
    const items = unarchivedMedia(this.ctx, limit);
    for (const it of items) this.ensure(it.userId, it.kind, it.hash);
    return items.length;
  }

  get pending(): number {
    return this.queue.length + this.running;
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length) {
      const it = this.queue.shift()!;
      this.running++;
      void archiveOne(this.ctx, it, this.fetcher)
        .catch((err) => logger.warn('Archivo de avatares:', err))
        .finally(() => {
          this.running--;
          this.queued.delete(`${it.userId}:${it.kind}:${it.hash}`);
          this.pump();
        });
    }
  }

  /** Para los tests: espera a que se vacíe la cola. */
  async idle(): Promise<void> {
    while (this.pending) await new Promise((r) => setTimeout(r, 5));
  }
}

let archiver: MediaArchiver | null = null;

export function setArchiver(a: MediaArchiver | null): void {
  archiver = a;
}

/** Pide guardar una imagen (no hace nada si el archivador no arrancó, p. ej. en los tests). */
export function ensureArchived(userId: string, kind: MediaKind, hash: string | null | undefined): void {
  archiver?.ensure(userId, kind, hash);
}

export { getMediaFile };

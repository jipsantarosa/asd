import { logger } from '../../logger';
import type { MediaEntry, MediaKind } from '../../services/userMedia';
import { blank, blit, decodePng, encodePng, fill, resizeCover, type Rgba } from './png';

/**
 * Collage del historial de avatares o banners, como una grilla de miniaturas (la más reciente primero).
 * Las imágenes se piden a la CDN de Discord en PNG y en tamaño chico, de a 6 en paralelo y con tiempo límite.
 * Si alguna imagen vieja ya no está en la CDN, su casilla queda en gris (no se inventa nada).
 */
export const COLLAGE_MAX = 64;

const LAYOUT: Record<MediaKind, { cols: number; w: number; h: number; size: number }> = {
  avatar: { cols: 8, w: 64, h: 64, size: 64 },
  banner: { cols: 3, w: 192, h: 76, size: 256 },
};
const GAP = 4;
const RADIUS = { avatar: 6, banner: 6 };

/** URL en PNG y tamaño chico (los avatares animados se sirven como su primer cuadro). */
export function thumbUrl(url: string, size: number): string {
  return url.replace(/\.(gif|png|webp|jpg)(\?.*)?$/, `.png?size=${size}`);
}

async function fetchImage(url: string, timeoutMs: number): Promise<Rgba | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > 2_000_000) return null;
    return decodePng(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export interface Collage {
  png: Buffer;
  shown: number;
  missing: number;
}

/**
 * `local` devuelve la copia guardada por el bot (si hay): se usa antes que la CDN, que borra las imágenes viejas.
 */
export async function buildCollage(
  entries: MediaEntry[], kind: MediaKind,
  fetcher: (url: string) => Promise<Rgba | null> = (u) => fetchImage(u, 4000),
  local: (e: MediaEntry) => Buffer | null = () => null,
): Promise<Collage | null> {
  const list = entries.slice(0, COLLAGE_MAX);
  if (!list.length) return null;
  const L = LAYOUT[kind];
  const cols = Math.min(L.cols, list.length);
  const rows = Math.ceil(list.length / cols);
  const canvas = blank(cols * L.w + (cols - 1) * GAP, rows * L.h + (rows - 1) * GAP);
  const images = await mapLimit(list, 6, async (e) => {
    const saved = local(e);
    const img = saved ? decodePng(saved) : null;
    return img ?? fetcher(thumbUrl(e.url, L.size));
  });
  let missing = 0;
  images.forEach((img, i) => {
    const x = (i % cols) * (L.w + GAP);
    const y = Math.floor(i / cols) * (L.h + GAP);
    const tile = img ? resizeCover(img, L.w, L.h) : fill(blank(L.w, L.h), 64, 66, 73);
    if (!img) missing++;
    blit(canvas, tile, x, y, RADIUS[kind]);
  });
  if (missing === list.length) {
    logger.warn('Collage: no se pudo descargar ninguna imagen de la CDN de Discord.');
  }
  return { png: encodePng(canvas), shown: list.length, missing };
}

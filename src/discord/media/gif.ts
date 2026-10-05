import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import jpeg from 'jpeg-js';
import { GameError } from '../../services/context';
import { decodePng, resizeCover, type Rgba } from './png';

/**
 * !gif: convierte fotos (PNG o JPG) en GIF. Con una imagen sale un GIF quieto; con varias, una animación
 * (una imagen detrás de otra). Todo en JavaScript puro (sin librerías nativas).
 */

export const GIF_MAX_SIDE = 512;
export const GIF_MAX_FRAMES = 10;
export const GIF_MAX_INPUT = 8 * 1024 * 1024;

/** PNG o JPG → RGBA. Otros formatos (WebP, HEIC…) no se pueden leer sin librerías nativas. */
export function decodeImage(buf: Buffer): Rgba {
  if (buf.length > GIF_MAX_INPUT) throw new GameError('La imagen pesa demasiado (máximo 8 MB).');
  if (buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const img = decodePng(buf);
    if (!img) throw new GameError('No pude leer ese PNG (puede estar dañado o ser un PNG entrelazado).');
    return img;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    try {
      const d = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 });
      return { width: d.width, height: d.height, data: d.data };
    } catch {
      throw new GameError('No pude leer ese JPG.');
    }
  }
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') throw new GameError('Esa imagen ya es un GIF. 😄');
  throw new GameError('Solo puedo convertir imágenes **PNG** o **JPG**.');
}

/** Achica (sin deformar) para que el lado más largo sea como mucho `max`. */
export function fitWithin(img: Rgba, max = GIF_MAX_SIDE): Rgba {
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  if (scale === 1) return img;
  return resizeCover(img, Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
}

/** Una o varias imágenes → GIF. Todas las imágenes quedan del tamaño de la primera. */
export function encodeGif(images: Rgba[], delayMs = 800): Buffer {
  if (!images.length) throw new GameError('No hay imágenes para convertir.');
  const first = fitWithin(images[0]);
  const frames = [first, ...images.slice(1, GIF_MAX_FRAMES).map((img) => resizeCover(img, first.width, first.height))];
  const gif = GIFEncoder();
  for (const f of frames) {
    const palette = quantize(f.data, 256, { format: 'rgba4444', oneBitAlpha: true });
    const index = applyPalette(f.data, palette, 'rgba4444');
    const transparentIndex = palette.findIndex((c) => c.length > 3 && c[3] === 0);
    gif.writeFrame(index, f.width, f.height, {
      palette,
      delay: frames.length > 1 ? delayMs : 0,
      ...(transparentIndex >= 0 ? { transparent: true, transparentIndex } : {}),
    });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

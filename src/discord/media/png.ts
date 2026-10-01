import zlib from 'node:zlib';

/**
 * PNG mínimo en TypeScript puro (solo zlib de Node): decodifica y codifica imágenes RGBA.
 * Sin dependencias nativas (canvas/sharp), así se instala igual en Windows, Linux y Mac.
 * Soporta lo que sirve la CDN de Discord: PNG no entrelazado, tipos de color 0, 2, 3, 4 y 6,
 * profundidad 8 (y 1/2/4 en paleta, 16 en el resto, tomando el byte alto).
 */
export interface Rgba {
  width: number;
  height: number;
  /** width × height × 4 bytes. */
  data: Uint8Array;
}

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodifica un PNG. Devuelve null si el formato no está soportado o el archivo está dañado. */
export function decodePng(buf: Buffer): Rgba | null {
  try {
    if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;
    let pos = 8;
    let width = 0;
    let height = 0;
    let depth = 0;
    let colorType = 0;
    let interlace = 0;
    let palette: Buffer | null = null;
    let trns: Buffer | null = null;
    const idat: Buffer[] = [];
    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString('latin1', pos + 4, pos + 8);
      const body = buf.subarray(pos + 8, pos + 8 + len);
      pos += 12 + len;
      if (type === 'IHDR') {
        width = body.readUInt32BE(0);
        height = body.readUInt32BE(4);
        depth = body[8];
        colorType = body[9];
        interlace = body[12];
      } else if (type === 'PLTE') palette = body;
      else if (type === 'tRNS') trns = body;
      else if (type === 'IDAT') idat.push(body);
      else if (type === 'IEND') break;
    }
    if (!width || !height || width > 4096 || height > 4096 || interlace !== 0) return null;
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
    if (!channels || ![1, 2, 4, 8, 16].includes(depth)) return null;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bitsPerPixel = channels * depth;
    const bpp = Math.max(1, bitsPerPixel >> 3);
    const stride = Math.ceil((width * bitsPerPixel) / 8);
    if (raw.length < (stride + 1) * height) return null;

    // Quita los filtros de cada fila.
    const pixels = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      const src = y * (stride + 1) + 1;
      const dst = y * stride;
      for (let x = 0; x < stride; x++) {
        const v = raw[src + x];
        const a = x >= bpp ? pixels[dst + x - bpp] : 0;
        const b = y > 0 ? pixels[dst - stride + x] : 0;
        const c = x >= bpp && y > 0 ? pixels[dst - stride + x - bpp] : 0;
        let out: number;
        switch (filter) {
          case 0: out = v; break;
          case 1: out = v + a; break;
          case 2: out = v + b; break;
          case 3: out = v + ((a + b) >> 1); break;
          case 4: out = v + paeth(a, b, c); break;
          default: return null;
        }
        pixels[dst + x] = out & 0xff;
      }
    }

    const data = new Uint8Array(width * height * 4);
    const sample = (row: number, index: number): number => {
      // Lee la muestra número `index` de la fila (cualquier profundidad), escalada a 0..255.
      if (depth === 8) return pixels[row * stride + index];
      if (depth === 16) return pixels[row * stride + index * 2];
      const bit = index * depth;
      const byte = pixels[row * stride + (bit >> 3)];
      const v = (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
      return colorType === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (colorType === 3) {
          const idx = sample(y, x);
          if (!palette || idx * 3 + 2 >= palette.length) return null;
          data[o] = palette[idx * 3];
          data[o + 1] = palette[idx * 3 + 1];
          data[o + 2] = palette[idx * 3 + 2];
          data[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
        } else if (colorType === 0 || colorType === 4) {
          const g = sample(y, x * channels);
          data[o] = data[o + 1] = data[o + 2] = g;
          data[o + 3] = colorType === 4 ? sample(y, x * channels + 1) : 255;
        } else {
          data[o] = sample(y, x * channels);
          data[o + 1] = sample(y, x * channels + 1);
          data[o + 2] = sample(y, x * channels + 2);
          data[o + 3] = colorType === 6 ? sample(y, x * channels + 3) : 255;
        }
      }
    }
    return { width, height, data };
  } catch {
    return null;
  }
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}

/** Codifica una imagen RGBA como PNG (tipo 6, 8 bits). */
export function encodePng(img: Rgba): Buffer {
  const { width, height, data } = img;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 8 })), chunk('IEND', Buffer.alloc(0))]);
}

export function blank(width: number, height: number): Rgba {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Escala con muestreo bilineal y recorta al centro para llenar w×h (como object-fit: cover). */
export function resizeCover(src: Rgba, w: number, h: number): Rgba {
  const out = blank(w, h);
  const scale = Math.max(w / src.width, h / src.height);
  const ox = (src.width * scale - w) / 2;
  const oy = (src.height * scale - h) / 2;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.max(0, (y + oy + 0.5) / scale - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.max(0, (x + ox + 0.5) / scale - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = sx - x0;
      for (let c = 0; c < 4; c++) {
        const p00 = src.data[(y0 * src.width + x0) * 4 + c];
        const p10 = src.data[(y0 * src.width + x1) * 4 + c];
        const p01 = src.data[(y1 * src.width + x0) * 4 + c];
        const p11 = src.data[(y1 * src.width + x1) * 4 + c];
        out.data[(y * w + x) * 4 + c] = Math.round((p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy);
      }
    }
  }
  return out;
}

/** Pega `src` en `dst` en (dx, dy) con esquinas redondeadas y mezcla por alfa. */
export function blit(dst: Rgba, src: Rgba, dx: number, dy: number, radius = 0): void {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (radius > 0) {
        const cx = x < radius ? radius - x - 0.5 : x >= src.width - radius ? x - (src.width - radius) + 0.5 : 0;
        const cy = y < radius ? radius - y - 0.5 : y >= src.height - radius ? y - (src.height - radius) + 0.5 : 0;
        if (cx > 0 && cy > 0 && cx * cx + cy * cy > radius * radius) continue;
      }
      const tx = dx + x;
      const ty = dy + y;
      if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
      const s = (y * src.width + x) * 4;
      const d = (ty * dst.width + tx) * 4;
      const a = src.data[s + 3] / 255;
      const da = dst.data[d + 3] / 255;
      const outA = a + da * (1 - a);
      for (let c = 0; c < 3; c++) {
        dst.data[d + c] = outA ? Math.round((src.data[s + c] * a + dst.data[d + c] * da * (1 - a)) / outA) : 0;
      }
      dst.data[d + 3] = Math.round(outA * 255);
    }
  }
}

export function fill(img: Rgba, r: number, g: number, b: number, a = 255): Rgba {
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = r;
    img.data[i + 1] = g;
    img.data[i + 2] = b;
    img.data[i + 3] = a;
  }
  return img;
}

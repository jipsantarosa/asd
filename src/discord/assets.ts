import fs from 'node:fs';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import type { AchievementDef } from '../game/types';

/** Busca la carpeta assets/ subiendo desde este archivo (funciona igual con tsx y con dist/). */
function findAssets(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'assets');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

const ROOT = findAssets();
const cache = new Map<string, Buffer | null>();

function load(rel: string): Buffer | null {
  if (!ROOT) return null;
  if (!cache.has(rel)) {
    const file = path.join(ROOT, rel);
    // Solo nombres seguros: nunca se arma una ruta con texto del usuario.
    cache.set(rel, /^[a-z0-9_/]+\.png$/.test(rel) && fs.existsSync(file) ? fs.readFileSync(file) : null);
  }
  return cache.get(rel) ?? null;
}

export interface Img {
  file: AttachmentBuilder;
  /** Para usar en setThumbnail/setImage. */
  url: string;
}

function img(rel: string, name: string): Img | null {
  const buf = load(rel);
  return buf ? { file: new AttachmentBuilder(buf, { name }), url: `attachment://${name}` } : null;
}

export function rodImage(sprite: string | undefined): Img | null {
  return sprite ? img(`rods/${sprite}.png`, `cana_${sprite}.png`) : null;
}

export function badgeImage(def: AchievementDef): Img | null {
  return img(`badges/${def.id}.png`, `logro_${def.id}.png`) ?? img(`badges/badge_${def.tier}.png`, `logro_${def.id}.png`);
}

export function assetsDir(): string | null {
  return ROOT;
}

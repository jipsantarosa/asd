import { logger } from '../../logger';

/**
 * GIFs de besos de anime (apto para todo público) desde APIs públicas SFW.
 * Primero nekos.best y, si falla, waifu.pics. Solo se aceptan URLs https de sus propios dominios.
 */
export interface Gif {
  url: string;
  source: string;
  anime?: string;
}

const PROVIDERS: { name: string; url: string; hosts: RegExp; pick(json: unknown): { url?: string; anime?: string } }[] = [
  {
    name: 'nekos.best',
    url: 'https://nekos.best/api/v2/kiss',
    hosts: /^https:\/\/nekos\.best\//,
    pick: (j) => {
      const r = (j as { results?: { url?: string; anime_name?: string }[] }).results?.[0];
      return { url: r?.url, anime: r?.anime_name };
    },
  },
  {
    name: 'waifu.pics',
    url: 'https://api.waifu.pics/sfw/kiss',
    hosts: /^https:\/\/i\.waifu\.pics\//,
    pick: (j) => ({ url: (j as { url?: string }).url }),
  },
];

export async function randomKissGif(timeoutMs = 4000): Promise<Gif | null> {
  for (const p of PROVIDERS) {
    try {
      const res = await fetch(p.url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'ElValleBot/1.0' } });
      if (!res.ok) continue;
      const { url, anime } = p.pick(await res.json());
      if (url && p.hosts.test(url)) return { url, source: p.name, anime };
    } catch (err) {
      logger.warn(`GIF de ${p.name} no disponible:`, (err as Error).message);
    }
  }
  return null;
}

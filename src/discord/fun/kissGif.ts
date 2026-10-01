import { logger } from '../../logger';

/**
 * GIFs de besos de anime (apto para todo público) desde APIs públicas SFW.
 * Primero nekos.best (trae el nombre del anime) y, si falla, waifu.pics. Solo se aceptan URLs https de sus propios dominios.
 */
export interface Gif {
  url: string;
  source: string;
  anime?: string;
}

interface Candidate {
  url?: string;
  anime?: string;
}

const PROVIDERS: { name: string; url: string; hosts: RegExp; pick(json: unknown): Candidate[] }[] = [
  {
    name: 'nekos.best',
    // Varios resultados por pedido: así se puede elegir uno distinto al del beso original sin otra llamada.
    url: 'https://nekos.best/api/v2/kiss?amount=8',
    hosts: /^https:\/\/nekos\.best\//,
    pick: (j) => ((j as { results?: { url?: string; anime_name?: string }[] }).results ?? []).map((r) => ({ url: r.url, anime: r.anime_name })),
  },
  {
    name: 'waifu.pics',
    url: 'https://api.waifu.pics/sfw/kiss',
    hosts: /^https:\/\/i\.waifu\.pics\//,
    pick: (j) => [{ url: (j as { url?: string }).url }],
  },
];

/**
 * Un GIF de beso al azar. `exclude` evita repetir GIFs (p. ej. el del beso original al corresponder).
 * Nunca lanza: si ninguna API responde, devuelve null y el beso cuenta igual.
 */
export async function randomKissGif(opts: { exclude?: (string | null | undefined)[]; timeoutMs?: number } = {}): Promise<Gif | null> {
  const exclude = new Set((opts.exclude ?? []).filter((x): x is string => !!x));
  const timeoutMs = opts.timeoutMs ?? 4000;
  let fallback: Gif | null = null;
  for (const p of PROVIDERS) {
    // waifu.pics devuelve uno por pedido: un segundo intento si salió repetido.
    for (let attempt = 0; attempt < (p.name === 'waifu.pics' ? 2 : 1); attempt++) {
      try {
        const res = await fetch(p.url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'ElValleBot/2.0' } });
        if (!res.ok) break;
        const valid = p.pick(await res.json()).filter((c): c is Required<Pick<Candidate, 'url'>> & Candidate => !!c.url && p.hosts.test(c.url));
        const fresh = valid.filter((c) => !exclude.has(c.url));
        const chosen = fresh[Math.floor(Math.random() * fresh.length)];
        if (chosen) return { url: chosen.url, source: p.name, anime: chosen.anime || undefined };
        if (!fallback && valid[0]) fallback = { url: valid[0].url, source: p.name, anime: valid[0].anime || undefined };
      } catch (err) {
        logger.warn(`GIF de ${p.name} no disponible:`, (err as Error).message);
        break;
      }
    }
  }
  // Solo había repetidos: mejor un GIF repetido que ninguno.
  return fallback;
}

import { GameError } from './context';

/**
 * Estadísticas de juegos externos: Valorant (API de HenrikDev, la de Riot no es pública para esto) y CS2 (API
 * oficial de Steam). Las dos piden una clave gratuita en el .env. Acá solo se arma la consulta y se leen las
 * respuestas; la descarga la hace la capa de Discord (inyectable para los tests).
 */

export type JsonFetcher = (url: string, headers?: Record<string, string>) => Promise<{ status: number; json: unknown }>;

export const httpJson: JsonFetcher = async (url, headers = {}) => {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'casino-bot', ...headers }, signal: AbortSignal.timeout(10_000) });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch {
    return { status: 0, json: null };
  }
};

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const numOr = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ───────────────────────── Valorant ─────────────────────────

export const VALO_REGIONS = ['eu', 'na', 'latam', 'br', 'ap', 'kr'] as const;
export type ValoRegion = (typeof VALO_REGIONS)[number];

/** "Nombre con espacios#TAG" → nombre y tag (el # final separa el tag). */
export function parseRiotId(raw: string): { name: string; tag: string } {
  const t = raw.trim().replace(/^<@!?\d+>\s*/, '');
  const i = t.lastIndexOf('#');
  const name = i > 0 ? t.slice(0, i).trim() : '';
  const tag = i > 0 ? t.slice(i + 1).trim() : '';
  if (!name || !tag || name.length > 16 || tag.length > 5 || /[\\/?#]/.test(name) || !/^[\p{L}\p{N}]+$/u.test(tag)) {
    throw new GameError('Escribí el Riot ID completo: `!uservalo Nombre#TAG` (por ejemplo `!uservalo TenZ#0505`).');
  }
  return { name, tag };
}

export interface ValoMatch {
  map: string;
  mode: string;
  agent: string;
  kills: number;
  deaths: number;
  assists: number;
  headshotPct: number | null;
  won: boolean | null;
  startedAt: number | null;
}

export interface ValoProfile {
  name: string;
  tag: string;
  region: string;
  level: number;
  card: string | null;
  rank: string | null;
  rankImage: string | null;
  rr: number | null;
  peak: string | null;
  matches: ValoMatch[];
}

function apiError(status: number, what: string): never {
  if (status === 404) throw new GameError(`No encontré ${what}. Revisá que esté bien escrito.`);
  if (status === 401 || status === 403) throw new GameError('La clave de la API no es válida. Revisá la variable del `.env`.');
  if (status === 429) throw new GameError('La API está recibiendo demasiadas consultas. Probá en un minuto.');
  if (status === 0) throw new GameError('No me pude conectar con la API. Probá de nuevo en un rato.');
  throw new GameError(`La API respondió con un error (${status}). Probá de nuevo en un rato.`);
}

export function readValoMatches(json: unknown, name: string, tag: string): ValoMatch[] {
  const list = Array.isArray(obj(json).data) ? (obj(json).data as unknown[]) : [];
  const me = (p: Record<string, unknown>) => String(p.name ?? '').toLowerCase() === name.toLowerCase() && String(p.tag ?? '').toLowerCase() === tag.toLowerCase();
  const out: ValoMatch[] = [];
  for (const m of list) {
    const meta = obj(obj(m).metadata);
    const players = Array.isArray(obj(obj(m).players).all_players) ? (obj(obj(m).players).all_players as unknown[]).map(obj) : [];
    const p = players.find(me);
    if (!p) continue;
    const s = obj(p.stats);
    const shots = numOr(s.headshots) + numOr(s.bodyshots) + numOr(s.legshots);
    const team = String(p.team ?? '').toLowerCase();
    const teams = obj(obj(m).teams);
    const won = team && obj(teams[team]).has_won !== undefined ? obj(teams[team]).has_won === true : null;
    const start = numOr(meta.game_start, 0);
    out.push({
      map: str(meta.map) ?? '?',
      mode: str(meta.mode) ?? '?',
      agent: str(p.character) ?? '?',
      kills: numOr(s.kills),
      deaths: numOr(s.deaths),
      assists: numOr(s.assists),
      headshotPct: shots ? Math.round((numOr(s.headshots) / shots) * 100) : null,
      won,
      startedAt: start ? start * 1000 : null,
    });
  }
  return out;
}

export async function fetchValorant(raw: string, key: string, fetcher: JsonFetcher = httpJson): Promise<ValoProfile> {
  const { name, tag } = parseRiotId(raw);
  const base = 'https://api.henrikdev.xyz/valorant';
  const h = { Authorization: key };
  const enc = (s: string) => encodeURIComponent(s);
  const acc = await fetcher(`${base}/v1/account/${enc(name)}/${enc(tag)}`, h);
  if (acc.status !== 200) apiError(acc.status, `la cuenta **${name}#${tag}**`);
  const a = obj(obj(acc.json).data);
  const region = (str(a.region) ?? 'na').toLowerCase();
  const realName = str(a.name) ?? name;
  const realTag = str(a.tag) ?? tag;
  const profile: ValoProfile = {
    name: realName, tag: realTag, region, level: numOr(a.account_level), card: str(obj(a.card).wide) ?? str(obj(a.card).small),
    rank: null, rankImage: null, rr: null, peak: null, matches: [],
  };
  // El rango y las partidas son extra: si fallan, se muestra igual la cuenta.
  const mmr = await fetcher(`${base}/v2/mmr/${region}/${enc(realName)}/${enc(realTag)}`, h);
  if (mmr.status === 200) {
    const d = obj(obj(mmr.json).data);
    const cur = obj(d.current_data);
    profile.rank = str(cur.currenttierpatched);
    profile.rankImage = str(obj(cur.images).small);
    profile.rr = typeof cur.ranking_in_tier === 'number' ? cur.ranking_in_tier : null;
    profile.peak = str(obj(d.highest_rank).patched_tier);
  }
  const matches = await fetcher(`${base}/v3/matches/${region}/${enc(realName)}/${enc(realTag)}?size=5`, h);
  if (matches.status === 200) profile.matches = readValoMatches(matches.json, realName, realTag);
  return profile;
}

export function valoSummary(matches: ValoMatch[]): { kd: number | null; hs: number | null; wins: number; played: number; kills: number; deaths: number; assists: number } {
  const kills = matches.reduce((s, m) => s + m.kills, 0);
  const deaths = matches.reduce((s, m) => s + m.deaths, 0);
  const assists = matches.reduce((s, m) => s + m.assists, 0);
  const hsList = matches.map((m) => m.headshotPct).filter((x): x is number => x !== null);
  return {
    kd: matches.length ? Math.round((kills / Math.max(1, deaths)) * 100) / 100 : null,
    hs: hsList.length ? Math.round(hsList.reduce((s, x) => s + x, 0) / hsList.length) : null,
    wins: matches.filter((m) => m.won === true).length,
    played: matches.length,
    kills, deaths, assists,
  };
}

// ───────────────────────── CS2 (Steam) ─────────────────────────

/** Perfil de Steam: SteamID64, enlace /profiles/… o /id/…, o el nombre personalizado (vanity). */
export function parseSteamInput(raw: string): { steamId: string } | { vanity: string } {
  const t = raw.trim().replace(/^<|>$/g, '');
  const m = t.match(/steamcommunity\.com\/(profiles|id)\/([^/?#\s]+)/i);
  if (m) return m[1].toLowerCase() === 'profiles' ? checkId(m[2]) : checkVanity(m[2]);
  if (/^7656\d{13}$/.test(t)) return { steamId: t };
  return checkVanity(t);
}
function checkId(id: string): { steamId: string } {
  if (!/^7656\d{13}$/.test(id)) throw new GameError('Ese enlace de Steam no tiene un ID válido.');
  return { steamId: id };
}
function checkVanity(v: string): { vanity: string } {
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(v)) throw new GameError('Pasame tu perfil de Steam: el enlace (`steamcommunity.com/id/...` o `/profiles/...`), tu SteamID64 o tu nombre personalizado.');
  return { vanity: v };
}

export interface Cs2Profile {
  steamId: string;
  name: string;
  avatar: string | null;
  url: string;
  stats: {
    kills: number; deaths: number; kd: number; headshotPct: number; accuracyPct: number; hours: number;
    mvps: number; matchesWon: number; matchesPlayed: number; winPct: number | null; roundsPlayed: number; damage: number;
  };
}

export function readCs2Stats(json: unknown): Cs2Profile['stats'] {
  const list = Array.isArray(obj(obj(json).playerstats).stats) ? (obj(obj(json).playerstats).stats as unknown[]).map(obj) : [];
  const v = (name: string) => numOr(list.find((s) => s.name === name)?.value);
  const kills = v('total_kills');
  const deaths = v('total_deaths');
  const played = v('total_matches_played');
  const fired = v('total_shots_fired');
  return {
    kills,
    deaths,
    kd: Math.round((kills / Math.max(1, deaths)) * 100) / 100,
    headshotPct: kills ? Math.round((v('total_kills_headshot') / kills) * 1000) / 10 : 0,
    accuracyPct: fired ? Math.round((v('total_shots_hit') / fired) * 1000) / 10 : 0,
    hours: Math.round(v('total_time_played') / 3600),
    mvps: v('total_mvps'),
    matchesWon: v('total_matches_won'),
    matchesPlayed: played,
    winPct: played ? Math.round((v('total_matches_won') / played) * 1000) / 10 : null,
    roundsPlayed: v('total_rounds_played'),
    damage: v('total_damage_done'),
  };
}

export async function fetchCs2(raw: string, key: string, fetcher: JsonFetcher = httpJson): Promise<Cs2Profile> {
  const input = parseSteamInput(raw);
  const api = 'https://api.steampowered.com';
  const k = encodeURIComponent(key);
  let steamId: string;
  if ('vanity' in input) {
    const r = await fetcher(`${api}/ISteamUser/ResolveVanityURL/v1/?key=${k}&vanityurl=${encodeURIComponent(input.vanity)}`);
    if (r.status !== 200) apiError(r.status, 'ese perfil de Steam');
    const resp = obj(obj(r.json).response);
    if (resp.success !== 1 || !str(resp.steamid)) throw new GameError(`No encontré el perfil de Steam **${input.vanity}**. Probá con el enlace completo de tu perfil.`);
    steamId = resp.steamid as string;
  } else steamId = input.steamId;
  const sum = await fetcher(`${api}/ISteamUser/GetPlayerSummaries/v2/?key=${k}&steamids=${steamId}`);
  if (sum.status !== 200) apiError(sum.status, 'ese perfil de Steam');
  const player = obj((obj(obj(sum.json).response).players as unknown[] | undefined)?.[0]);
  if (!str(player.steamid)) throw new GameError('No encontré ese perfil de Steam.');
  if (player.communityvisibilitystate !== 3) throw new GameError('Ese perfil de Steam es **privado**. Para ver las estadísticas, poné el perfil y los "Detalles del juego" en público.');
  const st = await fetcher(`${api}/ISteamUserStats/GetUserStatsForGame/v2/?appid=730&key=${k}&steamid=${steamId}`);
  if (st.status === 403 || st.status === 500 || (st.status === 400 && !obj(st.json).playerstats)) {
    throw new GameError('No puedo ver las estadísticas de CS2 de ese perfil: los "Detalles del juego" son privados o nunca jugó.');
  }
  if (st.status !== 200) apiError(st.status, 'las estadísticas de CS2');
  return {
    steamId,
    name: str(player.personaname) ?? steamId,
    avatar: str(player.avatarfull),
    url: str(player.profileurl) ?? `https://steamcommunity.com/profiles/${steamId}`,
    stats: readCs2Stats(st.json),
  };
}

import { GameError, type GameContext } from '../services/context';

/**
 * Configuración global del casino. Se guarda como JSON en `casino_config` y SIEMPRE se normaliza al leer:
 * un valor fuera de rango (o un JSON editado a mano) nunca rompe el bot, se recorta al rango seguro.
 * Solo el dueño del bot la cambia (comandos !casino), y cada cambio queda en el registro administrativo.
 */

export const GAME_IDS = ['blackjack', 'roulette', 'slots', 'crash', 'plinko', 'mines', 'chicken', 'balloons', 'hilo', 'tower'] as const;
export type GameId = (typeof GAME_IDS)[number];

export function isGameId(x: unknown): x is GameId {
  return typeof x === 'string' && (GAME_IDS as readonly string[]).includes(x);
}

export interface GameSettings {
  enabled: boolean;
  minBet: number;
  maxBet: number;
  /** Ventaja de la casa en % (RTP = 100 − edge). Ruleta y blackjack tienen la ventaja en sus reglas. */
  edgePct: number;
  /** Espera mínima entre rondas nuevas del mismo juego. */
  cooldownMs: number;
}

export type TournamentMetric = 'profit' | 'wagered' | 'multiplier' | 'wins';
export const TOURNAMENT_METRICS: TournamentMetric[] = ['profit', 'wagered', 'multiplier', 'wins'];

export interface AutoTournament {
  enabled: boolean;
  metric: TournamentMetric;
  /** Premio de cada puesto (1.º, 2.º, …). La cantidad de ganadores es la cantidad de premios. */
  prizes: number[];
  /** Rondas mínimas para cobrar premio (evita ganar con una sola apuesta afortunada). */
  minRounds: number;
}

export interface CasinoConfig {
  currency: { name: string; emoji: string };
  startingBalance: number;
  /** Premio máximo de una ronda (tope anti-catástrofe para multiplicadores extremos). */
  maxPayout: number;
  games: Record<GameId, GameSettings>;
  daily: { amount: number; streakPct: number; streakMaxDays: number };
  weekly: { amount: number };
  rescue: { amount: number; below: number; cooldownHours: number };
  activity: {
    enabled: boolean;
    min: number;
    max: number;
    cooldownSeconds: number;
    dailyCap: number;
    minLetters: number;
    minWords: number;
    /** Desde este mensaje recompensado del día paga la mitad (y desde el doble, un cuarto). */
    decayAfter: number;
    streakPct: number;
    streakMaxDays: number;
    minAccountDays: number;
    minMemberHours: number;
  };
  levels: { rewardPerLevel: number };
  jackpot: { seed: number; contributionPct: number; fullBet: number };
  tournaments: { daily: AutoTournament; weekly: AutoTournament };
  /** Anuncio de grandes premios en el canal del casino de cada servidor. */
  bigWin: { multiplier: number; amount: number };
  /** Una partida sin tocar durante este tiempo se resuelve sola (cobra lo ganado, se planta o se devuelve). */
  abandonMinutes: number;
  /** Desfase horario de los días del casino (bonos diarios, actividad, torneo diario). −180 = Argentina. */
  timezoneOffsetMinutes: number;
  /** Evento: multiplicador de las recompensas de actividad hasta `until` (ms). */
  boost: { activity: number; until: number };
}

const game = (edgePct: number, cooldownMs = 1000): GameSettings => ({ enabled: true, minBet: 10, maxBet: 250_000, edgePct, cooldownMs });

export const DEFAULT_CASINO: CasinoConfig = {
  currency: { name: 'Coins', emoji: '🪙' },
  startingBalance: 5_000,
  maxPayout: 5_000_000,
  games: {
    blackjack: game(0.5),
    roulette: game(2.7),
    slots: game(3.9),
    crash: game(3),
    plinko: game(2),
    mines: game(3),
    chicken: game(3),
    balloons: game(3),
    hilo: game(3),
    tower: game(3),
  },
  daily: { amount: 1_000, streakPct: 10, streakMaxDays: 10 },
  weekly: { amount: 7_500 },
  rescue: { amount: 500, below: 100, cooldownHours: 8 },
  activity: {
    enabled: true, min: 4, max: 12, cooldownSeconds: 60, dailyCap: 600, minLetters: 6, minWords: 2,
    decayAfter: 30, streakPct: 5, streakMaxDays: 10, minAccountDays: 7, minMemberHours: 1,
  },
  levels: { rewardPerLevel: 20 },
  jackpot: { seed: 25_000, contributionPct: 1, fullBet: 1_000 },
  tournaments: {
    daily: { enabled: true, metric: 'profit', prizes: [15_000, 9_000, 6_000], minRounds: 10 },
    weekly: { enabled: true, metric: 'wagered', prizes: [60_000, 40_000, 25_000, 15_000, 10_000], minRounds: 30 },
  },
  bigWin: { multiplier: 50, amount: 100_000 },
  abandonMinutes: 30,
  timezoneOffsetMinutes: -180,
  boost: { activity: 1, until: 0 },
};

// ───────────────────────── Rangos seguros ─────────────────────────

export interface FieldDef {
  label: string;
  min: number;
  max: number;
  /** Decimales permitidos (0 = entero). */
  decimals?: number;
}

/** Campos numéricos editables. "games.*" vale para cada juego. */
export const CONFIG_FIELDS: Record<string, FieldDef> = {
  startingBalance: { label: 'Saldo inicial', min: 0, max: 1_000_000 },
  maxPayout: { label: 'Premio máximo por ronda', min: 1_000, max: 1_000_000_000_000 },
  'games.*.minBet': { label: 'Apuesta mínima', min: 1, max: 1_000_000_000 },
  'games.*.maxBet': { label: 'Apuesta máxima', min: 1, max: 1_000_000_000_000 },
  'games.*.edgePct': { label: 'Ventaja de la casa (%)', min: 0.5, max: 10, decimals: 2 },
  'games.*.cooldownMs': { label: 'Espera entre rondas (ms)', min: 0, max: 60_000 },
  'daily.amount': { label: 'Bono diario', min: 0, max: 10_000_000 },
  'daily.streakPct': { label: 'Bono diario: % extra por día de racha', min: 0, max: 50 },
  'daily.streakMaxDays': { label: 'Bono diario: días máximos de racha', min: 0, max: 60 },
  'weekly.amount': { label: 'Bono semanal', min: 0, max: 100_000_000 },
  'rescue.amount': { label: 'Rescate', min: 0, max: 1_000_000 },
  'rescue.below': { label: 'Rescate: saldo menor a', min: 0, max: 1_000_000 },
  'rescue.cooldownHours': { label: 'Rescate: horas de espera', min: 1, max: 168 },
  'activity.min': { label: 'Actividad: mínimo por mensaje', min: 0, max: 10_000 },
  'activity.max': { label: 'Actividad: máximo por mensaje', min: 0, max: 10_000 },
  'activity.cooldownSeconds': { label: 'Actividad: segundos entre recompensas', min: 10, max: 3_600 },
  'activity.dailyCap': { label: 'Actividad: tope diario', min: 0, max: 1_000_000 },
  'activity.minLetters': { label: 'Actividad: letras mínimas', min: 1, max: 200 },
  'activity.minWords': { label: 'Actividad: palabras mínimas', min: 1, max: 50 },
  'activity.decayAfter': { label: 'Actividad: mensajes antes de pagar la mitad', min: 1, max: 1_000 },
  'activity.streakPct': { label: 'Actividad: % extra por día de racha', min: 0, max: 50 },
  'activity.streakMaxDays': { label: 'Actividad: días máximos de racha', min: 0, max: 60 },
  'activity.minAccountDays': { label: 'Actividad: antigüedad mínima de la cuenta (días)', min: 0, max: 365 },
  'activity.minMemberHours': { label: 'Actividad: horas mínimas en el servidor', min: 0, max: 720 },
  'levels.rewardPerLevel': { label: 'Recompensa por nivel (× nivel)', min: 0, max: 100_000 },
  'jackpot.seed': { label: 'Jackpot: monto inicial', min: 0, max: 1_000_000_000 },
  'jackpot.contributionPct': { label: 'Jackpot: % de cada apuesta de Slots', min: 0, max: 5, decimals: 2 },
  'jackpot.fullBet': { label: 'Jackpot: apuesta para cobrarlo entero', min: 1, max: 1_000_000_000 },
  'tournaments.daily.minRounds': { label: 'Torneo diario: rondas mínimas', min: 0, max: 10_000 },
  'tournaments.weekly.minRounds': { label: 'Torneo semanal: rondas mínimas', min: 0, max: 100_000 },
  'bigWin.multiplier': { label: 'Anunciar premios desde (x)', min: 2, max: 1_000_000 },
  'bigWin.amount': { label: 'Anunciar premios desde (Coins)', min: 1, max: 1_000_000_000_000 },
  abandonMinutes: { label: 'Minutos para resolver una partida abandonada', min: 5, max: 1_440 },
  timezoneOffsetMinutes: { label: 'Desfase horario (minutos)', min: -720, max: 840 },
};

function fieldDef(path: string): FieldDef | null {
  if (CONFIG_FIELDS[path]) return CONFIG_FIELDS[path];
  const m = path.match(/^games\.([a-z]+)\.(\w+)$/);
  if (m && isGameId(m[1])) return CONFIG_FIELDS[`games.*.${m[2]}`] ?? null;
  return null;
}

function num(raw: unknown, def: number, f: FieldDef | null): number {
  const n = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(n)) return def;
  if (!f) return n;
  const factor = 10 ** (f.decimals ?? 0);
  return Math.min(f.max, Math.max(f.min, Math.round(n * factor) / factor));
}

function prizes(raw: unknown, def: number[]): number[] {
  if (!Array.isArray(raw)) return [...def];
  const out = raw.filter((x): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0 && x <= 1_000_000_000_000).slice(0, 10);
  return out.length ? out : [...def];
}

function metric(raw: unknown, def: TournamentMetric): TournamentMetric {
  return TOURNAMENT_METRICS.includes(raw as TournamentMetric) ? (raw as TournamentMetric) : def;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

/** Recorre la configuración por defecto y toma de `raw` solo valores del tipo y rango correctos. */
export function normalizeCasino(raw: unknown): CasinoConfig {
  const walk = (def: unknown, value: unknown, path: string): unknown => {
    if (typeof def === 'number') return num(value, def, fieldDef(path));
    if (typeof def === 'boolean') return typeof value === 'boolean' ? value : def;
    if (typeof def === 'string') return typeof value === 'string' && value.trim() ? value.trim().slice(0, 32) : def;
    if (Array.isArray(def)) return prizes(value, def as number[]);
    const out: Json = {};
    const v = obj(value);
    for (const [k, d] of Object.entries(def as Json)) out[k] = walk(d, v[k], path ? `${path}.${k}` : k);
    return out;
  };
  const cfg = walk(DEFAULT_CASINO, raw, '') as CasinoConfig;
  for (const id of GAME_IDS) {
    const g = cfg.games[id];
    if (g.maxBet < g.minBet) g.maxBet = g.minBet;
  }
  if (cfg.activity.max < cfg.activity.min) cfg.activity.max = cfg.activity.min;
  const t = obj(obj(raw).tournaments);
  cfg.tournaments.daily.metric = metric(obj(t.daily).metric, DEFAULT_CASINO.tournaments.daily.metric);
  cfg.tournaments.weekly.metric = metric(obj(t.weekly).metric, DEFAULT_CASINO.tournaments.weekly.metric);
  const b = obj(obj(raw).boost);
  cfg.boost.activity = num(b.activity, 1, { label: '', min: 1, max: 5, decimals: 1 });
  return cfg;
}

export function getCasinoConfig(ctx: GameContext): CasinoConfig {
  if (ctx.cache.casino) return ctx.cache.casino;
  const row = ctx.db.get<{ value: string }>("SELECT value FROM casino_config WHERE key = 'main'");
  let parsed: unknown = {};
  try {
    parsed = row ? JSON.parse(row.value) : {};
  } catch {
    parsed = {};
  }
  ctx.cache.casino = normalizeCasino(parsed);
  return ctx.cache.casino;
}

export function saveCasinoConfig(ctx: GameContext, cfg: CasinoConfig, actorId: string | null): CasinoConfig {
  const clean = normalizeCasino(cfg);
  ctx.db.run(
    `INSERT INTO casino_config (key, value, updated_by, updated_at) VALUES ('main', ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    JSON.stringify(clean), actorId, ctx.now(),
  );
  ctx.cache.casino = clean;
  return clean;
}

/** Cambia un campo numérico por su ruta ("daily.amount", "games.plinko.maxBet"), validando el rango. */
export function setConfigNumber(ctx: GameContext, path: string, value: number, actorId: string | null): CasinoConfig {
  const def = fieldDef(path);
  if (!def) throw new GameError(`No existe el ajuste \`${path}\`.`);
  const factor = 10 ** (def.decimals ?? 0);
  if (!Number.isFinite(value) || Math.round(value * factor) / factor !== value || value < def.min || value > def.max) {
    throw new GameError(`**${def.label}** tiene que ser un número ${def.decimals ? `con hasta ${def.decimals} decimales ` : 'entero '}entre ${def.min.toLocaleString('es-AR')} y ${def.max.toLocaleString('es-AR')}.`);
  }
  const cfg = structuredClone(getCasinoConfig(ctx)) as unknown as Json;
  const keys = path.split('.');
  let cur = cfg;
  for (const k of keys.slice(0, -1)) cur = cur[k] as Json;
  cur[keys[keys.length - 1]] = value;
  const next = cfg as unknown as CasinoConfig;
  if (keys[0] === 'games') {
    const g = next.games[keys[1] as GameId];
    if (g.minBet > g.maxBet) throw new GameError(`La apuesta mínima (${g.minBet}) no puede superar a la máxima (${g.maxBet}).`);
  }
  if (next.activity.min > next.activity.max) throw new GameError('El mínimo de actividad no puede superar al máximo.');
  return saveCasinoConfig(ctx, next, actorId);
}

export function readConfigNumber(cfg: CasinoConfig, path: string): number | null {
  if (!fieldDef(path)) return null;
  let cur: unknown = cfg;
  for (const k of path.split('.')) cur = (cur as Json)?.[k];
  return typeof cur === 'number' ? cur : null;
}

/** RTP de un juego como fracción (0,97 para 3 % de ventaja). */
export function rtpOf(cfg: CasinoConfig, gameId: GameId): number {
  return 1 - cfg.games[gameId].edgePct / 100;
}

/** Día del casino (YYYY-MM-DD) con el desfase horario configurado. */
export function casinoDay(cfg: CasinoConfig, nowMs: number): string {
  return new Date(nowMs + cfg.timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Inicio (ms) del día del casino que contiene `nowMs`. */
export function casinoDayStart(cfg: CasinoConfig, nowMs: number): number {
  const shifted = nowMs + cfg.timezoneOffsetMinutes * 60_000;
  return Math.floor(shifted / 86_400_000) * 86_400_000 - cfg.timezoneOffsetMinutes * 60_000;
}

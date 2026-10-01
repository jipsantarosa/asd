import type { Db } from '../db/types';
import type { GameConfig } from '../game/types';

/**
 * Contexto que reciben todos los servicios. Inyectar reloj y RNG permite
 * probar la lógica de forma determinista.
 */
export interface GameContext {
  db: Db;
  now: () => number;
  rng: () => number;
  baseConfig: GameConfig;
  defaultPrefix: string;
  /** Cachés en memoria (se invalidan al escribir). */
  cache: {
    settings: Map<string, GuildSettingsCache>;
    configs: Map<string, GameConfig>;
  };
}

export interface GuildSettingsCache {
  prefix: string;
  tunables: Record<string, number>;
}

export function createContext(opts: {
  db: Db;
  baseConfig: GameConfig;
  defaultPrefix?: string;
  now?: () => number;
  rng?: () => number;
}): GameContext {
  return {
    db: opts.db,
    baseConfig: opts.baseConfig,
    defaultPrefix: opts.defaultPrefix ?? '!',
    now: opts.now ?? Date.now,
    rng: opts.rng ?? Math.random,
    cache: { settings: new Map(), configs: new Map() },
  };
}

/** Error pensado para mostrarse tal cual al usuario. Todo lo demás se trata como error interno. */
export class GameError extends Error {
  constructor(
    message: string,
    /** Si se conoce, cuándo vuelve a estar disponible la acción (ms epoch). */
    readonly readyAt?: number,
  ) {
    super(message);
    this.name = 'GameError';
  }
}

/** Día lógico (YYYY-MM-DD) según el desfase horario configurado, para límites diarios. */
export function dayKey(nowMs: number, offsetMinutes: number): string {
  return new Date(nowMs + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Próximo reinicio diario en ms epoch. */
export function nextDayReset(nowMs: number, offsetMinutes: number): number {
  const shifted = nowMs + offsetMinutes * 60_000;
  const startOfDay = Math.floor(shifted / 86_400_000) * 86_400_000;
  return startOfDay + 86_400_000 - offsetMinutes * 60_000;
}

export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function weightedPick<T>(rng: () => number, entries: T[], weightOf: (e: T) => number): T {
  const total = entries.reduce((s, e) => s + Math.max(0, weightOf(e)), 0);
  if (total <= 0) return entries[0];
  let roll = rng() * total;
  for (const e of entries) {
    roll -= Math.max(0, weightOf(e));
    if (roll < 0) return e;
  }
  return entries[entries.length - 1];
}

/** Redondeo probabilístico: 2.3 → 2 (70%) o 3 (30%). Evita que los multiplicadores pequeños se pierdan. */
export function stochasticRound(rng: () => number, v: number): number {
  const base = Math.floor(v);
  return base + (rng() < v - base ? 1 : 0);
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function fmt(n: number): string {
  return Math.floor(n).toLocaleString('es-AR');
}

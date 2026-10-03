import type { CasinoConfig } from '../casino/config';
import type { Db } from '../db/types';

/**
 * Contexto que reciben todos los servicios. Inyectar el reloj permite probar la lógica de forma
 * determinista. (El azar de los juegos NO sale de acá: sale de semillas verificables, ver casino/rng.ts.)
 */
export interface GameContext {
  db: Db;
  now: () => number;
  defaultPrefix: string;
  /** Cachés en memoria (se invalidan al escribir). */
  cache: {
    settings: Map<string, GuildSettingsCache>;
    casino?: CasinoConfig;
    /** Esperas entre rondas del casino: "usuario:juego" → ms en que se puede volver a jugar. */
    cooldowns: Map<string, number>;
  };
}

export interface GuildSettingsCache {
  prefix: string;
  /** Idioma del bot en el servidor (!setlang). */
  lang: 'es' | 'en';
}

export function createContext(opts: { db: Db; defaultPrefix?: string; now?: () => number }): GameContext {
  return {
    db: opts.db,
    defaultPrefix: opts.defaultPrefix ?? '!',
    now: opts.now ?? Date.now,
    cache: { settings: new Map(), cooldowns: new Map() },
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

/** Día lógico (YYYY-MM-DD) según un desfase horario. */
export function dayKey(nowMs: number, offsetMinutes: number): string {
  return new Date(nowMs + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function fmt(n: number): string {
  return Math.floor(n).toLocaleString('es-AR');
}

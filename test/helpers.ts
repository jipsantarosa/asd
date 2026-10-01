import { createRequire } from 'node:module';
import { runMigrations } from '../src/db/migrations';
import type { Db, RunResult } from '../src/db/types';
import { DEFAULT_CONFIG } from '../src/game/defaults';
import { validateConfig } from '../src/game/config';
import type { GameConfig } from '../src/game/types';
import { createContext, type GameContext } from '../src/services/context';
import { resetLogCache } from '../src/services/logConfig';

const require = createRequire(__filename);

/** Base de datos en memoria: usa better-sqlite3 si está instalado; si no, node:sqlite (Node 22+). */
export function memoryDb(): Db {
  try {
    const { SqliteDb } = require('../src/db/sqlite') as typeof import('../src/db/sqlite');
    const Database = require('better-sqlite3');
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    return new SqliteDb(raw);
  } catch {
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => any };
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = ON');
    let depth = 0;
    const db: Db = {
      run: (sql, ...p): RunResult => {
        const r = raw.prepare(sql).run(...p);
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
      },
      get: <T>(sql: string, ...p: unknown[]) => raw.prepare(sql).get(...p) as T | undefined,
      all: <T>(sql: string, ...p: unknown[]) => raw.prepare(sql).all(...p) as T[],
      exec: (sql) => raw.exec(sql),
      transaction: <T>(fn: () => T): T => {
        const sp = `sp${depth}`;
        raw.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
        depth++;
        try {
          const out = fn();
          depth--;
          raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
          return out;
        } catch (e) {
          depth--;
          raw.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw e;
        }
      },
      close: () => raw.close(),
    };
    return db;
  }
}

/** RNG determinista (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TestWorld {
  ctx: GameContext;
  clock: { t: number; advance(ms: number): void };
}

export function makeWorld(overrides: Partial<GameConfig> = {}, seed = 42): TestWorld {
  resetLogCache();
  const db = memoryDb();
  runMigrations(db, 0);
  const cfg = { ...structuredClone(DEFAULT_CONFIG), ...overrides };
  validateConfig(cfg);
  const clock = { t: 1_750_000_000_000, advance(ms: number) { this.t += ms; } };
  const ctx = createContext({ db, baseConfig: cfg, now: () => clock.t, rng: seeded(seed) });
  return { ctx, clock };
}

export const G = '100000000000000001';
export const U = '200000000000000002';
export const U2 = '200000000000000003';

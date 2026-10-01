import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { logger } from '../logger';
import type { Db, RunResult } from './types';

/** Implementación de Db sobre better-sqlite3 con caché de sentencias preparadas. */
export class SqliteDb implements Db {
  private readonly cache = new Map<string, BetterSqlite3.Statement>();

  constructor(private readonly raw: BetterSqlite3.Database) {}

  private stmt(sql: string): BetterSqlite3.Statement {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: unknown[]): RunResult {
    const r = this.stmt(sql).run(...params);
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }

  get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    // better-sqlite3 convierte transacciones anidadas en savepoints automáticamente.
    return this.raw.transaction(fn).immediate();
  }

  close(): void {
    this.raw.close();
  }
}

/** Mínimo que usamos de node:sqlite (incluido en Node 22.13+ y 24, sin compilar nada). */
interface NodeStatement {
  run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...p: unknown[]): unknown;
  all(...p: unknown[]): unknown[];
}
interface NodeDatabase {
  prepare(sql: string): NodeStatement;
  exec(sql: string): void;
  close(): void;
}

/**
 * Implementación de Db sobre el SQLite que trae Node. Se usa cuando better-sqlite3
 * no tiene binario compilado para la versión de Node instalada (p. ej. Node 24 en Windows).
 * Mismo comportamiento: transacciones IMMEDIATE y savepoints para las anidadas.
 */
export class NodeSqliteDb implements Db {
  private readonly cache = new Map<string, NodeStatement>();
  private depth = 0;

  constructor(private readonly raw: NodeDatabase) {}

  private stmt(sql: string): NodeStatement {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: unknown[]): RunResult {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    const sp = `sp_${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (err) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}

const PRAGMAS = ['journal_mode = WAL', 'synchronous = NORMAL', 'foreign_keys = ON', 'busy_timeout = 5000'];

function openBetterSqlite(file: string): Db {
  // require dinámico: si el módulo nativo no está compilado, recién falla acá y podemos usar el plan B.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3') as typeof BetterSqlite3;
  const raw = new Database(file);
  for (const p of PRAGMAS) raw.pragma(p);
  return new SqliteDb(raw);
}

function openNodeSqlite(file: string): Db {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string) => NodeDatabase };
  const raw = new DatabaseSync(file);
  for (const p of PRAGMAS) raw.exec(`PRAGMA ${p}`);
  return new NodeSqliteDb(raw);
}

/**
 * Abre la base de datos. Usa better-sqlite3 si funciona en esta máquina; si no,
 * el SQLite incluido en Node. El archivo es el mismo en ambos casos: se puede
 * cambiar de uno a otro sin perder datos.
 */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  try {
    const db = openBetterSqlite(file);
    logger.info('Base de datos: better-sqlite3');
    return db;
  } catch (err) {
    logger.warn(`better-sqlite3 no está disponible (${(err as Error).message.split('\n')[0]}). Uso el SQLite incluido en Node.`);
  }
  try {
    const db = openNodeSqlite(file);
    logger.info('Base de datos: node:sqlite (incluido en Node)');
    return db;
  } catch (err) {
    throw new Error(
      `No se pudo abrir la base de datos. Instalá Node 22.13 o superior (trae SQLite incluido) o reparalo con "npm rebuild better-sqlite3". Detalle: ${(err as Error).message}`,
    );
  }
}

import crypto from 'node:crypto';
import { GameError, type GameContext } from '../services/context';

/**
 * Azar verificable ("provably fair"), diseño propio:
 *
 * - Cada jugador tiene una semilla del servidor (32 bytes de crypto.randomBytes, secreta) cuyo SHA-256 se
 *   muestra ANTES de jugar, una semilla del cliente (la puede cambiar) y un nonce que sube con cada apuesta.
 * - Los números de una ronda son HMAC-SHA256(clave = semillaServidor, mensaje = "semillaCliente:nonce:bloque").
 *   Cada bloque da 32 bytes = 8 enteros de 32 bits (big-endian); cada flotante es entero / 2³² ∈ [0, 1).
 * - Al rotar la semilla se revela la anterior: con ella cualquiera puede recalcular cada ronda y comprobar
 *   que el resultado no se cambió (el hash publicado lo compromete de antemano).
 *
 * Math.random() no se usa para nada que afecte un resultado.
 */

export const CLIENT_SEED_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function newServerSeed(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function newClientSeed(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Generador determinista de una ronda. Mismas semillas y nonce → mismos números, siempre. */
export class FairRng {
  private block = 0;
  private buf: number[] = [];
  private consumed = 0;

  constructor(readonly serverSeed: string, readonly clientSeed: string, readonly nonce: number) {}

  private refill(): void {
    const h = crypto.createHmac('sha256', this.serverSeed).update(`${this.clientSeed}:${this.nonce}:${this.block++}`).digest();
    for (let i = 0; i < 32; i += 4) this.buf.push(h.readUInt32BE(i) / 0x1_0000_0000);
  }

  /** Flotante en [0, 1). */
  next(): number {
    if (!this.buf.length) this.refill();
    this.consumed += 1;
    return this.buf.shift()!;
  }

  /** Entero en [0, n). */
  int(n: number): number {
    if (!Number.isInteger(n) || n < 1) throw new Error(`FairRng.int: n inválido ${n}`);
    return Math.floor(this.next() * n);
  }

  /** Mezcla Fisher-Yates (de atrás hacia adelante) sobre una copia. */
  shuffle<T>(items: readonly T[]): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Elección ponderada: devuelve el índice. */
  weighted(weights: readonly number[]): number {
    const total = weights.reduce((s, w) => s + w, 0);
    let roll = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i];
      if (roll < 0) return i;
    }
    return weights.length - 1;
  }

  get used(): number {
    return this.consumed;
  }
}

// ───────────────────────── Semillas en la base ─────────────────────────

export interface SeedRow {
  id: number;
  userId: string;
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  active: boolean;
  createdAt: number;
  revealedAt: number | null;
}

interface RawSeed {
  id: number; user_id: string; server_seed: string; server_seed_hash: string; client_seed: string; nonce: number;
  active: number; created_at: number; revealed_at: number | null;
}

const toSeed = (r: RawSeed): SeedRow => ({
  id: r.id, userId: r.user_id, serverSeed: r.server_seed, serverSeedHash: r.server_seed_hash, clientSeed: r.client_seed,
  nonce: r.nonce, active: r.active === 1, createdAt: r.created_at, revealedAt: r.revealed_at,
});

function insertSeed(ctx: GameContext, userId: string, clientSeed: string): SeedRow {
  const server = newServerSeed();
  const r = ctx.db.run(
    'INSERT INTO casino_seeds (user_id, server_seed, server_seed_hash, client_seed, nonce, active, created_at) VALUES (?, ?, ?, ?, 0, 1, ?)',
    userId, server, sha256(server), clientSeed, ctx.now(),
  );
  return seedById(ctx, Number(r.lastInsertRowid))!;
}

export function seedById(ctx: GameContext, id: number): SeedRow | null {
  const r = ctx.db.get<RawSeed>('SELECT * FROM casino_seeds WHERE id = ?', id);
  return r ? toSeed(r) : null;
}

/** Par de semillas activo (lo crea la primera vez). */
export function activeSeed(ctx: GameContext, userId: string): SeedRow {
  return ctx.db.transaction(() => {
    const r = ctx.db.get<RawSeed>('SELECT * FROM casino_seeds WHERE user_id = ? AND active = 1', userId);
    return r ? toSeed(r) : insertSeed(ctx, userId, newClientSeed());
  });
}

/** Reserva el nonce de una apuesta (debe llamarse dentro de la transacción de la apuesta). */
export function reserveNonce(ctx: GameContext, userId: string): { seed: SeedRow; nonce: number } {
  const seed = activeSeed(ctx, userId);
  const r = ctx.db.run('UPDATE casino_seeds SET nonce = nonce + 1 WHERE id = ? AND nonce = ?', seed.id, seed.nonce);
  if (r.changes !== 1) throw new Error('reserveNonce: carrera inesperada sobre el nonce');
  return { seed, nonce: seed.nonce };
}

export function rngFor(seed: SeedRow, nonce: number): FairRng {
  return new FairRng(seed.serverSeed, seed.clientSeed, nonce);
}

/**
 * Revela la semilla del servidor actual y empieza un par nuevo (con otra semilla del cliente, si se da).
 * No se permite con partidas abiertas: revelar la semilla mostraría resultados que todavía no se jugaron.
 */
export function rotateSeed(ctx: GameContext, userId: string, clientSeed?: string | null): { revealed: SeedRow; next: SeedRow } {
  if (clientSeed !== undefined && clientSeed !== null && !CLIENT_SEED_RE.test(clientSeed)) {
    throw new GameError('La semilla del cliente puede tener de 1 a 32 caracteres: letras, números, guion o guion bajo.');
  }
  return ctx.db.transaction(() => {
    const open = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM casino_rounds WHERE user_id = ? AND status = 'active'", userId)!.n;
    if (open) throw new GameError('Terminá tus partidas abiertas antes de rotar la semilla (si no, se revelarían sus resultados).');
    const current = activeSeed(ctx, userId);
    ctx.db.run('UPDATE casino_seeds SET active = 0, revealed_at = ? WHERE id = ?', ctx.now(), current.id);
    const next = insertSeed(ctx, userId, clientSeed ?? newClientSeed());
    return { revealed: { ...current, active: false, revealedAt: ctx.now() }, next };
  });
}

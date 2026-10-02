import crypto from 'node:crypto';
import { GameError, fmt, type GameContext } from '../services/context';
import { getCasinoConfig, type GameId } from './config';

/**
 * Economía del casino. applyTx() es el ÚNICO lugar donde cambia un saldo:
 * - valida que la cantidad sea un entero seguro (nada de NaN, decimales, Infinity ni desbordes);
 * - nunca deja un saldo negativo ni por encima del tope;
 * - registra saldo anterior y nuevo (la base además verifica que cuadren con un CHECK);
 * - con una clave de idempotencia, un pago repetido devuelve la transacción original en lugar de pagar dos veces.
 * Todo corre dentro de una transacción SQLite sincrónica: no hay forma de que otra operación se meta en el medio.
 */

export const COINS = 'coins';
/** Tope duro de saldo: muy por debajo de 2⁵³, así ninguna suma pierde precisión. */
export const MAX_BALANCE = 1_000_000_000_000_000;
const SNOWFLAKE = /^\d{17,20}$/;

export const TX_TYPES = [
  'STARTER', 'BET', 'WIN', 'LOSS', 'PUSH', 'REFUND', 'BONUS', 'ACTIVITY', 'LEVEL_REWARD',
  'ACHIEVEMENT_REWARD', 'TOURNAMENT_REWARD', 'TOURNAMENT_ENTRY', 'JACKPOT', 'DROP', 'ADMIN_ADJUSTMENT', 'WORK', 'FINE',
] as const;
export type TxType = (typeof TX_TYPES)[number];

/** Tipos que restan (los demás suman, salvo los ajustes administrativos, que pueden ir para los dos lados). */
const DEBITS: TxType[] = ['BET', 'TOURNAMENT_ENTRY', 'FINE'];
/** Ingresos que no vienen de apostar (para la estadística de bonos). */
const BONUS_TYPES: TxType[] = ['BONUS', 'ACTIVITY', 'LEVEL_REWARD', 'ACHIEVEMENT_REWARD', 'TOURNAMENT_REWARD', 'DROP', 'WORK'];

export interface TxInput {
  userId: string;
  amount: number;
  type: TxType;
  game?: GameId | null;
  roundId?: number | null;
  guildId?: string | null;
  /** Clave única: la misma clave nunca se aplica dos veces. */
  key?: string | null;
  meta?: Record<string, unknown> | null;
  currency?: string;
}

export interface TxRecord {
  txId: string;
  userId: string;
  amount: number;
  before: number;
  after: number;
  type: TxType;
  game: string | null;
  roundId: number | null;
  createdAt: number;
  /** true si la clave ya existía y no se volvió a aplicar. */
  replayed: boolean;
}

export class InsufficientFundsError extends GameError {
  constructor(readonly needed: number, readonly balance: number) {
    super(`No te alcanza: necesitás 🪙 **${fmt(needed)}** y tenés 🪙 **${fmt(balance)}**.`);
    this.name = 'InsufficientFundsError';
  }
}

/** Valida una cantidad de Coins (entero seguro, no negativo, dentro del tope). */
export function assertCoins(n: unknown, what = 'La cantidad'): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > MAX_BALANCE) {
    throw new GameError(`${what} tiene que ser un número entero entre 0 y ${fmt(MAX_BALANCE)}.`);
  }
  return n;
}

function newTxId(): string {
  return `tx_${crypto.randomBytes(9).toString('base64url')}`;
}

interface RawTx {
  tx_id: string; user_id: string; amount: number; balance_before: number; balance_after: number; type: TxType;
  game: string | null; round_id: number | null; created_at: number;
}

const toTx = (r: RawTx, replayed: boolean): TxRecord => ({
  txId: r.tx_id, userId: r.user_id, amount: r.amount, before: r.balance_before, after: r.balance_after, type: r.type,
  game: r.game, roundId: r.round_id, createdAt: r.created_at, replayed,
});

/** Inserta la transacción y mueve el saldo (sin validaciones: solo para uso interno, ya validado). */
function writeTx(ctx: GameContext, input: TxInput, before: number): TxRecord {
  const currency = input.currency ?? COINS;
  const after = before + input.amount;
  const now = ctx.now();
  const upd = ctx.db.run('UPDATE casino_wallets SET balance = ?, updated_at = ? WHERE user_id = ? AND currency = ? AND balance = ?',
    after, now, input.userId, currency, before);
  if (upd.changes !== 1) throw new Error(`writeTx: la billetera de ${input.userId} cambió en medio de la transacción`);
  // Estadística de "bonos recibidos" (todo lo que no viene de apostar).
  if (BONUS_TYPES.includes(input.type) && input.amount > 0) {
    ctx.db.run('UPDATE casino_users SET bonus_total = bonus_total + ? WHERE user_id = ?', input.amount, input.userId);
  }
  const txId = newTxId();
  ctx.db.run(
    `INSERT INTO casino_transactions (tx_id, user_id, currency, amount, balance_before, balance_after, type, game, round_id, guild_id, idempotency_key, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    txId, input.userId, currency, input.amount, before, after, input.type, input.game ?? null, input.roundId ?? null,
    input.guildId ?? null, input.key ?? null, input.meta ? JSON.stringify(input.meta).slice(0, 2000) : null, now,
  );
  return { txId, userId: input.userId, amount: input.amount, before, after, type: input.type, game: input.game ?? null, roundId: input.roundId ?? null, createdAt: now, replayed: false };
}

/**
 * Crea la cuenta del casino si no existe: perfil, billetera, saldo inicial y (una sola vez) el bono de
 * bienvenida para quien tenía monedas en la granja de El Valle (1 Coin cada 1.000, con tope de 2.500).
 * Idempotente: dos llamadas simultáneas crean una sola cuenta.
 */
export function ensureCasinoUser(ctx: GameContext, userId: string): void {
  if (!SNOWFLAKE.test(userId)) throw new GameError('Usuario inválido.');
  ctx.db.transaction(() => {
    const now = ctx.now();
    const created = ctx.db.run(
      'INSERT OR IGNORE INTO casino_users (user_id, created_at, last_active_at, updated_at) VALUES (?, ?, ?, ?)',
      userId, now, now, now,
    ).changes === 1;
    if (!created) return;
    ctx.db.run('INSERT OR IGNORE INTO casino_wallets (user_id, currency, balance, updated_at) VALUES (?, ?, 0, ?)', userId, COINS, now);
    const cfg = getCasinoConfig(ctx);
    if (cfg.startingBalance > 0) writeTx(ctx, { userId, amount: cfg.startingBalance, type: 'STARTER', key: `starter:${userId}` }, 0);
    const legacy = ctx.db.get<{ coins: number | null }>('SELECT SUM(coins) AS coins FROM profiles WHERE user_id = ?', userId)?.coins ?? 0;
    const bonus = Math.min(2_500, Math.floor(Math.max(0, legacy) / 1_000));
    if (bonus > 0) {
      writeTx(ctx, { userId, amount: bonus, type: 'BONUS', key: `legacy:${userId}`, meta: { legacy: true, valleCoins: legacy } }, getBalance(ctx, userId));
    }
  });
}

export function getBalance(ctx: GameContext, userId: string, currency = COINS): number {
  return ctx.db.get<{ balance: number }>('SELECT balance FROM casino_wallets WHERE user_id = ? AND currency = ?', userId, currency)?.balance ?? 0;
}

/** El único punto de cambio de saldo. Ver el comentario del archivo. */
export function applyTx(ctx: GameContext, input: TxInput): TxRecord {
  if (!SNOWFLAKE.test(input.userId)) throw new GameError('Usuario inválido.');
  if (!(TX_TYPES as readonly string[]).includes(input.type)) throw new Error(`applyTx: tipo inválido ${input.type}`);
  if (!Number.isSafeInteger(input.amount) || Math.abs(input.amount) > MAX_BALANCE) throw new Error(`applyTx: cantidad inválida ${input.amount}`);
  if (input.amount === 0 && input.type !== 'LOSS') throw new Error(`applyTx: cantidad 0 en ${input.type}`);
  if (DEBITS.includes(input.type) && input.amount > 0) throw new Error(`applyTx: ${input.type} debe restar`);
  if (!DEBITS.includes(input.type) && input.type !== 'ADMIN_ADJUSTMENT' && input.amount < 0) throw new Error(`applyTx: ${input.type} debe sumar`);
  return ctx.db.transaction(() => {
    if (input.key) {
      const prev = ctx.db.get<RawTx>('SELECT * FROM casino_transactions WHERE idempotency_key = ?', input.key);
      if (prev) {
        if (prev.user_id !== input.userId || prev.type !== input.type) throw new Error(`applyTx: clave ${input.key} reutilizada con otros datos`);
        return toTx(prev, true);
      }
    }
    ensureCasinoUser(ctx, input.userId);
    const before = getBalance(ctx, input.userId, input.currency ?? COINS);
    const after = before + input.amount;
    if (after < 0) throw new InsufficientFundsError(-input.amount, before);
    if (after > MAX_BALANCE) throw new GameError('Ese movimiento superaría el saldo máximo permitido.');
    return writeTx(ctx, input, before);
  });
}

export function getTransactions(ctx: GameContext, userId: string, limit = 10): TxRecord[] {
  return ctx.db.all<RawTx>('SELECT * FROM casino_transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, Math.max(1, Math.min(50, limit)))
    .map((r) => toTx(r, false));
}

/**
 * Auditoría de la economía: la suma de todos los saldos tiene que ser exactamente la suma de todas las
 * transacciones (cada billetera empieza en 0 y solo cambia con una transacción).
 */
export function ledgerAudit(ctx: GameContext): { wallets: number; ledger: number; ok: boolean; users: number } {
  const wallets = ctx.db.get<{ s: number | null }>('SELECT SUM(balance) AS s FROM casino_wallets')!.s ?? 0;
  const ledger = ctx.db.get<{ s: number | null }>('SELECT SUM(amount) AS s FROM casino_transactions')!.s ?? 0;
  const users = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM casino_users')!.n;
  return { wallets, ledger, ok: wallets === ledger, users };
}

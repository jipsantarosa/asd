import { GameError, type GameContext } from '../services/context';
import { checkAchievements, type Unlocked } from './achievements';
import { getCasinoConfig, rtpOf, type GameId } from './config';
import { applyTx, ensureCasinoUser, getBalance, InsufficientFundsError } from './economy';
import { contributeJackpot, jackpotShare, payJackpot } from './jackpot';
import { reserveNonce, rngFor, seedById, type FairRng } from './rng';
import { scoreRound } from './tournaments';
import { assertNotBlocked, levelFromWagered, outcomeOf, recordRoundStats, touchUser, type Outcome } from './users';

/**
 * Casino Engine: todo lo que comparten los juegos.
 *
 * Un juego solo define sus reglas (ver CasinoGame). El motor se encarga de validar y cobrar la apuesta,
 * reservar el nonce del azar verificable, guardar el estado, rechazar botones viejos (versión), liquidar con
 * tope de premio, actualizar estadísticas, torneos, logros, niveles y jackpot, y devolver o resolver partidas
 * interrumpidas. Cada operación es UNA transacción SQLite sincrónica: o se aplica entera, o no se aplica nada.
 */

export interface Settlement {
  /** Multiplicador sobre lo apostado (juegos de multiplicador). */
  multiplier?: number;
  /** O un pago absoluto (blackjack, con varias manos y apuestas extra). */
  payout?: number;
  /** Resumen corto para el historial: "🎡 17 🔴". */
  summary: string;
  /** Datos públicos del resultado (se guardan con la ronda). */
  result?: Record<string, unknown>;
  /** Marcas para logros: 'jackpot' (además cobra el pozo), 'bj_natural', 'tower_complete'… */
  flags?: string[];
}

export interface Step<S> {
  state: S;
  /** Apuesta extra dentro de la misma ronda (doblar o dividir en blackjack). */
  extraBet?: number;
  /** La ronda terminó. */
  settle?: Settlement;
}

export interface GameAction {
  type: string;
  arg?: number;
}

export interface PlayContext<P> {
  rng: FairRng;
  bet: number;
  params: P;
  /** Retorno al jugador configurado (0,97 = 3 % de ventaja). */
  rtp: number;
  now: number;
}

export interface ActContext<P> {
  rtp: number;
  now: number;
  bet: number;
  totalBet: number;
  params: P;
  /** Último momento en que el bot estuvo vivo (para resolver partidas interrumpidas por un reinicio). */
  lastAlive: number;
}

export type GameKind = 'instant' | 'interactive' | 'live';

/** Contrato de un juego. Las reglas son puras: no tocan Discord ni la base de datos. */
export interface CasinoGame<P = unknown, S = unknown> {
  id: GameId;
  name: string;
  emoji: string;
  color: number;
  kind: GameKind;
  /** Una línea para el lobby. */
  tagline: string;
  /** Uso por prefijo, sin el nombre del comando: "<apuesta> [minas]". */
  usage: string;
  /** Ventaja fija por reglas (ruleta, blackjack); si no, se usa la configurada. */
  fixedEdge?: string;
  /** Aporta al jackpot progresivo. */
  jackpot?: boolean;
  /** Valida y normaliza los parámetros propios del juego (además de la apuesta). Lanza GameError si son inválidos. */
  parseParams(args: string[]): P;
  /** Describe los parámetros para mostrarlos ("5 minas", "riesgo alto · 12 filas"). */
  describeParams?(params: P): string;
  /** Juegos instantáneos: el resultado completo de una vez. */
  play?(c: PlayContext<P>): Settlement;
  /** Juegos con decisiones: estado inicial. TODO el azar se decide acá (las acciones son deterministas). */
  start?(c: PlayContext<P>): Step<S>;
  act?(state: S, action: GameAction, c: ActContext<P>): Step<S>;
  /** Partida abandonada o interrumpida: cobrar lo ganado, plantarse, o devolver la apuesta. */
  resolveAbandoned?(state: S, c: ActContext<P>): Settlement | 'refund';
  /** Lo que se puede verificar con la semilla revelada, sin depender de las decisiones del jugador. */
  fairSummary(rng: FairRng, params: P, rtp: number): string;
}

export type RoundStatus = 'active' | 'won' | 'lost' | 'push' | 'refunded';

export interface Round {
  id: number;
  userId: string;
  guildId: string | null;
  channelId: string | null;
  messageId: string | null;
  game: GameId;
  bet: number;
  totalBet: number;
  payout: number;
  multiplier: number;
  /** RTP con el que empezó la ronda. */
  rtp: number;
  status: RoundStatus;
  params: unknown;
  result: Record<string, unknown> | null;
  summary: string | null;
  version: number;
  seedId: number;
  nonce: number;
  rebetUsed: boolean;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
}

interface RawRound {
  id: number; user_id: string; guild_id: string | null; channel_id: string | null; message_id: string | null; game: GameId; bet: number;
  total_bet: number; payout: number; multiplier: number; rtp: number; status: RoundStatus; params: string; state: string | null; result: string | null;
  summary: string | null; version: number; seed_id: number; nonce: number; rebet_used: number; created_at: number; updated_at: number;
  settled_at: number | null;
}

function json<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const toRound = (r: RawRound): Round => ({
  id: r.id, userId: r.user_id, guildId: r.guild_id, channelId: r.channel_id, messageId: r.message_id, game: r.game, bet: r.bet,
  totalBet: r.total_bet, payout: r.payout, multiplier: r.multiplier, rtp: r.rtp, status: r.status, params: json(r.params, {}), result: json(r.result, null),
  summary: r.summary, version: r.version, seedId: r.seed_id, nonce: r.nonce, rebetUsed: r.rebet_used === 1, createdAt: r.created_at,
  updatedAt: r.updated_at, settledAt: r.settled_at,
});

export interface SettleInfo {
  payout: number;
  profit: number;
  multiplier: number;
  outcome: Outcome;
  summary: string;
  jackpot: number;
  capped: boolean;
  achievements: Unlocked[];
  levelUp: { from: number; to: number; reward: number } | null;
  tournaments: string[];
  bigWin: boolean;
  flags: string[];
}

export interface RoundView<S = unknown> {
  round: Round;
  /** Estado completo (incluye lo oculto: la pantalla decide qué mostrar). Null en juegos instantáneos. */
  state: S | null;
  /** Solo si la ronda terminó en esta llamada. */
  settled: SettleInfo | null;
  balance: number;
}

/** Ya hay una partida abierta de ese juego: la interfaz ofrece retomarla. */
export class ActiveRoundError extends GameError {
  constructor(readonly roundId: number, readonly game: GameId) {
    super('Ya tenés una partida abierta de este juego. Terminala (o retomala) antes de empezar otra.');
    this.name = 'ActiveRoundError';
  }
}

/** La partida ya se liquidó (botón de un mensaje que no se llegó a actualizar). */
export class RoundOverError extends GameError {
  constructor() {
    super('Esa partida ya terminó.');
    this.name = 'RoundOverError';
  }
}

/** Botón viejo (doble clic, mensaje repetido): su versión ya no es la actual. */
export class StaleActionError extends GameError {
  constructor() {
    super('Ese botón ya no es válido: la partida avanzó. Usá el mensaje más reciente.');
    this.name = 'StaleActionError';
  }
}

// ───────────────────────── Registro de juegos ─────────────────────────

const registry = new Map<GameId, CasinoGame>();

export function registerGame(game: CasinoGame): void {
  if (registry.has(game.id)) throw new Error(`Juego duplicado: ${game.id}`);
  registry.set(game.id, game);
}

export function gameOf(id: GameId): CasinoGame {
  const g = registry.get(id);
  if (!g) throw new GameError('Ese juego no existe.');
  return g;
}

export function allGames(): CasinoGame[] {
  return [...registry.values()];
}

// ───────────────────────── Lecturas ─────────────────────────

export function getRound(ctx: GameContext, id: number): Round | null {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const r = ctx.db.get<RawRound>('SELECT * FROM casino_rounds WHERE id = ?', id);
  return r ? toRound(r) : null;
}

function getRaw(ctx: GameContext, id: number): RawRound | null {
  return ctx.db.get<RawRound>('SELECT * FROM casino_rounds WHERE id = ?', id) ?? null;
}

export function activeRoundOf(ctx: GameContext, userId: string, game: GameId): Round | null {
  const r = ctx.db.get<RawRound>("SELECT * FROM casino_rounds WHERE user_id = ? AND game = ? AND status = 'active'", userId, game);
  return r ? toRound(r) : null;
}

export function activeRounds(ctx: GameContext, userId: string): Round[] {
  return ctx.db.all<RawRound>("SELECT * FROM casino_rounds WHERE user_id = ? AND status = 'active' ORDER BY id", userId).map(toRound);
}

/** Partidas abiertas sin tocar desde `before` (para resolverlas solas). */
export function staleRounds(ctx: GameContext, before: number, games?: GameId[]): Round[] {
  const rows = ctx.db.all<RawRound>("SELECT * FROM casino_rounds WHERE status = 'active' AND updated_at < ? ORDER BY id LIMIT 200", before).map(toRound);
  return games ? rows.filter((r) => games.includes(r.game)) : rows;
}

/** Todas las partidas abiertas de ciertos juegos (p. ej. los Crash en vuelo al reiniciar). */
export function activeRoundsOfGames(ctx: GameContext, games: GameId[]): Round[] {
  if (!games.length) return [];
  return ctx.db.all<RawRound>(`SELECT * FROM casino_rounds WHERE status = 'active' AND game IN (${games.map(() => '?').join(', ')}) ORDER BY id`, ...games).map(toRound);
}

export function roundState<S>(ctx: GameContext, id: number): S | null {
  const r = getRaw(ctx, id);
  return r ? json<S | null>(r.state, null) : null;
}

export function viewOf<S>(ctx: GameContext, id: number, settled: SettleInfo | null = null): RoundView<S> {
  const raw = getRaw(ctx, id);
  if (!raw) throw new GameError('Esa partida no existe.');
  const round = toRound(raw);
  return { round, state: json<S | null>(raw.state, null), settled, balance: getBalance(ctx, round.userId) };
}

export function setRoundMessage(ctx: GameContext, id: number, channelId: string | null, messageId: string | null): void {
  ctx.db.run('UPDATE casino_rounds SET channel_id = COALESCE(?, channel_id), message_id = COALESCE(?, message_id) WHERE id = ?', channelId, messageId, id);
}

// ───────────────────────── Apostar ─────────────────────────

export interface BetRequest {
  userId: string;
  guildId: string | null;
  channelId: string | null;
  game: GameId;
  bet: number;
  params: unknown;
}

function createRound(ctx: GameContext, req: BetRequest, game: CasinoGame): { round: Round; rng: FairRng } {
  const cfg = getCasinoConfig(ctx);
  const gs = cfg.games[req.game];
  if (!gs.enabled) throw new GameError(`🔒 ${game.emoji} **${game.name}** está cerrado por ahora.`);
  ensureCasinoUser(ctx, req.userId);
  assertNotBlocked(ctx, req.userId);
  if (Number.isSafeInteger(req.bet) && req.bet < gs.minBet && getBalance(ctx, req.userId) < gs.minBet) {
    throw new GameError(`No te alcanza para ${game.name}: la apuesta mínima es 🪙 **${gs.minBet.toLocaleString('es-AR')}** y tenés 🪙 **${getBalance(ctx, req.userId).toLocaleString('es-AR')}**. Probá \`!daily\` o \`!work\`.`);
  }
  if (!Number.isSafeInteger(req.bet) || req.bet < gs.minBet || req.bet > gs.maxBet) {
    throw new GameError(`La apuesta de ${game.name} tiene que ser entre 🪙 **${gs.minBet.toLocaleString('es-AR')}** y 🪙 **${gs.maxBet.toLocaleString('es-AR')}**.`);
  }
  const now = ctx.now();
  const cdKey = `${req.userId}:${req.game}`;
  const ready = ctx.cache.cooldowns.get(cdKey) ?? 0;
  if (ready > now) throw new GameError(`⏳ Esperá un momento antes de otra ronda de ${game.name}.`, ready);
  const open = activeRoundOf(ctx, req.userId, req.game);
  if (open) throw new ActiveRoundError(open.id, req.game);
  const balance = getBalance(ctx, req.userId);
  if (balance < req.bet) throw new InsufficientFundsError(req.bet, balance);

  const { seed, nonce } = reserveNonce(ctx, req.userId);
  const ins = ctx.db.run(
    `INSERT INTO casino_rounds (user_id, guild_id, channel_id, game, bet, total_bet, rtp, status, params, seed_id, nonce, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    req.userId, req.guildId, req.channelId, req.game, req.bet, req.bet, gameRtp(ctx, game), JSON.stringify(req.params ?? {}), seed.id, nonce, now, now,
  );
  const id = Number(ins.lastInsertRowid);
  applyTx(ctx, { userId: req.userId, amount: -req.bet, type: 'BET', game: req.game, roundId: id, guildId: req.guildId, key: `bet:${id}` });
  if (game.jackpot) contributeJackpot(ctx, req.bet);
  touchUser(ctx, req.userId, req.guildId);
  ctx.cache.cooldowns.set(cdKey, now + gs.cooldownMs);
  return { round: toRound(getRaw(ctx, id)!), rng: rngFor(seed, nonce) };
}

/** Juego instantáneo: apuesta, resultado y liquidación en una sola transacción. */
export function playInstant(ctx: GameContext, req: BetRequest): RoundView {
  const game = gameOf(req.game);
  if (game.kind !== 'instant' || !game.play) throw new Error(`${game.id} no es instantáneo`);
  return ctx.db.transaction(() => {
    const { round, rng } = createRound(ctx, req, game);
    const s = game.play!({ rng, bet: req.bet, params: req.params, rtp: round.rtp, now: ctx.now() });
    const info = settle(ctx, round, s, null);
    return viewOf(ctx, round.id, info);
  });
}

/** Juego con decisiones: apuesta y estado inicial (puede terminar ya, p. ej. un blackjack natural). */
export function startRound<S = unknown>(ctx: GameContext, req: BetRequest): RoundView<S> {
  const game = gameOf(req.game);
  if (!game.start) throw new Error(`${game.id} no tiene start()`);
  return ctx.db.transaction(() => {
    const { round, rng } = createRound(ctx, req, game);
    const step = game.start!({ rng, bet: req.bet, params: req.params, rtp: round.rtp, now: ctx.now() });
    if (step.settle) return viewOf<S>(ctx, round.id, settle(ctx, round, step.settle, step.state));
    ctx.db.run('UPDATE casino_rounds SET state = ?, updated_at = ? WHERE id = ?', JSON.stringify(step.state), ctx.now(), round.id);
    return viewOf<S>(ctx, round.id);
  });
}

/** RTP que recibe el juego: el configurado, menos el aporte al jackpot en los juegos que lo financian. */
function gameRtp(ctx: GameContext, game: CasinoGame): number {
  const cfg = getCasinoConfig(ctx);
  return rtpOf(cfg, game.id) - (game.jackpot ? cfg.jackpot.contributionPct / 100 : 0);
}

function actContext(ctx: GameContext, round: Round, lastAlive?: number): ActContext<unknown> {
  return { rtp: round.rtp, now: ctx.now(), bet: round.bet, totalBet: round.totalBet, params: round.params, lastAlive: lastAlive ?? ctx.now() };
}

/**
 * Una decisión del jugador. `version` es la que tenía el botón: si la partida ya avanzó (doble clic,
 * botón de un mensaje viejo, interacción repetida), se rechaza sin cambiar nada.
 */
export function actOnRound<S = unknown>(ctx: GameContext, a: { userId: string; roundId: number; version: number; action: GameAction }): RoundView<S> {
  return ctx.db.transaction(() => {
    const raw = getRaw(ctx, a.roundId);
    if (!raw) throw new GameError('Esa partida no existe.');
    const round = toRound(raw);
    if (round.userId !== a.userId) throw new GameError('🔒 Esa partida es de otra persona.');
    if (round.status !== 'active') throw new RoundOverError();
    if (round.version !== a.version) throw new StaleActionError();
    const game = gameOf(round.game);
    if (!game.act) throw new GameError('Este juego no tiene decisiones.');
    const step = game.act(json<S>(raw.state, null as S) as never, a.action, actContext(ctx, round));
    if (step.extraBet !== undefined) {
      if (!Number.isSafeInteger(step.extraBet) || step.extraBet <= 0) throw new Error(`extraBet inválido: ${step.extraBet}`);
      applyTx(ctx, { userId: round.userId, amount: -step.extraBet, type: 'BET', game: round.game, roundId: round.id, guildId: round.guildId, key: `bet:${round.id}:${round.version}`, meta: { action: a.action.type } });
      ctx.db.run('UPDATE casino_rounds SET total_bet = total_bet + ? WHERE id = ?', step.extraBet, round.id);
      round.totalBet += step.extraBet;
    }
    if (step.settle) return viewOf<S>(ctx, round.id, settle(ctx, round, step.settle, step.state));
    const upd = ctx.db.run('UPDATE casino_rounds SET state = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
      JSON.stringify(step.state), ctx.now(), round.id, round.version);
    if (upd.changes !== 1) throw new StaleActionError();
    return viewOf<S>(ctx, round.id);
  });
}

/** Juegos en vivo (Crash): el reloj del servidor avanza la partida. Devuelve la vista si terminó. */
export function tickLiveRound<S = unknown>(ctx: GameContext, roundId: number): RoundView<S> | null {
  return ctx.db.transaction(() => {
    const raw = getRaw(ctx, roundId);
    if (!raw || raw.status !== 'active') return null;
    const round = toRound(raw);
    const game = gameOf(round.game);
    if (game.kind !== 'live' || !game.act) return null;
    const step = game.act(json<S>(raw.state, null as S) as never, { type: 'tick' }, actContext(ctx, round));
    return step.settle ? viewOf<S>(ctx, round.id, settle(ctx, round, step.settle, step.state)) : null;
  });
}

/** Devuelve la apuesta completa (incluidas las extras) de una partida que no se puede reconstruir. */
export function refundRound(ctx: GameContext, roundId: number, reason: string): RoundView | null {
  return ctx.db.transaction(() => {
    const raw = getRaw(ctx, roundId);
    if (!raw || raw.status !== 'active') return null;
    const now = ctx.now();
    const upd = ctx.db.run(
      "UPDATE casino_rounds SET status = 'refunded', payout = total_bet, multiplier = 1, summary = ?, settled_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'active'",
      `↩️ ${reason}`.slice(0, 200), now, now, roundId,
    );
    if (upd.changes !== 1) return null;
    applyTx(ctx, { userId: raw.user_id, amount: raw.total_bet, type: 'REFUND', game: raw.game, roundId, guildId: raw.guild_id, key: `refund:${roundId}`, meta: { reason } });
    return viewOf(ctx, roundId);
  });
}

/** Partida abandonada o interrumpida por un reinicio: el juego decide (cobrar, plantarse) o se devuelve. */
export function resolveStaleRound(ctx: GameContext, roundId: number, lastAlive: number): RoundView | null {
  return ctx.db.transaction(() => {
    const raw = getRaw(ctx, roundId);
    if (!raw || raw.status !== 'active') return null;
    const round = toRound(raw);
    const game = gameOf(round.game);
    const state = json<unknown>(raw.state, null);
    const r = state && game.resolveAbandoned ? game.resolveAbandoned(state, actContext(ctx, round, lastAlive)) : 'refund';
    if (r === 'refund') return refundRound(ctx, roundId, 'Partida interrumpida: se devolvió la apuesta');
    return viewOf(ctx, round.id, settle(ctx, round, r, state));
  });
}

/** "Repetir apuesta": cada mensaje terminado se puede repetir una sola vez (protege del doble clic). */
export function claimRebet(ctx: GameContext, roundId: number, userId: string): Round {
  const upd = ctx.db.run("UPDATE casino_rounds SET rebet_used = 1 WHERE id = ? AND user_id = ? AND status <> 'active' AND rebet_used = 0", roundId, userId);
  if (upd.changes !== 1) throw new GameError('Ese botón ya se usó. Tocá el del mensaje más reciente.');
  return getRound(ctx, roundId)!;
}

// ───────────────────────── Liquidar ─────────────────────────

/** Multiplicador a centésimos, sin errores de coma flotante (2,43 × 100 = 242,99999…). */
export function toCents(multiplier: number): number {
  return Math.max(0, Math.floor(multiplier * 100 + 1e-6));
}

/** apuesta × multiplicador con enteros exactos (BigInt): sin desbordes ni redondeos raros. */
export function payoutFor(totalBet: number, multiplier: number): number {
  return Number((BigInt(totalBet) * BigInt(toCents(multiplier))) / 100n);
}

function settle(ctx: GameContext, round: Round, s: Settlement, finalState: unknown): SettleInfo {
  const cfg = getCasinoConfig(ctx);
  const raw = s.payout !== undefined ? s.payout : payoutFor(round.totalBet, s.multiplier ?? 0);
  if (!Number.isSafeInteger(raw) || raw < 0) throw new Error(`Liquidación inválida en la ronda ${round.id}: ${raw}`);
  const capped = raw > cfg.maxPayout;
  const gamePayout = Math.min(raw, cfg.maxPayout);
  const now = ctx.now();

  // 1) Cerrar la ronda (condicional: una ronda se liquida una sola vez; el segundo intento no encuentra 'active').
  const multiplier = s.multiplier !== undefined && !capped ? toCents(s.multiplier) / 100 : Math.round((gamePayout / round.totalBet) * 100) / 100;
  const first = outcomeOf(round.totalBet, gamePayout);
  const upd = ctx.db.run(
    `UPDATE casino_rounds SET status = ?, payout = ?, multiplier = ?, state = ?, result = ?, summary = ?, settled_at = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND status = 'active'`,
    first === 'win' ? 'won' : first === 'push' ? 'push' : 'lost', gamePayout, multiplier, finalState === null ? null : JSON.stringify(finalState), JSON.stringify(s.result ?? {}), s.summary.slice(0, 300), now, now, round.id,
  );
  if (upd.changes !== 1) throw new RoundOverError();

  // 2) Pagar (o registrar la pérdida). La clave settle:<id> garantiza una sola liquidación.
  const base = { userId: round.userId, game: round.game, roundId: round.id, guildId: round.guildId, key: `settle:${round.id}` };
  if (gamePayout > round.totalBet) applyTx(ctx, { ...base, amount: gamePayout, type: 'WIN', meta: { multiplier } });
  else if (gamePayout === round.totalBet) applyTx(ctx, { ...base, amount: gamePayout, type: 'PUSH' });
  else if (gamePayout > 0) applyTx(ctx, { ...base, amount: gamePayout, type: 'WIN', meta: { multiplier, partial: true } });
  else applyTx(ctx, { ...base, amount: 0, type: 'LOSS' });
  const jackpot = s.flags?.includes('jackpot') ? payJackpot(ctx, round.userId, jackpotShare(ctx, round.totalBet), round.id) : 0;

  const payout = gamePayout + jackpot;
  const outcome = outcomeOf(round.totalBet, payout);
  const effective = jackpot ? Math.round((payout / round.totalBet) * 100) / 100 : multiplier;
  if (jackpot) {
    const status: RoundStatus = outcome === 'win' ? 'won' : outcome === 'push' ? 'push' : 'lost';
    ctx.db.run('UPDATE casino_rounds SET status = ?, payout = ?, multiplier = ? WHERE id = ?', status, payout, effective, round.id);
  }

  // 3) Estadísticas, nivel, torneos y logros (misma transacción).
  const user = recordRoundStats(ctx, { userId: round.userId, game: round.game, totalBet: round.totalBet, payout, multiplier: effective, at: now });
  let levelUp: SettleInfo['levelUp'] = null;
  const level = levelFromWagered(user.totalWagered);
  if (level > user.levelRewarded) {
    let reward = 0;
    for (let n = user.levelRewarded + 1; n <= level; n++) reward += n * cfg.levels.rewardPerLevel;
    ctx.db.run('UPDATE casino_users SET level_rewarded = ? WHERE user_id = ? AND level_rewarded < ?', level, round.userId, level);
    if (reward > 0) applyTx(ctx, { userId: round.userId, amount: reward, type: 'LEVEL_REWARD', key: `level:${round.userId}:${level}`, meta: { from: user.levelRewarded, to: level } });
    levelUp = { from: user.levelRewarded, to: level, reward };
  }
  const tournaments = scoreRound(ctx, { userId: round.userId, game: round.game, totalBet: round.totalBet, payout, multiplier: effective, at: now });
  const flags = s.flags ?? [];
  const achievements = checkAchievements(ctx, round.userId, {
    kind: 'round', game: round.game, totalBet: round.totalBet, payout, multiplier: effective, flags, user, balance: getBalance(ctx, round.userId),
  }, round.id);
  const bigWin = jackpot > 0 || (outcome === 'win' && (effective >= cfg.bigWin.multiplier || payout - round.totalBet >= cfg.bigWin.amount));
  return {
    payout, profit: payout - round.totalBet, multiplier: effective, outcome, summary: s.summary, jackpot, capped, achievements, levelUp, tournaments, bigWin, flags,
  };
}

/** Resumen verificable de una ronda con su semilla (para !fairness). */
export function fairSummaryOf(ctx: GameContext, round: Round): { revealed: boolean; serverSeed: string | null; serverSeedHash: string; clientSeed: string; nonce: number; summary: string | null } {
  const seed = seedById(ctx, round.seedId);
  if (!seed) throw new GameError('No encontré la semilla de esa ronda.');
  const revealed = !seed.active;
  const summary = revealed ? gameOf(round.game).fairSummary(rngFor(seed, round.nonce), round.params as never, round.rtp) : null;
  return { revealed, serverSeed: revealed ? seed.serverSeed : null, serverSeedHash: seed.serverSeedHash, clientSeed: seed.clientSeed, nonce: round.nonce, summary };
}

export function recentRounds(ctx: GameContext, userId: string, opts: { game?: GameId | null; limit?: number; offset?: number } = {}): Round[] {
  const limit = Math.max(1, Math.min(25, opts.limit ?? 10));
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = opts.game
    ? ctx.db.all<RawRound>("SELECT * FROM casino_rounds WHERE user_id = ? AND game = ? AND status <> 'active' ORDER BY id DESC LIMIT ? OFFSET ?", userId, opts.game, limit, offset)
    : ctx.db.all<RawRound>("SELECT * FROM casino_rounds WHERE user_id = ? AND status <> 'active' ORDER BY id DESC LIMIT ? OFFSET ?", userId, limit, offset);
  return rows.map(toRound);
}

export function countRounds(ctx: GameContext, userId: string, game?: GameId | null): number {
  return game
    ? ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM casino_rounds WHERE user_id = ? AND game = ? AND status <> 'active'", userId, game)!.n
    : ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM casino_rounds WHERE user_id = ? AND status <> 'active'", userId)!.n;
}

import { GameError, fmt, type GameContext } from '../services/context';
import { checkAchievements, type Unlocked } from './achievements';
import { casinoDayStart, getCasinoConfig, isGameId, TOURNAMENT_METRICS, type GameId, type TournamentMetric } from './config';
import { applyTx, assertCoins } from './economy';

/**
 * Torneos del casino.
 * - La puntuación se suma dentro de la MISMA transacción que liquida cada ronda: no hay rondas que cuenten dos veces.
 * - Cerrar un torneo es un cambio de estado condicional (active → finished) y cada premio tiene una clave única:
 *   un cierre repetido (dos ticks, un reinicio a mitad) nunca paga dos veces.
 * - Los torneos sin cuota inscriben solos en la primera apuesta válida; los que tienen cuota exigen unirse antes.
 */

export type TournamentKind = 'daily' | 'weekly' | 'special';
export type TournamentStatus = 'draft' | 'scheduled' | 'active' | 'finished' | 'cancelled';

export interface Tournament {
  id: number;
  name: string;
  description: string;
  kind: TournamentKind;
  metric: TournamentMetric;
  game: GameId | null;
  minBet: number;
  maxBet: number | null;
  entryFee: number;
  feesToPool: boolean;
  prizes: number[];
  minRounds: number;
  status: TournamentStatus;
  startsAt: number;
  endsAt: number;
  autoKey: string | null;
  createdBy: string;
  createdAt: number;
  finishedAt: number | null;
}

interface RawTournament {
  id: number; name: string; description: string; kind: TournamentKind; metric: TournamentMetric; game: string | null; min_bet: number;
  max_bet: number | null; entry_fee: number; fees_to_pool: number; prizes: string; min_rounds: number; status: TournamentStatus;
  starts_at: number; ends_at: number; auto_key: string | null; created_by: string; created_at: number; finished_at: number | null;
}

function parsePrizes(raw: string): number[] {
  try {
    const a = JSON.parse(raw) as unknown;
    return Array.isArray(a) ? a.filter((x): x is number => Number.isSafeInteger(x) && x > 0) : [];
  } catch {
    return [];
  }
}

const toTournament = (r: RawTournament): Tournament => ({
  id: r.id, name: r.name, description: r.description, kind: r.kind, metric: r.metric, game: isGameId(r.game) ? r.game : null,
  minBet: r.min_bet, maxBet: r.max_bet, entryFee: r.entry_fee, feesToPool: r.fees_to_pool === 1, prizes: parsePrizes(r.prizes),
  minRounds: r.min_rounds, status: r.status, startsAt: r.starts_at, endsAt: r.ends_at, autoKey: r.auto_key, createdBy: r.created_by,
  createdAt: r.created_at, finishedAt: r.finished_at,
});

export const METRIC_META: Record<TournamentMetric, { label: string; emoji: string; unit: string }> = {
  profit: { label: 'Mayor beneficio', emoji: '📈', unit: 'Coins' },
  wagered: { label: 'Más apostado', emoji: '💸', unit: 'Coins' },
  multiplier: { label: 'Mayor multiplicador', emoji: '✖️', unit: 'x' },
  wins: { label: 'Más victorias', emoji: '🏅', unit: 'victorias' },
};

export const MAX_PRIZES = 10;

export function getTournament(ctx: GameContext, id: number): Tournament | null {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const r = ctx.db.get<RawTournament>('SELECT * FROM casino_tournaments WHERE id = ?', id);
  return r ? toTournament(r) : null;
}

export function requireTournament(ctx: GameContext, id: number): Tournament {
  const t = getTournament(ctx, id);
  if (!t) throw new GameError(`No existe el torneo #${id}.`);
  return t;
}

export function listTournaments(ctx: GameContext, statuses: TournamentStatus[], limit = 25): Tournament[] {
  const marks = statuses.map(() => '?').join(', ');
  return ctx.db.all<RawTournament>(
    `SELECT * FROM casino_tournaments WHERE status IN (${marks}) ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, ends_at DESC LIMIT ?`,
    ...statuses, Math.max(1, Math.min(50, limit)),
  ).map(toTournament);
}

export interface TournamentInput {
  name: string;
  description?: string;
  metric: TournamentMetric;
  game?: GameId | null;
  minBet?: number;
  maxBet?: number | null;
  entryFee?: number;
  feesToPool?: boolean;
  prizes: number[];
  minRounds?: number;
  startsAt: number;
  endsAt: number;
}

function validate(input: TournamentInput): void {
  const name = input.name.trim();
  if (name.length < 3 || name.length > 60) throw new GameError('El nombre del torneo tiene que tener entre 3 y 60 caracteres.');
  if ((input.description ?? '').length > 300) throw new GameError('La descripción puede tener hasta 300 caracteres.');
  if (!TOURNAMENT_METRICS.includes(input.metric)) throw new GameError('Métrica inválida.');
  if (input.game !== undefined && input.game !== null && !isGameId(input.game)) throw new GameError('Juego inválido.');
  if (!input.prizes.length || input.prizes.length > MAX_PRIZES) throw new GameError(`Poné entre 1 y ${MAX_PRIZES} premios.`);
  input.prizes.forEach((p) => { assertCoins(p, 'Cada premio'); if (p <= 0) throw new GameError('Los premios tienen que ser mayores a 0.'); });
  assertCoins(input.minBet ?? 0, 'La apuesta mínima');
  if (input.maxBet !== undefined && input.maxBet !== null) {
    assertCoins(input.maxBet, 'La apuesta máxima');
    if (input.maxBet < (input.minBet ?? 0) || input.maxBet === 0) throw new GameError('La apuesta máxima tiene que ser mayor que la mínima.');
  }
  assertCoins(input.entryFee ?? 0, 'La entrada');
  if (!Number.isSafeInteger(input.minRounds ?? 0) || (input.minRounds ?? 0) < 0 || (input.minRounds ?? 0) > 100_000) throw new GameError('Rondas mínimas inválidas.');
  if (!Number.isSafeInteger(input.startsAt) || !Number.isSafeInteger(input.endsAt) || input.endsAt <= input.startsAt) throw new GameError('La fecha de fin tiene que ser posterior a la de inicio.');
  if (input.endsAt - input.startsAt > 60 * 86_400_000) throw new GameError('Un torneo puede durar como máximo 60 días.');
}

/** Crea un torneo especial. Queda en borrador hasta que el dueño lo inicia (o programado si ya tiene fecha futura). */
export function createTournament(ctx: GameContext, input: TournamentInput, createdBy: string, status: 'draft' | 'scheduled' = 'draft'): Tournament {
  validate(input);
  const now = ctx.now();
  const r = ctx.db.run(
    `INSERT INTO casino_tournaments (name, description, kind, metric, game, min_bet, max_bet, entry_fee, fees_to_pool, prizes, min_rounds, status, starts_at, ends_at, created_by, created_at, updated_at)
     VALUES (?, ?, 'special', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.name.trim(), (input.description ?? '').trim(), input.metric, input.game ?? null, input.minBet ?? 0, input.maxBet ?? null,
    input.entryFee ?? 0, input.feesToPool === false ? 0 : 1, JSON.stringify(input.prizes), input.minRounds ?? 0, status,
    input.startsAt, input.endsAt, createdBy, now, now,
  );
  return getTournament(ctx, Number(r.lastInsertRowid))!;
}

/** Edita un torneo. Uno activo solo puede cambiar nombre, descripción, premios y extender el fin. */
export function updateTournament(ctx: GameContext, id: number, patch: Partial<TournamentInput>): Tournament {
  return ctx.db.transaction(() => {
    const t = requireTournament(ctx, id);
    if (t.status === 'finished' || t.status === 'cancelled') throw new GameError('Ese torneo ya terminó: no se puede editar.');
    if (t.status === 'active') {
      const allowed = ['name', 'description', 'prizes', 'endsAt'];
      const bad = Object.keys(patch).filter((k) => !allowed.includes(k));
      if (bad.length) throw new GameError('Un torneo en curso solo puede cambiar nombre, descripción, premios y extender el fin.');
      if (patch.endsAt !== undefined && patch.endsAt < t.endsAt) throw new GameError('A un torneo en curso solo se le puede extender el fin.');
    }
    const next: TournamentInput = {
      name: patch.name ?? t.name, description: patch.description ?? t.description, metric: patch.metric ?? t.metric,
      game: patch.game !== undefined ? patch.game : t.game, minBet: patch.minBet ?? t.minBet, maxBet: patch.maxBet !== undefined ? patch.maxBet : t.maxBet,
      entryFee: patch.entryFee ?? t.entryFee, feesToPool: patch.feesToPool ?? t.feesToPool, prizes: patch.prizes ?? t.prizes,
      minRounds: patch.minRounds ?? t.minRounds, startsAt: patch.startsAt ?? t.startsAt, endsAt: patch.endsAt ?? t.endsAt,
    };
    validate(next);
    ctx.db.run(
      `UPDATE casino_tournaments SET name = ?, description = ?, metric = ?, game = ?, min_bet = ?, max_bet = ?, entry_fee = ?, fees_to_pool = ?,
         prizes = ?, min_rounds = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?`,
      next.name.trim(), (next.description ?? '').trim(), next.metric, next.game ?? null, next.minBet ?? 0, next.maxBet ?? null, next.entryFee ?? 0,
      next.feesToPool === false ? 0 : 1, JSON.stringify(next.prizes), next.minRounds ?? 0, next.startsAt, next.endsAt, ctx.now(), id,
    );
    return requireTournament(ctx, id);
  });
}

/** Inicia ya (o programa, si `startsAt` es futuro y no se fuerza). */
export function startTournament(ctx: GameContext, id: number, force = true): Tournament {
  return ctx.db.transaction(() => {
    const t = requireTournament(ctx, id);
    if (t.status !== 'draft' && t.status !== 'scheduled') throw new GameError(`El torneo #${id} no se puede iniciar (está ${t.status}).`);
    const now = ctx.now();
    if (!force && t.startsAt > now) {
      ctx.db.run("UPDATE casino_tournaments SET status = 'scheduled', updated_at = ? WHERE id = ?", now, id);
    } else {
      // Iniciar ya: empieza ahora; si la fecha de fin ya pasó, conserva la duración planeada.
      const endsAt = t.endsAt > now ? t.endsAt : now + (t.endsAt - t.startsAt);
      ctx.db.run("UPDATE casino_tournaments SET status = 'active', starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?", now, endsAt, now, id);
    }
    return requireTournament(ctx, id);
  });
}

/** Cancela: devuelve las entradas pagadas y no reparte premios. */
export function cancelTournament(ctx: GameContext, id: number): { tournament: Tournament; refunded: number } {
  return ctx.db.transaction(() => {
    const t = requireTournament(ctx, id);
    if (t.status === 'finished' || t.status === 'cancelled') throw new GameError('Ese torneo ya terminó.');
    ctx.db.run("UPDATE casino_tournaments SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?", ctx.now(), ctx.now(), id);
    let refunded = 0;
    for (const e of ctx.db.all<{ user_id: string; fee_paid: number }>('SELECT user_id, fee_paid FROM casino_tournament_entries WHERE tournament_id = ? AND fee_paid > 0', id)) {
      applyTx(ctx, { userId: e.user_id, amount: e.fee_paid, type: 'REFUND', key: `tourfee-refund:${id}:${e.user_id}`, meta: { tournament: id } });
      refunded += 1;
    }
    return { tournament: requireTournament(ctx, id), refunded };
  });
}

/** Inscripción a un torneo con entrada: cobra la cuota una sola vez. */
export function joinTournament(ctx: GameContext, id: number, userId: string): Tournament {
  return ctx.db.transaction(() => {
    const t = requireTournament(ctx, id);
    if (t.status !== 'active' && t.status !== 'scheduled') throw new GameError('Ese torneo no está abierto.');
    const now = ctx.now();
    const exists = ctx.db.get('SELECT 1 FROM casino_tournament_entries WHERE tournament_id = ? AND user_id = ?', id, userId);
    if (exists) throw new GameError('Ya estás en ese torneo.');
    if (t.entryFee > 0) applyTx(ctx, { userId, amount: -t.entryFee, type: 'TOURNAMENT_ENTRY', key: `tourfee:${id}:${userId}`, meta: { tournament: id } });
    ctx.db.run('INSERT INTO casino_tournament_entries (tournament_id, user_id, fee_paid, joined_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, userId, t.entryFee, now, now);
    ctx.db.run('UPDATE casino_users SET tournaments_played = tournaments_played + 1 WHERE user_id = ?', userId);
    return t;
  });
}

/**
 * Suma una ronda liquidada a los torneos activos que corresponden (juego, apuesta mínima/máxima, fechas).
 * Se llama dentro de la transacción de la liquidación. Devuelve los nombres de los torneos que sumaron.
 */
export function scoreRound(ctx: GameContext, r: { userId: string; game: GameId; totalBet: number; payout: number; multiplier: number; at: number }): string[] {
  const open = ctx.db.all<RawTournament>(
    `SELECT * FROM casino_tournaments WHERE status = 'active' AND starts_at <= ? AND ends_at > ?
       AND (game IS NULL OR game = ?) AND min_bet <= ? AND (max_bet IS NULL OR max_bet >= ?)`,
    r.at, r.at, r.game, r.totalBet, r.totalBet,
  ).map(toTournament);
  const names: string[] = [];
  const win = r.payout > r.totalBet;
  for (const t of open) {
    const entry = ctx.db.get('SELECT 1 FROM casino_tournament_entries WHERE tournament_id = ? AND user_id = ?', t.id, r.userId);
    if (!entry) {
      if (t.entryFee > 0) continue; // con entrada, solo cuentan quienes se unieron
      ctx.db.run('INSERT INTO casino_tournament_entries (tournament_id, user_id, joined_at, updated_at) VALUES (?, ?, ?, ?)', t.id, r.userId, r.at, r.at);
      ctx.db.run('UPDATE casino_users SET tournaments_played = tournaments_played + 1 WHERE user_id = ?', r.userId);
    }
    ctx.db.run(
      `UPDATE casino_tournament_entries SET rounds = rounds + 1, wins = wins + ?, wagered = wagered + ?, profit = profit + ?,
         best_multiplier = MAX(best_multiplier, ?), updated_at = ? WHERE tournament_id = ? AND user_id = ?`,
      win ? 1 : 0, r.totalBet, r.payout - r.totalBet, win ? r.multiplier : 0, r.at, t.id, r.userId,
    );
    ctx.db.run(
      `UPDATE casino_tournament_entries SET score = CASE ? WHEN 'profit' THEN profit WHEN 'wagered' THEN wagered WHEN 'multiplier' THEN best_multiplier ELSE wins END
       WHERE tournament_id = ? AND user_id = ?`,
      t.metric, t.id, r.userId,
    );
    names.push(t.name);
  }
  return names;
}

export interface Standing {
  rank: number;
  userId: string;
  score: number;
  rounds: number;
  wagered: number;
  profit: number;
  prize: number;
  qualified: boolean;
}

/** Premios finales: los fijos más (si corresponde) las entradas, repartidas en la misma proporción. */
export function finalPrizes(ctx: GameContext, t: Tournament): number[] {
  if (!t.feesToPool || t.entryFee <= 0) return [...t.prizes];
  const fees = ctx.db.get<{ s: number | null }>('SELECT SUM(fee_paid) AS s FROM casino_tournament_entries WHERE tournament_id = ?', t.id)!.s ?? 0;
  const total = t.prizes.reduce((s, p) => s + p, 0);
  return t.prizes.map((p) => p + Math.floor((fees * p) / total));
}

/** Tabla del torneo. Para premio hace falta jugar las rondas mínimas (y, en beneficio, terminar en positivo). */
export function standings(ctx: GameContext, t: Tournament, limit = 10, offset = 0): Standing[] {
  const prizes = finalPrizes(ctx, t);
  const rows = ctx.db.all<{ user_id: string; score: number; rounds: number; wagered: number; profit: number; prize: number; final_rank: number | null }>(
    `SELECT user_id, score, rounds, wagered, profit, prize, final_rank FROM casino_tournament_entries WHERE tournament_id = ?
     ORDER BY (rounds >= ? AND score > 0) DESC, score DESC, updated_at ASC LIMIT ? OFFSET ?`,
    t.id, t.minRounds, Math.max(1, Math.min(50, limit)), Math.max(0, offset),
  );
  return rows.map((r, i) => {
    const rank = offset + i + 1;
    const qualified = r.rounds >= t.minRounds && r.score > 0;
    return {
      rank, userId: r.user_id, score: r.score, rounds: r.rounds, wagered: r.wagered, profit: r.profit, qualified,
      prize: t.status === 'finished' ? r.prize : qualified && rank <= prizes.length ? prizes[rank - 1] : 0,
    };
  });
}

export function standingOf(ctx: GameContext, t: Tournament, userId: string): Standing | null {
  const me = ctx.db.get<{ score: number; rounds: number; updated_at: number }>('SELECT score, rounds, updated_at FROM casino_tournament_entries WHERE tournament_id = ? AND user_id = ?', t.id, userId);
  if (!me) return null;
  const qualified = me.rounds >= t.minRounds && me.score > 0;
  const ahead = ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM casino_tournament_entries WHERE tournament_id = ? AND user_id <> ? AND (
       (rounds >= ? AND score > 0) > ? OR ((rounds >= ? AND score > 0) = ? AND (score > ? OR (score = ? AND updated_at < ?))))`,
    t.id, userId, t.minRounds, qualified ? 1 : 0, t.minRounds, qualified ? 1 : 0, me.score, me.score, me.updated_at,
  )!.n;
  return standings(ctx, t, 1, ahead)[0] ?? null;
}

export function participants(ctx: GameContext, id: number): number {
  return ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM casino_tournament_entries WHERE tournament_id = ?', id)!.n;
}

export interface FinishResult {
  tournament: Tournament;
  winners: { userId: string; rank: number; prize: number; score: number; achievements: Unlocked[] }[];
  participants: number;
}

/** Cierra el torneo y reparte los premios. Idempotente: si ya estaba cerrado, devuelve null. */
export function finishTournament(ctx: GameContext, id: number): FinishResult | null {
  return ctx.db.transaction(() => {
    const t = getTournament(ctx, id);
    if (!t || t.status !== 'active') return null;
    const now = ctx.now();
    const closed = ctx.db.run("UPDATE casino_tournaments SET status = 'finished', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'active'", now, now, id);
    if (closed.changes !== 1) return null;
    const prizes = finalPrizes(ctx, t);
    const top = standings(ctx, { ...t, status: 'active' }, prizes.length).filter((s) => s.qualified);
    const winners: FinishResult['winners'] = [];
    top.forEach((s, i) => {
      const prize = prizes[i];
      applyTx(ctx, { userId: s.userId, amount: prize, type: 'TOURNAMENT_REWARD', key: `tour:${id}:${s.userId}`, meta: { tournament: id, rank: i + 1 } });
      ctx.db.run('UPDATE casino_tournament_entries SET final_rank = ?, prize = ? WHERE tournament_id = ? AND user_id = ?', i + 1, prize, id, s.userId);
      let achievements: Unlocked[] = [];
      if (i === 0) {
        ctx.db.run('UPDATE casino_users SET tournaments_won = tournaments_won + 1 WHERE user_id = ?', s.userId);
        achievements = checkAchievements(ctx, s.userId, { kind: 'tournament_win' });
      }
      winners.push({ userId: s.userId, rank: i + 1, prize, score: s.score, achievements });
    });
    return { tournament: requireTournament(ctx, id), winners, participants: participants(ctx, id) };
  });
}

/** Torneos que cambian de estado ahora (programados que empiezan y activos que terminan). */
export function dueTournaments(ctx: GameContext): { toStart: number[]; toFinish: number[] } {
  const now = ctx.now();
  return {
    toStart: ctx.db.all<{ id: number }>("SELECT id FROM casino_tournaments WHERE status = 'scheduled' AND starts_at <= ?", now).map((r) => r.id),
    toFinish: ctx.db.all<{ id: number }>("SELECT id FROM casino_tournaments WHERE status = 'active' AND ends_at <= ?", now).map((r) => r.id),
  };
}

/** Crea (si no existen) el torneo diario y el semanal del período actual. Idempotente por `auto_key`. */
export function ensureAutoTournaments(ctx: GameContext): Tournament[] {
  const cfg = getCasinoConfig(ctx);
  const now = ctx.now();
  const created: Tournament[] = [];
  const day = casinoDayStart(cfg, now);
  const make = (kind: 'daily' | 'weekly', key: string, startsAt: number, endsAt: number) => {
    const a = cfg.tournaments[kind];
    if (!a.enabled || endsAt <= now) return;
    const m = METRIC_META[a.metric];
    const r = ctx.db.run(
      `INSERT OR IGNORE INTO casino_tournaments (name, description, kind, metric, game, min_bet, max_bet, entry_fee, fees_to_pool, prizes, min_rounds, status, starts_at, ends_at, auto_key, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 0, NULL, 0, 0, ?, ?, 'active', ?, ?, ?, 'sistema', ?, ?)`,
      kind === 'daily' ? '🌅 Torneo diario' : '🗓️ Torneo semanal',
      `${m.emoji} ${m.label} en todos los juegos. Mínimo ${a.minRounds} rondas para cobrar premio.`,
      kind, a.metric, JSON.stringify(a.prizes), a.minRounds, startsAt, endsAt, key, now, now,
    );
    if (r.changes === 1) created.push(getTournament(ctx, Number(r.lastInsertRowid))!);
  };
  make('daily', `daily:${new Date(day + cfg.timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10)}`, day, day + 86_400_000);
  const shifted = new Date(now + cfg.timezoneOffsetMinutes * 60_000);
  const weekStart = day - ((shifted.getUTCDay() + 6) % 7) * 86_400_000; // lunes
  make('weekly', `weekly:${new Date(weekStart + cfg.timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10)}`, weekStart, weekStart + 7 * 86_400_000);
  return created;
}

export function prizeLine(prizes: number[], emoji = '🪙'): string {
  const medals = ['🥇', '🥈', '🥉'];
  return prizes.map((p, i) => `${medals[i] ?? `${i + 1}.`} ${emoji} ${fmt(p)}`).join(' · ');
}

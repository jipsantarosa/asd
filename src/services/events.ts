import { getBuff, getItem } from '../game/config';
import type { EventRewardDef, GameConfig } from '../game/types';
import { applyBuff, GUILD_WIDE } from './buffs';
import { GameError, dayKey, randInt, weightedPick, type GameContext } from './context';
import { gameConfig } from './guildSettings';
import { ensureProfile, getProfile, totalLevel } from './player';
import { recordAction } from './actions';
import { grantReward, type RewardSpec } from './rewards';

export interface EventConfigRow {
  guild_id: string;
  channel_id: string | null;
  enabled: number;
  next_at: number | null;
  updated_at: number;
}

export interface EventRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  kind: 'sorteo' | 'marea';
  reward_json: string;
  winners: number;
  state: 'open' | 'closed' | 'cancelled';
  created_at: number;
  ends_at: number;
  result_json: string | null;
}

export interface EventWinner {
  userId: string;
  text: string;
}

export interface EventResult {
  event: EventRow;
  reward: EventRewardDef;
  participants: number;
  winners: EventWinner[];
}

// ───────────────────────── Configuración por servidor ─────────────────────────

export function getEventConfig(ctx: GameContext, guildId: string): EventConfigRow {
  return ctx.db.get<EventConfigRow>('SELECT * FROM event_config WHERE guild_id = ?', guildId)
    ?? { guild_id: guildId, channel_id: null, enabled: 0, next_at: null, updated_at: 0 };
}

/** Intervalo aleatorio entre eventos (los extremos se ordenan por si el admin los cargó al revés). */
export function randomIntervalMs(cfg: GameConfig, rng: () => number): number {
  const a = cfg.tuning.events.minMinutes;
  const b = cfg.tuning.events.maxMinutes;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.round((lo + (hi - lo) * rng()) * 60_000);
}

export function setEventChannel(ctx: GameContext, guildId: string, channelId: string): void {
  ctx.db.run(
    `INSERT INTO event_config (guild_id, channel_id, enabled, next_at, updated_at) VALUES (?, ?, 0, NULL, ?)
     ON CONFLICT (guild_id) DO UPDATE SET channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
    guildId, channelId, ctx.now(),
  );
}

export function setEventsEnabled(ctx: GameContext, guildId: string, enabled: boolean): EventConfigRow {
  return ctx.db.transaction(() => {
    const cur = getEventConfig(ctx, guildId);
    if (enabled && !cur.channel_id) throw new GameError('Primero elegí el canal donde se van a publicar los eventos.');
    const next = enabled ? ctx.now() + randomIntervalMs(gameConfig(ctx, guildId), ctx.rng) : null;
    ctx.db.run(
      `INSERT INTO event_config (guild_id, channel_id, enabled, next_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET enabled = excluded.enabled, next_at = excluded.next_at, updated_at = excluded.updated_at`,
      guildId, cur.channel_id, enabled ? 1 : 0, next, ctx.now(),
    );
    return getEventConfig(ctx, guildId);
  });
}

// ───────────────────────── Programación ─────────────────────────

export function dueGuilds(ctx: GameContext): string[] {
  return ctx.db.all<{ guild_id: string }>(
    'SELECT guild_id FROM event_config WHERE enabled = 1 AND channel_id IS NOT NULL AND next_at IS NOT NULL AND next_at <= ?', ctx.now(),
  ).map((r) => r.guild_id);
}

export function openEvent(ctx: GameContext, guildId: string): EventRow | undefined {
  return ctx.db.get<EventRow>("SELECT * FROM events WHERE guild_id = ? AND state = 'open'", guildId);
}

export function getEvent(ctx: GameContext, id: number): EventRow | undefined {
  return ctx.db.get<EventRow>('SELECT * FROM events WHERE id = ?', id);
}

export function eventReward(cfg: GameConfig, e: EventRow): EventRewardDef {
  const saved = JSON.parse(e.reward_json) as EventRewardDef;
  // Si el catálogo cambió, se respeta el premio anunciado (el que quedó guardado).
  return saved;
}

/**
 * Crea el próximo evento si corresponde. Es atómico: reprograma `next_at` con un UPDATE
 * condicional, así que dos ticks del programador (o dos procesos) no pueden crear dos eventos.
 * Además, un índice único impide que haya dos sorteos abiertos a la vez en un servidor.
 * `force` = lanzado a mano por un admin (ignora el horario, pero no el sorteo abierto).
 */
export function planEvent(ctx: GameContext, guildId: string, force = false): EventRow | null {
  return ctx.db.transaction(() => {
    const cfg = gameConfig(ctx, guildId);
    const conf = getEventConfig(ctx, guildId);
    const now = ctx.now();
    if (!conf.channel_id) {
      if (force) throw new GameError('Primero elegí el canal de eventos.');
      return null;
    }
    const nextAt = now + randomIntervalMs(cfg, ctx.rng);
    if (force) {
      if (openEvent(ctx, guildId)) throw new GameError('Ya hay un sorteo abierto en este servidor.');
      ctx.db.run('UPDATE event_config SET next_at = ?, updated_at = ? WHERE guild_id = ?', conf.enabled ? nextAt : null, now, guildId);
    } else {
      const r = ctx.db.run('UPDATE event_config SET next_at = ?, updated_at = ? WHERE guild_id = ? AND enabled = 1 AND next_at <= ?',
        nextAt, now, guildId, now);
      if (r.changes !== 1) return null;
      if (openEvent(ctx, guildId)) return null; // hay uno en curso: se salta este turno
    }

    const t = cfg.tuning.events;
    if (ctx.rng() < t.boostChance) {
      // "Marea dorada": bonus para todo el servidor, sin sorteo.
      const buff = getBuff(cfg, cfg.events.guildBoostBuffId)!;
      const until = applyBuffSafe(ctx, guildId, GUILD_WIDE, buff.id, t.boostMinutes);
      const reward: EventRewardDef = { id: 'marea', label: buff.name, emoji: buff.emoji, weight: 0, kind: 'buff', buffId: buff.id, min: 1, max: 1 };
      const r = ctx.db.run(
        `INSERT INTO events (guild_id, channel_id, kind, reward_json, winners, state, created_at, ends_at, result_json)
         VALUES (?, ?, 'marea', ?, 0, 'closed', ?, ?, ?)`,
        guildId, conf.channel_id, JSON.stringify(reward), now, until, JSON.stringify({ until }),
      );
      return getEvent(ctx, Number(r.lastInsertRowid))!;
    }

    const reward = weightedPick(ctx.rng, cfg.events.rewards, (x) => x.weight);
    const winners = randInt(ctx.rng, 1, Math.max(1, t.maxWinners));
    const r = ctx.db.run(
      `INSERT INTO events (guild_id, channel_id, kind, reward_json, winners, state, created_at, ends_at)
       VALUES (?, ?, 'sorteo', ?, ?, 'open', ?, ?)`,
      guildId, conf.channel_id, JSON.stringify(reward), winners, now, now + t.joinSeconds * 1000,
    );
    return getEvent(ctx, Number(r.lastInsertRowid))!;
  });
}

function applyBuffSafe(ctx: GameContext, guildId: string, userId: string, buffId: string, minutes?: number): number {
  try {
    return applyBuff(ctx, guildId, userId, buffId, 'evento', minutes);
  } catch (err) {
    // Si ya estaba al tope de duración, el premio "se pierde" sin romper el evento.
    if (err instanceof GameError) {
      return ctx.db.get<{ expires_at: number }>('SELECT expires_at FROM buffs WHERE guild_id = ? AND user_id = ? AND buff_id = ?', guildId, userId, buffId)?.expires_at ?? ctx.now();
    }
    throw err;
  }
}

export function setEventMessage(ctx: GameContext, id: number, messageId: string): void {
  ctx.db.run('UPDATE events SET message_id = ? WHERE id = ?', messageId, id);
}

export function cancelEvent(ctx: GameContext, id: number): void {
  ctx.db.run("UPDATE events SET state = 'cancelled' WHERE id = ? AND state = 'open'", id);
}

/** Sorteos abiertos cuyo mensaje nunca se publicó (p. ej. se cortó el bot justo al crearlo). */
export function orphanEvents(ctx: GameContext, olderThanMs = 120_000): number[] {
  return ctx.db.all<{ id: number }>(
    "SELECT id FROM events WHERE state = 'open' AND message_id IS NULL AND created_at < ?", ctx.now() - olderThanMs,
  ).map((r) => r.id);
}

// ───────────────────────── Participación ─────────────────────────

/**
 * Anota a un jugador. Los chequeos de cuenta alternativa que dependen de Discord
 * (antigüedad de la cuenta y del ingreso al servidor) los hace la capa de Discord antes de llamar acá.
 */
export function joinEvent(ctx: GameContext, eventId: number, guildId: string, userId: string): { participants: number; endsAt: number } {
  return ctx.db.transaction(() => {
    const e = getEvent(ctx, eventId);
    if (!e || e.guild_id !== guildId || e.kind !== 'sorteo') throw new GameError('Ese evento no existe.');
    if (e.state !== 'open' || e.ends_at <= ctx.now()) throw new GameError('Este sorteo ya terminó.');
    const cfg = gameConfig(ctx, guildId);
    const p = ensureProfile(ctx, guildId, userId);
    const minLevel = cfg.tuning.events.minTotalLevel;
    if (totalLevel(p) < minLevel) throw new GameError(`Para participar necesitás nivel total ${minLevel} (tenés ${totalLevel(p)}). ¡Jugá un poco con /granja o /pesca!`);
    const r = ctx.db.run('INSERT OR IGNORE INTO event_entries (event_id, user_id, joined_at) VALUES (?, ?, ?)', eventId, userId, ctx.now());
    if (r.changes !== 1) throw new GameError('Ya estás participando en este sorteo.');
    const participants = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM event_entries WHERE event_id = ?', eventId)!.n;
    return { participants, endsAt: e.ends_at };
  });
}

export function dueClosures(ctx: GameContext): number[] {
  return ctx.db.all<{ id: number }>("SELECT id FROM events WHERE state = 'open' AND ends_at <= ?", ctx.now()).map((r) => r.id);
}

function winsToday(ctx: GameContext, guildId: string, userId: string, day: string): number {
  return ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM event_wins WHERE guild_id = ? AND user_id = ? AND day = ?', guildId, userId, day)!.n;
}

/** Convierte el premio del sorteo en una recompensa estándar y la entrega (mismo camino que logros y colecciones). */
function grantEventReward(ctx: GameContext, cfg: GameConfig, guildId: string, userId: string, reward: EventRewardDef): string {
  const p = ensureProfile(ctx, guildId, userId);
  const qty = () => randInt(ctx.rng, reward.min, reward.max);
  let spec: RewardSpec;
  switch (reward.kind) {
    case 'coins':
      spec = { coins: Math.round(qty() * Math.min(6, 1 + (reward.scalePerLevel ?? 0) * totalLevel(p))) };
      break;
    case 'bait':
      spec = { items: [{ itemId: cfg.fishing.baitItemId, qty: qty() }] };
      break;
    case 'item':
      spec = { items: [{ itemId: reward.itemId ?? '', qty: qty() }] };
      break;
    case 'buff':
      spec = { buffId: reward.buffId };
      break;
    case 'xp':
      spec = { fishXpFraction: reward.min + (reward.max - reward.min) * ctx.rng() };
      break;
    default:
      return '—';
  }
  const text = grantReward(ctx, guildId, userId, spec, `evento: ${reward.id}`).lines.join(' · ') || '—';
  recordAction(ctx, guildId, userId, 'event', { stats: { 'stat:events_won': 1 } });
  return text;
}

/**
 * Cierra un sorteo vencido, elige ganadores y entrega premios, todo en UNA transacción.
 * El UPDATE condicional (state = 'open') hace que llamarlo dos veces —dos ticks, un reinicio
 * a mitad de camino, dos procesos— entregue los premios una sola vez.
 */
export function closeEvent(ctx: GameContext, eventId: number): EventResult | null {
  return ctx.db.transaction(() => {
    const now = ctx.now();
    const r = ctx.db.run("UPDATE events SET state = 'closed' WHERE id = ? AND state = 'open' AND ends_at <= ?", eventId, now);
    if (r.changes !== 1) return null;
    const e = getEvent(ctx, eventId)!;
    const cfg = gameConfig(ctx, e.guild_id);
    const reward = eventReward(cfg, e);
    const day = dayKey(now, cfg.timezoneOffsetMinutes);
    const entries = ctx.db.all<{ user_id: string }>('SELECT user_id FROM event_entries WHERE event_id = ? ORDER BY joined_at, user_id', eventId).map((x) => x.user_id);

    // Elegibles: siguen existiendo y no superaron el tope diario de victorias.
    const eligible = entries.filter((u) => getProfile(ctx, e.guild_id, u) && winsToday(ctx, e.guild_id, u, day) < cfg.tuning.events.dailyWinCap);
    // Mezcla Fisher–Yates con el RNG del contexto (reproducible en tests).
    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(ctx.rng() * (i + 1));
      [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
    }
    const winners: EventWinner[] = [];
    for (const userId of eligible.slice(0, e.winners)) {
      const text = grantEventReward(ctx, cfg, e.guild_id, userId, reward);
      ctx.db.run('INSERT INTO event_wins (event_id, guild_id, user_id, day, reward_json) VALUES (?, ?, ?, ?, ?)',
        eventId, e.guild_id, userId, day, JSON.stringify({ id: reward.id, text }));
      winners.push({ userId, text });
    }
    ctx.db.run('UPDATE events SET result_json = ? WHERE id = ?', JSON.stringify({ participants: entries.length, winners }), eventId);
    return { event: getEvent(ctx, eventId)!, reward, participants: entries.length, winners };
  });
}

export function recentEvents(ctx: GameContext, guildId: string, limit = 5): EventRow[] {
  return ctx.db.all<EventRow>("SELECT * FROM events WHERE guild_id = ? AND state <> 'cancelled' ORDER BY id DESC LIMIT ?", guildId, limit);
}

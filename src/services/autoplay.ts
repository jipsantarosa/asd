import { castAt, type CastResult } from './fishing';
import { farm, type FarmResult } from './farming';
import { GameError, type GameContext } from './context';
import { ensureProfile } from './player';
import { FEATURE_TIER, requireTier, tierOf } from './premium';

/**
 * !autoplay (Premium Tier 2+): cada 10 minutos el bot cosecha y pesca una vez por vos,
 * en el servidor donde lo activaste. Usa las mismas funciones que los botones, así que respeta
 * el vigor, la carnada, las esperas y los desbloqueos: no regala nada que no ganarías jugando.
 * El estado vive en la base de datos: sobrevive reinicios y nunca corre dos veces el mismo turno.
 */
export const AUTOPLAY_INTERVAL_MS = 10 * 60_000;

export interface AutoplayRow {
  guild_id: string;
  user_id: string;
  enabled: number;
  next_at: number;
  started_at: number;
  harvests: number;
  catches: number;
  runs: number;
  last_at: number | null;
  last_note: string | null;
}

export function getAutoplay(ctx: GameContext, guildId: string, userId: string): AutoplayRow | null {
  return ctx.db.get<AutoplayRow>('SELECT * FROM autoplay WHERE guild_id = ? AND user_id = ?', guildId, userId) ?? null;
}

export function setAutoplay(ctx: GameContext, guildId: string, userId: string, on: boolean): AutoplayRow | null {
  if (on) requireTier(ctx, userId, FEATURE_TIER.autoplay, '!autoplay');
  ensureProfile(ctx, guildId, userId);
  const now = ctx.now();
  if (on) {
    ctx.db.run(
      `INSERT INTO autoplay (guild_id, user_id, enabled, next_at, started_at) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET enabled = 1, next_at = excluded.next_at, started_at = excluded.started_at,
         harvests = 0, catches = 0, runs = 0, last_note = NULL`,
      guildId, userId, now, now,
    );
  } else {
    ctx.db.run('UPDATE autoplay SET enabled = 0 WHERE guild_id = ? AND user_id = ?', guildId, userId);
  }
  return getAutoplay(ctx, guildId, userId);
}

export function dueAutoplay(ctx: GameContext, limit = 50): { guildId: string; userId: string }[] {
  return ctx.db.all<{ guild_id: string; user_id: string }>(
    'SELECT guild_id, user_id FROM autoplay WHERE enabled = 1 AND next_at <= ? ORDER BY next_at LIMIT ?', ctx.now(), limit,
  ).map((r) => ({ guildId: r.guild_id, userId: r.user_id }));
}

export interface AutoplayRun {
  farm: FarmResult | null;
  fish: CastResult | null;
  notes: string[];
  /** Se apagó porque el premium venció o bajó de nivel. */
  stopped: boolean;
}

/**
 * Un turno de autoplay. Primero reserva el turno con un UPDATE condicional: si dos procesos
 * (o dos ticks) lo intentan a la vez, solo uno lo corre. Devuelve null si no tocaba.
 */
export function runAutoplay(ctx: GameContext, guildId: string, userId: string): AutoplayRun | null {
  const now = ctx.now();
  const claimed = ctx.db.run(
    'UPDATE autoplay SET next_at = ? WHERE guild_id = ? AND user_id = ? AND enabled = 1 AND next_at <= ?',
    now + AUTOPLAY_INTERVAL_MS, guildId, userId, now,
  ).changes === 1;
  if (!claimed) return null;

  if (tierOf(ctx, userId) < FEATURE_TIER.autoplay) {
    ctx.db.run("UPDATE autoplay SET enabled = 0, last_at = ?, last_note = 'Se apagó: el premium venció o bajó de nivel.' WHERE guild_id = ? AND user_id = ?", now, guildId, userId);
    return { farm: null, fish: null, notes: ['Se apagó: el premium venció o bajó de nivel.'], stopped: true };
  }

  const notes: string[] = [];
  let farmRes: FarmResult | null = null;
  let fishRes: CastResult | null = null;
  try {
    farmRes = farm(ctx, guildId, userId);
    notes.push(`🌾 cosecha: ${farmRes.drops.reduce((n, d) => n + d.qty, 0)} cultivos`);
  } catch (err) {
    if (!(err instanceof GameError)) throw err;
    notes.push(`🌾 ${err.message}`);
  }
  try {
    fishRes = castAt(ctx, guildId, userId, 'random');
    notes.push(`🎣 pesca: ${fishRes.catches.length} ${fishRes.catches.length === 1 ? 'pez' : 'peces'}`);
  } catch (err) {
    if (!(err instanceof GameError)) throw err;
    notes.push(`🎣 ${err.message}`);
  }
  ctx.db.run(
    'UPDATE autoplay SET runs = runs + 1, harvests = harvests + ?, catches = catches + ?, last_at = ?, last_note = ? WHERE guild_id = ? AND user_id = ?',
    farmRes ? 1 : 0, fishRes?.catches.length ?? 0, now, notes.join(' · ').slice(0, 300), guildId, userId,
  );
  return { farm: farmRes, fish: fishRes, notes, stopped: false };
}

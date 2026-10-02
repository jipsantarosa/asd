import { Events } from 'discord.js';
import { getCasinoConfig } from '../../casino/config';
import { activeRoundsOfGames, allGames, resolveStaleRound, staleRounds, type RoundView } from '../../casino/engine';
import { closeExpiredDrops } from '../../casino/events';
import { dueTournaments, ensureAutoTournaments } from '../../casino/tournaments';
import { logger } from '../../logger';
import type { GameContext } from '../../services/context';
import type { App } from '../app';
import { dropPanel } from './admin';
import { closeAndAnnounce, startAndAnnounce } from './announce';
import { refreshRoundMessage } from './play';

/**
 * Tareas de fondo del casino:
 * - latido: guarda cada 10 s que el bot está vivo (para resolver con justicia un Crash interrumpido);
 * - al arrancar: resuelve los Crash que quedaron en vuelo (pagar el retiro automático, pérdida o devolución);
 * - cada minuto: resuelve partidas abandonadas (cobrar lo ganado, plantarse o devolver);
 * - cada 15 s: torneos automáticos, torneos que empiezan o terminan, y lluvias de monedas vencidas.
 */

const HEARTBEAT_KEY = 'heartbeat';

export function lastHeartbeat(ctx: GameContext): number | null {
  const r = ctx.db.get<{ value: string }>('SELECT value FROM casino_meta WHERE key = ?', HEARTBEAT_KEY);
  const n = r ? Number(r.value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

export function beat(ctx: GameContext): void {
  const now = ctx.now();
  ctx.db.run(`INSERT INTO casino_meta (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, HEARTBEAT_KEY, String(now), now);
}

/** Crash en vuelo cuando el bot se apagó: se resuelven con el último latido. Devuelve las rondas resueltas. */
export function recoverLiveRounds(ctx: GameContext): RoundView[] {
  const lastAlive = lastHeartbeat(ctx) ?? ctx.now();
  const out: RoundView[] = [];
  const live = allGames().filter((g) => g.kind === 'live').map((g) => g.id);
  for (const r of activeRoundsOfGames(ctx, live)) {
    const v = resolveStaleRound(ctx, r.id, lastAlive);
    if (v) out.push(v);
  }
  return out;
}

/** Partidas sin tocar durante `abandonMinutes`. */
export function resolveAbandoned(ctx: GameContext): RoundView[] {
  const cfg = getCasinoConfig(ctx);
  const now = ctx.now();
  const out: RoundView[] = [];
  for (const r of staleRounds(ctx, now - cfg.abandonMinutes * 60_000)) {
    const v = resolveStaleRound(ctx, r.id, now);
    if (v) out.push(v);
  }
  return out;
}

export function startCasino(app: App): { stop(): void } {
  const ctx = app.ctx;
  let recovered: RoundView[] = [];
  try {
    recovered = recoverLiveRounds(ctx);
    if (recovered.length) logger.info(`Casino: ${recovered.length} partida(s) de Crash interrumpidas se resolvieron tras el reinicio.`);
    ensureAutoTournaments(ctx);
  } catch (err) {
    logger.error('Casino: fallo al recuperar partidas:', err);
  }
  beat(ctx);

  // Los mensajes se actualizan cuando Discord está listo.
  app.client.once(Events.ClientReady, () => {
    for (const v of recovered) void refreshRoundMessage(app, v);
  });

  const heartbeat = setInterval(() => {
    try {
      beat(ctx);
    } catch (err) {
      logger.warn('Casino: latido:', err);
    }
  }, 10_000);

  let busy = false;
  const tick = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        ensureAutoTournaments(ctx);
        const due = dueTournaments(ctx);
        for (const id of due.toStart) await startAndAnnounce(app, id).catch((err) => logger.warn(`Torneo ${id} (inicio):`, err));
        for (const id of due.toFinish) await closeAndAnnounce(app, id).catch((err) => logger.warn(`Torneo ${id} (cierre):`, err));
        for (const d of closeExpiredDrops(ctx)) {
          const ch = app.client.guilds.cache.get(d.guildId)?.channels.cache.get(d.channelId);
          if (d.messageId && ch?.isTextBased()) await ch.messages.edit(d.messageId, { ...dropPanel(d, d.claims), allowedMentions: { parse: [] } }).catch(() => undefined);
        }
      } catch (err) {
        logger.error('Casino: tarea periódica:', err);
      } finally {
        busy = false;
      }
    })();
  }, 15_000);

  const abandon = setInterval(() => {
    try {
      const done = resolveAbandoned(ctx);
      for (const v of done) void refreshRoundMessage(app, v);
      if (done.length) logger.info(`Casino: ${done.length} partida(s) abandonadas resueltas.`);
    } catch (err) {
      logger.error('Casino: partidas abandonadas:', err);
    }
  }, 60_000);

  for (const t of [heartbeat, tick, abandon]) t.unref();
  return {
    stop() {
      clearInterval(heartbeat);
      clearInterval(tick);
      clearInterval(abandon);
      try {
        beat(ctx);
      } catch {
        /* la base ya puede estar cerrada */
      }
    },
  };
}

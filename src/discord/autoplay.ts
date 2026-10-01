import { logger } from '../logger';
import { dueAutoplay, runAutoplay } from '../services/autoplay';
import type { App } from './app';

/**
 * Corre los turnos de !autoplay que tocan (revisa cada minuto). Si en un turno hubo logros
 * o subidas de nivel, entrega distinciones y avisos por DM como cualquier otra acción.
 */
export function startAutoplayScheduler(app: App, everyMs = 60_000): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(async () => {
    if (running || !app.client.isReady()) return;
    running = true;
    try {
      for (const { guildId, userId } of dueAutoplay(app.ctx)) {
        const guild = app.client.guilds.cache.get(guildId);
        if (!guild) continue; // el bot ya no está en ese servidor: queda en pausa
        try {
          const r = runAutoplay(app.ctx, guildId, userId);
          const notable = r && (r.farm?.gain.levelUp || r.fish?.gain.levelUp || r.farm?.outcome.achievements.length || r.fish?.outcome.achievements.length);
          if (notable) {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member) await app.afterAction?.(member);
          }
        } catch (err) {
          logger.warn(`Autoplay de ${userId} en ${guildId}:`, err);
        }
      }
    } finally {
      running = false;
    }
  }, everyMs);
  timer.unref();
  return timer;
}

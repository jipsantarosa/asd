import { PermissionFlagsBits, type Guild, type GuildTextBasedChannel } from 'discord.js';
import { logger } from '../../logger';
import {
  cancelEvent, closeEvent, dueClosures, dueGuilds, eventReward, getEvent, orphanEvents, planEvent, setEventMessage, type EventRow,
} from '../../services/events';
import { gameConfig } from '../../services/guildSettings';
import type { App } from '../app';
import { logSystem } from '../logging/sender';
import { closedEventMessage, mareaMessage, openEventMessage } from '../ui/eventPanels';
import { COLORS } from '../ui/theme';

function eventChannel(guild: Guild, channelId: string): GuildTextBasedChannel | null {
  const ch = guild.channels.cache.get(channelId);
  const me = guild.members.me;
  if (!ch || !ch.isTextBased() || !me) return null;
  if (!ch.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return null;
  return ch as GuildTextBasedChannel;
}

/** Publica un evento ya creado en la base de datos. Si no se puede publicar, se cancela (sin premios). */
async function publish(app: App, e: EventRow): Promise<void> {
  const guild = app.client.guilds.cache.get(e.guild_id);
  const cfg = gameConfig(app.ctx, e.guild_id);
  const ch = guild ? eventChannel(guild, e.channel_id) : null;
  if (!guild || !ch) {
    cancelEvent(app.ctx, e.id);
    if (guild) await logSystem(app.ctx, guild, `⚠️ No pude publicar un evento en <#${e.channel_id}>: revisá que el bot pueda ver el canal, escribir e insertar enlaces.`, COLORS.warn);
    return;
  }
  const panel = e.kind === 'marea' ? mareaMessage(cfg, e) : openEventMessage(cfg, e, eventReward(cfg, e));
  try {
    const msg = await ch.send({ ...panel, allowedMentions: { parse: [] } });
    setEventMessage(app.ctx, e.id, msg.id);
  } catch (err) {
    cancelEvent(app.ctx, e.id);
    logger.warn(`No pude publicar el evento ${e.id}:`, (err as Error).message);
  }
}

/** Crea y publica un evento. `force` = lanzado a mano desde /eventos (errores visibles al admin). */
export async function launchEvent(app: App, guildId: string, force = false): Promise<EventRow | null> {
  const e = planEvent(app.ctx, guildId, force);
  if (e) await publish(app, e);
  return e ? getEvent(app.ctx, e.id) ?? null : null;
}

export async function finishEvent(app: App, eventId: number): Promise<void> {
  // Primero se cierra y se reparten premios en la base (atómico e idempotente); después se avisa en Discord.
  const res = closeEvent(app.ctx, eventId);
  if (!res) return;
  const guild = app.client.guilds.cache.get(res.event.guild_id);
  if (!guild) return;
  const cfg = gameConfig(app.ctx, guild.id);
  const ch = eventChannel(guild, res.event.channel_id);
  if (!ch) return;
  const panel = closedEventMessage(cfg, res);
  if (res.event.message_id) {
    await ch.messages.edit(res.event.message_id, { ...panel, allowedMentions: { parse: [] } }).catch(() => undefined);
  }
  if (res.winners.length) {
    await ch.send({
      content: `🎉 ${res.winners.map((w) => `<@${w.userId}>`).join(' ')} ${res.winners.length === 1 ? 'ganó' : 'ganaron'} el sorteo. ¡Felicitaciones!`,
      allowedMentions: { users: res.winners.map((w) => w.userId) },
    }).catch(() => undefined);
  }
}

/**
 * Programador: cada 20 s cierra sorteos vencidos y lanza los eventos que tocan.
 * Todo el estado vive en la base de datos, así que un reinicio no duplica ni pierde eventos:
 * al volver, cierra lo vencido y sigue el calendario.
 */
export function startEventScheduler(app: App, everyMs = 20_000): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running || !app.client.isReady()) return;
    running = true;
    try {
      for (const id of orphanEvents(app.ctx)) cancelEvent(app.ctx, id);
      for (const id of dueClosures(app.ctx)) await finishEvent(app, id);
      for (const guildId of dueGuilds(app.ctx)) {
        if (!app.client.guilds.cache.has(guildId)) continue;
        await launchEvent(app, guildId).catch((err) => logger.warn(`Evento en ${guildId}:`, err));
      }
    } catch (err) {
      logger.error('Programador de eventos:', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  return timer;
}

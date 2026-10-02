import type { Message } from 'discord.js';
import { ActivityGuard, rewardMessage } from '../../casino/activity';
import { logger } from '../../logger';
import type { App } from '../app';

/**
 * Escucha de mensajes para las Coins por actividad. Corre después del automod y de los comandos
 * (el spam borrado y los comandos nunca pagan). No responde nada en el chat: lo ganado se ve en !balance.
 */
export function createActivityListener(app: App): (msg: Message) => void {
  const guard = new ActivityGuard();
  const sweep = setInterval(() => guard.sweep(Date.now()), 10 * 60_000);
  sweep.unref();
  return (msg) => {
    if (!msg.inGuild() || msg.author.bot || msg.webhookId || msg.system) return;
    try {
      rewardMessage(app.ctx, guard, {
        userId: msg.author.id,
        guildId: msg.guildId,
        messageId: msg.id,
        content: msg.content,
        accountCreatedAt: msg.author.createdTimestamp,
        memberJoinedAt: msg.member?.joinedTimestamp ?? null,
      });
    } catch (err) {
      logger.warn('Actividad del casino:', err);
    }
  };
}

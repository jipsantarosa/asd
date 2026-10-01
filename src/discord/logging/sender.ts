import { ChannelType, EmbedBuilder, PermissionFlagsBits, type Guild, type MessageCreateOptions, type TextChannel } from 'discord.js';
import { logger } from '../../logger';
import type { GameContext } from '../../services/context';
import { getLogConfig, type LogKey } from '../../services/logConfig';
import { COLORS } from '../ui/theme';

/** Devuelve el canal de registro si existe y el bot puede escribir en él. */
export function logChannel(ctx: GameContext, guild: Guild, key: LogKey): TextChannel | null {
  const id = getLogConfig(ctx, guild.id).channels[key];
  if (!id) return null;
  const ch = guild.channels.cache.get(id);
  if (!ch || ch.type !== ChannelType.GuildText) return null;
  const me = guild.members.me;
  if (!me || !ch.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return null;
  return ch;
}

export async function sendLog(ctx: GameContext, guild: Guild, key: LogKey, payload: MessageCreateOptions): Promise<void> {
  const ch = logChannel(ctx, guild, key);
  if (!ch) return;
  try {
    await ch.send({ ...payload, allowedMentions: { parse: [] } });
  } catch (err) {
    logger.warn(`No pude escribir en el registro ${key} de ${guild.id}:`, (err as Error).message);
  }
}

/** Aviso en el canal del sistema del bot (configuración, alertas antiabuso). */
export async function logSystem(ctx: GameContext, guild: Guild, text: string, color: number = COLORS.log): Promise<void> {
  await sendLog(ctx, guild, 'sistema', { embeds: [new EmbedBuilder().setColor(color).setDescription(text).setTimestamp()] });
}

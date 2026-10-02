import { ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, type Guild } from 'discord.js';
import { getCasinoGuild } from '../../casino/guilds';
import type { GameContext } from '../../services/context';
import { getSettings } from '../../services/guildSettings';
import { getLogConfig } from '../../services/logConfig';
import { row, type Panel } from '../app';
import { cid } from './ids';
import { COLORS } from './theme';

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

/** /ajustes: lo que maneja el staff de cada servidor. La economía del casino es global y solo la toca el dueño del bot. */
export function settingsPanel(ctx: GameContext, guild: Guild, owner: string, notice?: string): Panel {
  const s = getSettings(ctx, guild.id);
  const logs = getLogConfig(ctx, guild.id);
  const g = getCasinoGuild(ctx, guild.id);
  const embed = new EmbedBuilder()
    .setColor(COLORS.settings)
    .setTitle('⚙️ Ajustes del servidor')
    .setDescription([
      ...(notice ? [notice, ''] : []),
      `⌨️ **Prefijo:** \`${s.prefix}\` (también funciona mencionar al bot)`,
      `📝 **Registro de mensajes enviados:** ${logs.logSentMessages ? 'activado' : 'desactivado'}`,
      '',
      '**🎰 Casino en este servidor**',
      `📢 **Canal de anuncios:** ${g.announceChannelId ? `<#${g.announceChannelId}>` : '*ninguno* (no se anuncian premios ni torneos)'}`,
      `🎲 **Canales de juego:** ${g.gameChannels.length ? g.gameChannels.map((c) => `<#${c}>`).join(' ') : '*cualquier canal*'}`,
      `💬 **Coins por actividad:** ${g.activityEnabled ? 'activadas' : 'desactivadas'}`,
      '',
      '-# La economía (saldos, apuestas, premios y torneos) es la misma en todos los servidores y solo la configura el dueño del bot. Las monedas son virtuales: no se compran ni se cambian por dinero.',
    ].join('\n'));

  const announce = new ChannelSelectMenuBuilder().setCustomId(cid('st', 'announce', owner)).setPlaceholder('Canal de anuncios del casino…')
    .setChannelTypes(...TEXT_CHANNELS).setMinValues(0).setMaxValues(1);
  if (g.announceChannelId) announce.setDefaultChannels(g.announceChannelId);
  const games = new ChannelSelectMenuBuilder().setCustomId(cid('st', 'games', owner)).setPlaceholder('Canales de juego (vacío = cualquiera)…')
    .setChannelTypes(...TEXT_CHANNELS).setMinValues(0).setMaxValues(10);
  if (g.gameChannels.length) games.setDefaultChannels(...g.gameChannels);

  return {
    embeds: [embed],
    components: [
      row(announce),
      row(games),
      row(
        new ButtonBuilder().setCustomId(cid('st', 'prefix', owner)).setLabel('Cambiar prefijo').setEmoji('⌨️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(cid('st', 'logmsg', owner)).setLabel(logs.logSentMessages ? 'No registrar mensajes' : 'Registrar mensajes').setEmoji('📝').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(cid('st', 'activity', owner)).setLabel(g.activityEnabled ? 'Apagar Coins por actividad' : 'Activar Coins por actividad').setEmoji('💬')
          .setStyle(g.activityEnabled ? ButtonStyle.Secondary : ButtonStyle.Success),
      ),
    ],
  };
}

import {
  ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, type Guild,
} from 'discord.js';
import type { GameContext } from '../../services/context';
import { MAX_TEMP_CHANNELS_PER_GUILD, getVoiceConfig, listTempChannels } from '../../services/tempVoice';
import { row, type Panel, type Row } from '../app';
import { cid } from './ids';
import { COLORS, clean } from './theme';

export const VOICE_COLOR = 0x5865f2;

/** Botones de la interfaz: [acción, emoji, nombre]. Tres filas de cinco, como un control remoto. */
export const VOICE_BUTTONS: [string, string, string][][] = [
  [['name', '✏️', 'Nombre'], ['limit', '👥', 'Límite'], ['lock', '🔒', 'Privado'], ['hide', '👻', 'Ocultar'], ['region', '🌍', 'Región']],
  [['trust', '✅', 'Permitir'], ['untrust', '➖', 'Quitar acceso'], ['invite', '📨', 'Invitar'], ['kick', '👢', 'Expulsar'], ['info', 'ℹ️', 'Info']],
  [['block', '🚫', 'Bloquear'], ['unblock', '♻️', 'Desbloquear'], ['claim', '👑', 'Reclamar'], ['transfer', '🔁', 'Transferir'], ['delete', '🗑️', 'Eliminar']],
];

export const VOICE_ACTIONS = VOICE_BUTTONS.flat().map(([act]) => act);

/** Solo ícono (como un control remoto, compacto en el celular); el nombre de cada botón está en la leyenda. */
function buttonRows(): Row[] {
  return VOICE_BUTTONS.map((line) => row(...line.map(([act, emoji]) =>
    new ButtonBuilder().setCustomId(cid('vc', act, '0')).setEmoji(emoji)
      .setStyle(act === 'delete' ? ButtonStyle.Danger : ButtonStyle.Secondary))));
}

/** Leyenda con "chips": `✏️ Nombre` `👥 Límite` … (una línea por fila de botones). */
function legend(): string {
  return VOICE_BUTTONS.map((line) => line.map(([, emoji, label]) => `\`${emoji} ${label}\``).join(' ')).join('\n');
}

/**
 * Interfaz pública (canal de interfaz o /canal). Los botones actúan sobre el canal temporal en el que
 * estás (o sobre el canal de cuyo chat sale el panel).
 */
export function voiceInterface(hubId: string | null): Panel {
  const embed = new EmbedBuilder()
    .setColor(VOICE_COLOR)
    .setTitle('🎛️ Interfaz de canales temporales')
    .setDescription([
      hubId ? `Entrá a <#${hubId}> y el bot te crea **tu propio canal de voz**. Cuando queda vacío, se borra solo.` : 'Todavía no hay un canal para crear salas. Un admin lo configura con `/voz`.',
      '',
      legend(),
      '',
      '-# Los botones actúan sobre el canal temporal en el que estás. Tus ajustes (nombre, límite, privacidad, permitidos y bloqueados) se guardan para la próxima vez.',
    ].join('\n'));
  return { embeds: [embed], components: buttonRows() };
}

/** Panel que se publica en el chat del canal recién creado. Los botones actúan sobre ESTE canal. */
export function ownerWelcome(ownerId: string): Panel {
  const embed = new EmbedBuilder()
    .setColor(VOICE_COLOR)
    .setTitle('🎙️ Tu canal está listo')
    .setDescription([
      `<@${ownerId}> es quien maneja este canal. Desde estos botones podés renombrarlo, ponerle límite, hacerlo privado, permitir o bloquear personas y más.`,
      '',
      legend(),
      '',
      '-# Si quien lo creó se va, cualquiera adentro puede usar 👑 Reclamar. Cuando el canal queda vacío, se borra solo.',
    ].join('\n'));
  return { embeds: [embed], components: buttonRows() };
}

export interface VoiceInfo {
  name: string;
  ownerId: string;
  ownerPresent: boolean;
  createdAt: number;
  members: number;
  limit: number;
  locked: boolean;
  hidden: boolean;
  region: string | null;
  trusted: string[];
  blocked: string[];
}

export function voiceInfoEmbed(v: VoiceInfo): EmbedBuilder {
  const list = (ids: string[]) => (ids.length ? ids.slice(0, 15).map((id) => `<@${id}>`).join(' ') + (ids.length > 15 ? ` y ${ids.length - 15} más` : '') : '*nadie*');
  return new EmbedBuilder()
    .setColor(VOICE_COLOR)
    .setTitle(`ℹ️ ${clean(v.name)}`)
    .setDescription([
      `👑 **Dueño:** <@${v.ownerId}>${v.ownerPresent ? '' : ' · *no está en el canal (se puede reclamar)*'}`,
      `🕒 **Creado:** <t:${Math.floor(v.createdAt / 1000)}:R>`,
      `👥 **Adentro:** ${v.members}${v.limit ? `/${v.limit}` : ''} · **Límite:** ${v.limit || 'sin límite'}`,
      `${v.locked ? '🔒 **Privado**: solo entran quienes permitas' : '🔓 **Abierto**: cualquiera puede entrar'}`,
      `${v.hidden ? '👻 **Oculto**: solo lo ven quienes permitas' : '👁️ **Visible** para todos'}`,
      `🌍 **Región:** ${v.region ?? 'automática'}`,
      '',
      `✅ **Permitidos:** ${list(v.trusted)}`,
      `🚫 **Bloqueados:** ${list(v.blocked)}`,
    ].join('\n'));
}

/** /voz — administración del sistema. */
export function voiceAdminPanel(ctx: GameContext, guild: Guild, owner: string, notice?: string): Panel {
  const conf = getVoiceConfig(ctx, guild.id);
  const active = listTempChannels(ctx, guild.id);
  const ch = (id: string | null) => (id && guild.channels.cache.has(id) ? `<#${id}>` : id ? '⚠️ *borrado*' : '*sin configurar*');
  const embed = new EmbedBuilder()
    .setColor(COLORS.settings)
    .setTitle('🔊 Canales de voz temporales')
    .setDescription([
      notice ? `${notice}\n` : '',
      `**Estado:** ${conf.enabled ? '🟢 activado' : '🔴 desactivado'}`,
      `**Categoría:** ${ch(conf.categoryId)}`,
      `**Canal para crear:** ${ch(conf.hubChannelId)}`,
      `**Interfaz:** ${ch(conf.interfaceChannelId)}`,
      `**Nombre por defecto:** \`${conf.nameTemplate}\` · **Límite por defecto:** ${conf.defaultLimit || 'sin límite'}`,
      `**Canales activos:** ${active.length}/${MAX_TEMP_CHANNELS_PER_GUILD}`,
      '',
      '-# **Configurar / reparar** crea, recupera o actualiza la categoría, el canal "➕ Crear canal" y la interfaz, sin duplicar nada. Al actualizar el bot se sincroniza solo.',
    ].filter((x) => x !== '').join('\n'));
  return {
    embeds: [embed],
    components: [
      row(
        new ButtonBuilder().setCustomId(cid('va', 'setup', owner)).setLabel('Configurar / reparar').setEmoji('🛠️').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(cid('va', 'tpl', owner)).setLabel('Nombre y límite').setEmoji('✏️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(cid('va', 'toggle', owner)).setLabel(conf.enabled ? 'Desactivar' : 'Activar')
          .setEmoji(conf.enabled ? '⏸️' : '▶️').setStyle(conf.enabled ? ButtonStyle.Danger : ButtonStyle.Secondary).setDisabled(!conf.hubChannelId),
        new ButtonBuilder().setCustomId(cid('va', 'view', owner)).setEmoji('🔄').setStyle(ButtonStyle.Secondary),
      ),
      row(new ChannelSelectMenuBuilder().setCustomId(cid('va', 'post', owner)).setPlaceholder('Publicar la interfaz en otro canal…')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    ],
  };
}

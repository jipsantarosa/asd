import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getVoiceConfig } from '../../services/tempVoice';
import { voiceAdminPanel, voiceInterface } from '../ui/voicePanels';
import type { Command } from './types';

/** /voz — administración de los canales de voz temporales (crear, reparar, plantilla, activar). */
export const vozCmd: Command = {
  name: 'voz',
  aliases: ['tempvoice', 'vozadmin'],
  prefix: true,
  permission: PermissionFlagsBits.ManageGuild,
  permissionName: 'Gestionar servidor',
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('voz')
    .setDescription('Canales de voz temporales: configurar, reparar y ajustar los canales nuevos.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async run(c) {
    await c.reply(voiceAdminPanel(c.app.ctx, c.guild, c.member.id), { ephemeral: true });
  },
};

/** /canal — la interfaz para manejar tu canal temporal (los mismos botones que el canal de interfaz). */
export const canalCmd: Command = {
  name: 'canal',
  aliases: ['vc', 'micanal', 'sala'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('canal')
    .setDescription('Maneja tu canal de voz temporal: nombre, límite, privacidad, permisos y más.'),
  async run(c) {
    await c.reply(voiceInterface(getVoiceConfig(c.app.ctx, c.guild.id).hubChannelId), { ephemeral: true });
  },
};

import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { GameError } from '../../services/context';
import { getSettings, setPrefix } from '../../services/guildSettings';
import { getLogConfig } from '../../services/logConfig';
import { logSystem } from '../logging/sender';
import { runSetup } from '../logging/setup';
import { maintenanceRow } from '../setupMaintenance';
import { helpPanel } from '../ui/helpPanel';
import { rolesAdminPanel } from '../ui/rolesPanel';
import { settingsPanel } from '../ui/settingsPanel';
import { COLORS } from '../ui/theme';
import { CASINO_COMMANDS } from '../casino/commands';
import { stealCmd, stealContextMenu } from './steal';
import { divorceCmd, marryCmd, profileCmd, setlangCmd } from './social';
import { antiWebhooksCmd, boostTrackerCmd } from './serverTools';
import { plantillaCmd, setupDiscordCmd } from './serverTemplates';
import type { Command } from './types';
import { canalCmd, vozCmd } from './voice';
import { MODERATION_COMMANDS } from './moderation';
import { avatares, banners, besosCmd, kissCmd, purgar } from './community';
import { botProfileCmd, clearAvatarsCmd, clearNamesCmd, clearTagsCmd, ghostCmd, mstatsCmd, namesCmd, premiumCmd, tagsCmd } from './premium';

const ayuda: Command = {
  name: 'ayuda',
  aliases: ['help', 'h', 'comandos'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('ayuda').setDescription('Guía del casino y lista de comandos.'),
  async run(c) {
    await c.reply(helpPanel(c.app.ctx, c.viewer), { ephemeral: true });
  },
};

const prefijo: Command = {
  name: 'prefijo',
  aliases: ['prefix'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('prefijo').setDescription('Ver o cambiar el prefijo de comandos de texto.')
    .addStringOption((o) => o.setName('nuevo').setDescription('Nuevo prefijo (1 a 5 caracteres, sin espacios)').setMaxLength(5)),
  async run(c) {
    const next = c.str('nuevo', 0);
    const current = getSettings(c.app.ctx, c.guild.id).prefix;
    if (!next) {
      await c.reply({ content: `⌨️ El prefijo de este servidor es \`${current}\`. También podés mencionarme en lugar de usar el prefijo.` }, { ephemeral: true });
      return;
    }
    if (!c.member.permissions.has(PermissionFlagsBits.ManageGuild)) throw new GameError('Necesitás el permiso **Gestionar servidor** para cambiar el prefijo.');
    const saved = setPrefix(c.app.ctx, c.guild.id, next);
    await logSystem(c.app.ctx, c.guild, `⌨️ <@${c.member.id}> cambió el prefijo de \`${current}\` a \`${saved}\`.`);
    await c.reply({ content: `✅ Listo: el nuevo prefijo es \`${saved}\` (por ejemplo \`${saved}casino\`).` }, { ephemeral: true });
  },
};

const ajustes: Command = {
  name: 'ajustes',
  aliases: ['config', 'settings'],
  prefix: true,
  permission: PermissionFlagsBits.ManageGuild,
  permissionName: 'Gestionar servidor',
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('ajustes').setDescription('Prefijo, registros y canales del casino en este servidor.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async run(c) {
    await c.reply(settingsPanel(c.app.ctx, c.guild, c.member.id), { ephemeral: true });
  },
};

const roles: Command = {
  name: 'roles',
  aliases: ['rolesadmin'],
  prefix: true,
  permission: PermissionFlagsBits.ManageRoles,
  permissionName: 'Gestionar roles',
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('roles').setDescription('Centro de roles: grupos seleccionables y distinciones por nivel del casino.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  async run(c) {
    await c.reply(rolesAdminPanel(c.app.ctx, c.guild, c.member.id, { kind: 'home' }), { ephemeral: true });
  },
};

const setup: Command = {
  name: 'setup',
  aliases: [],
  prefix: true,
  permission: PermissionFlagsBits.Administrator,
  permissionName: 'Administrador',
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('setup').setDescription('Configura, repara o actualiza el sistema de registros del servidor (sin duplicar).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption((o) => o.setName('rol_staff').setDescription('Rol adicional (sin permisos de admin) que podrá leer los registros'))
    .addBooleanOption((o) => o.setName('registrar_mensajes').setDescription('¿Registrar todos los mensajes enviados? (por defecto: sí)')),
  async run(c) {
    const staff = c.role('rol_staff', 0);
    if (staff && (staff.id === c.guild.id || staff.managed)) throw new GameError('Ese rol no sirve como rol de staff.');
    await c.defer(true);
    const res = await c.app.guildLock.run(`setup:${c.guild.id}`, async () => {
      const previous = getLogConfig(c.app.ctx, c.guild.id);
      return runSetup(c.app.ctx, c.guild, {
        staffRoleId: staff?.id ?? null,
        logSentMessages: c.bool('registrar_mensajes', 1) ?? previous.logSentMessages,
        executorTag: c.member.user.tag,
      });
    });
    if (!res.ran) throw new GameError('Ya hay un `/setup` en curso en este servidor. Esperá a que termine.');
    await c.reply({ embeds: [res.value.embed], components: res.value.ok || res.value.duplicates ? [maintenanceRow(c.member.id, 'logs', res.value.duplicates)] : [] }, { ephemeral: true });
    await logSystem(c.app.ctx, c.guild, `🛠️ <@${c.member.id}> ejecutó \`/setup\`.`, COLORS.ok);
  },
};

export const COMMANDS: Command[] = [
  ...CASINO_COMMANDS,
  profileCmd, marryCmd, divorceCmd, setlangCmd, boostTrackerCmd, antiWebhooksCmd, setupDiscordCmd, plantillaCmd,
  ayuda, prefijo, ajustes, roles, setup, stealCmd, purgar, avatares, banners, kissCmd, besosCmd,
  premiumCmd, namesCmd, tagsCmd, clearAvatarsCmd, clearNamesCmd, clearTagsCmd, mstatsCmd, ghostCmd, botProfileCmd,
  vozCmd, canalCmd, ...MODERATION_COMMANDS,
];

/** Comandos del menú contextual (clic derecho en un mensaje → Apps). */
export const CONTEXT_MENUS = [stealContextMenu];

const byName = new Map<string, Command>();
for (const cmd of COMMANDS) {
  for (const n of [cmd.name, ...cmd.aliases]) {
    if (byName.has(n)) throw new Error(`Nombre de comando duplicado: ${n}`);
    byName.set(n, cmd);
  }
}

export function findCommand(name: string): Command | undefined {
  return byName.get(name.toLowerCase());
}


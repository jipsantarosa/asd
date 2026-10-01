import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { GameError } from '../../services/context';
import { ensureProfile } from '../../services/player';
import { getSettings, setPrefix } from '../../services/guildSettings';
import { getLogConfig } from '../../services/logConfig';
import { viewerOf } from '../app';
import { logSystem } from '../logging/sender';
import { runSetup } from '../logging/setup';
import { syncRewardRoles } from '../roleSafety';
import { farmPanel } from '../ui/farmPanel';
import { fishPanel } from '../ui/fishPanel';
import { helpPanel, inventoryPanel, profilePanel } from '../ui/infoPanels';
import { MARKET_SECTIONS, marketPanel, type MarketSection } from '../ui/marketPanel';
import { rolesAdminPanel } from '../ui/rolesPanel';
import { settingsPanel } from '../ui/settingsPanel';
import { COLORS } from '../ui/theme';
import { topPanel } from '../ui/topPanel';
import { eventsAdminPanel } from '../ui/eventPanels';
import { TOP_CATEGORIES, TOP_META, type TopCategory } from '../../services/leaderboard';
import { Routes } from 'discord.js';
import type { Command } from './types';
import { canalCmd, vozCmd } from './voice';
import { MODERATION_COMMANDS } from './moderation';
import { avatares, banners, besosCmd, kissCmd, purgar } from './community';
import { autoplayCmd, botProfileCmd, clearAvatarsCmd, clearNamesCmd, clearTagsCmd, ghostCmd, mstatsCmd, namesCmd, premiumCmd, tagsCmd } from './premium';

const granja: Command = {
  name: 'granja',
  aliases: ['farm', 'g', 'huerta'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('granja').setDescription('Abrí tu granja y cosechá.'),
  async run(c) {
    await c.reply(farmPanel(c.app.ctx, c.viewer));
  },
};

const pesca: Command = {
  name: 'pesca',
  aliases: ['pescar', 'fish', 'p'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('pesca').setDescription('Salí a pescar: lanzá y peleá con el pez.'),
  async run(c) {
    await c.reply(fishPanel(c.app.ctx, c.viewer));
  },
};

const mercado: Command = {
  name: 'mercado',
  aliases: ['tienda', 'shop'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('mercado').setDescription('Comprá equipo, suministros, permisos y mejoras; vendé tu producción.')
    .addStringOption((o) => o.setName('seccion').setDescription('Sección inicial')
      .addChoices(...MARKET_SECTIONS.map((s) => ({ name: s, value: s })))),
  async run(c) {
    const raw = c.str('seccion', 0)?.toLowerCase();
    const section = (MARKET_SECTIONS as string[]).includes(raw ?? '') ? (raw as MarketSection) : 'equipo';
    await c.reply(marketPanel(c.app.ctx, c.viewer, section));
  },
};

const inventario: Command = {
  name: 'inventario',
  aliases: ['inv', 'mochila', 'i'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('inventario').setDescription('Mirá tu mochila.'),
  async run(c) {
    await c.reply(inventoryPanel(c.app.ctx, c.viewer));
  },
};

const perfil: Command = {
  name: 'perfil',
  aliases: ['profile', 'yo', 'nivel'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('perfil').setDescription('Niveles, equipo, colección y distinciones.')
    .addUserOption((o) => o.setName('usuario').setDescription('Ver el perfil de otra persona')),
  async run(c) {
    const target = (await c.member_('usuario', 0)) ?? c.member;
    if (target.user.bot) throw new GameError('Los bots no juegan en El Valle.');
    ensureProfile(c.app.ctx, c.guild.id, target.id);
    if (target.id === c.member.id) await syncRewardRoles(c.app.ctx, c.member);
    await c.reply(profilePanel(c.app.ctx, c.viewer, viewerOf(target)));
  },
};

const ayuda: Command = {
  name: 'ayuda',
  aliases: ['help', 'h', 'comandos'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('ayuda').setDescription('Guía del juego y lista de comandos.'),
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
    await c.reply({ content: `✅ Listo: el nuevo prefijo es \`${saved}\` (por ejemplo \`${saved}granja\`).` }, { ephemeral: true });
  },
};

const ajustes: Command = {
  name: 'ajustes',
  aliases: ['config', 'settings'],
  prefix: true,
  permission: PermissionFlagsBits.ManageGuild,
  permissionName: 'Gestionar servidor',
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('ajustes').setDescription('Ajustes del bot y valores del juego para este servidor.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async run(c) {
    await c.reply(settingsPanel(c.app.ctx, c.guild.id, c.member.id), { ephemeral: true });
  },
};

const roles: Command = {
  name: 'roles',
  aliases: ['rolesadmin'],
  prefix: true,
  permission: PermissionFlagsBits.ManageRoles,
  permissionName: 'Gestionar roles',
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('roles').setDescription('Centro de roles: grupos seleccionables y distinciones por nivel.')
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
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('setup').setDescription('Configura o repara el sistema de registros del servidor.')
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
    await c.reply({ embeds: [res.value] }, { ephemeral: true });
    await logSystem(c.app.ctx, c.guild, `🛠️ <@${c.member.id}> ejecutó \`/setup\`.`, COLORS.ok);
  },
};

const top: Command = {
  name: 'top',
  aliases: ['ranking', 'leaderboard', 'lb'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('top').setDescription('Ranking del servidor: niveles, fortuna y colección.')
    .addStringOption((o) => o.setName('categoria').setDescription('Qué ranking ver')
      .addChoices(...TOP_CATEGORIES.map((id) => ({ name: TOP_META[id].label, value: id })))),
  async run(c) {
    const raw = c.str('categoria', 0)?.toLowerCase() ?? 'total';
    const cat = (TOP_CATEGORIES as string[]).includes(raw) ? (raw as TopCategory) : 'total';
    await c.reply(await topPanel(c.app.ctx, c.guild, c.viewer, cat));
  },
};

const jugar: Command = {
  name: 'jugar',
  aliases: ['play', 'juego'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('jugar').setDescription('Abre El Valle como juego (Actividad): granja, pesca y top.'),
  async run(c) {
    const howTo = '🎮 **El Valle como juego:** entrá a un canal de voz → tocá el ícono del cohete (**Actividades**) → elegí la app.\n' +
      'Si no aparece, un admin tiene que habilitar las Actividades de la aplicación (README, sección 10).';
    if (!c.interaction) {
      await c.reply({ content: `${howTo}\nTambién podés usar \`/jugar\` para abrirlo directo.` });
      return;
    }
    // Respuesta LAUNCH_ACTIVITY (tipo 12): Discord abre la Actividad para quien usó el comando.
    try {
      await c.app.client.rest.post(Routes.interactionCallback(c.interaction.id, c.interaction.token), { body: { type: 12 }, auth: false });
    } catch {
      await c.reply({ content: `No pude abrir la Actividad automáticamente.\n${howTo}` }, { ephemeral: true });
    }
  },
};

const eventos: Command = {
  name: 'eventos',
  aliases: ['events', 'sorteos'],
  prefix: true,
  permission: PermissionFlagsBits.ManageGuild,
  permissionName: 'Gestionar servidor',
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('eventos').setDescription('Sorteos y mareas doradas automáticas: canal, activación y lanzamiento manual.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async run(c) {
    await c.reply(eventsAdminPanel(c.app.ctx, c.guild, c.member.id), { ephemeral: true });
  },
};

export const COMMANDS: Command[] = [granja, pesca, mercado, inventario, perfil, top, jugar, ayuda, prefijo, ajustes, roles, eventos, setup, purgar, avatares, banners, kissCmd, besosCmd,
  premiumCmd, namesCmd, tagsCmd, clearAvatarsCmd, clearNamesCmd, clearTagsCmd, mstatsCmd, ghostCmd, botProfileCmd, autoplayCmd,
  vozCmd, canalCmd, ...MODERATION_COMMANDS];

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


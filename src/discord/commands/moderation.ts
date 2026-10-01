import { EmbedBuilder, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder, type GuildMember, type User } from 'discord.js';
import { GameError } from '../../services/context';
import { CASE_META, REASON_MAX, getCase, parseDuration, type CaseAction } from '../../services/moderation';
import {
  banUser, canModerate, kickMember, requireModerator, timeoutMember, unbanUser, untimeoutMember, warnMember, type ActionResult, type Actor,
} from '../moderation/actions';
import { automodPanel, casePanel, historyPanel } from '../ui/modPanels';
import type { Command, CommandContext } from './types';

const MENTION = /^<@!?(\d{17,20})>$|^(\d{17,20})$/;

function actor(c: CommandContext): Actor {
  return { app: c.app, guild: c.guild, moderator: c.member };
}

/** Confirmación pública y compacta: "⚠️ @x fue advertido · Caso #12". */
function resultEmbed(action: CaseAction, target: { id: string }, r: ActionResult): EmbedBuilder {
  const m = CASE_META[action];
  return new EmbedBuilder().setColor(m.color).setDescription([
    `${m.emoji} <@${target.id}> fue **${m.past}** · Caso **#${r.c.number}**`,
    `**Motivo:** ${r.c.reason}`,
    ...r.notes,
    r.dm || ['unban'].includes(action) ? '' : '-# No le pude avisar por mensaje privado.',
  ].filter(Boolean).join('\n'));
}

async function needMember(c: CommandContext, usage: string): Promise<GuildMember> {
  const m = await c.member_('usuario', 0);
  if (!m) throw new GameError(`Uso: \`${usage}\` (la persona tiene que estar en el servidor).`);
  return m;
}

async function anyUser(c: CommandContext, raw: string | null, usage: string): Promise<User> {
  const m = raw?.trim().match(MENTION);
  const id = m?.[1] ?? m?.[2];
  if (!id) throw new GameError(`Uso: \`${usage}\` (mención o ID).`);
  const user = await c.app.client.users.fetch(id).catch(() => null);
  if (!user) throw new GameError('No encontré a ese usuario.');
  return user;
}

const reasonOf = (c: CommandContext, index: number) => c.text('motivo', index);

// ───────────────────────── Acciones compartidas (slash /mod y prefijo) ─────────────────────────

const RUN: Record<string, (c: CommandContext) => Promise<void>> = {
  async warn(c) {
    requireModerator(c.app, c.member, 'warn');
    const target = await needMember(c, `${c.prefix}warn @usuario motivo`);
    await c.defer(); // MD, registro y posible escalado pueden tardar más de 3 s
    const r = await warnMember(actor(c), target, reasonOf(c, 1));
    await c.reply({ embeds: [resultEmbed('warn', target, r)] });
  },
  async timeout(c) {
    requireModerator(c.app, c.member, 'timeout');
    const target = await needMember(c, `${c.prefix}timeout @usuario 10m motivo`);
    const ms = parseDuration(c.str('duracion', 1));
    await c.defer();
    const r = await timeoutMember(actor(c), target, ms, reasonOf(c, 2));
    await c.reply({ embeds: [resultEmbed('timeout', target, r)] });
  },
  async untimeout(c) {
    requireModerator(c.app, c.member, 'timeout');
    const target = await needMember(c, `${c.prefix}untimeout @usuario motivo`);
    await c.defer();
    const r = await untimeoutMember(actor(c), target, reasonOf(c, 1));
    await c.reply({ embeds: [resultEmbed('untimeout', target, r)] });
  },
  async kick(c) {
    requireModerator(c.app, c.member, 'kick');
    const target = await needMember(c, `${c.prefix}kick @usuario motivo`);
    await c.defer();
    const r = await kickMember(actor(c), target, reasonOf(c, 1));
    await c.reply({ embeds: [resultEmbed('kick', target, r)] });
  },
  async ban(c) {
    requireModerator(c.app, c.member, 'ban');
    const user = c.interaction ? c.interaction.options.getUser('usuario', true) : await anyUser(c, c.args[0] ?? null, `${c.prefix}ban @usuario motivo`);
    const member = await c.guild.members.fetch(user.id).catch(() => null);
    const del = c.interaction ? c.interaction.options.getInteger('borrar') ?? 0 : 0;
    await c.defer();
    const r = await banUser(actor(c), user, member, reasonOf(c, 1), del);
    await c.reply({ embeds: [resultEmbed('ban', user, r)] });
  },
  async unban(c) {
    requireModerator(c.app, c.member, 'ban');
    const user = await anyUser(c, c.str('usuario', 0), `${c.prefix}unban ID motivo`);
    await c.defer();
    const r = await unbanUser(actor(c), user, reasonOf(c, 1));
    await c.reply({ embeds: [resultEmbed('unban', user, r)] });
  },
  async historial(c) {
    requireModerator(c.app, c.member, 'history');
    const user = await c.user_('usuario', 0);
    if (!user) throw new GameError(`Uso: \`${c.prefix}historial @usuario\` (mención o ID).`);
    const member = await c.guild.members.fetch(user.id).catch(() => null);
    await c.reply(historyPanel(c.app.ctx, c.guild.id, c.member.id, {
      id: user.id, name: member?.displayName ?? user.username, avatar: user.displayAvatarURL({ size: 64 }),
    }), { ephemeral: true });
  },
  async caso(c) {
    requireModerator(c.app, c.member, 'history');
    const n = c.int('numero', 0);
    if (!n || n < 1) throw new GameError(`Uso: \`${c.prefix}caso 12\``);
    const found = getCase(c.app.ctx, c.guild.id, n);
    if (!found) throw new GameError(`No existe el caso #${n}.`);
    await c.reply(casePanel(found, c.member.id, canModerate(c.app, c.member, 'editcase')), { ephemeral: true });
  },
};

// ───────────────────────── /mod (un solo comando de barra, con subcomandos) ─────────────────────────

const reasonOpt = (o: import('discord.js').SlashCommandStringOption) => o.setName('motivo').setDescription('Motivo (queda en el caso)').setMaxLength(REASON_MAX);

export const modCmd: Command = {
  name: 'mod',
  aliases: [],
  prefix: false,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('mod')
    .setDescription('Moderación: advertir, aislar, expulsar, banear, historial y casos.')
    .addSubcommand((s) => s.setName('warn').setDescription('Advierte a alguien (queda un caso; varias advertencias pueden sancionar solas).')
      .addUserOption((o) => o.setName('usuario').setDescription('A quién').setRequired(true)).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('timeout').setDescription('Aísla a alguien un tiempo: no puede escribir ni hablar.')
      .addUserOption((o) => o.setName('usuario').setDescription('A quién').setRequired(true))
      .addStringOption((o) => o.setName('duracion').setDescription('Ej: 10m, 1h, 1h30m, 2d (máx. 28d)').setRequired(true).setMaxLength(20))
      .addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('untimeout').setDescription('Quita el aislamiento.')
      .addUserOption((o) => o.setName('usuario').setDescription('A quién').setRequired(true)).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('kick').setDescription('Expulsa a alguien del servidor (puede volver con una invitación).')
      .addUserOption((o) => o.setName('usuario').setDescription('A quién').setRequired(true)).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('ban').setDescription('Banea a alguien (también si ya no está en el servidor: pegá su ID).')
      .addUserOption((o) => o.setName('usuario').setDescription('A quién (o su ID)').setRequired(true)).addStringOption(reasonOpt)
      .addIntegerOption((o) => o.setName('borrar').setDescription('Borrar sus mensajes recientes').addChoices(
        { name: 'No borrar', value: 0 }, { name: 'Última hora', value: 3600 }, { name: 'Último día', value: 86_400 }, { name: 'Últimos 7 días', value: 604_800 })))
    .addSubcommand((s) => s.setName('unban').setDescription('Levanta un baneo.')
      .addStringOption((o) => o.setName('usuario').setDescription('ID (o mención) del usuario baneado').setRequired(true).setMaxLength(30)).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('historial').setDescription('Casos de moderación de una persona.')
      .addUserOption((o) => o.setName('usuario').setDescription('De quién (o su ID)').setRequired(true)))
    .addSubcommand((s) => s.setName('caso').setDescription('Ver un caso: editar el motivo o anularlo.')
      .addIntegerOption((o) => o.setName('numero').setDescription('Número de caso').setRequired(true).setMinValue(1))),
  async run(c) {
    const sub = c.interaction?.options.getSubcommand(true) ?? '';
    const fn = RUN[sub];
    if (!fn) throw new GameError('Subcomando desconocido.');
    await fn(c);
  },
};

// ───────────────────────── Versiones por prefijo (!warn, !timeout, …) ─────────────────────────

function prefixOnly(name: string, aliases: string[], run: (c: CommandContext) => Promise<void>): Command {
  return { name, aliases, prefix: true, run };
}

export const warnCommand = prefixOnly('warn', ['advertir', 'adv'], RUN.warn);
export const timeoutCommand = prefixOnly('timeout', ['mute', 'aislar', 'to'], RUN.timeout);
export const untimeoutCommand = prefixOnly('untimeout', ['unmute', 'desaislar'], RUN.untimeout);
export const kickCommand = prefixOnly('kick', ['expulsar'], RUN.kick);
export const banCommand = prefixOnly('ban', ['banear'], RUN.ban);
export const unbanCommand = prefixOnly('unban', ['desbanear'], RUN.unban);
export const historialCommand = prefixOnly('historial', ['history', 'modlogs', 'sanciones'], RUN.historial);
export const casoCommand = prefixOnly('caso', ['case'], RUN.caso);

// ───────────────────────── /automod ─────────────────────────

export const automodCmd: Command = {
  name: 'automod',
  aliases: ['modconfig', 'antiraid'],
  prefix: true,
  permission: PermissionFlagsBits.ManageGuild,
  permissionName: 'Gestionar servidor',
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('automod')
    .setDescription('Antispam, antiflood, enlaces, antiraid, advertencias y roles de moderación.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async run(c) {
    await c.reply(automodPanel(c.app.ctx, c.guild, c.member.id), { ephemeral: true });
  },
};

export const MODERATION_COMMANDS: Command[] = [
  modCmd, warnCommand, timeoutCommand, untimeoutCommand, kickCommand, banCommand, unbanCommand, historialCommand, casoCommand, automodCmd,
];

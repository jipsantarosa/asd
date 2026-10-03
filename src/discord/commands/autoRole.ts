import { EmbedBuilder, Events, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder, type Guild, type GuildMember, type Role } from 'discord.js';
import { logger } from '../../logger';
import { autoRoleFor, getAutoRoles, setAutoRole, type AutoRoleKind } from '../../services/autoRole';
import { GameError } from '../../services/context';
import { getRaidUntil } from '../../services/moderation';
import type { App } from '../app';
import { logSystem } from '../logging/sender';
import { roleProblem } from '../roleSafety';
import { COLORS } from '../ui/theme';
import type { Command, CommandContext } from './types';

/**
 * /autorol: roles automáticos al entrar. Se separan solos: las personas reciben el rol de miembros
 * (por ejemplo "Miembro") y los bots el rol de bots (por ejemplo "Bots").
 */

const LABEL: Record<AutoRoleKind, string> = { members: 'miembros', bots: 'bots' };

async function giveAutoRole(app: App, member: GuildMember): Promise<void> {
  const isBot = member.user.bot;
  if (!isBot && member.pending) return; // con la verificación de reglas, se da al aceptarlas
  const roleId = autoRoleFor(app.ctx, member.guild.id, isBot);
  if (!roleId || member.roles.cache.has(roleId)) return;
  if (!isBot && getRaidUntil(app.ctx, member.guild.id) > Date.now()) return; // en modo raid no se dan roles
  const role = member.guild.roles.cache.get(roleId);
  const problem = roleProblem(member.guild, role);
  if (problem) {
    logger.warn(`Autorol (${isBot ? 'bots' : 'miembros'}) en ${member.guild.id}: no puedo dar el rol (${problem}).`);
    return;
  }
  await member.roles.add(role!, isBot ? 'Autorol de bots' : 'Autorol de miembros');
}

export function startAutoRole(app: App): void {
  app.client.on(Events.GuildMemberAdd, (m) => void giveAutoRole(app, m).catch((err) => logger.warn('Autorol:', err)));
  // Con "verificación de miembros" (aceptar reglas), el rol se da cuando la persona acepta.
  app.client.on(Events.GuildMemberUpdate, (old, m) => {
    if (old.pending && !m.pending) void giveAutoRole(app, m).catch((err) => logger.warn('Autorol:', err));
  });
}

/** Da los autoroles a quienes ya están en el servidor y no los tienen. */
export async function applyAutoRolesToAll(app: App, guild: Guild, limit = 2000): Promise<{ members: number; bots: number; failed: number; pending: number }> {
  const roles = getAutoRoles(app.ctx, guild.id);
  const out = { members: 0, bots: 0, failed: 0, pending: 0 };
  const list = await guild.members.fetch();
  const usable = (id: string | null): Role | null => {
    const r = id ? guild.roles.cache.get(id) : undefined;
    return r && !roleProblem(guild, r) ? r : null;
  };
  const human = usable(roles.members);
  const bot = usable(roles.bots);
  const todo = [...list.values()].filter((m) => {
    const r = m.user.bot ? bot : human;
    return r && !m.roles.cache.has(r.id) && (m.user.bot || !m.pending);
  });
  out.pending = Math.max(0, todo.length - limit);
  for (const m of todo.slice(0, limit)) {
    const r = (m.user.bot ? bot : human)!;
    await m.roles.add(r, 'Autorol (aplicado a todos)').then(() => (m.user.bot ? out.bots++ : out.members++), () => out.failed++);
  }
  return out;
}

function parse(c: CommandContext): { action: 'set' | 'off' | 'aplicar' | 'estado'; kind: AutoRoleKind | null } {
  if (c.interaction) {
    const sub = c.interaction.options.getSubcommand(false) ?? 'estado';
    if (sub === 'miembros') return { action: 'set', kind: 'members' };
    if (sub === 'bots') return { action: 'set', kind: 'bots' };
    if (sub === 'off') {
      const t = c.interaction.options.getString('tipo');
      return { action: 'off', kind: t === 'members' || t === 'bots' ? t : null };
    }
    return { action: sub === 'aplicar' ? 'aplicar' : 'estado', kind: null };
  }
  const [a, b] = c.args.map((x) => x.toLowerCase());
  const kindOf = (x: string | undefined): AutoRoleKind | null =>
    x && ['bots', 'bot'].includes(x) ? 'bots' : x && ['miembros', 'miembro', 'members', 'member', 'personas'].includes(x) ? 'members' : null;
  if (!a || ['estado', 'status', 'ver'].includes(a)) return { action: 'estado', kind: null };
  if (['off', 'desactivar', 'apagar', 'quitar'].includes(a)) return { action: 'off', kind: kindOf(b) };
  if (['aplicar', 'todos', 'apply'].includes(a)) return { action: 'aplicar', kind: null };
  return { action: 'set', kind: kindOf(a) ?? 'members' };
}

export const autoRoleCmd: Command = {
  name: 'autorol',
  aliases: ['autorole', 'rolauto'],
  prefix: true,
  permission: PermissionFlagsBits.ManageRoles,
  permissionName: 'Gestionar roles',
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('autorol')
    .setDescription('Roles automáticos al entrar: uno para las personas y otro para los bots.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((s) => s.setName('miembros').setDescription('Rol que reciben las personas que entran (por ejemplo "Miembro").')
      .addRoleOption((o) => o.setName('rol').setDescription('Rol para las personas').setRequired(true)))
    .addSubcommand((s) => s.setName('bots').setDescription('Rol que reciben los bots que se agregan (por ejemplo "Bots").')
      .addRoleOption((o) => o.setName('rol').setDescription('Rol para los bots').setRequired(true)))
    .addSubcommand((s) => s.setName('aplicar').setDescription('Dar los autoroles a todos los que ya están en el servidor.'))
    .addSubcommand((s) => s.setName('off').setDescription('Desactivar un autorol (o los dos).')
      .addStringOption((o) => o.setName('tipo').setDescription('Cuál desactivar (por defecto, los dos)')
        .addChoices({ name: 'Miembros', value: 'members' }, { name: 'Bots', value: 'bots' })))
    .addSubcommand((s) => s.setName('estado').setDescription('Ver los autoroles actuales.')),
  async run(c) {
    const { ctx } = c.app;
    const g = c.guild;
    const { action, kind } = parse(c);
    switch (action) {
      case 'set': {
        const k = kind ?? 'members';
        const role = c.role('rol', 0) ?? c.role('rol', 1);
        if (!role) throw new GameError(`Mencioná el rol. Ejemplos: \`${c.prefix}autorol @Miembro\` · \`${c.prefix}autorol bots @Bots\`.`);
        const problem = roleProblem(g, role);
        if (problem) throw new GameError(`No puedo usar ${role} como autorol: ${problem}.`);
        const other = getAutoRoles(ctx, g.id)[k === 'members' ? 'bots' : 'members'];
        if (other === role.id) throw new GameError(`Ese rol ya es el autorol de ${LABEL[k === 'members' ? 'bots' : 'members']}. Usá uno distinto para cada uno.`);
        setAutoRole(ctx, g.id, k, role.id);
        await logSystem(ctx, g, `🎭 <@${c.member.id}> configuró el autorol de ${LABEL[k]}: <@&${role.id}>.`);
        await c.reply({
          content: `✅ Listo: ${k === 'members' ? 'cada **persona** que entre' : 'cada **bot** que se agregue'} va a recibir <@&${role.id}>. Para dárselo a los que ya están: \`${c.prefix}autorol aplicar\`.`,
        }, { ephemeral: true });
        return;
      }
      case 'off': {
        const kinds: AutoRoleKind[] = kind ? [kind] : ['members', 'bots'];
        for (const k of kinds) setAutoRole(ctx, g.id, k, null);
        await logSystem(ctx, g, `🎭 <@${c.member.id}> desactivó el autorol de ${kinds.map((k) => LABEL[k]).join(' y ')}.`);
        await c.reply({ content: `⏸️ Autorol de ${kinds.map((k) => LABEL[k]).join(' y ')} desactivado. Nadie pierde el rol que ya tiene.` }, { ephemeral: true });
        return;
      }
      case 'aplicar': {
        const a = getAutoRoles(ctx, g.id);
        if (!a.members && !a.bots) throw new GameError(`Primero elegí los roles: \`${c.prefix}autorol @Miembro\` y \`${c.prefix}autorol bots @Bots\`.`);
        await c.defer(true);
        const r = await applyAutoRolesToAll(c.app, g);
        await c.reply({
          content: `✅ Les di el autorol a **${r.members}** personas y **${r.bots}** bots${r.failed ? ` (no pude con ${r.failed})` : ''}. Los demás ya lo tenían.${r.pending ? ` Quedan ${r.pending}: volvé a correr el comando.` : ''}`,
        }, { ephemeral: true });
        return;
      }
      default: {
        const a = getAutoRoles(ctx, g.id);
        const line = (id: string | null, k: AutoRoleKind) => (id
          ? `<@&${id}>${g.roles.cache.has(id) ? '' : ' ⚠️ (el rol ya no existe)'}`
          : `desactivado — \`${c.prefix}autorol ${k === 'bots' ? 'bots ' : ''}@rol\``);
        await c.reply({
          embeds: [new EmbedBuilder().setColor(COLORS.roles).setTitle('🎭 Autoroles')
            .setDescription(`**Personas:** ${line(a.members, 'members')}\n**Bots:** ${line(a.bots, 'bots')}\n\nSe separan solos: cada persona recibe el de personas y cada bot el de bots.`)],
        }, { ephemeral: true });
      }
    }
  },
};

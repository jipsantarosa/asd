import { EmbedBuilder, Events, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder, type Guild, type GuildMember } from 'discord.js';
import { logger } from '../../logger';
import { GameError } from '../../services/context';
import { TIERS, tierOf, type PremiumTier } from '../../services/premium';
import {
  clearPremiumRoles, getPremiumRoles, guildsWithPremiumRoles, PREMIUM_ROLE_DEFAULTS, premiumRoleChanges, setPremiumRole,
} from '../../services/premiumRoles';
import type { App } from '../app';
import { logSystem } from '../logging/sender';
import { roleProblem } from '../roleSafety';
import { COLORS } from '../ui/theme';
import type { Command, CommandContext } from './types';

/**
 * Roles premium: un rol por nivel (Booster, Tier 2, Tier 3, Tier 4). Quien tiene premium recibe el rol de su nivel
 * en cada servidor que los tenga configurados; si cambia de nivel, se le cambia, y si lo pierde o vence, se le quita.
 */

const TIER_LIST: PremiumTier[] = [1, 2, 3, 4];

/** Deja los roles premium de un miembro acordes a su nivel. Devuelve si cambió algo. */
export async function syncMemberPremium(app: App, member: GuildMember): Promise<boolean> {
  if (member.user.bot) return false;
  const roles = getPremiumRoles(app.ctx, member.guild.id);
  if (!Object.keys(roles).length) return false;
  const { add, remove } = premiumRoleChanges(roles, tierOf(app.ctx, member.id), (id) => member.roles.cache.has(id));
  const ok = (id: string) => !roleProblem(member.guild, member.guild.roles.cache.get(id));
  const toAdd = add.filter(ok);
  const toRemove = remove.filter(ok);
  if (!toAdd.length && !toRemove.length) return false;
  if (toRemove.length) await member.roles.remove(toRemove, 'Roles premium');
  if (toAdd.length) await member.roles.add(toAdd, 'Roles premium');
  return true;
}

/** Tras dar o quitar premium: actualiza a esa persona en todos los servidores con roles premium. */
export async function syncUserPremiumEverywhere(app: App, userId: string): Promise<void> {
  for (const guildId of guildsWithPremiumRoles(app.ctx)) {
    const guild = app.client.guilds.cache.get(guildId);
    const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
    if (member) await syncMemberPremium(app, member).catch((err) => logger.warn('Roles premium:', err));
  }
}

export async function syncGuildPremium(app: App, guild: Guild): Promise<number> {
  if (!Object.keys(getPremiumRoles(app.ctx, guild.id)).length) return 0;
  const members = await guild.members.fetch();
  let changed = 0;
  for (const m of members.values()) {
    if (await syncMemberPremium(app, m).catch(() => false)) changed++;
  }
  return changed;
}

export function startPremiumRoles(app: App, everyMs = 10 * 60_000): NodeJS.Timeout {
  app.client.on(Events.GuildMemberAdd, (m) => void syncMemberPremium(app, m).catch((err) => logger.warn('Roles premium:', err)));
  // Revisión periódica: quita el rol a quien se le venció el premium.
  const sweep = async () => {
    for (const guildId of guildsWithPremiumRoles(app.ctx)) {
      const guild = app.client.guilds.cache.get(guildId);
      if (guild) await syncGuildPremium(app, guild).catch((err) => logger.warn('Roles premium:', err));
    }
  };
  setTimeout(() => void sweep(), 60_000);
  return setInterval(() => void sweep(), everyMs);
}

/** Crea los roles que falten (uno por nivel) y los deja configurados. */
export async function createPremiumRoles(app: App, guild: Guild, reason: string): Promise<{ created: string[]; reused: string[] }> {
  const current = getPremiumRoles(app.ctx, guild.id);
  const out = { created: [] as string[], reused: [] as string[] };
  // Del nivel más bajo al más alto: cada rol nuevo queda arriba del anterior.
  for (const tier of TIER_LIST) {
    const existing = current[tier] ? guild.roles.cache.get(current[tier]!) : guild.roles.cache.find((r) => r.name === PREMIUM_ROLE_DEFAULTS[tier].name && !r.managed);
    if (existing) {
      setPremiumRole(app.ctx, guild.id, tier, existing.id);
      out.reused.push(existing.id);
      continue;
    }
    const role = await guild.roles.create({ name: PREMIUM_ROLE_DEFAULTS[tier].name, colors: { primaryColor: PREMIUM_ROLE_DEFAULTS[tier].color }, hoist: true, permissions: [], reason });
    setPremiumRole(app.ctx, guild.id, tier, role.id);
    out.created.push(role.id);
  }
  return out;
}

function sub(c: CommandContext): string {
  if (c.interaction) return c.interaction.options.getSubcommand(false) ?? 'estado';
  const a = c.args[0]?.toLowerCase();
  if (!a || ['estado', 'status', 'ver'].includes(a)) return 'estado';
  if (['crear', 'create'].includes(a)) return 'crear';
  if (['off', 'desactivar', 'quitar'].includes(a)) return 'off';
  if (['sync', 'sincronizar', 'actualizar'].includes(a)) return 'sync';
  return 'set';
}

export const premiumRolesCmd: Command = {
  name: 'rolespremium',
  aliases: ['premiumroles', 'rolpremium'],
  prefix: true,
  permission: PermissionFlagsBits.ManageRoles,
  permissionName: 'Gestionar roles',
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('rolespremium')
    .setDescription('Un rol por nivel premium: el bot se lo da a quien tiene premium y se lo quita si lo pierde.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((s) => s.setName('crear').setDescription('Crea los 4 roles (Premium Booster, Tier 2, Tier 3, Tier 4) y los configura.'))
    .addSubcommand((s) => s.setName('set').setDescription('Usar un rol que ya existe para un nivel.')
      .addIntegerOption((o) => o.setName('nivel').setDescription('Nivel premium').setRequired(true)
        .addChoices(...TIER_LIST.map((t) => ({ name: `${t} - ${TIERS[t].name}`, value: t }))))
      .addRoleOption((o) => o.setName('rol').setDescription('Rol para ese nivel').setRequired(true)))
    .addSubcommand((s) => s.setName('sync').setDescription('Revisar ahora a todos los miembros (dar y quitar roles).'))
    .addSubcommand((s) => s.setName('off').setDescription('Dejar de manejar roles premium en este servidor (no borra los roles).'))
    .addSubcommand((s) => s.setName('estado').setDescription('Ver los roles premium configurados.')),
  async run(c) {
    const { ctx } = c.app;
    const g = c.guild;
    switch (sub(c)) {
      case 'crear': {
        await c.defer(true);
        const res = await createPremiumRoles(c.app, g, `Roles premium (por ${c.member.user.tag})`);
        const changed = await syncGuildPremium(c.app, g);
        await logSystem(ctx, g, `💎 <@${c.member.id}> configuró los roles premium.`);
        await c.reply({
          content: `✅ Roles premium listos: ${TIER_LIST.map((t) => `<@&${getPremiumRoles(ctx, g.id)[t]}>`).join(' · ')}.\nCreé ${res.created.length} y reutilicé ${res.reused.length}. Actualicé a ${changed} miembros. Desde ahora se dan y se quitan solos.`,
        }, { ephemeral: true });
        return;
      }
      case 'set': {
        const tier = c.int('nivel', 1);
        const role = c.role('rol', 2);
        if (!tier || !role) throw new GameError(`Uso: \`${c.prefix}rolespremium set <nivel 1-4> @rol\`.`);
        const problem = roleProblem(g, role);
        if (problem) throw new GameError(`No puedo usar ${role}: ${problem}.`);
        setPremiumRole(ctx, g.id, tier, role.id);
        await c.defer(true);
        const changed = await syncGuildPremium(c.app, g);
        await c.reply({ content: `✅ El nivel ${tier} (${TIERS[tier as PremiumTier].name}) usa <@&${role.id}>. Actualicé a ${changed} miembros.` }, { ephemeral: true });
        return;
      }
      case 'sync': {
        await c.defer(true);
        const changed = await syncGuildPremium(c.app, g);
        await c.reply({ content: `🔄 Listo: actualicé los roles premium de ${changed} miembros.` }, { ephemeral: true });
        return;
      }
      case 'off': {
        clearPremiumRoles(ctx, g.id);
        await c.reply({ content: '⏸️ Ya no manejo roles premium en este servidor. Los roles siguen existiendo; borralos a mano si no los querés.' }, { ephemeral: true });
        return;
      }
      default: {
        const roles = getPremiumRoles(ctx, g.id);
        const lines = TIER_LIST.map((t) => `${TIERS[t].emoji} **${TIERS[t].name}:** ${roles[t] ? `<@&${roles[t]}>` : 'sin rol'}`);
        await c.reply({
          embeds: [new EmbedBuilder().setColor(COLORS.roles).setTitle('💎 Roles premium').setDescription(
            `${lines.join('\n')}\n\nCada persona con premium recibe solo el rol de su nivel; si lo pierde o vence, se lo quito.${Object.keys(roles).length ? '' : `\nCrealos con \`${c.prefix}rolespremium crear\`.`}`,
          )],
        }, { ephemeral: true });
      }
    }
  },
};

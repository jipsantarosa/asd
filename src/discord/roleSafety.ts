import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from 'discord.js';
import type { GameContext } from '../services/context';
import { getCasinoUser, levelFromWagered } from '../casino/users';
import { eligibleRewards, listRewards } from '../services/roles';
import { logger } from '../logger';

/** Permisos que nunca deben poder autoasignarse ni darse como recompensa. */
const DANGEROUS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
];

/** Devuelve el motivo por el que el bot no debe gestionar este rol, o null si es seguro. */
export function roleProblem(guild: Guild, role: Role | undefined | null): string | null {
  if (!role) return 'el rol ya no existe';
  if (role.id === guild.id) return 'es @everyone';
  if (role.managed) return 'lo gestiona una integración o bot';
  if (DANGEROUS.some((perm) => role.permissions.has(perm, false))) return 'tiene permisos de moderación/administración';
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return 'el bot no tiene "Gestionar roles"';
  if (role.position >= me.roles.highest.position) return 'está por encima (o al mismo nivel) del rol del bot';
  return null;
}

/** Nivel del casino de una persona (1 si todavía no jugó). */
export function casinoLevel(ctx: GameContext, userId: string): number {
  const u = getCasinoUser(ctx, userId);
  return u ? levelFromWagered(u.totalWagered) : 1;
}

/**
 * Otorga las distinciones (roles por nivel del casino) que el miembro ya ganó. Solo agrega, nunca quita
 * (si un admin baja un requisito, nadie pierde un rol por sorpresa).
 */
export async function syncRewardRoles(ctx: GameContext, member: GuildMember): Promise<string[]> {
  const rewards = listRewards(ctx, member.guild.id);
  if (!rewards.length) return [];
  const eligible = eligibleRewards(rewards, casinoLevel(ctx, member.id));
  const toAdd = eligible
    .map((r) => member.guild.roles.cache.get(r.role_id))
    .filter((role): role is Role => !!role && !member.roles.cache.has(role.id) && roleProblem(member.guild, role) === null);
  if (!toAdd.length) return [];
  try {
    await member.roles.add(toAdd, 'Distinción por nivel del casino');
    return toAdd.map((r) => r.id);
  } catch (err) {
    logger.warn(`No pude asignar distinciones en ${member.guild.id}:`, err);
    return [];
  }
}

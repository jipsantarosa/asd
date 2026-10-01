import { PermissionFlagsBits, type Guild, type GuildMember, type User } from 'discord.js';
import { logger } from '../../logger';
import { GameError } from '../../services/context';
import {
  ACTION_LEVEL, activeWarnCount, cleanReason, createCase, escalationFor, formatDuration, getAutomod, levelFromRoles, setCaseLog,
  type CaseAction, type ModAction, type ModCase,
} from '../../services/moderation';
import type { App } from '../app';
import { logChannel } from '../logging/sender';
import { caseEmbed, sanctionDm } from '../ui/modPanels';

const F = PermissionFlagsBits;

/** Permiso de Discord que alcanza por sí solo para cada acción (sin roles configurados). */
const DISCORD_PERM: Record<ModAction, { flag: bigint; name: string }> = {
  warn: { flag: F.ModerateMembers, name: 'Moderar miembros' },
  timeout: { flag: F.ModerateMembers, name: 'Moderar miembros' },
  history: { flag: F.ModerateMembers, name: 'Moderar miembros' },
  kick: { flag: F.KickMembers, name: 'Expulsar miembros' },
  ban: { flag: F.BanMembers, name: 'Banear miembros' },
  editcase: { flag: F.ManageGuild, name: 'Gestionar servidor' },
};

/**
 * ¿Puede esta persona hacer esta acción con el bot?
 * Dueño o Administrador: todo. Si no, alcanza el permiso de Discord equivalente o un rol de moderación
 * configurado en /automod (mod: advertir, aislar, historial · admin: además expulsar, banear, editar casos).
 */
export function canModerate(app: App, member: GuildMember, action: ModAction): boolean {
  if (member.id === member.guild.ownerId || member.permissions.has(F.Administrator)) return true;
  if (member.permissions.has(DISCORD_PERM[action].flag)) return true;
  const level = levelFromRoles(app.ctx, member.guild.id, member.roles.cache.keys());
  return level === 'admin' || (level === 'mod' && ACTION_LEVEL[action] === 'mod');
}

export function requireModerator(app: App, member: GuildMember, action: ModAction): void {
  if (!canModerate(app, member, action)) {
    throw new GameError(`No tenés permiso para esto. Necesitás **${DISCORD_PERM[action].name}** o un rol de moderación configurado en \`/automod\` → Roles.`);
  }
}

/**
 * Reglas de jerarquía (las mismas de Discord, más algunas propias):
 * nunca a uno mismo, al dueño ni al bot; el moderador tiene que estar por encima del objetivo (salvo el dueño)
 * y el bot también.
 */
export function hierarchyProblem(guild: Guild, moderator: GuildMember | null, target: GuildMember): string | null {
  const me = guild.members.me;
  if (target.id === guild.ownerId) return 'es el dueño del servidor';
  if (me && target.id === me.id) return 'soy yo 🤖';
  if (moderator && target.id === moderator.id) return 'sos vos';
  if (moderator && moderator.id !== guild.ownerId && target.roles.highest.comparePositionTo(moderator.roles.highest) >= 0) return 'tiene un rol igual o más alto que el tuyo';
  if (me && target.roles.highest.comparePositionTo(me.roles.highest) >= 0) return 'tiene un rol igual o más alto que el mío';
  return null;
}

/** Quién ejecuta: una persona (comandos) o el bot (automod y escalado). */
export interface Actor {
  app: App;
  guild: Guild;
  moderator: GuildMember | null;
  /** Sin MD ni log individual (p. ej. expulsiones masivas del modo raid, que van en un resumen). */
  silent?: boolean;
}

export interface ActionResult {
  c: ModCase;
  dm: boolean;
  notes: string[];
}

function moderatorId(a: Actor): string {
  return a.moderator?.id ?? a.guild.members.me?.id ?? '0';
}

function auditReason(a: Actor, reason: string): string {
  return `${a.moderator ? `${a.moderator.user.username}: ` : 'Automod: '}${reason}`.slice(0, 500);
}

/** Una sanción a la vez por persona: dos moderadores (o un doble clic) no la sancionan dos veces. */
async function locked<T>(a: Actor, targetId: string, fn: () => Promise<T>): Promise<T> {
  const r = await a.app.guildLock.run(`mod:${a.guild.id}:${targetId}`, fn);
  if (!r.ran) throw new GameError('Ya se está aplicando otra sanción a esa persona. Esperá un segundo.');
  return r.value;
}

async function dm(a: Actor, user: User, c: ModCase, activeWarns?: number): Promise<boolean> {
  if (a.silent || !getAutomod(a.app.ctx, a.guild.id).dmOnAction || user.bot) return false;
  return user.send({ embeds: [sanctionDm(c, a.guild.name, activeWarns)] }).then(() => true).catch(() => false);
}

/** Publica el caso en el registro de moderación y guarda dónde quedó (para editarlo si cambia el motivo). */
export async function logCase(app: App, guild: Guild, c: ModCase): Promise<void> {
  const ch = logChannel(app.ctx, guild, 'moderacion');
  if (!ch) return;
  const msg = await ch.send({ embeds: [caseEmbed(c)], allowedMentions: { parse: [] } }).catch(() => null);
  if (msg) setCaseLog(app.ctx, c.id, ch.id, msg.id);
}

/** Actualiza la ficha publicada en el registro (motivo editado o caso anulado). */
export async function refreshCaseLog(app: App, guild: Guild, c: ModCase): Promise<void> {
  if (!c.logChannelId || !c.logMessageId) return;
  const ch = guild.channels.cache.get(c.logChannelId);
  if (ch?.isTextBased()) await ch.messages.edit(c.logMessageId, { embeds: [caseEmbed(c)] }).catch(() => undefined);
}

async function record(a: Actor, action: CaseAction, user: User, reason: string, durationMs: number | null, dmBefore?: boolean): Promise<ActionResult> {
  const c = createCase(a.app.ctx, { guildId: a.guild.id, action, targetId: user.id, moderatorId: moderatorId(a), reason, durationMs, auto: !a.moderator });
  const sent = dmBefore ?? (await dm(a, user, c));
  if (!a.silent) await logCase(a.app, a.guild, c);
  return { c, dm: sent, notes: [] };
}

function apiError(err: unknown, what: string): GameError {
  const code = (err as { code?: number }).code;
  if (code === 50013) return new GameError(`Discord no me deja ${what}: me falta un permiso o su rol está por encima del mío.`);
  if (code === 10007) return new GameError('Esa persona ya no está en el servidor.');
  if (code === 10026) return new GameError('Ese usuario no está baneado.');
  logger.warn(`Moderación (${what}):`, err);
  return new GameError(`No pude ${what}. Probá de nuevo en un rato.`);
}

function checkTarget(a: Actor, target: GuildMember): void {
  const problem = hierarchyProblem(a.guild, a.moderator, target);
  if (problem) throw new GameError(`No podés sancionar a <@${target.id}>: ${problem}.`);
}

// ───────────────────────── Acciones ─────────────────────────

export async function warnMember(a: Actor, target: GuildMember, rawReason: string | null): Promise<ActionResult> {
  if (target.user.bot) throw new GameError('No se puede advertir a un bot.');
  checkTarget(a, target);
  const reason = cleanReason(rawReason);
  const res = await locked(a, target.id, async () => {
    const c = createCase(a.app.ctx, { guildId: a.guild.id, action: 'warn', targetId: target.id, moderatorId: moderatorId(a), reason, auto: !a.moderator });
    const n = activeWarnCount(a.app.ctx, a.guild.id, target.id);
    const sent = await dm(a, target.user, c, n);
    if (!a.silent) await logCase(a.app, a.guild, c);
    return { c, dm: sent, notes: [`⚠️ Lleva **${n}** ${n === 1 ? 'advertencia activa' : 'advertencias activas'}.`], n };
  });
  // Escalado automático (lo ejecuta el bot, fuera del candado de la advertencia).
  const esc = escalationFor(getAutomod(a.app.ctx, a.guild.id), res.n);
  if (esc) {
    const bot: Actor = { app: a.app, guild: a.guild, moderator: null };
    const why = `Escalado automático: ${res.n} advertencias activas`;
    try {
      if (esc.action === 'timeout') {
        const r = await timeoutMember(bot, target, esc.ms, why);
        res.notes.push(`⏱️ Escalado: aislado ${formatDuration(esc.ms)} (caso #${r.c.number}).`);
      } else if (esc.action === 'kick') {
        const r = await kickMember(bot, target, why);
        res.notes.push(`👢 Escalado: expulsado (caso #${r.c.number}).`);
      } else {
        const r = await banUser(bot, target.user, target, why, 0);
        res.notes.push(`🔨 Escalado: baneado (caso #${r.c.number}).`);
      }
    } catch (err) {
      res.notes.push(`-# No se pudo aplicar el escalado automático: ${(err as Error).message}`);
    }
  }
  return { c: res.c, dm: res.dm, notes: res.notes };
}

export async function timeoutMember(a: Actor, target: GuildMember, ms: number, rawReason: string | null): Promise<ActionResult> {
  checkTarget(a, target);
  if (target.permissions.has(F.Administrator)) throw new GameError('Discord no permite aislar a un administrador.');
  if (!target.moderatable) throw new GameError('No puedo aislar a esa persona: necesito **Moderar miembros** y un rol más alto que el suyo.');
  const reason = cleanReason(rawReason);
  return locked(a, target.id, async () => {
    await target.timeout(ms, auditReason(a, reason)).catch((err) => { throw apiError(err, 'aislarlo'); });
    return record(a, 'timeout', target.user, reason, ms);
  });
}

export async function untimeoutMember(a: Actor, target: GuildMember, rawReason: string | null): Promise<ActionResult> {
  if (!target.isCommunicationDisabled()) throw new GameError('Esa persona no está aislada.');
  checkTarget(a, target);
  const reason = cleanReason(rawReason);
  return locked(a, target.id, async () => {
    await target.timeout(null, auditReason(a, reason)).catch((err) => { throw apiError(err, 'quitarle el aislamiento'); });
    return record(a, 'untimeout', target.user, reason, null);
  });
}

export async function kickMember(a: Actor, target: GuildMember, rawReason: string | null): Promise<ActionResult> {
  checkTarget(a, target);
  if (!target.kickable) throw new GameError('No puedo expulsar a esa persona: necesito **Expulsar miembros** y un rol más alto que el suyo.');
  const reason = cleanReason(rawReason);
  return locked(a, target.id, async () => {
    // El MD va antes: después de expulsarla ya no compartimos servidor y Discord no lo entrega.
    const sent = await warnBeforeRemoval(a, target.user, 'kick', reason);
    await target.kick(auditReason(a, reason)).catch((err) => { throw apiError(err, 'expulsarlo'); });
    return record(a, 'kick', target.user, reason, null, sent);
  });
}

export async function banUser(a: Actor, user: User, member: GuildMember | null, rawReason: string | null, deleteSeconds: number): Promise<ActionResult> {
  if (member) {
    checkTarget(a, member);
    if (!member.bannable) throw new GameError('No puedo banear a esa persona: necesito **Banear miembros** y un rol más alto que el suyo.');
  } else {
    if (user.id === a.guild.ownerId) throw new GameError('No se puede banear al dueño del servidor.');
    if (user.id === a.guild.members.me?.id) throw new GameError('No me puedo banear a mí mismo. 🤖');
  }
  const already = await a.guild.bans.fetch({ user: user.id, force: true }).catch(() => null);
  if (already) throw new GameError(`<@${user.id}> ya está baneado.`);
  const reason = cleanReason(rawReason);
  return locked(a, user.id, async () => {
    // Solo se le puede avisar si todavía comparte el servidor (antes del baneo).
    const sent = member ? await warnBeforeRemoval(a, user, 'ban', reason) : false;
    await a.guild.members.ban(user.id, { reason: auditReason(a, reason), deleteMessageSeconds: Math.max(0, Math.min(604_800, deleteSeconds)) })
      .catch((err) => { throw apiError(err, 'banearlo'); });
    return record(a, 'ban', user, reason, null, sent);
  });
}

export async function unbanUser(a: Actor, user: User, rawReason: string | null): Promise<ActionResult> {
  const ban = await a.guild.bans.fetch({ user: user.id, force: true }).catch(() => null);
  if (!ban) throw new GameError('Ese usuario no está baneado.');
  const reason = cleanReason(rawReason);
  return locked(a, user.id, async () => {
    await a.guild.members.unban(user.id, auditReason(a, reason)).catch((err) => { throw apiError(err, 'desbanearlo'); });
    return record(a, 'unban', user, reason, null, false);
  });
}

/**
 * Aviso por MD antes de expulsar o banear (después ya no se puede). Se llama recién cuando todo está validado
 * (jerarquía, permisos, que no esté ya baneado), así que la acción casi nunca falla después del aviso.
 */
export async function warnBeforeRemoval(a: Actor, user: User, action: 'kick' | 'ban', rawReason: string | null): Promise<boolean> {
  if (a.silent || !getAutomod(a.app.ctx, a.guild.id).dmOnAction || user.bot) return false;
  const preview: ModCase = {
    id: 0, guildId: a.guild.id, number: 0, action, targetId: user.id, moderatorId: moderatorId(a), reason: cleanReason(rawReason), durationMs: null,
    auto: !a.moderator, active: true, createdAt: Date.now(), expiresAt: null, revokedBy: null, revokedAt: null, logChannelId: null, logMessageId: null,
  };
  const e = sanctionDm(preview, a.guild.name).setFooter({ text: 'Si creés que es un error, hablá con el staff del servidor.' });
  return user.send({ embeds: [e] }).then(() => true).catch(() => false);
}

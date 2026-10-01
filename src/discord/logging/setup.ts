import {
  ChannelType, EmbedBuilder, OverwriteType, PermissionFlagsBits, PermissionsBitField, type CategoryChannel, type Guild,
  type OverwriteResolvable, type Role, type TextChannel,
} from 'discord.js';
import { logger } from '../../logger';
import type { GameContext } from '../../services/context';
import { ensureSettings } from '../../services/guildSettings';
import {
  CATEGORY_NAME, LOG_CHANNELS, getLogConfig, planSetup, saveLogConfig, type ExistingChannel, type LogConfig, type LogKey,
} from '../../services/logConfig';
import { COLORS } from '../ui/theme';

/** Permisos que el bot necesita en el servidor para configurar y escribir los registros. */
export const SETUP_REQUIRED: { flag: bigint; name: string }[] = [
  { flag: PermissionFlagsBits.ViewChannel, name: 'Ver canales' },
  { flag: PermissionFlagsBits.ManageChannels, name: 'Gestionar canales' },
  { flag: PermissionFlagsBits.ManageRoles, name: 'Gestionar roles (para los permisos de los canales)' },
  { flag: PermissionFlagsBits.ViewAuditLog, name: 'Ver el registro de auditoría' },
  { flag: PermissionFlagsBits.SendMessages, name: 'Enviar mensajes' },
  { flag: PermissionFlagsBits.EmbedLinks, name: 'Insertar enlaces' },
  { flag: PermissionFlagsBits.AttachFiles, name: 'Adjuntar archivos' },
  { flag: PermissionFlagsBits.ReadMessageHistory, name: 'Leer el historial de mensajes' },
];

const BOT_ALLOW = [
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory,
];
const READER_ALLOW = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

export function missingSetupPermissions(guild: Guild): string[] {
  const me = guild.members.me;
  if (!me) return SETUP_REQUIRED.map((p) => p.name);
  return SETUP_REQUIRED.filter((p) => !me.permissions.has(p.flag)).map((p) => p.name);
}

/**
 * Permisos de la categoría y de cada canal (idénticos, así quedan sincronizados):
 * - @everyone no ve nada.
 * - El bot ve y escribe (explícito: si no, el "deny" de @everyone lo dejaría ciego).
 * - Roles con Administrador o Gestionar servidor, y el rol de staff opcional, pueden leer pero no escribir.
 */
export function buildOverwrites(guild: Guild, staffRoleId: string | null): OverwriteResolvable[] {
  const me = guild.members.me!;
  const overwrites: OverwriteResolvable[] = [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: me.id, type: OverwriteType.Member, allow: BOT_ALLOW },
  ];
  const readers = new Map<string, Role>();
  for (const role of guild.roles.cache.values()) {
    if (role.id === guild.id || role.managed) continue;
    if (role.permissions.has(PermissionFlagsBits.Administrator) || role.permissions.has(PermissionFlagsBits.ManageGuild)) readers.set(role.id, role);
  }
  if (staffRoleId) {
    const staff = guild.roles.cache.get(staffRoleId);
    if (staff && staff.id !== guild.id) readers.set(staff.id, staff);
  }
  for (const role of [...readers.values()].sort((a, b) => b.position - a.position).slice(0, 40)) {
    overwrites.push({ id: role.id, type: OverwriteType.Role, allow: READER_ALLOW, deny: [PermissionFlagsBits.SendMessages] });
  }
  return overwrites;
}

function snapshot(guild: Guild): ExistingChannel[] {
  return [...guild.channels.cache.values()].map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type === ChannelType.GuildCategory ? 'category' : c.type === ChannelType.GuildText ? 'text' : 'other',
    parentId: 'parentId' in c ? c.parentId ?? null : null,
  }));
}

export interface SetupOptions {
  staffRoleId: string | null;
  logSentMessages: boolean;
  executorTag: string;
}

/**
 * Configura o repara el sistema de registros. Es idempotente: ejecutarlo varias veces no
 * duplica canales. Los IDs se guardan en la base de datos; los nombres solo se usan para
 * adoptar canales huérfanos dentro de la categoría (p. ej. si se perdió la BD).
 */
export async function runSetup(ctx: GameContext, guild: Guild, opts: SetupOptions): Promise<EmbedBuilder> {
  ensureSettings(ctx, guild.id);
  const missing = missingSetupPermissions(guild);
  if (missing.length) {
    return new EmbedBuilder().setColor(COLORS.error).setTitle('❌ Me faltan permisos')
      .setDescription(`Para configurar los registros necesito:\n${missing.map((m) => `• ${m}`).join('\n')}\n\nDámelos (o un rol que los tenga) y volvé a ejecutar \`/setup\`.`);
  }

  await guild.channels.fetch();
  await guild.roles.fetch();
  const stored = getLogConfig(ctx, guild.id);
  const staffRoleId = opts.staffRoleId ?? stored.staffRoleId;
  const plan = planSetup(stored, snapshot(guild));
  const overwrites = buildOverwrites(guild, staffRoleId);
  const reason = `Configuración de registros (/setup por ${opts.executorTag})`;
  const report: string[] = [];
  const errors: string[] = [];

  let category: CategoryChannel;
  if (plan.category.kind === 'create') {
    category = await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory, permissionOverwrites: overwrites, reason });
    report.push(`🆕 Categoría **${CATEGORY_NAME}** creada`);
  } else {
    category = guild.channels.cache.get(plan.category.id) as CategoryChannel;
    await category.permissionOverwrites.set(overwrites, reason);
    report.push(`🔧 Categoría <#${category.id}> ${plan.category.kind === 'adopt' ? 'recuperada' : 'verificada'} y permisos corregidos`);
  }

  const result: LogConfig = { categoryId: category.id, staffRoleId, logSentMessages: opts.logSentMessages, channels: {} };
  for (const step of plan.steps) {
    const def = LOG_CHANNELS.find((c) => c.key === step.key)!;
    try {
      let ch: TextChannel;
      if (step.kind === 'create') {
        ch = await guild.channels.create({ name: def.name, type: ChannelType.GuildText, parent: category.id, topic: def.topic, permissionOverwrites: overwrites, reason });
        report.push(`🆕 <#${ch.id}> creado`);
      } else {
        ch = guild.channels.cache.get(step.channelId) as TextChannel;
        if (step.kind === 'reparent') await ch.setParent(category.id, { lockPermissions: false, reason });
        await ch.permissionOverwrites.set(overwrites, reason);
        if (!ch.topic) await ch.setTopic(def.topic, reason);
        report.push(step.kind === 'keep' ? `✅ <#${ch.id}> correcto` : `🔧 <#${ch.id}> ${step.kind === 'adopt' ? 'recuperado' : 'devuelto a la categoría'}`);
      }
      result.channels[step.key as LogKey] = ch.id;
    } catch (err) {
      logger.warn(`/setup: fallo en ${step.key} (${guild.id}):`, err);
      errors.push(`❌ ${def.name}: ${(err as Error).message}`);
    }
  }
  saveLogConfig(ctx, guild.id, result);

  // Verificación final: el bot debe poder escribir en cada canal guardado.
  const me = guild.members.me!;
  for (const [key, id] of Object.entries(result.channels)) {
    const ch = guild.channels.cache.get(id!);
    if (!ch || !ch.permissionsFor(me).has(new PermissionsBitField(BOT_ALLOW))) errors.push(`⚠️ No puedo escribir en el canal de ${key}.`);
  }

  const embed = new EmbedBuilder()
    .setColor(errors.length ? COLORS.warn : COLORS.ok)
    .setTitle(errors.length ? '⚠️ Registros configurados con advertencias' : '✅ Registros listos')
    .setDescription(truncateLines([...report, ...errors], 3900))
    .addFields(
      { name: 'Quién puede verlos', value: `Roles con Administrador o Gestionar servidor${staffRoleId ? ` y <@&${staffRoleId}>` : ''}. Nadie más.`, inline: false },
      { name: 'Mensajes enviados', value: opts.logSentMessages ? 'Se registran (podés desactivarlo en `/ajustes`).' : 'No se registran.', inline: false },
    )
    .setFooter({ text: 'Podés volver a ejecutar /setup cuando quieras: repara sin duplicar.' });
  return embed;
}

function truncateLines(lines: string[], max: number): string {
  let out = '';
  for (const l of lines) {
    if (out.length + l.length + 1 > max) return `${out}\n…`;
    out += `${out ? '\n' : ''}${l}`;
  }
  return out;
}

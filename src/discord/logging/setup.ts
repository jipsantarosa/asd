import {
  ChannelType, EmbedBuilder, OverwriteType, PermissionFlagsBits, PermissionsBitField, type CategoryChannel, type Guild,
  type GuildBasedChannel, type OverwriteResolvable, type Role, type TextChannel,
} from 'discord.js';
import { logger } from '../../logger';
import type { GameContext } from '../../services/context';
import { ensureSettings } from '../../services/guildSettings';
import { markSetupVersion } from '../../services/setupVersions';
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

export interface SetupResult {
  embed: EmbedBuilder;
  /** Canales y categorías sobrantes de instalaciones anteriores (para ofrecer borrarlos). */
  duplicates: number;
  ok: boolean;
}

/**
 * Configura, repara y sincroniza el sistema de registros con el diseño de esta versión del bot, sin duplicar:
 * - encuentra sus canales por ID guardado o, si se perdió la base, por nombre (también por nombres de versiones anteriores);
 * - los deja con el nombre, la descripción, la categoría y los permisos actuales (sin borrarlos: se conserva el historial);
 * - informa los canales sobrantes de instalaciones anteriores, que solo se borran si alguien lo confirma.
 */
export async function runSetup(ctx: GameContext, guild: Guild, opts: SetupOptions): Promise<SetupResult> {
  ensureSettings(ctx, guild.id);
  const missing = missingSetupPermissions(guild);
  if (missing.length) {
    return {
      ok: false, duplicates: 0,
      embed: new EmbedBuilder().setColor(COLORS.error).setTitle('❌ Me faltan permisos')
        .setDescription(`Para configurar los registros necesito:\n${missing.map((m) => `• ${m}`).join('\n')}\n\nDámelos (o un rol que los tenga) y volvé a ejecutar \`/setup\`.`),
    };
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
    const changes: string[] = [];
    if (category.name !== CATEGORY_NAME) {
      await category.setName(CATEGORY_NAME, reason);
      changes.push('renombrada');
    }
    await category.permissionOverwrites.set(overwrites, reason);
    report.push(`🔧 Categoría <#${category.id}> ${plan.category.kind === 'adopt' ? 'recuperada' : 'verificada'}${changes.length ? ` y ${changes.join(', ')}` : ''}`);
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
        // Sincronizar con el diseño actual: categoría, nombre, descripción y permisos.
        const changes: string[] = [];
        if (ch.parentId !== category.id) {
          await ch.setParent(category.id, { lockPermissions: false, reason });
          changes.push('movido a la categoría');
        }
        if (ch.name !== def.name) {
          const old = ch.name;
          await ch.setName(def.name, reason);
          changes.push(`renombrado (antes \`${old}\`)`);
        }
        if (ch.topic !== def.topic) {
          await ch.setTopic(def.topic, reason);
          changes.push('descripción actualizada');
        }
        await ch.permissionOverwrites.set(overwrites, reason);
        const label = step.kind === 'adopt' ? 'recuperado' : step.kind === 'reparent' ? 'devuelto a la categoría' : 'correcto';
        report.push(`${changes.length || step.kind !== 'keep' ? '🔧' : '✅'} <#${ch.id}> ${changes.length ? changes.join(', ') : label}`);
      }
      result.channels[step.key] = ch.id;
    } catch (err) {
      logger.warn(`/setup: fallo en ${step.key} (${guild.id}):`, err);
      errors.push(`❌ ${def.name}: ${(err as Error).message}`);
    }
  }
  saveLogConfig(ctx, guild.id, result);
  markSetupVersion(ctx, guild.id, 'logs');

  // Verificación final: el bot debe poder escribir en cada canal guardado.
  const me = guild.members.me!;
  for (const [key, id] of Object.entries(result.channels)) {
    const ch = guild.channels.cache.get(id!);
    if (!ch || !ch.permissionsFor(me).has(new PermissionsBitField(BOT_ALLOW))) errors.push(`⚠️ No puedo escribir en el canal de ${key}.`);
  }
  const dups = duplicateLogChannels(ctx, guild);
  if (dups.length) report.push(`\n🧹 Hay **${dups.length}** ${dups.length === 1 ? 'canal sobrante' : 'canales sobrantes'} de instalaciones anteriores: ${dups.slice(0, 10).map((c) => `<#${c.id}>`).join(' ')}. Podés borrarlos con el botón de abajo.`);

  const embed = new EmbedBuilder()
    .setColor(errors.length ? COLORS.warn : COLORS.ok)
    .setTitle(errors.length ? '⚠️ Registros configurados con advertencias' : '✅ Registros listos y actualizados')
    .setDescription(truncateLines([...report, ...errors], 3900))
    .addFields(
      { name: 'Quién puede verlos', value: `Roles con Administrador o Gestionar servidor${staffRoleId ? ` y <@&${staffRoleId}>` : ''}. Nadie más.`, inline: false },
      { name: 'Mensajes enviados', value: opts.logSentMessages ? 'Se registran (podés desactivarlo en `/ajustes`).' : 'No se registran.', inline: false },
    )
    .setFooter({ text: 'Al actualizar el bot, los registros se sincronizan solos. /setup los repara cuando quieras, sin duplicar.' });
  return { embed, duplicates: dups.length, ok: !errors.length };
}

/**
 * Canales de registro sobrantes (y categorías de registros repetidas que quedarían vacías).
 * Se recalcula en el momento de borrar: nunca incluye un canal en uso ni algo fuera de las categorías de registros.
 */
export function duplicateLogChannels(ctx: GameContext, guild: Guild): GuildBasedChannel[] {
  const plan = planSetup(getLogConfig(ctx, guild.id), snapshot(guild));
  const inUse = new Set(Object.values(getLogConfig(ctx, guild.id).channels));
  const channels = plan.duplicates.filter((id) => !inUse.has(id)).map((id) => guild.channels.cache.get(id)).filter((c): c is GuildBasedChannel => !!c);
  const gone = new Set(channels.map((c) => c.id));
  const emptyCats = plan.duplicateCategories
    .map((id) => guild.channels.cache.get(id))
    .filter((c): c is CategoryChannel => c?.type === ChannelType.GuildCategory && c.children.cache.every((ch) => gone.has(ch.id)));
  return [...channels, ...emptyCats];
}

/** Borra solo lo que duplicateLogChannels marca como sobrante. */
export async function deleteLogDuplicates(ctx: GameContext, guild: Guild, executorTag: string): Promise<number> {
  await guild.channels.fetch();
  const list = duplicateLogChannels(ctx, guild);
  let n = 0;
  // Primero los canales, después las categorías (ya vacías).
  for (const c of [...list].sort((a, b) => Number(a.type === ChannelType.GuildCategory) - Number(b.type === ChannelType.GuildCategory))) {
    if (await c.delete(`Duplicado de registros (por ${executorTag})`).then(() => true).catch(() => false)) n += 1;
  }
  return n;
}

/**
 * Reinstalación limpia: borra los canales de registro del bot (los guardados, los sobrantes y la categoría si queda vacía)
 * y vuelve a crearlos. Se pierde el historial de esos canales: por eso pide doble confirmación.
 */
export async function reinstallLogs(ctx: GameContext, guild: Guild, opts: SetupOptions): Promise<SetupResult> {
  await guild.channels.fetch();
  const cfg = getLogConfig(ctx, guild.id);
  const reason = `Reinstalación de registros (por ${opts.executorTag})`;
  const targets = [...Object.values(cfg.channels).map((id) => guild.channels.cache.get(id!)), ...duplicateLogChannels(ctx, guild)]
    .filter((c): c is GuildBasedChannel => !!c && c.type !== ChannelType.GuildCategory);
  for (const c of targets) await c.delete(reason).catch(() => undefined);
  const cat = cfg.categoryId ? guild.channels.cache.get(cfg.categoryId) : undefined;
  if (cat?.type === ChannelType.GuildCategory && cat.children.cache.size === 0) await cat.delete(reason).catch(() => undefined);
  saveLogConfig(ctx, guild.id, { ...cfg, categoryId: null, channels: {} });
  return runSetup(ctx, guild, { ...opts, staffRoleId: opts.staffRoleId ?? cfg.staffRoleId });
}

function truncateLines(lines: string[], max: number): string {
  let out = '';
  for (const l of lines) {
    if (out.length + l.length + 1 > max) return `${out}\n…`;
    out += `${out ? '\n' : ''}${l}`;
  }
  return out;
}

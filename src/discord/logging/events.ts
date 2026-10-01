import {
  AttachmentBuilder, AuditLogEvent, ChannelType, EmbedBuilder, Events, PermissionFlagsBits,
  type Client, type Guild, type GuildAuditLogsEntry, type Message, type PartialMessage,
} from 'discord.js';
import { logger } from '../../logger';
import type { GameContext } from '../../services/context';
import { forgetLogChannel, getLogConfig, isLogChannel } from '../../services/logConfig';
import { forgetRole } from '../../services/roles';
import { COLORS, clean, truncate } from '../ui/theme';
import { logSystem, sendLog } from './sender';

const MAX_REUPLOAD_BYTES = 8 * 1024 * 1024;
const ts = (d: Date | number | null | undefined) => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>` : 'desconocido');
const who = (id: string | null | undefined) => (id ? `<@${id}> (\`${id}\`)` : 'desconocido');

function inLogArea(ctx: GameContext, guild: Guild, channelId: string | null | undefined): boolean {
  if (!channelId) return false;
  const ch = guild.channels.cache.get(channelId);
  const parent = ch && 'parentId' in ch ? ch.parentId : null;
  return isLogChannel(ctx, guild.id, channelId, parent);
}

function base(color: number, title: string): EmbedBuilder {
  return new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
}

async function findExecutor(guild: Guild, type: AuditLogEvent, targetId: string, channelId?: string): Promise<string | null> {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    const entry = logs.entries.find((e) => e.targetId === targetId && Date.now() - e.createdTimestamp < 10_000
      && (!channelId || (e.extra as { channel?: { id: string } } | null)?.channel?.id === channelId));
    return entry?.executorId ?? null;
  } catch {
    return null;
  }
}

export function registerLogEvents(client: Client, ctx: GameContext): void {
  // ───────────── Mensajes enviados + adjuntos ─────────────
  client.on(Events.MessageCreate, async (msg) => {
    try {
      if (!msg.inGuild() || msg.author.bot || msg.system || inLogArea(ctx, msg.guild, msg.channelId)) return;
      const cfg = getLogConfig(ctx, msg.guildId);
      if (cfg.logSentMessages && msg.content) {
        await sendLog(ctx, msg.guild, 'mensajes', {
          embeds: [base(COLORS.log, '📝 Mensaje enviado')
            .setAuthor({ name: msg.author.tag, iconURL: msg.author.displayAvatarURL() })
            .setDescription(truncate(msg.content, 3800))
            .addFields({ name: 'Canal', value: `<#${msg.channelId}> · [ir al mensaje](${msg.url})`, inline: true }, { name: 'Autor', value: who(msg.author.id), inline: true })],
        });
      }
      if (msg.attachments.size) {
        const small = msg.attachments.filter((a) => a.size <= MAX_REUPLOAD_BYTES).first(10);
        const big = msg.attachments.filter((a) => a.size > MAX_REUPLOAD_BYTES);
        await sendLog(ctx, msg.guild, 'adjuntos', {
          embeds: [base(COLORS.log, `🖼️ ${msg.attachments.size} adjunto(s)`)
            .setAuthor({ name: msg.author.tag, iconURL: msg.author.displayAvatarURL() })
            .setDescription(`${who(msg.author.id)} en <#${msg.channelId}> · [ir al mensaje](${msg.url})${big.size ? `\nDemasiado grandes para respaldar: ${big.map((a) => clean(a.name)).join(', ')}` : ''}`)],
          files: small.map((a) => new AttachmentBuilder(a.url, { name: a.name })),
        });
      }
    } catch (err) {
      logger.warn('log messageCreate:', err);
    }
  });

  // ───────────── Mensajes editados ─────────────
  client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
    try {
      const msg = newMsg.partial ? await newMsg.fetch().catch(() => null) : newMsg;
      if (!msg || !msg.inGuild() || msg.author.bot || inLogArea(ctx, msg.guild, msg.channelId)) return;
      if (oldMsg.content !== null && oldMsg.content === msg.content) return; // solo cambió un embed
      await sendLog(ctx, msg.guild, 'mensajes', {
        embeds: [base(COLORS.warn, '✏️ Mensaje editado')
          .setAuthor({ name: msg.author.tag, iconURL: msg.author.displayAvatarURL() })
          .addFields(
            { name: 'Antes', value: truncate(oldMsg.content ?? '*(no estaba en memoria)*', 1000) || '*(vacío)*' },
            { name: 'Después', value: truncate(msg.content, 1000) || '*(vacío)*' },
            { name: 'Canal', value: `<#${msg.channelId}> · [ir al mensaje](${msg.url})`, inline: true },
            { name: 'Autor', value: who(msg.author.id), inline: true },
          )],
      });
    } catch (err) {
      logger.warn('log messageUpdate:', err);
    }
  });

  // ───────────── Mensajes eliminados ─────────────
  client.on(Events.MessageDelete, async (msg: Message | PartialMessage) => {
    try {
      if (!msg.guild || inLogArea(ctx, msg.guild, msg.channelId)) return;
      if (msg.author?.bot) return;
      const executor = msg.author ? await findExecutor(msg.guild, AuditLogEvent.MessageDelete, msg.author.id, msg.channelId) : null;
      const embed = base(COLORS.error, '🗑️ Mensaje eliminado')
        .setDescription(msg.content ? truncate(msg.content, 3800) : '*Contenido no disponible (el mensaje no estaba en memoria del bot).*')
        .addFields(
          { name: 'Canal', value: `<#${msg.channelId}>`, inline: true },
          { name: 'Autor', value: who(msg.author?.id), inline: true },
          { name: 'Eliminado por', value: executor ? who(executor) : 'el autor (o no registrado)', inline: true },
        );
      if (msg.author) embed.setAuthor({ name: msg.author.tag, iconURL: msg.author.displayAvatarURL() });
      if (msg.attachments?.size) embed.addFields({ name: 'Adjuntos', value: truncate(msg.attachments.map((a) => clean(a.name)).join(', '), 1000) + '\n*Revisá el canal de adjuntos para ver el respaldo.*' });
      await sendLog(ctx, msg.guild, 'eliminados', { embeds: [embed] });
    } catch (err) {
      logger.warn('log messageDelete:', err);
    }
  });

  client.on(Events.MessageBulkDelete, async (messages, channel) => {
    try {
      if (!('guild' in channel) || !channel.guild || inLogArea(ctx, channel.guild, channel.id)) return;
      const lines = [...messages.values()].reverse().map((m) =>
        `[${m.createdAt?.toISOString() ?? '?'}] ${m.author?.tag ?? 'desconocido'} (${m.author?.id ?? '?'}): ${m.content ?? '(sin contenido en memoria)'}`);
      await sendLog(ctx, channel.guild, 'eliminados', {
        embeds: [base(COLORS.error, '🧹 Eliminación masiva').setDescription(`Se eliminaron **${messages.size}** mensajes en <#${channel.id}>. Transcripción adjunta.`)],
        files: [new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), { name: `eliminados-${channel.id}.txt` })],
      });
    } catch (err) {
      logger.warn('log bulkDelete:', err);
    }
  });

  // ───────────── Entradas y salidas ─────────────
  client.on(Events.GuildMemberAdd, async (member) => {
    const ageDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
    await sendLog(ctx, member.guild, 'entradas', {
      embeds: [base(COLORS.ok, '📥 Entró un miembro')
        .setAuthor({ name: member.user.tag, iconURL: member.displayAvatarURL() })
        .setDescription(`${who(member.id)}\nCuenta creada ${ts(member.user.createdAt)}${ageDays < 7 ? ' ⚠️ **cuenta nueva**' : ''}\nMiembros: **${member.guild.memberCount}**`)],
    });
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    const roles = member.roles?.cache.filter((r) => r.id !== member.guild.id).map((r) => `<@&${r.id}>`) ?? [];
    await sendLog(ctx, member.guild, 'entradas', {
      embeds: [base(COLORS.warn, '📤 Salió un miembro')
        .setAuthor({ name: member.user?.tag ?? member.id, iconURL: member.user?.displayAvatarURL() })
        .setDescription(`${who(member.id)}\nSe había unido ${ts(member.joinedAt)}\nRoles: ${truncate(roles.join(' ') || 'ninguno', 900)}\n*Si fue expulsión o baneo, figura en su canal correspondiente.*`)],
    });
  });

  // ───────────── Voz ─────────────
  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    if (oldState.channelId === newState.channelId) return;
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;
    const text = !oldState.channelId ? `🔊 ${who(member.id)} entró a <#${newState.channelId}>`
      : !newState.channelId ? `🔇 ${who(member.id)} salió de <#${oldState.channelId}>`
        : `🔀 ${who(member.id)} pasó de <#${oldState.channelId}> a <#${newState.channelId}>`;
    await sendLog(ctx, newState.guild, 'voz', { embeds: [new EmbedBuilder().setColor(COLORS.log).setDescription(text).setTimestamp()] });
  });

  // ───────────── Auditoría: baneos, expulsiones, sanciones, roles, apodos, servidor ─────────────
  client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
    try {
      await handleAudit(ctx, entry, guild);
    } catch (err) {
      logger.warn('log audit:', err);
    }
  });

  // ───────────── Mantenimiento: canales y roles borrados ─────────────
  client.on(Events.ChannelDelete, async (channel) => {
    if (channel.type === ChannelType.DM || !('guild' in channel)) return;
    const key = forgetLogChannel(ctx, channel.guild.id, channel.id);
    if (key) await logSystem(ctx, channel.guild, `⚠️ Se eliminó el canal de registros **${key}**. Ejecutá \`/setup\` para recrearlo.`, COLORS.warn);
  });

  client.on(Events.GuildRoleDelete, (role) => forgetRole(ctx, role.guild.id, role.id));
}

type Change = { key: string; old?: unknown; new?: unknown };

async function handleAudit(ctx: GameContext, entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
  const executor = who(entry.executorId);
  const target = entry.targetId;
  const reason = entry.reason ? clean(truncate(entry.reason, 500)) : 'sin motivo';
  const changes = (entry.changes ?? []) as unknown as Change[];

  switch (entry.action) {
    case AuditLogEvent.MemberBanAdd:
      return sendLog(ctx, guild, 'baneos', { embeds: [base(COLORS.error, '🔨 Miembro baneado').setDescription(`**Usuario:** ${who(target)}\n**Por:** ${executor}\n**Motivo:** ${reason}`)] });
    case AuditLogEvent.MemberBanRemove:
      return sendLog(ctx, guild, 'baneos', { embeds: [base(COLORS.ok, '🕊️ Baneo revocado').setDescription(`**Usuario:** ${who(target)}\n**Por:** ${executor}`)] });
    case AuditLogEvent.MemberKick:
      return sendLog(ctx, guild, 'expulsiones', { embeds: [base(COLORS.warn, '👢 Miembro expulsado').setDescription(`**Usuario:** ${who(target)}\n**Por:** ${executor}\n**Motivo:** ${reason}`)] });
    case AuditLogEvent.MemberPrune:
      return sendLog(ctx, guild, 'moderacion', { embeds: [base(COLORS.warn, '✂️ Limpieza de miembros').setDescription(`**Por:** ${executor}\n**Motivo:** ${reason}`)] });
    case AuditLogEvent.MemberMove:
    case AuditLogEvent.MemberDisconnect:
      return sendLog(ctx, guild, 'moderacion', { embeds: [base(COLORS.warn, entry.action === AuditLogEvent.MemberMove ? '🔀 Miembros movidos de canal de voz' : '📴 Miembros desconectados de voz').setDescription(`**Por:** ${executor}`)] });
    case AuditLogEvent.MemberUpdate: {
      for (const c of changes) {
        if (c.key === 'nick') {
          await sendLog(ctx, guild, 'apodos', {
            embeds: [base(COLORS.log, '🏷️ Cambio de apodo').setDescription(`**Miembro:** ${who(target)}\n**Antes:** ${c.old ? clean(String(c.old)) : '*(sin apodo)*'}\n**Ahora:** ${c.new ? clean(String(c.new)) : '*(sin apodo)*'}\n**Por:** ${entry.executorId === target ? 'el propio miembro' : executor}`)],
          });
        } else if (c.key === 'communication_disabled_until') {
          const until = c.new ? new Date(String(c.new)) : null;
          await sendLog(ctx, guild, 'moderacion', {
            embeds: [base(until ? COLORS.error : COLORS.ok, until ? '⏱️ Aislamiento aplicado' : '✅ Aislamiento retirado')
              .setDescription(`**Miembro:** ${who(target)}\n**Por:** ${executor}${until ? `\n**Hasta:** <t:${Math.floor(until.getTime() / 1000)}:f>` : ''}\n**Motivo:** ${reason}`)],
          });
        } else if (c.key === 'mute' || c.key === 'deaf') {
          await sendLog(ctx, guild, 'moderacion', {
            embeds: [base(COLORS.warn, c.key === 'mute' ? '🔇 Silencio en voz' : '🙉 Ensordecido en voz').setDescription(`**Miembro:** ${who(target)}\n**Estado:** ${c.new ? 'activado' : 'desactivado'}\n**Por:** ${executor}`)],
          });
        }
      }
      return;
    }
    case AuditLogEvent.MemberRoleUpdate: {
      const fmt = (v: unknown) => (Array.isArray(v) ? v.map((r: { id: string }) => `<@&${r.id}>`).join(' ') : '');
      const added = changes.filter((c) => c.key === '$add').map((c) => fmt(c.new)).join(' ');
      const removed = changes.filter((c) => c.key === '$remove').map((c) => fmt(c.new)).join(' ');
      return sendLog(ctx, guild, 'roles', {
        embeds: [base(COLORS.log, '🎭 Roles de un miembro').setDescription(`**Miembro:** ${who(target)}${added ? `\n➕ ${added}` : ''}${removed ? `\n➖ ${removed}` : ''}\n**Por:** ${executor}`)],
      });
    }
    case AuditLogEvent.RoleCreate:
    case AuditLogEvent.RoleDelete:
    case AuditLogEvent.RoleUpdate: {
      const title = { [AuditLogEvent.RoleCreate]: '🆕 Rol creado', [AuditLogEvent.RoleDelete]: '🗑️ Rol eliminado', [AuditLogEvent.RoleUpdate]: '🛠️ Rol modificado' }[entry.action];
      const name = changes.find((c) => c.key === 'name');
      return sendLog(ctx, guild, 'roles', {
        embeds: [base(COLORS.log, title).setDescription(`**Rol:** ${entry.action === AuditLogEvent.RoleDelete ? clean(String(name?.old ?? target)) : `<@&${target}>`}\n**Por:** ${executor}${describeChanges(changes)}`)],
      });
    }
    case AuditLogEvent.ChannelCreate:
    case AuditLogEvent.ChannelDelete:
    case AuditLogEvent.ChannelUpdate:
    case AuditLogEvent.ChannelOverwriteCreate:
    case AuditLogEvent.ChannelOverwriteUpdate:
    case AuditLogEvent.ChannelOverwriteDelete: {
      const titles: Record<number, string> = {
        [AuditLogEvent.ChannelCreate]: '🆕 Canal creado', [AuditLogEvent.ChannelDelete]: '🗑️ Canal eliminado', [AuditLogEvent.ChannelUpdate]: '🛠️ Canal modificado',
        [AuditLogEvent.ChannelOverwriteCreate]: '🔐 Permisos de canal agregados', [AuditLogEvent.ChannelOverwriteUpdate]: '🔐 Permisos de canal modificados',
        [AuditLogEvent.ChannelOverwriteDelete]: '🔐 Permisos de canal quitados',
      };
      const name = changes.find((c) => c.key === 'name');
      const ref = entry.action === AuditLogEvent.ChannelDelete ? `#${clean(String(name?.old ?? target))}` : `<#${target}>`;
      return sendLog(ctx, guild, 'servidor', { embeds: [base(COLORS.log, titles[entry.action]).setDescription(`**Canal:** ${ref}\n**Por:** ${executor}${describeChanges(changes)}`)] });
    }
    case AuditLogEvent.GuildUpdate:
    case AuditLogEvent.InviteCreate:
    case AuditLogEvent.InviteDelete:
    case AuditLogEvent.WebhookCreate:
    case AuditLogEvent.WebhookDelete:
    case AuditLogEvent.EmojiCreate:
    case AuditLogEvent.EmojiDelete:
    case AuditLogEvent.BotAdd:
    case AuditLogEvent.IntegrationCreate:
    case AuditLogEvent.IntegrationDelete: {
      const titles: Record<number, string> = {
        [AuditLogEvent.GuildUpdate]: '⚙️ Ajustes del servidor modificados', [AuditLogEvent.InviteCreate]: '🔗 Invitación creada',
        [AuditLogEvent.InviteDelete]: '🔗 Invitación eliminada', [AuditLogEvent.WebhookCreate]: '🪝 Webhook creado',
        [AuditLogEvent.WebhookDelete]: '🪝 Webhook eliminado', [AuditLogEvent.EmojiCreate]: '😀 Emoji agregado',
        [AuditLogEvent.EmojiDelete]: '😶 Emoji eliminado', [AuditLogEvent.BotAdd]: '🤖 Bot agregado',
        [AuditLogEvent.IntegrationCreate]: '🔌 Integración agregada', [AuditLogEvent.IntegrationDelete]: '🔌 Integración eliminada',
      };
      const extra = entry.action === AuditLogEvent.BotAdd ? `\n**Bot:** ${who(target)}` : '';
      return sendLog(ctx, guild, 'servidor', { embeds: [base(entry.action === AuditLogEvent.BotAdd ? COLORS.warn : COLORS.log, titles[entry.action]).setDescription(`**Por:** ${executor}${extra}${describeChanges(changes)}`)] });
    }
    default:
      return;
  }
}

function describeChanges(changes: Change[]): string {
  const shown = changes.filter((c) => typeof c.old !== 'object' && typeof c.new !== 'object').slice(0, 6)
    .map((c) => `\`${c.key}\`: ${truncate(clean(String(c.old ?? '—')), 80)} → ${truncate(clean(String(c.new ?? '—')), 80)}`);
  return shown.length ? `\n${shown.join('\n')}` : '';
}

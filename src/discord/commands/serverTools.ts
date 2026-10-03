import {
  AuditLogEvent, ChannelType, EmbedBuilder, Events, InteractionContextType, MessageFlags, MessageType, PermissionFlagsBits, SlashCommandBuilder,
  type Guild, type GuildMember, type Message, type PartialGuildMember,
} from 'discord.js';
import { t, type Lang } from '../../i18n';
import { logger } from '../../logger';
import { BOOST_DEFAULTS, BoostDedupe, fillBoostText, getBoostConfig, parseColor, saveBoostConfig, type BoostConfig } from '../../services/boost';
import { GameError } from '../../services/context';
import { getSettings } from '../../services/guildSettings';
import { getWebhookGuard, judgeWebhookCreator, saveWebhookGuard, WebhookFlood, webhookMessageProblem } from '../../services/webhookGuard';
import type { App } from '../app';
import { logSystem, sendLog } from '../logging/sender';
import { COLORS, clean } from '../ui/theme';
import type { Command, CommandContext } from './types';

const langOf = (app: App, guildId: string): Lang => getSettings(app.ctx, guildId).lang;
const CHANNEL = /^<#(\d{17,20})>$|^(\d{17,20})$/;

function sub(c: CommandContext): string | null {
  return c.interaction ? c.interaction.options.getSubcommand(false) : c.args[0]?.toLowerCase() ?? null;
}

// ───────────────────────── /boosttracker ─────────────────────────

export function boostEmbed(cfg: BoostConfig, guild: Guild, member: { id: string; displayName: string; avatar: string }): EmbedBuilder {
  const vars = { userId: member.id, username: member.displayName, server: guild.name, boosts: guild.premiumSubscriptionCount ?? 0, tier: guild.premiumTier };
  const e = new EmbedBuilder()
    .setColor(cfg.color)
    .setTitle(fillBoostText(cfg.title, vars).slice(0, 256))
    .setDescription(fillBoostText(cfg.description, vars).slice(0, 4000))
    .setThumbnail(member.avatar)
    .setTimestamp();
  if (cfg.imageUrl) e.setImage(cfg.imageUrl);
  if (cfg.footer) e.setFooter({ text: fillBoostText(cfg.footer, vars).replace(/<@\d+>/g, member.displayName).slice(0, 200) });
  return e;
}

export async function announceBoost(app: App, member: GuildMember): Promise<boolean> {
  const cfg = getBoostConfig(app.ctx, member.guild.id);
  if (!cfg.enabled || !cfg.channelId) return false;
  const ch = member.guild.channels.cache.get(cfg.channelId);
  if (!ch?.isTextBased() || !ch.isSendable()) return false;
  await ch.send({
    content: `<@${member.id}>`,
    embeds: [boostEmbed(cfg, member.guild, { id: member.id, displayName: member.displayName, avatar: member.displayAvatarURL({ size: 256 }) })],
    allowedMentions: { users: [member.id] },
  });
  return true;
}

function boostStatus(L: Lang, cfg: BoostConfig): string {
  return t(L, 'boost.status', { state: cfg.enabled ? t(L, 'boost.on') : t(L, 'boost.offState'), channel: cfg.channelId ? `<#${cfg.channelId}>` : t(L, 'boost.noChannel') });
}

const EDIT_FIELDS: Record<string, keyof BoostConfig> = {
  titulo: 'title', título: 'title', title: 'title',
  descripcion: 'description', descripción: 'description', description: 'description', desc: 'description',
  color: 'color', colour: 'color',
  imagen: 'imageUrl', image: 'imageUrl', img: 'imageUrl',
  footer: 'footer', pie: 'footer',
};

export const boostTrackerCmd: Command = {
  name: 'boosttracker',
  aliases: ['boosts', 'boost'],
  prefix: true,
  permission: PermissionFlagsBits.ManageGuild,
  permissionName: 'Gestionar servidor',
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('boosttracker').setDescription('🚀 Mensaje especial cuando alguien boostea el servidor.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('setup').setDescription('Activar y elegir el canal').addChannelOption((o) => o.setName('canal').setDescription('Canal del anuncio')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
    .addSubcommand((s) => s.setName('edit').setDescription('Personalizar el mensaje')
      .addStringOption((o) => o.setName('titulo').setDescription('Título').setMaxLength(256))
      .addStringOption((o) => o.setName('descripcion').setDescription('Descripción ({user} {server} {boosts} {tier})').setMaxLength(2000))
      .addStringOption((o) => o.setName('color').setDescription('Oro, Rosa, Morado, Azul, Verde, Rojo, Naranja o #RRGGBB').setMaxLength(20))
      .addStringOption((o) => o.setName('imagen').setDescription('Enlace https de una imagen o GIF ("no" para quitarla)').setMaxLength(500))
      .addStringOption((o) => o.setName('footer').setDescription('Pie del mensaje ("no" para quitarlo)').setMaxLength(200)))
    .addSubcommand((s) => s.setName('test').setDescription('Ver cómo queda (con vos de ejemplo)'))
    .addSubcommand((s) => s.setName('reset').setDescription('Volver al mensaje por defecto'))
    .addSubcommand((s) => s.setName('off').setDescription('Desactivar'))
    .addSubcommand((s) => s.setName('status').setDescription('Ver la configuración')),
  async run(c) {
    const ctx = c.app.ctx;
    const L = langOf(c.app, c.guild.id);
    const me = { id: c.member.id, displayName: c.member.displayName, avatar: c.member.displayAvatarURL({ size: 256 }) };
    const preview = async (text: string) => {
      const cfg = getBoostConfig(ctx, c.guild.id);
      await c.reply({ content: text, embeds: [boostEmbed(cfg, c.guild, me)] });
    };
    switch (sub(c)) {
      case 'setup': {
        const raw = c.interaction ? c.interaction.options.getChannel('canal', true).id : c.args[1]?.match(CHANNEL)?.slice(1).find(Boolean);
        const ch = raw ? c.guild.channels.cache.get(raw) : undefined;
        if (!ch || !ch.isTextBased() || !ch.isSendable()) throw new GameError(`Uso: \`${c.prefix}boosttracker setup #canal\``);
        if (!('permissionsFor' in ch) || !ch.permissionsFor(c.guild.members.me!).has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
          throw new GameError(t(L, 'boost.cantWrite', { channel: `<#${ch.id}>` }));
        }
        saveBoostConfig(ctx, c.guild.id, { enabled: true, channelId: ch.id });
        await logSystem(ctx, c.guild, `🚀 <@${c.member.id}> activó los mensajes de boost en <#${ch.id}>.`);
        return preview(t(L, 'boost.setup', { channel: `<#${ch.id}>` }));
      }
      case 'edit': {
        if (!getBoostConfig(ctx, c.guild.id).channelId) throw new GameError(t(L, 'boost.notSetup'));
        const patch: Partial<BoostConfig> = {};
        const apply = (field: keyof BoostConfig, value: string | null) => {
          if (value === null) return;
          const v = value.trim();
          if (field === 'color') patch.color = parseColor(v);
          else if (field === 'imageUrl') patch.imageUrl = ['no', 'none', 'quitar', '-'].includes(v.toLowerCase()) ? null : v;
          else if (field === 'footer') patch.footer = ['no', 'none', 'quitar', '-'].includes(v.toLowerCase()) ? '' : v;
          else if (field === 'title') patch.title = v;
          else if (field === 'description') patch.description = v.replace(/\\n/g, '\n');
        };
        if (c.interaction) {
          const o = c.interaction.options;
          apply('title', o.getString('titulo'));
          apply('description', o.getString('descripcion'));
          apply('color', o.getString('color'));
          apply('imageUrl', o.getString('imagen'));
          apply('footer', o.getString('footer'));
        } else {
          // !boosttracker edit color Oro · !boosttracker edit titulo ¡Gracias!
          const field = EDIT_FIELDS[c.args[1]?.toLowerCase() ?? ''];
          if (!field) throw new GameError(`Uso: \`${c.prefix}boosttracker edit <titulo|descripcion|color|imagen|footer> <valor>\``);
          apply(field, c.args.slice(2).join(' ') || null);
        }
        if (!Object.keys(patch).length) throw new GameError('Decime qué cambiar: título, descripción, color, imagen o footer.');
        saveBoostConfig(ctx, c.guild.id, patch);
        await logSystem(ctx, c.guild, `🚀 <@${c.member.id}> editó el mensaje de boost (${Object.keys(patch).join(', ')}).`);
        return preview(t(L, 'boost.saved'));
      }
      case 'test':
        if (!getBoostConfig(ctx, c.guild.id).channelId) throw new GameError(t(L, 'boost.notSetup'));
        return preview(t(L, 'boost.preview'));
      case 'reset':
        saveBoostConfig(ctx, c.guild.id, { ...BOOST_DEFAULTS });
        return preview(t(L, 'boost.saved'));
      case 'off':
        saveBoostConfig(ctx, c.guild.id, { enabled: false });
        await c.reply({ content: t(L, 'boost.off') });
        return;
      default:
        await c.reply({ content: boostStatus(L, getBoostConfig(ctx, c.guild.id)) });
    }
  },
};

// ───────────────────────── /anti-webhooks ─────────────────────────

const WH_PERMS: [bigint, string][] = [
  [PermissionFlagsBits.ManageWebhooks, 'Gestionar webhooks'],
  [PermissionFlagsBits.ViewAuditLog, 'Ver el registro de auditoría'],
  [PermissionFlagsBits.ManageMessages, 'Gestionar mensajes'],
];

function webhookStatus(app: App, guild: Guild): string {
  const L = langOf(app, guild.id);
  const cfg = getWebhookGuard(app.ctx, guild.id);
  return t(L, 'wh.status', {
    state: cfg.enabled ? t(L, 'wh.on') : t(L, 'wh.off'),
    admins: cfg.allowAdmins ? t(L, 'wh.yes') : t(L, 'wh.no'),
    kick: cfg.kickBots ? t(L, 'wh.yes') : t(L, 'wh.no'),
    roles: cfg.allowRoles.map((r) => `<@&${r}>`).join(' ') || t(L, 'wh.none'),
  });
}

export const antiWebhooksCmd: Command = {
  name: 'anti-webhooks',
  aliases: ['antiwebhooks', 'antiwebhook', 'webhooks'],
  prefix: true,
  permission: PermissionFlagsBits.ManageGuild,
  permissionName: 'Gestionar servidor',
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('anti-webhooks').setDescription('🪝 Protección contra webhooks creados o usados con malas intenciones.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('setup').setDescription('Activar la protección'))
    .addSubcommand((s) => s.setName('off').setDescription('Desactivar'))
    .addSubcommand((s) => s.setName('status').setDescription('Ver la configuración'))
    .addSubcommand((s) => s.setName('allow').setDescription('Permitir que un rol cree webhooks').addRoleOption((o) => o.setName('rol').setDescription('Rol').setRequired(true)))
    .addSubcommand((s) => s.setName('disallow').setDescription('Quitar un rol permitido').addRoleOption((o) => o.setName('rol').setDescription('Rol').setRequired(true)))
    .addSubcommand((s) => s.setName('admins').setDescription('¿Los administradores pueden crear webhooks?').addBooleanOption((o) => o.setName('permitir').setDescription('Sí o no').setRequired(true)))
    .addSubcommand((s) => s.setName('bots').setDescription('¿Expulsar bots que creen webhooks sin permiso?').addBooleanOption((o) => o.setName('expulsar').setDescription('Sí o no').setRequired(true))),
  async run(c) {
    const ctx = c.app.ctx;
    const L = langOf(c.app, c.guild.id);
    const g = c.guild;
    const s = sub(c);
    const reply = async (extra?: string) => { await c.reply({ content: [extra, webhookStatus(c.app, g)].filter(Boolean).join('\n\n') }); };
    switch (s) {
      case 'setup': {
        const me = g.members.me!;
        const missing = WH_PERMS.filter(([p]) => !me.permissions.has(p)).map(([, n]) => n);
        if (missing.length) throw new GameError(t(L, 'wh.missing', { perms: missing.join('**, **') }));
        saveWebhookGuard(ctx, g.id, { enabled: true });
        await logSystem(ctx, g, `🪝 <@${c.member.id}> activó el anti-webhooks.`);
        return reply(t(L, 'wh.enabled'));
      }
      case 'off':
        saveWebhookGuard(ctx, g.id, { enabled: false });
        await logSystem(ctx, g, `🪝 <@${c.member.id}> desactivó el anti-webhooks.`);
        return reply(t(L, 'wh.disabled'));
      case 'allow':
      case 'disallow': {
        const role = c.role('rol', 1);
        if (!role || role.id === g.id) throw new GameError(`Uso: \`${c.prefix}anti-webhooks ${s} @rol\``);
        const cfg = getWebhookGuard(ctx, g.id);
        saveWebhookGuard(ctx, g.id, { allowRoles: s === 'allow' ? [...cfg.allowRoles, role.id] : cfg.allowRoles.filter((r) => r !== role.id) });
        return reply();
      }
      case 'admins':
      case 'bots': {
        const v = c.interaction ? c.interaction.options.getBoolean(s === 'admins' ? 'permitir' : 'expulsar', true) : c.bool('x', 1);
        if (v === null) throw new GameError(`Uso: \`${c.prefix}anti-webhooks ${s} si|no\``);
        saveWebhookGuard(ctx, g.id, s === 'admins' ? { allowAdmins: v } : { kickBots: v });
        return reply();
      }
      default:
        return reply();
    }
  },
};

// ───────────────────────── Eventos ─────────────────────────

const BOOST_TYPES = new Set([MessageType.GuildBoost, MessageType.GuildBoostTier1, MessageType.GuildBoostTier2, MessageType.GuildBoostTier3]);

/** Escucha boosts y webhooks. */
export function startServerTools(app: App): void {
  const client = app.client;
  const dedupe = new BoostDedupe();
  const flood = new WebhookFlood();
  const boost = (member: GuildMember) => {
    if (!dedupe.first(`${member.guild.id}:${member.id}`, Date.now())) return;
    void announceBoost(app, member).catch((err) => logger.warn('Boost tracker:', err));
  };

  // Cada boost genera un mensaje de sistema (si el servidor no los desactivó); el primero, además, cambia al miembro.
  client.on(Events.MessageCreate, (msg) => {
    if (msg.inGuild() && BOOST_TYPES.has(msg.type) && msg.member) boost(msg.member);
    if (msg.inGuild() && msg.webhookId) void onWebhookMessage(app, msg, flood).catch((err) => logger.warn('Anti-webhooks (mensaje):', err));
  });
  client.on(Events.GuildMemberUpdate, (old: GuildMember | PartialGuildMember, now: GuildMember) => {
    if (!old.partial && !old.premiumSince && now.premiumSince) boost(now);
  });

  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    if (entry.action !== AuditLogEvent.WebhookCreate) return;
    void onWebhookCreate(app, guild, entry.executorId, entry.targetId).catch((err) => logger.warn('Anti-webhooks:', err));
  });
}

async function onWebhookCreate(app: App, guild: Guild, executorId: string | null, webhookId: string | null): Promise<void> {
  const cfg = getWebhookGuard(app.ctx, guild.id);
  if (!cfg.enabled || !executorId || !webhookId) return;
  const L = langOf(app, guild.id);
  const member = await guild.members.fetch(executorId).catch(() => null);
  const verdict = judgeWebhookCreator(cfg, {
    id: executorId,
    isSelf: executorId === app.client.user?.id,
    isOwner: executorId === guild.ownerId,
    isBot: member?.user.bot ?? false,
    isAdmin: member?.permissions.has(PermissionFlagsBits.Administrator) ?? false,
    roleIds: member ? [...member.roles.cache.keys()] : [],
  });
  if (verdict === 'allow') return;
  const hooks = await guild.fetchWebhooks().catch(() => null);
  const hook = hooks?.get(webhookId);
  if (hook) await hook.delete('Anti-webhooks: creado sin permiso').catch(() => undefined);
  const text = t(L, 'wh.deleted', { who: `<@${executorId}>`, channel: hook?.channelId ? `<#${hook.channelId}>` : '?' });
  await sendLog(app.ctx, guild, 'moderacion', { embeds: [new EmbedBuilder().setColor(COLORS.warn).setDescription(text).setTimestamp()] });
  if (verdict === 'delete_kick' && member?.kickable) {
    await member.kick('Anti-webhooks: bot que creó un webhook sin permiso').catch(() => undefined);
    await sendLog(app.ctx, guild, 'moderacion', { embeds: [new EmbedBuilder().setColor(COLORS.error).setDescription(t(L, 'wh.kicked', { who: `<@${executorId}>` })).setTimestamp()] });
  }
}

async function onWebhookMessage(app: App, msg: Message<true>, flood: WebhookFlood): Promise<void> {
  const cfg = getWebhookGuard(app.ctx, msg.guildId);
  if (!cfg.enabled) return;
  // Respuestas de comandos de bots y anuncios de canales seguidos también llegan con webhookId: no se tocan.
  if (msg.applicationId || msg.interactionMetadata || msg.flags.has(MessageFlags.IsCrosspost) || msg.author.id === app.client.user?.id) return;
  const L = langOf(app, msg.guildId);
  const name = clean(msg.author.username);
  const channel = `<#${msg.channelId}>`;
  if (flood.hit(msg.webhookId!, Date.now())) {
    const hook = await msg.fetchWebhook().catch(() => null);
    if (hook) {
      await hook.delete('Anti-webhooks: spam').catch(() => undefined);
      await sendLog(app.ctx, msg.guild, 'moderacion', { embeds: [new EmbedBuilder().setColor(COLORS.error).setDescription(t(L, 'wh.flood', { name, channel })).setTimestamp()] });
    }
    await msg.delete().catch(() => undefined);
    return;
  }
  const why = webhookMessageProblem(msg.content, msg.mentions.everyone);
  if (!why) return;
  await msg.delete().catch(() => undefined);
  await sendLog(app.ctx, msg.guild, 'moderacion', { embeds: [new EmbedBuilder().setColor(COLORS.warn).setDescription(t(L, 'wh.msg', { name, channel, why })).setTimestamp()] });
}

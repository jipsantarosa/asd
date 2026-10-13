import {
  ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, Events, InteractionContextType, SlashCommandBuilder, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, type Guild,
} from 'discord.js';
import { logger } from '../../logger';
import { GameError, type GameContext } from '../../services/context';
import { row, type App, type Panel } from '../app';
import { update, values, type Handler } from '../handlers/util';
import { isOwner } from '../owner';
import { cid } from '../ui/ids';
import { clean } from '../ui/theme';
import type { Command } from './types';

/**
 * /servidores (solo dueños del bot): en qué servidores está el bot, con miembros, dueño, fecha en que lo
 * agregaron y cuánta gente usó el casino ahí; detalle de cada uno, sacar el bot de un servidor, y avisos
 * en un canal cuando lo agregan o lo sacan.
 */

const PAGE = 10;
const ACCENT = 0x5865f2;
const NOTIFY_KEY = 'bot_guild_notify_channel';
const DAY = 86_400_000;

const num = (n: number) => n.toLocaleString('es-AR');
const ts = (ms: number, style: 'R' | 'f' | 'D' = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;

function requireOwner(userId: string): void {
  if (!isOwner(userId)) throw new GameError('Solo el dueño del bot puede usar esto.');
}

export function getNotifyChannel(ctx: GameContext): string | null {
  return ctx.db.get<{ value: string }>('SELECT value FROM casino_meta WHERE key = ?', NOTIFY_KEY)?.value || null;
}

export function setNotifyChannel(ctx: GameContext, channelId: string | null): void {
  if (channelId && !/^\d{17,20}$/.test(channelId)) throw new GameError('Canal inválido.');
  if (!channelId) ctx.db.run('DELETE FROM casino_meta WHERE key = ?', NOTIFY_KEY);
  else ctx.db.run(`INSERT INTO casino_meta (key, value, updated_at) VALUES (?, ?, ?)
                   ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, NOTIFY_KEY, channelId, ctx.now());
}

/** Cuántas personas usaron el casino en cada servidor (total y en los últimos 7 días). */
export function casinoPlayersByGuild(ctx: GameContext, now = ctx.now()): Map<string, { total: number; week: number }> {
  const rows = ctx.db.all<{ guild_id: string; total: number; week: number }>(
    'SELECT guild_id, COUNT(*) AS total, SUM(last_seen >= ?) AS week FROM casino_user_guilds GROUP BY guild_id', now - 7 * DAY,
  );
  return new Map(rows.map((r) => [r.guild_id, { total: r.total, week: r.week ?? 0 }]));
}

function sorted(app: App): Guild[] {
  return [...app.client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));
}

function listPanel(app: App, owner: string, page: number, notice?: string): Panel {
  const guilds = sorted(app);
  const pages = Math.max(1, Math.ceil(guilds.length / PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const players = casinoPlayersByGuild(app.ctx);
  const members = guilds.reduce((s, g) => s + g.memberCount, 0);
  const active = [...players.values()].reduce((s, v) => s + v.week, 0);
  const slice = guilds.slice(p * PAGE, p * PAGE + PAGE);
  const notify = getNotifyChannel(app.ctx);
  const e = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle('🌐 Servidores del bot')
    .setDescription([
      notice ?? '',
      `**${num(guilds.length)}** servidores · **${num(members)}** miembros en total · **${num(active)}** jugaron al casino esta semana`,
      '',
      ...slice.map((g, i) => {
        const pl = players.get(g.id);
        return `**${p * PAGE + i + 1}. ${clean(g.name)}**\n-# 👥 ${num(g.memberCount)} · 🎰 ${num(pl?.total ?? 0)} jugadores${pl?.week ? ` (${num(pl.week)} esta semana)` : ''} · agregado ${g.joinedTimestamp ? ts(g.joinedTimestamp) : '—'}`;
      }),
      '',
      `🔔 Avisos de altas y bajas: ${notify ? `<#${notify}>` : '*desactivados* (`/servidores avisos`)'}`,
    ].filter((l, i) => l || i > 0).join('\n').slice(0, 4096))
    .setFooter({ text: `Página ${p + 1} de ${pages} · ordenados por miembros` });
  const rows = [];
  if (slice.length) {
    rows.push(row(new StringSelectMenuBuilder().setCustomId(cid('bg', 'see', owner, p)).setPlaceholder('Ver un servidor…')
      .addOptions(slice.map((g) => new StringSelectMenuOptionBuilder().setValue(g.id).setLabel(g.name.slice(0, 100)).setDescription(`${num(g.memberCount)} miembros`)))));
  }
  rows.push(row(
    new ButtonBuilder().setCustomId(cid('bg', 'page', owner, p - 1)).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
    new ButtonBuilder().setCustomId(cid('bg', 'page', owner, p)).setLabel('Actualizar').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('bg', 'page', owner, p + 1)).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(p >= pages - 1),
  ));
  return { embeds: [e], components: rows };
}

async function guildPanel(app: App, owner: string, guildId: string, page: number): Promise<Panel> {
  const g = app.client.guilds.cache.get(guildId);
  if (!g) throw new GameError('El bot ya no está en ese servidor.');
  const ownerUser = await app.client.users.fetch(g.ownerId).catch(() => null);
  const pl = casinoPlayersByGuild(app.ctx).get(g.id);
  const channels = g.channels.cache;
  const e = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(clean(g.name))
    .setThumbnail(g.iconURL({ size: 128 }))
    .addFields(
      { name: '🆔 ID', value: `\`${g.id}\``, inline: true },
      { name: '👑 Dueño', value: ownerUser ? `${clean(ownerUser.username)}\n\`${g.ownerId}\`` : `\`${g.ownerId}\``, inline: true },
      { name: '👥 Miembros', value: num(g.memberCount), inline: true },
      { name: '📅 Bot agregado', value: g.joinedTimestamp ? `${ts(g.joinedTimestamp, 'D')} (${ts(g.joinedTimestamp)})` : '—', inline: true },
      { name: '🗓️ Servidor creado', value: ts(g.createdTimestamp, 'D'), inline: true },
      { name: '🚀 Boosts', value: `${g.premiumSubscriptionCount ?? 0} (nivel ${g.premiumTier})`, inline: true },
      { name: '💬 Canales', value: `${channels.filter((c) => c.type === ChannelType.GuildText).size} de texto · ${channels.filter((c) => c.type === ChannelType.GuildVoice).size} de voz`, inline: true },
      { name: '🎰 Casino', value: `${num(pl?.total ?? 0)} jugadores · ${num(pl?.week ?? 0)} esta semana`, inline: true },
      { name: '🌐 Idioma', value: g.preferredLocale, inline: true },
    );
  if (g.description) e.setDescription(clean(g.description).slice(0, 300));
  return {
    embeds: [e],
    components: [row(
      new ButtonBuilder().setCustomId(cid('bg', 'page', owner, page)).setLabel('Volver').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(cid('bg', 'leave', owner, g.id, page)).setLabel('Sacar el bot').setEmoji('🚪').setStyle(ButtonStyle.Danger),
    )],
  };
}

export const botGuildsHandler: Handler = async (app, i, id) => {
  requireOwner(i.user.id);
  switch (id.act) {
    case 'page':
      return update(i, listPanel(app, i.user.id, Number(id.args[0]) || 0));
    case 'see':
      return update(i, await guildPanel(app, i.user.id, values(i)[0] ?? '', Number(id.args[0]) || 0));
    case 'leave': {
      const g = app.client.guilds.cache.get(id.args[0] ?? '');
      if (!g) throw new GameError('El bot ya no está en ese servidor.');
      return update(i, {
        embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription(`¿Sacar el bot de **${clean(g.name)}**? Para volver, alguien de ese servidor lo tiene que invitar de nuevo. Los datos guardados no se borran.`)],
        components: [row(
          new ButtonBuilder().setCustomId(cid('bg', 'leaveok', i.user.id, g.id, id.args[1] ?? 0)).setLabel('Sí, sacarlo').setEmoji('🚪').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(cid('bg', 'page', i.user.id, id.args[1] ?? 0)).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
        )],
      });
    }
    case 'leaveok': {
      const g = app.client.guilds.cache.get(id.args[0] ?? '');
      if (!g) throw new GameError('El bot ya no está en ese servidor.');
      // Desde el mismo servidor no: el panel desaparecería sin confirmar nada.
      if (g.id === i.guildId) throw new GameError('No puedo sacar el bot del servidor desde el que estás usando el panel. Abrí `/servidores` desde otro.');
      const name = g.name;
      await g.leave();
      return update(i, listPanel(app, i.user.id, Number(id.args[1]) || 0, `🚪 El bot salió de **${clean(name)}**.`));
    }
    default:
      throw new GameError('Acción desconocida.');
  }
};

/** Avisa en el canal configurado cuando agregan o sacan el bot de un servidor. */
export function startGuildNotices(app: App): void {
  const notify = async (g: Guild, joined: boolean) => {
    const channelId = getNotifyChannel(app.ctx);
    if (!channelId) return;
    const ch = await app.client.channels.fetch(channelId).catch(() => null);
    if (!ch?.isTextBased() || !('send' in ch)) return;
    const total = app.client.guilds.cache.size;
    const e = new EmbedBuilder()
      .setColor(joined ? 0x2ecc71 : 0xe74c3c)
      .setTitle(joined ? '📥 Me agregaron a un servidor' : '📤 Me sacaron de un servidor')
      .setThumbnail(g.iconURL({ size: 128 }))
      .setDescription(`**${clean(g.name ?? 'Servidor')}**\n-# ID \`${g.id}\`${g.memberCount ? ` · ${num(g.memberCount)} miembros` : ''}${joined && g.ownerId ? ` · dueño \`${g.ownerId}\`` : ''}`)
      .setFooter({ text: `Ahora estoy en ${num(total)} servidores` })
      .setTimestamp(new Date());
    await ch.send({ embeds: [e], allowedMentions: { parse: [] } }).catch((err) => logger.warn('Avisos de servidores:', err));
  };
  app.client.on(Events.GuildCreate, (g) => void notify(g, true));
  app.client.on(Events.GuildDelete, (g) => {
    // Una caída de Discord también "borra" el servidor por un rato: eso no es que lo hayan sacado.
    if (g.available === false) return;
    void notify(g, false);
  });
}

export const botGuildsCmd: Command = {
  name: 'servidores',
  aliases: ['servers', 'guilds', 'botservers'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('servidores')
    .setDescription('👑 (Dueño del bot) En qué servidores está el bot, y avisos cuando lo agregan o lo sacan.')
    .addSubcommand((s) => s.setName('lista').setDescription('Lista de servidores con miembros, dueño y uso del casino.'))
    .addSubcommand((s) => s.setName('avisos').setDescription('Avisar en un canal cada vez que agregan o sacan el bot.')
      .addChannelOption((o) => o.setName('canal').setDescription('Canal de avisos (vacío = desactivar)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))),
  async run(c) {
    requireOwner(c.member.id);
    const sub = c.interaction ? c.interaction.options.getSubcommand(false) : c.args[0]?.toLowerCase();
    if (sub === 'avisos') {
      const ch = c.interaction ? c.interaction.options.getChannel('canal') : c.message?.mentions.channels.first() ?? null;
      setNotifyChannel(c.app.ctx, ch?.id ?? null);
      await c.reply({ content: ch ? `🔔 Listo: aviso en <#${ch.id}> cada vez que agregan o sacan el bot de un servidor.` : '🔕 Avisos desactivados.' }, { ephemeral: true });
      return;
    }
    await c.reply(listPanel(c.app, c.member.id, 0), { ephemeral: true });
  },
};

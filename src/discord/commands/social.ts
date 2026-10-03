import {
  ButtonBuilder, ButtonStyle, EmbedBuilder, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder, type Guild,
} from 'discord.js';
import { ACHIEVEMENTS, unlockedAchievements } from '../../casino/achievements';
import { ensureCasinoUser } from '../../casino/economy';
import { rankOf } from '../../casino/leaderboard';
import { getCasinoUser, levelProgress, MAX_LEVEL, rankFor } from '../../casino/users';
import { workStatus } from '../../casino/work';
import { t, type Lang } from '../../i18n';
import { GameError } from '../../services/context';
import { getSettings, LANGUAGES, setLanguage } from '../../services/guildSettings';
import { answerProposal, cancelProposal, divorce, getMarriage, getProposal, propose, PROPOSAL_TTL_MS, type Proposal } from '../../services/marriage';
import { kissStats } from '../../services/social';
import { row, type App, type Panel } from '../app';
import type { Handler } from '../handlers/util';
import { update } from '../handlers/util';
import { logSystem } from '../logging/sender';
import { syncRewardRoles } from '../roleSafety';
import { cid } from '../ui/ids';
import { COLORS, clean, num } from '../ui/theme';
import type { Command, CommandContext } from './types';

const langOf = (app: App, guildId: string): Lang => getSettings(app.ctx, guildId).lang;
const date = (ms: number, style = 'd') => `<t:${Math.floor(ms / 1000)}:${style}>`;

async function nameOf(app: App, guild: Guild, id: string): Promise<string> {
  const m = guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
  if (m) return m.displayName;
  const u = await app.client.users.fetch(id).catch(() => null);
  return u ? u.globalName ?? u.username : `#${id.slice(-4)}`;
}

// ───────────────────────── !profile ─────────────────────────

/** Tarjeta de perfil: nivel, puesto, estadísticas, billetera y matrimonio. */
export async function profileCard(app: App, guild: Guild, viewerId: string, target: { id: string; name: string; avatar: string }): Promise<Panel> {
  const ctx = app.ctx;
  const L = langOf(app, guild.id);
  ensureCasinoUser(ctx, target.id);
  const u = getCasinoUser(ctx, target.id)!;
  const lp = levelProgress(u.totalWagered);
  const rank = rankFor(lp.level);
  const pos = rankOf(ctx, 'richest', target.id);
  const kisses = kissStats(ctx, guild.id, target.id);
  const ach = unlockedAchievements(ctx, target.id).size;
  const work = workStatus(ctx, target.id);
  const m = getMarriage(ctx, target.id);
  const levelLine = lp.level >= MAX_LEVEL
    ? `**${lp.level}** (MAX)`
    : `**${lp.level}** (${num(u.totalWagered - lp.from)}/${num(lp.to - lp.from)})`;
  const e = new EmbedBuilder()
    .setColor(rank.color)
    .setTitle(`@${target.name}`)
    .setThumbnail(target.avatar)
    .setDescription([
      `⭐ **${t(L, 'profile.level')}:** ${levelLine}`,
      `${rank.emoji} **${rank.name}** · 👑 ${pos.rank ? t(L, 'profile.richest', { rank: num(pos.rank) }) : t(L, 'profile.unranked')}`,
    ].join('\n'))
    .addFields(
      {
        name: t(L, 'profile.stats'),
        value: [
          `💋 **${t(L, 'profile.kissesGiven')}:** ${num(kisses.given)}`,
          `💞 **${t(L, 'profile.kissesReceived')}:** ${num(kisses.received)}`,
          `🏅 **${t(L, 'profile.achievements')}:** ${ach}/${ACHIEVEMENTS.length}`,
          `🎲 **${t(L, 'profile.games')}:** ${num(u.rounds)}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: t(L, 'profile.wallet'),
        value: [
          `🪙 **${t(L, 'profile.coins')}:** ${num(u.balance)}`,
          `🧰 **${t(L, 'profile.shifts')}:** ${num(work.shifts)}`,
          `🔥 **${t(L, 'profile.streak')}:** ${num(u.dailyStreak)}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: t(L, 'profile.marriage'),
        value: m ? `💕 **${clean(await nameOf(app, guild, m.partnerId))}** · ${t(L, 'profile.since', { date: date(m.since) })}` : `💔 ${t(L, 'profile.single')}`,
      },
      { name: '​', value: `-# ${t(L, 'profile.registered', { date: date(u.createdAt) })} (${date(u.createdAt, 'R')})` },
    );
  return {
    embeds: [e],
    components: [row(new ButtonBuilder().setCustomId(cid('cl', 'tab', viewerId, target.id, 'profile')).setLabel(t(L, 'profile.casinoStats')).setEmoji('📊').setStyle(ButtonStyle.Secondary))],
  };
}

async function targetOf(c: CommandContext): Promise<{ id: string; name: string; avatar: string }> {
  const m = await c.member_('usuario', 0);
  if (m) {
    if (m.user.bot) throw new GameError(t(langOf(c.app, c.guild.id), 'profile.bot'));
    return { id: m.id, name: m.displayName, avatar: m.displayAvatarURL({ size: 256 }) };
  }
  const u = c.interaction ? null : await c.user_('usuario', 0);
  if (u && !u.bot) return { id: u.id, name: u.globalName ?? u.username, avatar: u.displayAvatarURL({ size: 256 }) };
  return { id: c.member.id, name: c.member.displayName, avatar: c.member.displayAvatarURL({ size: 256 }) };
}

export const profileCmd: Command = {
  name: 'profile',
  aliases: ['perfil', 'p', 'yo', 'nivel', 'level'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('profile').setDescription('👤 Tu perfil: nivel, puesto, estadísticas, billetera y matrimonio.')
    .addUserOption((o) => o.setName('usuario').setDescription('Ver el perfil de otra persona')),
  async run(c) {
    const target = await targetOf(c);
    await c.defer();
    // Al mirar el propio perfil se entregan las distinciones por nivel que falten.
    if (target.id === c.member.id) await syncRewardRoles(c.app.ctx, c.member);
    await c.reply(await profileCard(c.app, c.guild, c.member.id, target));
  },
};

// ───────────────────────── !marry / !divorce ─────────────────────────

async function proposalPanel(app: App, guild: Guild, p: Proposal): Promise<Panel> {
  const L = langOf(app, guild.id);
  const [proposer, target] = [`<@${p.proposerId}>`, `<@${p.targetId}>`];
  const pName = clean(await nameOf(app, guild, p.proposerId));
  const tName = clean(await nameOf(app, guild, p.targetId));
  const e = new EmbedBuilder().setColor(0xff6fa8).setTitle(t(L, 'marry.title'));
  if (p.status === 'open') {
    e.setDescription(`${t(L, 'marry.ask', { proposer, target })}\n\n-# ${t(L, 'marry.expires', { when: date(p.createdAt + PROPOSAL_TTL_MS, 'R') })}`);
    return {
      embeds: [e],
      components: [row(
        new ButtonBuilder().setCustomId(cid('mr', 'yes', '0', p.id)).setLabel(t(L, 'marry.accept')).setEmoji('💍').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(cid('mr', 'no', '0', p.id)).setLabel(t(L, 'marry.reject')).setEmoji('💔').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(cid('mr', 'cancel', '0', p.id)).setLabel(t(L, 'marry.cancel')).setStyle(ButtonStyle.Secondary),
      )],
    };
  }
  const text = p.status === 'accepted' ? t(L, 'marry.accepted', { a: `**${pName}**`, b: `**${tName}**` })
    : p.status === 'rejected' ? t(L, 'marry.rejected', { target: `**${tName}**`, proposer: `**${pName}**` })
      : p.status === 'cancelled' ? t(L, 'marry.cancelled', { proposer: `**${pName}**` })
        : `⌛ ${t(L, 'marry.expires', { when: date(p.createdAt + PROPOSAL_TTL_MS, 'R') })}`;
  e.setColor(p.status === 'accepted' ? COLORS.win : COLORS.push).setDescription(text);
  return { embeds: [e], components: [] };
}

export const marryCmd: Command = {
  name: 'marry',
  aliases: ['casarse', 'casar', 'proponer', 'matrimonio'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('marry').setDescription('💍 Proponele casamiento a alguien (o mirá con quién estás casado/a).')
    .addUserOption((o) => o.setName('usuario').setDescription('A quién proponerle casamiento')),
  async run(c) {
    const L = langOf(c.app, c.guild.id);
    const target = await c.member_('usuario', 0);
    if (!target) {
      const m = getMarriage(c.app.ctx, c.member.id);
      const who = `**${clean(c.member.displayName)}**`;
      const text = m
        ? t(L, 'marry.status', { user: who, partner: clean(await nameOf(c.app, c.guild, m.partnerId)), since: t(L, 'profile.since', { date: date(m.since) }) })
        : `${t(L, 'marry.single', { user: who })}\n-# ${t(L, 'marry.usage', { p: c.prefix })}`;
      await c.reply({ embeds: [new EmbedBuilder().setColor(0xff6fa8).setDescription(text)] });
      return;
    }
    if (target.user.bot) throw new GameError(t(L, 'marry.bot'));
    const p = propose(c.app.ctx, c.guild.id, c.member.id, target.id);
    await c.defer();
    // La mención de la persona sí suena: es a quien se le pregunta.
    const panel = await proposalPanel(c.app, c.guild, p);
    if (c.message) await c.message.reply({ ...panel, content: `<@${target.id}>`, allowedMentions: { users: [target.id], repliedUser: false } });
    else await c.reply(panel);
  },
};

export const divorceCmd: Command = {
  name: 'divorce',
  aliases: ['divorcio', 'divorciarse'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('divorce').setDescription('💔 Divorciarte de tu pareja.'),
  async run(c) {
    const L = langOf(c.app, c.guild.id);
    const m = getMarriage(c.app.ctx, c.member.id);
    if (!m) throw new GameError(t(L, 'marry.single', { user: `**${clean(c.member.displayName)}**` }));
    const partner = clean(await nameOf(c.app, c.guild, m.partnerId));
    await c.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.warn).setDescription(t(L, 'divorce.confirm', { partner }))],
      components: [row(
        new ButtonBuilder().setCustomId(cid('mr', 'div', c.member.id)).setLabel(t(L, 'divorce.yes')).setEmoji('💔').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(cid('mr', 'keep', c.member.id)).setLabel(t(L, 'marry.cancel')).setStyle(ButtonStyle.Secondary),
      )],
    });
  },
};

export const marryHandler: Handler = async (app, i, id) => {
  const ctx = app.ctx;
  const L = langOf(app, i.guildId);
  if (id.act === 'div') {
    const m = divorce(ctx, i.user.id);
    await update(i, { embeds: [new EmbedBuilder().setColor(COLORS.push).setDescription(t(L, 'divorce.done', { partner: clean(await nameOf(app, i.guild, m.partnerId)) }))], components: [] });
    return;
  }
  if (id.act === 'keep') {
    await update(i, { embeds: [new EmbedBuilder().setColor(COLORS.ok).setDescription('💕')], components: [] });
    return;
  }
  const proposalId = Number(id.args[0]);
  const p = getProposal(ctx, proposalId);
  if (!p || p.guildId !== i.guildId) throw new GameError('Esa propuesta ya no existe.');
  if (id.act === 'cancel') {
    if (i.user.id !== p.proposerId) throw new GameError('Solo quien hizo la propuesta puede retirarla.');
    cancelProposal(ctx, proposalId, i.user.id);
  } else if (id.act === 'yes' || id.act === 'no') {
    try {
      answerProposal(ctx, proposalId, i.user.id, id.act === 'yes');
    } catch (err) {
      // Si venció o ya se respondió, el mensaje se actualiza igual para que no queden botones colgados.
      const now = getProposal(ctx, proposalId);
      if (now && now.status !== 'open' && i.isMessageComponent()) await i.message.edit({ ...(await proposalPanel(app, i.guild, now)), allowedMentions: { parse: [] } }).catch(() => undefined);
      throw err;
    }
  } else throw new GameError(t(L, 'common.unknown'));
  await update(i, await proposalPanel(app, i.guild, getProposal(ctx, proposalId)!));
};

// ───────────────────────── !setlang ─────────────────────────

export const setlangCmd: Command = {
  name: 'setlang',
  aliases: ['idioma', 'language', 'lang'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('setlang').setDescription('🌐 Idioma del bot en este servidor / Bot language in this server.')
    .addStringOption((o) => o.setName('idioma').setDescription('es = Español, en = English').addChoices({ name: 'Español', value: 'es' }, { name: 'English', value: 'en' })),
  async run(c) {
    const raw = c.str('idioma', 0);
    const current = langOf(c.app, c.guild.id);
    if (!raw) {
      await c.reply({ content: `${t(current, 'lang.current', { lang: LANGUAGES[current], p: c.prefix })}` });
      return;
    }
    if (!c.member.permissions.has(PermissionFlagsBits.ManageGuild)) throw new GameError(t(current, 'common.needManageGuild'));
    const lang = setLanguage(c.app.ctx, c.guild.id, raw);
    await c.reply({ content: `${t(lang, 'lang.set')}\n${t(lang, 'lang.partial')}` });
    await logSystem(c.app.ctx, c.guild, `🌐 <@${c.member.id}> cambió el idioma del bot a **${LANGUAGES[lang]}**.`);
  },
};

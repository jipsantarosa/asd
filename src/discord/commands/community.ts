import { EmbedBuilder, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder, type GuildTextBasedChannel, type Message } from 'discord.js';
import { GameError } from '../../services/context';
import { kiss } from '../../services/social';
import { logView } from '../../services/historyViews';
import { logSystem } from '../logging/sender';
import { randomKissGif } from '../fun/kissGif';
import { PURGE_MAX, purgeUserMessages } from '../moderation/purge';
import { fetchAndRecord } from '../tracking/userMedia';
import { mediaPanel } from '../ui/mediaPanels';
import { kissButtons, kissEmbed } from '../ui/kissPanels';
import { COLORS } from '../ui/theme';
import type { Command, CommandContext } from './types';


function channelOf(c: CommandContext): GuildTextBasedChannel {
  const ch = c.interaction?.channel ?? c.message?.channel;
  if (!ch || !ch.isTextBased() || !('bulkDelete' in ch)) throw new GameError('Este comando solo funciona en canales de texto del servidor.');
  return ch as GuildTextBasedChannel;
}

// ───────────────────────── !m @usuario 1000 ─────────────────────────

export function botCanPurge(channel: GuildTextBasedChannel): string | null {
  const me = channel.guild.members.me;
  if (!me) return 'No pude verificar mis permisos.';
  const perms = channel.permissionsFor(me);
  const missing: string[] = [];
  if (!perms.has(PermissionFlagsBits.ViewChannel)) missing.push('Ver canal');
  if (!perms.has(PermissionFlagsBits.ReadMessageHistory)) missing.push('Leer el historial de mensajes');
  if (!perms.has(PermissionFlagsBits.ManageMessages)) missing.push('Gestionar mensajes');
  return missing.length ? `Me falta el permiso **${missing.join('**, **')}** en <#${channel.id}>.` : null;
}


export const purgar: Command = {
  name: 'purgar',
  aliases: ['m', 'c', 'clear', 'purge', 'limpiar'],
  prefix: true,
  permission: PermissionFlagsBits.ManageMessages,
  permissionName: 'Gestionar mensajes',
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('purgar')
    .setDescription('Borra los mensajes recientes de un usuario en este canal (máx. 1000, menos de 14 días).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addUserOption((o) => o.setName('usuario').setDescription('De quién borrar los mensajes').setRequired(true))
    .addIntegerOption((o) => o.setName('cantidad').setDescription('Cuántos mensajes (1–1000)').setMinValue(1).setMaxValue(PURGE_MAX).setRequired(true)),
  async run(c) {
    const target = await c.user_('usuario', 0);
    if (!target) throw new GameError(`Uso: \`${c.prefix}m @usuario 100\` (hasta ${PURGE_MAX}).`);
    const raw = c.interaction ? c.interaction.options.getInteger('cantidad') : Number((c.args[1] ?? '').replace(/\./g, ''));
    const amount = Number(raw);
    if (!Number.isInteger(amount) || amount < 1 || amount > PURGE_MAX) throw new GameError(`La cantidad tiene que ser un número entre 1 y ${PURGE_MAX}.`);

    const channel = channelOf(c);
    // Permisos del moderador en ESTE canal (no solo a nivel servidor).
    if (!channel.permissionsFor(c.member).has(PermissionFlagsBits.ManageMessages)) throw new GameError(`No tenés **Gestionar mensajes** en <#${channel.id}>.`);
    const botProblem = botCanPurge(channel);
    if (botProblem) throw new GameError(botProblem);
    // Jerarquía: no se pueden limpiar mensajes de alguien con un rol igual o más alto (salvo el dueño del servidor).
    const targetMember = await c.guild.members.fetch(target.id).catch(() => null);
    if (targetMember && target.id !== c.member.id && c.guild.ownerId !== c.member.id
      && targetMember.roles.highest.comparePositionTo(c.member.roles.highest) >= 0) {
      throw new GameError('No podés borrar mensajes de alguien con un rol igual o superior al tuyo.');
    }

    // Aviso de progreso ("Buscando mensajes…") que después se reemplaza por el resultado.
    const progress = new EmbedBuilder().setColor(0xe0418a).setDescription(`🔍 Buscando mensajes de ${target} en <#${channel.id}>…`);
    let progressMsg: Message | null = null;
    if (c.interaction) {
      await c.defer(true);
      await c.interaction.editReply({ embeds: [progress] });
    } else if (c.message) {
      progressMsg = await c.message.reply({ embeds: [progress], allowedMentions: { parse: [], repliedUser: false } }).catch(() => null);
    }
    const skip = new Set([c.message?.id, progressMsg?.id].filter((x): x is string => !!x));
    const run = await c.app.guildLock.run(`purge:${channel.id}`, () => purgeUserMessages(channel, target.id, amount, skip));
    if (!run.ran) {
      const busy = new EmbedBuilder().setColor(COLORS.warn).setDescription('⏳ Ya hay una limpieza en curso en este canal. Esperá a que termine.');
      if (c.interaction) await c.interaction.editReply({ embeds: [busy] });
      else if (progressMsg) await progressMsg.edit({ embeds: [busy] }).catch(() => undefined);
      return;
    }
    const r = run.value;

    const lines = [
      `🧹 Listo: borré **${r.deleted}** ${r.deleted === 1 ? 'mensaje' : 'mensajes'} de ${target} en <#${channel.id}>.`,
      r.deleted < amount && r.tooOld ? `⏳ ${r.tooOld} ${r.tooOld === 1 ? 'mensaje tiene' : 'mensajes tienen'} más de 14 días: Discord no permite borrarlos en bloque.` : '',
      r.deleted < amount && !r.tooOld ? `-# No había más mensajes suyos entre los ${r.scanned.toLocaleString('es-AR')} revisados${r.stoppedByAge ? ' (el resto tiene más de 14 días)' : ''}.` : '',
    ].filter(Boolean).join('\n');
    const done = new EmbedBuilder().setColor(r.deleted ? COLORS.ok : COLORS.warn).setDescription(lines);
    await logSystem(c.app.ctx, c.guild, `🧹 <@${c.member.id}> borró ${r.deleted} mensajes de <@${target.id}> en <#${channel.id}> (pedidos: ${amount}, revisados: ${r.scanned}).`, COLORS.warn);

    if (c.interaction) {
      await c.interaction.editReply({ embeds: [done] });
    } else {
      // Por prefijo: se borra el comando y el resultado desaparece solo a los 10 s.
      await c.message?.delete().catch(() => undefined);
      const note = progressMsg
        ? await progressMsg.edit({ embeds: [done] }).catch(() => null)
        : await channel.send({ embeds: [done], allowedMentions: { parse: [] } }).catch(() => null);
      if (note) setTimeout(() => void note.delete().catch(() => undefined), 10_000).unref();
    }
  },
};

// ───────────────────────── !avs y !banners ─────────────────────────

function mediaCommand(kind: 'avatar' | 'banner'): Command {
  const isAvatar = kind === 'avatar';
  return {
    name: isAvatar ? 'avatares' : 'banners',
    aliases: isAvatar ? ['avs', 'avatars', 'avatar', 'av'] : ['bns', 'banner', 'bn'],
    prefix: true,
    data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName(isAvatar ? 'avatares' : 'banners')
      .setDescription(isAvatar ? 'Avatar actual e historial de avatares detectados por el bot.' : 'Banner actual e historial de banners detectados por el bot.')
      .addUserOption((o) => o.setName('usuario').setDescription('De quién (por defecto, vos)')),
    async run(c) {
      const who = (await c.user_('usuario', 0)) ?? c.member.user;
      // Pide el usuario completo (el banner solo llega así) y registra lo que haya ahora.
      const user = await fetchAndRecord(c.app, who.id, c.guild.id);
      if (!user) throw new GameError('No encontré a ese usuario.');
      // Cuenta para !mstats de esa persona (salvo que te mires a vos o tengas !ghostmode).
      logView(c.app.ctx, c.member.id, user.id, kind, c.guild.id);
      // Armar el collage puede tardar unos segundos (descarga las miniaturas): se avisa primero.
      await c.defer();
      await c.reply(await mediaPanel(c.app.ctx, c.member.id, user, kind, 'collage', isAvatar ? user.avatar : user.banner ?? null));
    },
  };
}

export const avatares = mediaCommand('avatar');
export const banners = mediaCommand('banner');

// ───────────────────────── !kiss @usuario ─────────────────────────

export const kissCmd: Command = {
  name: 'kiss',
  aliases: ['beso', 'besar'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('kiss').setDescription('Dale un beso a alguien 💋')
    .addUserOption((o) => o.setName('usuario').setDescription('A quién besar').setRequired(true)),
  async run(c) {
    const target = await c.member_('usuario', 0);
    if (!target) throw new GameError(`Uso: \`${c.prefix}kiss @usuario\``);
    if (target.user.bot) throw new GameError('Los bots no pueden recibir besos… todavía. 🤖');
    // Primero se cuenta (atómico, con cooldown) y después se busca el GIF: si la API de GIFs falla, el beso igual cuenta.
    const r = kiss(c.app.ctx, c.guild.id, c.member.id, target.id);
    if (c.interaction) await c.defer();
    const gif = await randomKissGif();
    await c.reply({
      embeds: [kissEmbed({ authorName: c.member.displayName, targetName: target.displayName, authorId: c.member.id, targetId: target.id, result: r, gif })],
      components: [kissButtons(c.member.id, target.id)],
    });
  },
};

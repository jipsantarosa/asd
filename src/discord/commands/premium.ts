import { ButtonBuilder, ButtonStyle, EmbedBuilder, InteractionContextType, PermissionFlagsBits, Routes, SlashCommandBuilder } from 'discord.js';
import { GameError } from '../../services/context';
import { logView, viewStats } from '../../services/historyViews';
import {
  FEATURE_TIER, TIERS, getPremium, grantPremium, isGhost, listPremium, requireTier, revokePremium, setBotSlots, setGhost, type PremiumTier,
} from '../../services/premium';
import { hideViewsOf } from '../../services/historyViews';
import { row } from '../app';
import { isOwner } from '../owner';
import { fetchAndRecord, serverTag } from '../tracking/userMedia';
import { cid } from '../ui/ids';
import { namesEmbed, tagsEmbed } from '../ui/namesPanel';
import type { Command, CommandContext } from './types';
import { AUTOPLAY_INTERVAL_MS, getAutoplay, setAutoplay } from '../../services/autoplay';

const ACCENT = 0xe0418a;
const VIEW_LABEL = { avatar: '🖼️ avatares', banner: '🎏 banners', names: '🪪 nombres', tags: '🏷️ tags' } as const;

function tierLine(t: PremiumTier): string {
  return `${TIERS[t].emoji} **${TIERS[t].name}**`;
}

export function premiumBadge(tier: number): string {
  return tier ? ` (VIP ${TIERS[tier as PremiumTier].emoji})` : '';
}

// ───────────────────────── !premium (dar / quitar / ver / lista) ─────────────────────────

export const premiumCmd: Command = {
  name: 'premium',
  aliases: ['vip'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('premium').setDescription('Premium del bot: ver tu nivel (el dueño del bot puede darlo o quitarlo).')
    .addStringOption((o) => o.setName('accion').setDescription('Qué hacer').addChoices(
      { name: 'ver', value: 'ver' }, { name: 'dar (dueño)', value: 'dar' }, { name: 'quitar (dueño)', value: 'quitar' }, { name: 'lista (dueño)', value: 'lista' },
      { name: 'servidores de !botperfil (dueño; la cantidad va en "dias")', value: 'servidores' }))
    .addUserOption((o) => o.setName('usuario').setDescription('A quién'))
    .addIntegerOption((o) => o.setName('nivel').setDescription('Nivel 1 a 4').setMinValue(1).setMaxValue(4))
    .addIntegerOption((o) => o.setName('dias').setDescription('Duración en días (vacío = sin vencimiento)').setMinValue(1).setMaxValue(3650)),
  async run(c) {
    const ctx = c.app.ctx;
    let action = (c.interaction ? c.interaction.options.getString('accion') : c.args[0]?.toLowerCase()) ?? 'ver';
    if (/^<@!?\d+>$|^\d{17,20}$/.test(action)) action = 'ver';
    const userIdx = c.interaction ? 0 : /^<@!?\d+>$|^\d{17,20}$/.test(c.args[0] ?? '') ? 0 : 1;
    const ownerOnly = () => {
      if (!isOwner(c.member.id)) throw new GameError('🔒 Solo el dueño del bot puede dar o quitar premium.');
    };

    if (action === 'dar' || action === 'give') {
      ownerOnly();
      const user = await c.user_('usuario', 1);
      const tier = c.interaction ? c.interaction.options.getInteger('nivel') : Number(c.args[2]);
      const daysRaw = c.interaction ? c.interaction.options.getInteger('dias') : c.args[3] ? Number(c.args[3]) : null;
      if (!user || !tier) throw new GameError(`Uso: \`${c.prefix}premium dar @usuario <1-4> [días]\``);
      if (user.bot) throw new GameError('Los bots no pueden tener premium.');
      const p = grantPremium(ctx, user.id, Number(tier), c.member.id, daysRaw ?? null);
      await c.reply({ embeds: [new EmbedBuilder().setColor(ACCENT).setDescription(
        `✅ ${user} ahora tiene ${tierLine(p.tier)}${p.expires_at ? ` hasta <t:${Math.floor(p.expires_at / 1000)}:f>` : ' (sin vencimiento)'}.`)] }, { ephemeral: true });
      return;
    }
    if (action === 'servidores' || action === 'slots') {
      ownerOnly();
      const user = await c.user_('usuario', 1);
      const n = c.interaction ? c.interaction.options.getInteger('dias') : Number(c.args[2]);
      if (!user || !n) throw new GameError(`Uso: \`${c.prefix}premium servidores @usuario <cantidad>\` (cuántos servidores puede personalizar con !botperfil).`);
      setBotSlots(ctx, user.id, Number(n));
      await c.reply({ content: `🔮 ${user} ahora puede personalizar el bot en **${n}** servidores.` }, { ephemeral: true });
      return;
    }
    if (action === 'quitar' || action === 'remove') {
      ownerOnly();
      const user = await c.user_('usuario', 1);
      if (!user) throw new GameError(`Uso: \`${c.prefix}premium quitar @usuario\``);
      const ok = revokePremium(ctx, user.id);
      await c.reply({ content: ok ? `🗑️ Le quité el premium a ${user}.` : `${user} no tenía premium.` }, { ephemeral: true });
      return;
    }
    if (action === 'lista' || action === 'list') {
      ownerOnly();
      const all = listPremium(ctx);
      const lines = all.slice(0, 40).map((p) => `${tierLine(p.tier)} — <@${p.user_id}>${p.expires_at ? ` · vence <t:${Math.floor(p.expires_at / 1000)}:R>` : ''}`);
      await c.reply({ embeds: [new EmbedBuilder().setColor(ACCENT).setTitle(`💎 Usuarios premium (${all.length})`).setDescription(lines.join('\n') || '*Nadie todavía.*')] }, { ephemeral: true });
      return;
    }

    // ver: el tuyo o el de otra persona, más la tabla de niveles.
    const target = (await c.user_('usuario', userIdx)) ?? c.member.user;
    const p = getPremium(ctx, target.id);
    const perks = ([1, 2, 3, 4] as PremiumTier[]).map((t) => `${tierLine(t)}${p && p.tier >= t ? ' ✅' : ''}\n-# ${TIERS[t].perks.join(' · ')}`).join('\n');
    await c.reply({ embeds: [new EmbedBuilder().setColor(ACCENT)
      .setAuthor({ name: `Premium de ${target.displayName ?? target.username}`, iconURL: target.displayAvatarURL({ size: 64 }) })
      .setDescription([
        p ? `Nivel actual: ${tierLine(p.tier)}${p.expires_at ? ` · vence <t:${Math.floor(p.expires_at / 1000)}:R>` : ''}${p.tier >= 4 ? ` · !botperfil en ${p.bot_slots} servidores` : ''}` : 'Sin premium. Lo da el dueño del bot.',
        '-# Vale en todos los servidores donde esté el bot.',
        '',
        perks,
        '',
        '-# Cada nivel incluye todo lo del anterior.',
      ].join('\n'))] });
  },
};

// ───────────────────────── !names (gratis) y !tags (Tier 1) ─────────────────────────

export const namesCmd: Command = {
  name: 'names',
  aliases: ['nombres', 'nicks', 'nms'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('names').setDescription('Historial de nombres (usuario, nombre visible y apodos) detectado por el bot.')
    .addUserOption((o) => o.setName('usuario').setDescription('De quién (por defecto, vos)')),
  async run(c) {
    const who = (await c.user_('usuario', 0)) ?? c.member.user;
    const user = await fetchAndRecord(c.app, who.id, c.guild.id);
    if (!user) throw new GameError('No encontré a ese usuario.');
    logView(c.app.ctx, c.member.id, user.id, 'names', c.guild.id);
    await c.reply({ embeds: [namesEmbed(c.app.ctx, user, c.guild)] });
  },
};

export const tagsCmd: Command = {
  name: 'tags',
  aliases: ['tag', 'clanes'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('tags').setDescription('Historial de tags de servidor de un usuario (Premium Tier 1).')
    .addUserOption((o) => o.setName('usuario').setDescription('De quién (por defecto, vos)')),
  async run(c) {
    requireTier(c.app.ctx, c.member.id, FEATURE_TIER.tags, '!tags');
    const who = (await c.user_('usuario', 0)) ?? c.member.user;
    const user = await fetchAndRecord(c.app, who.id, c.guild.id);
    if (!user) throw new GameError('No encontré a ese usuario.');
    logView(c.app.ctx, c.member.id, user.id, 'tags', c.guild.id);
    const name = (id: string) => c.app.client.guilds.cache.get(id)?.name ?? null;
    await c.reply({ embeds: [tagsEmbed(c.app.ctx, user, name, serverTag(user)?.tag ?? null)] });
  },
};

// ───────────────────────── limpiezas (con confirmación) ─────────────────────────

export type ClearKind = 'avatars' | 'names' | 'tags';
const CLEAR: Record<ClearKind, { cmd: string; tier: PremiumTier; label: string }> = {
  avatars: { cmd: '!clearavatars', tier: FEATURE_TIER.clearavatars, label: 'avatares y banners' },
  names: { cmd: '!clearnames', tier: FEATURE_TIER.clearnames, label: 'nombres y apodos' },
  tags: { cmd: '!cleartags', tier: FEATURE_TIER.cleartags, label: 'tags de servidor' },
};

export function clearInfo(kind: ClearKind) {
  return CLEAR[kind];
}

function clearCommand(kind: ClearKind, name: string, aliases: string[]): Command {
  const info = CLEAR[kind];
  return {
    name,
    aliases,
    prefix: true,
    data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName(name)
      .setDescription(`Borra tu historial de ${info.label} (Premium ${TIERS[info.tier].name}).`),
    async run(c: CommandContext) {
      requireTier(c.app.ctx, c.member.id, info.tier, info.cmd);
      await c.reply({
        embeds: [new EmbedBuilder().setColor(0xed4245).setDescription(`🗑️ ¿Borrar **todo** tu historial de ${info.label}?\nNo se puede deshacer. Lo actual se vuelve a registrar como único.`)],
        components: [row(
          new ButtonBuilder().setCustomId(cid('pr', 'clear', c.member.id, kind)).setLabel('Sí, borrar').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(cid('pr', 'cancel', c.member.id)).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
        )],
      }, { ephemeral: true });
    },
  };
}

export const clearAvatarsCmd = clearCommand('avatars', 'clearavatars', ['clearavs', 'clearbanners']);
export const clearNamesCmd = clearCommand('names', 'clearnames', ['clearnicks']);
export const clearTagsCmd = clearCommand('tags', 'cleartags', ['cleartag']);

// ───────────────────────── !mstats (Tier 2 parcial / Tier 3 completo) ─────────────────────────

export const mstatsCmd: Command = {
  name: 'mstats',
  aliases: ['vistas', 'views'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('mstats').setDescription('Quién miró tus historiales (Tier 2: cantidad · Tier 3: últimas 10 personas).'),
  async run(c) {
    const p = requireTier(c.app.ctx, c.member.id, FEATURE_TIER.mstats, '!mstats');
    const s = viewStats(c.app.ctx, c.member.id);
    const full = p.tier >= FEATURE_TIER.mstatsFull;
    const e = new EmbedBuilder().setColor(ACCENT)
      .setAuthor({ name: `Vistas a los historiales de ${c.member.displayName}`, iconURL: c.member.displayAvatarURL({ size: 64 }) })
      .setDescription(`👀 **${s.people}** ${s.people === 1 ? 'persona miró' : 'personas miraron'} tus historiales (${s.total} ${s.total === 1 ? 'vez' : 'veces'}).`)
      .addFields({ name: 'Por historial', value: (Object.keys(VIEW_LABEL) as (keyof typeof VIEW_LABEL)[]).map((k) => `${VIEW_LABEL[k]}: **${s.byKind[k]}**`).join(' · ') });
    if (full) {
      e.addFields({ name: 'Últimas 10 personas', value: s.recent.map((r) => `• <@${r.viewerId}> — ${VIEW_LABEL[r.kind]} <t:${Math.floor(r.viewedAt / 1000)}:R>`).join('\n') || '*Nadie todavía.*' });
    } else {
      e.addFields({ name: 'Últimas 10 personas', value: `🔒 Con ${tierLine(3)} ves quiénes fueron.` });
    }
    e.setFooter({ text: 'Quienes usan !ghostmode (Tier 4) no aparecen. Mirarte a vos mismo no cuenta.' });
    await c.reply({ embeds: [e] }, { ephemeral: true });
  },
};

// ───────────────────────── !ghostmode (Tier 4) ─────────────────────────

export const ghostCmd: Command = {
  name: 'ghostmode',
  aliases: ['ghost', 'fantasma'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('ghostmode').setDescription('Oculta tus vistas a historiales ajenos (Premium Tier 4).')
    .addBooleanOption((o) => o.setName('activo').setDescription('Activar o desactivar (por defecto, alterna)')),
  async run(c) {
    const ctx = c.app.ctx;
    requireTier(ctx, c.member.id, FEATURE_TIER.ghostmode, '!ghostmode');
    const raw = c.interaction ? c.interaction.options.getBoolean('activo') : c.args[0] ? ['on', 'si', 'sí', 'activar', '1'].includes(c.args[0].toLowerCase()) : null;
    const on = setGhost(ctx, c.member.id, raw ?? !isGhost(ctx, c.member.id));
    // Al activarlo, también desaparecen las vistas que ya habías dejado.
    const hidden = on ? hideViewsOf(ctx, c.member.id) : 0;
    await c.reply({ embeds: [new EmbedBuilder().setColor(on ? 0x2b2d31 : ACCENT).setDescription(on
      ? `👻 **Modo fantasma activado.** Tus vistas a historiales ajenos no se registran${hidden ? ` (y borré ${hidden} vista${hidden === 1 ? '' : 's'} anterior${hidden === 1 ? '' : 'es'})` : ''}.`
      : '👁️ Modo fantasma desactivado. Tus vistas vuelven a registrarse.')] }, { ephemeral: true });
  },
};

// ───────────────────────── !botperfil (Tier 4) ─────────────────────────

/** Servidores por defecto para !botperfil (el dueño lo cambia por persona con !premium servidores). */
export const BOT_PROFILE_SLOTS = 3;
const IMG_TYPES = /^image\/(png|jpeg|gif|webp)$/;

async function imageDataUri(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) throw new GameError('No pude descargar la imagen.');
  const type = res.headers.get('content-type')?.split(';')[0] ?? '';
  if (!IMG_TYPES.test(type)) throw new GameError('La imagen tiene que ser PNG, JPG, GIF o WEBP.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 8_000_000) throw new GameError('La imagen pesa demasiado (máx. 8 MB).');
  return `data:${type};base64,${buf.toString('base64')}`;
}

export const botProfileCmd: Command = {
  name: 'botperfil',
  aliases: ['botprofile', 'perfilbot'],
  prefix: true,
  permission: PermissionFlagsBits.ManageGuild,
  permissionName: 'Gestionar servidor',
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('botperfil').setDescription('Cambia el apodo, avatar o banner del bot en este servidor (Premium Tier 4).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('que').setDescription('Qué cambiar').setRequired(true).addChoices(
      { name: 'nombre', value: 'nombre' }, { name: 'avatar', value: 'avatar' }, { name: 'banner', value: 'banner' },
      { name: 'restablecer todo', value: 'reset' }, { name: 'ver mis servidores', value: 'ver' }))
    .addStringOption((o) => o.setName('nombre').setDescription('Nuevo apodo del bot').setMaxLength(32))
    .addAttachmentOption((o) => o.setName('imagen').setDescription('Imagen para avatar o banner')),
  async run(c) {
    const ctx = c.app.ctx;
    const prem = requireTier(ctx, c.member.id, FEATURE_TIER.botprofile, '!botperfil');
    const maxSlots = prem.bot_slots ?? BOT_PROFILE_SLOTS;
    const what = (c.interaction ? c.interaction.options.getString('que') : c.args[0]?.toLowerCase()) ?? 'ver';
    const slots = ctx.db.all<{ guild_id: string }>('SELECT guild_id FROM bot_profile_slots WHERE user_id = ?', c.member.id).map((r) => r.guild_id);

    if (what === 'ver') {
      const names = slots.map((g) => `• ${c.app.client.guilds.cache.get(g)?.name ?? g}`).join('\n') || '*Ninguno todavía.*';
      await c.reply({ content: `🔮 Personalizaste el bot en **${slots.length}/${maxSlots}** servidores:\n${names}\n-# Uso: \`${c.prefix}botperfil nombre <texto>\`, \`${c.prefix}botperfil avatar\` (adjuntá una imagen), \`${c.prefix}botperfil banner\`, \`${c.prefix}botperfil reset\`.` }, { ephemeral: true });
      return;
    }

    const owner = ctx.db.get<{ user_id: string }>('SELECT user_id FROM bot_profile_slots WHERE guild_id = ?', c.guild.id)?.user_id;
    if (owner && owner !== c.member.id) throw new GameError(`El perfil del bot en este servidor ya lo personaliza <@${owner}>.`);
    if (!owner && slots.length >= maxSlots) throw new GameError(`Ya usaste tus ${maxSlots} servidores. Liberá uno con \`${c.prefix}botperfil reset\` en ese servidor.`);

    const body: Record<string, string | null> = {};
    if (what === 'reset') {
      body.nick = null;
      body.avatar = null;
      body.banner = null;
    } else if (what === 'nombre' || what === 'name') {
      const nick = (c.interaction ? c.interaction.options.getString('nombre') : c.args.slice(1).join(' '))?.trim();
      if (!nick || nick.length > 32) throw new GameError(`Uso: \`${c.prefix}botperfil nombre <hasta 32 caracteres>\``);
      body.nick = nick;
    } else if (what === 'avatar' || what === 'banner') {
      const att = c.interaction ? c.interaction.options.getAttachment('imagen') : c.message?.attachments.first();
      const url = att?.url ?? (c.args[1] && /^https:\/\//.test(c.args[1]) ? c.args[1] : null);
      if (!url) throw new GameError(`Adjuntá una imagen al mensaje: \`${c.prefix}botperfil ${what}\` + imagen.`);
      if (c.interaction) await c.defer(true);
      body[what] = await imageDataUri(url);
    } else {
      throw new GameError(`Opciones: nombre, avatar, banner, reset, ver.`);
    }

    // Perfil del bot en este servidor (apodo, avatar y banner propios del servidor).
    await c.app.client.rest.patch(Routes.guildMember(c.guild.id, '@me'), { body, reason: `!botperfil por ${c.member.user.username}` })
      .catch((err: { message?: string }) => { throw new GameError(`Discord rechazó el cambio: ${err.message ?? 'error desconocido'}`); });
    if (what === 'reset') ctx.db.run('DELETE FROM bot_profile_slots WHERE user_id = ? AND guild_id = ?', c.member.id, c.guild.id);
    else ctx.db.run('INSERT OR IGNORE INTO bot_profile_slots (user_id, guild_id, claimed_at) VALUES (?, ?, ?)', c.member.id, c.guild.id, ctx.now());
    await c.reply({ content: what === 'reset' ? '♻️ Restablecí el perfil del bot en este servidor y liberé el lugar.' : `✅ Listo: cambié el ${what === 'nombre' || what === 'name' ? 'apodo' : what} del bot en este servidor.` }, { ephemeral: true });
  },
};

// ───────────────────────── !autoplay (Tier 2) ─────────────────────────

export const autoplayCmd: Command = {
  name: 'autoplay',
  aliases: ['auto', 'autojugar'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('autoplay').setDescription('El bot pesca y farmea por vos cada 10 minutos en este servidor (Premium Tier 2).')
    .addBooleanOption((o) => o.setName('activo').setDescription('Activar o desactivar (vacío = ver el estado)')),
  async run(c) {
    const ctx = c.app.ctx;
    const raw = c.interaction ? c.interaction.options.getBoolean('activo') : c.args[0]
      ? ['on', 'si', 'sí', 'activar', '1'].includes(c.args[0].toLowerCase()) ? true : ['off', 'no', 'desactivar', '0'].includes(c.args[0].toLowerCase()) ? false : null
      : null;
    if (raw !== null) setAutoplay(ctx, c.guild.id, c.member.id, raw);
    const a = getAutoplay(ctx, c.guild.id, c.member.id);
    const on = !!a?.enabled;
    const e = new EmbedBuilder().setColor(on ? 0x57f287 : ACCENT)
      .setAuthor({ name: `Autoplay de ${c.member.displayName}`, iconURL: c.member.displayAvatarURL({ size: 64 }) })
      .setDescription([
        on ? `🤖 **Activado** · cada ${AUTOPLAY_INTERVAL_MS / 60_000} min cosecha y pesca una vez por vos en este servidor.` : '⏸️ **Desactivado.**',
        on ? `Próximo turno <t:${Math.floor(a!.next_at / 1000)}:R>.` : '',
        a ? `\nDesde <t:${Math.floor(a.started_at / 1000)}:R>: **${a.runs}** turnos · 🌾 ${a.harvests} cosechas · 🎣 ${a.catches} peces` : '',
        a?.last_note ? `-# Último turno: ${a.last_note}` : '',
        '',
        `-# Usa tu vigor y tu carnada como si jugaras vos: si te quedás sin carnada, solo cosecha. \`${c.prefix}autoplay on\` / \`${c.prefix}autoplay off\``,
      ].filter(Boolean).join('\n'));
    await c.reply({ embeds: [e] }, { ephemeral: true });
  },
};

import { maintenanceRow } from '../setupMaintenance';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, ModalBuilder, OverwriteType, PermissionFlagsBits,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder,
  type CategoryChannel, type GuildMember, type NewsChannel, type TextChannel, type VoiceChannel,
} from 'discord.js';
import { GameError } from '../../services/context';
import {
  forgetTempChannel, getTempChannel, getVoiceConfig, removeAccess, saveVoiceConfig, saveVoiceProfile, setAccess, setTempOwner,
  validateChannelName, validateLimit, type TempChannel,
} from '../../services/tempVoice';
import type { App } from '../app';
import { row } from '../app';
import { logSystem, sendLog } from '../logging/sender';
import { cid } from '../ui/ids';
import { COLORS, clean, truncate } from '../ui/theme';
import { VOICE_ACTIONS, voiceAdminPanel, voiceInfoEmbed } from '../ui/voicePanels';
import {
  accessOptions, humans, isStaff, ownerOptions, postInterface, privacyOf, renames, setupTempVoice, withTimeout,
} from '../voice/tempVoice';
import { deferPanel, deferPrivate, field, finishPrivate, update, values, type Handler, type Ix } from './util';

const SNOWFLAKE = /^\d{17,20}$/;
const F = PermissionFlagsBits;
const PUBLIC_ACTIONS = new Set(VOICE_ACTIONS);

interface Target {
  channel: VoiceChannel;
  temp: TempChannel;
  parent: CategoryChannel | null;
  isOwner: boolean;
  staff: boolean;
}

/**
 * ¿Sobre qué canal actúa el botón?
 * - Botones de la interfaz: el canal de cuyo chat sale el panel o, si no, el canal temporal en el que estás.
 * - Menús y ventanas que abre un botón: el canal queda fijado en el customId (y se vuelve a validar).
 */
function resolveTarget(app: App, i: Ix, explicitId?: string): Target {
  const { ctx } = app;
  const guild = i.guild;
  let channelId = explicitId;
  if (!channelId) channelId = (i.channelId && getTempChannel(ctx, i.channelId) ? i.channelId : i.member.voice.channelId) ?? undefined;
  const hub = getVoiceConfig(ctx, guild.id).hubChannelId;
  const howTo = hub ? `Entrá a <#${hub}> y se crea el tuyo.` : 'Un admin tiene que activarlos con `/voz`.';
  if (!channelId) throw new GameError(`Tenés que estar en tu canal de voz temporal. ${howTo}`);
  if (!SNOWFLAKE.test(channelId)) throw new GameError('Canal inválido.');
  const temp = getTempChannel(ctx, channelId);
  if (!temp || temp.guildId !== guild.id) throw new GameError(`<#${channelId}> no es un canal temporal. ${howTo}`);
  const channel = guild.channels.cache.get(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    forgetTempChannel(ctx, channelId);
    throw new GameError('Ese canal ya no existe.');
  }
  return { channel, temp, parent: channel.parent, isOwner: temp.ownerId === i.user.id, staff: isStaff(i.member) };
}

function requireOwner(t: Target): void {
  if (t.isOwner || t.staff) return;
  const absent = !t.channel.members.has(t.temp.ownerId);
  throw new GameError(`Solo <@${t.temp.ownerId}> maneja este canal.${absent ? ' Como no está adentro, podés tocar **👑 Reclamar**.' : ''}`);
}

/** Respuesta privada con un menú (el siguiente paso de la acción). */
async function askPrivate(i: Ix, content: string, component: StringSelectMenuBuilder | UserSelectMenuBuilder | ButtonBuilder[]): Promise<void> {
  const r = Array.isArray(component) ? row(...component) : row(component);
  await i.reply({ content, components: [r], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

function memberOptions(members: GuildMember[]): StringSelectMenuOptionBuilder[] {
  return members.slice(0, 25).map((m) => new StringSelectMenuOptionBuilder().setValue(m.id)
    .setLabel(truncate(m.displayName, 100)).setDescription(truncate(`@${m.user.username}`, 100)));
}

/** Personas con permiso propio en el canal (permitidas o bloqueadas), sin contar al dueño ni al bot. */
function memberOverwrites(t: Target, kind: 'allow' | 'deny'): string[] {
  const me = t.channel.guild.members.me?.id;
  return [...t.channel.permissionOverwrites.cache.values()]
    .filter((o) => o.type === OverwriteType.Member && o.id !== t.temp.ownerId && o.id !== me && (kind === 'allow' ? o.allow : o.deny).has(F.Connect))
    .map((o) => o.id);
}

async function namedOptions(t: Target, ids: string[]): Promise<StringSelectMenuOptionBuilder[]> {
  const guild = t.channel.guild;
  const found = ids.length ? await guild.members.fetch({ user: ids.slice(0, 25) }).catch(() => null) : null;
  return ids.slice(0, 25).map((id) => {
    const m = found?.get(id) ?? guild.members.cache.get(id);
    return new StringSelectMenuOptionBuilder().setValue(id).setLabel(truncate(m?.displayName ?? `Usuario ${id}`, 100))
      .setDescription(m ? truncate(`@${m.user.username}`, 100) : 'ya no está en el servidor');
  });
}

let regionCache: { at: number; list: { id: string; name: string }[] } | null = null;
async function voiceRegions(app: App): Promise<{ id: string; name: string }[]> {
  if (regionCache && Date.now() - regionCache.at < 6 * 3_600_000) return regionCache.list;
  const all = await app.client.fetchVoiceRegions().catch(() => null);
  const list = all ? [...all.values()].filter((r) => !r.deprecated).map((r) => ({ id: r.id, name: r.name })).slice(0, 24) : [];
  if (list.length) regionCache = { at: Date.now(), list };
  return list;
}

/** Selección de usuarios del menú, sin bots ni a uno mismo. */
function pickedUsers(i: Ix): { ids: string[]; skipped: string[] } {
  if (!i.isUserSelectMenu()) return { ids: values(i).filter((v) => SNOWFLAKE.test(v)), skipped: [] };
  const ids: string[] = [];
  const skipped: string[] = [];
  for (const u of i.users.values()) {
    if (u.bot) skipped.push(`${clean(u.username)} (bot)`);
    else if (u.id === i.user.id) skipped.push('vos');
    else ids.push(u.id);
  }
  return { ids, skipped };
}

function summary(done: string, list: string[], skipped: string[]): string {
  return [list.length ? `${done} ${list.map((id) => `<@${id}>`).join(' ')}` : '', skipped.length ? `-# Sin cambios: ${skipped.join(', ')}` : '']
    .filter(Boolean).join('\n') || 'No hubo cambios.';
}

/** Pasa el canal a otra persona: permisos de dueño para la nueva, se quitan los de la anterior. */
async function changeOwner(app: App, t: Target, newOwner: GuildMember, why: 'reclamó' | 'recibió'): Promise<void> {
  const ch = t.channel;
  setTempOwner(app.ctx, ch.id, t.temp.ownerId, newOwner.id);
  await withTimeout(ch.permissionOverwrites.edit(newOwner.id, ownerOptions(ch.guild, t.parent), { type: OverwriteType.Member, reason: `Nuevo dueño del canal temporal (${why})` }));
  await ch.permissionOverwrites.delete(t.temp.ownerId, 'Ya no es dueño del canal temporal').catch(() => undefined);
  await ch.send({ content: `👑 <@${newOwner.id}> ahora maneja este canal.`, allowedMentions: { parse: [] } }).catch(() => undefined);
  await sendLog(app.ctx, ch.guild, 'voz', { embeds: [new EmbedBuilder().setColor(COLORS.log).setTimestamp()
    .setDescription(`👑 <@${newOwner.id}> ${why} el canal temporal <#${ch.id}> (antes era de <@${t.temp.ownerId}>).`)] });
}

export const voiceHandler: Handler = async (app, i, id) => {
  const { ctx } = app;
  if (id.act === 'delno') {
    await finishPrivate(i, 'Cancelado. El canal sigue como estaba.');
    return;
  }
  const explicit = PUBLIC_ACTIONS.has(id.act) ? undefined : id.args[0];
  if (!PUBLIC_ACTIONS.has(id.act) && !SNOWFLAKE.test(explicit ?? '')) throw new GameError('Este menú es de una versión anterior. Tocá el botón de nuevo.');
  const t = resolveTarget(app, i, explicit);
  const ch = t.channel;
  const guild = i.guild;
  const next = (act: string) => cid('vc', act, i.user.id, ch.id);
  const reason = `Canal temporal: ${i.user.username}`;
  // Tipo explícito: así discord.js no exige que la persona esté en caché para editar su permiso.
  const asMember = { type: OverwriteType.Member, reason };
  // Las preferencias se guardan solo cuando actúa el dueño (un moderador no cambia los ajustes de otra persona).
  const remember = t.isOwner;

  switch (id.act) {
    // ── Información ──
    case 'info': {
      const { locked, hidden } = privacyOf(ch);
      await i.reply({
        embeds: [voiceInfoEmbed({
          name: ch.name, ownerId: t.temp.ownerId, ownerPresent: ch.members.has(t.temp.ownerId), createdAt: t.temp.createdAt,
          members: humans(ch).length, limit: ch.userLimit, locked, hidden, region: ch.rtcRegion,
          trusted: memberOverwrites(t, 'allow'), blocked: memberOverwrites(t, 'deny'),
        })],
        flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
      });
      return;
    }

    // ── Nombre y límite (ventanas) ──
    case 'name': {
      requireOwner(t);
      if (!i.isButton()) return;
      const wait = renames.readyAt(ch.id, Date.now());
      if (wait) throw new GameError(`Discord solo deja renombrar un canal 2 veces cada 10 minutos. Vas a poder de nuevo <t:${Math.ceil(wait / 1000)}:R>.`);
      await i.showModal(new ModalBuilder().setCustomId(next('namesave')).setTitle('Nombre del canal').addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Nuevo nombre')
          .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(100).setValue(ch.name.slice(0, 100))),
      ));
      return;
    }
    case 'namesave': {
      requireOwner(t);
      const name = validateChannelName(field(i, 'name'));
      const wait = renames.readyAt(ch.id, Date.now());
      if (wait) throw new GameError(`Discord solo deja renombrar un canal 2 veces cada 10 minutos. Vas a poder de nuevo <t:${Math.ceil(wait / 1000)}:R>.`);
      await deferPrivate(i);
      renames.record(ch.id, Date.now());
      await withTimeout(ch.setName(name, reason));
      if (remember) saveVoiceProfile(ctx, guild.id, t.temp.ownerId, { name });
      await finishPrivate(i, `✏️ Listo: el canal ahora se llama **${clean(name)}**.${remember ? '\n-# Lo guardé para tus próximos canales.' : ''}`);
      return;
    }
    case 'limit': {
      requireOwner(t);
      if (!i.isButton()) return;
      await i.showModal(new ModalBuilder().setCustomId(next('limitsave')).setTitle('Límite de personas').addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('limit').setLabel('Cantidad máxima (0 = sin límite, hasta 99)')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2).setValue(String(ch.userLimit))),
      ));
      return;
    }
    case 'limitsave': {
      requireOwner(t);
      const n = validateLimit(field(i, 'limit'));
      await deferPrivate(i);
      await withTimeout(ch.setUserLimit(n, reason));
      if (remember) saveVoiceProfile(ctx, guild.id, t.temp.ownerId, { limit: n });
      await finishPrivate(i, n ? `👥 Límite: **${n}** ${n === 1 ? 'persona' : 'personas'}.` : '👥 Sin límite de personas.');
      return;
    }

    // ── Privacidad (alternan) ──
    case 'lock': {
      requireOwner(t);
      await deferPrivate(i);
      const locked = !privacyOf(ch).locked;
      await withTimeout(ch.permissionOverwrites.edit(guild.id, { Connect: locked ? false : null }, { type: OverwriteType.Role, reason }));
      if (remember) saveVoiceProfile(ctx, guild.id, t.temp.ownerId, { locked });
      await finishPrivate(i, locked
        ? '🔒 **Canal privado.** Solo entran quienes permitas con ✅ Permitir (los que ya están, siguen).'
        : '🔓 **Canal abierto.** Cualquiera puede entrar.');
      return;
    }
    case 'hide': {
      requireOwner(t);
      await deferPrivate(i);
      const hidden = !privacyOf(ch).hidden;
      if (hidden) {
        // Quienes ya están adentro lo siguen viendo (si no, Discord los desconectaría).
        for (const m of humans(ch).slice(0, 25)) {
          if (m.id !== t.temp.ownerId) await ch.permissionOverwrites.edit(m.id, accessOptions(guild, t.parent), asMember).catch(() => undefined);
        }
      }
      await withTimeout(ch.permissionOverwrites.edit(guild.id, { ViewChannel: hidden ? false : null }, { type: OverwriteType.Role, reason }));
      if (remember) saveVoiceProfile(ctx, guild.id, t.temp.ownerId, { hidden });
      await finishPrivate(i, hidden
        ? '👻 **Canal oculto.** Solo lo ven quienes permitas y quienes ya están adentro.'
        : '👁️ **Canal visible** para todos.');
      return;
    }

    // ── Región ──
    case 'region': {
      requireOwner(t);
      const regions = await voiceRegions(app);
      const menu = new StringSelectMenuBuilder().setCustomId(next('regionset')).setPlaceholder('Región de voz…').addOptions(
        new StringSelectMenuOptionBuilder().setValue('auto').setLabel('Automática').setDescription('Discord elige la mejor').setEmoji('✨').setDefault(!ch.rtcRegion),
        ...regions.map((r) => new StringSelectMenuOptionBuilder().setValue(r.id).setLabel(truncate(r.name, 100)).setDefault(ch.rtcRegion === r.id)),
      );
      await askPrivate(i, '🌍 Elegí la región del servidor de voz (si hay lag o cortes, probá una más cercana):', menu);
      return;
    }
    case 'regionset': {
      requireOwner(t);
      const v = values(i)[0];
      const regions = await voiceRegions(app);
      if (v !== 'auto' && !regions.some((r) => r.id === v)) throw new GameError('Región inválida.');
      const region = v === 'auto' ? null : v;
      await deferPrivate(i);
      await withTimeout(ch.setRTCRegion(region, reason));
      if (remember) saveVoiceProfile(ctx, guild.id, t.temp.ownerId, { region });
      await finishPrivate(i, `🌍 Región: **${region ? regions.find((r) => r.id === region)?.name ?? region : 'automática'}**.`);
      return;
    }

    // ── Permitir / quitar acceso / invitar ──
    case 'trust': {
      requireOwner(t);
      await askPrivate(i, '✅ ¿A quién le permitís entrar aunque el canal sea privado u oculto?',
        new UserSelectMenuBuilder().setCustomId(next('trustset')).setPlaceholder('Elegí personas…').setMinValues(1).setMaxValues(10));
      return;
    }
    case 'trustset': {
      requireOwner(t);
      const { ids, skipped } = pickedUsers(i);
      await deferPrivate(i);
      const allowed = remember ? setAccess(ctx, guild.id, t.temp.ownerId, ids, 'trust') : { changed: ids, skipped: [] };
      skipped.push(...allowed.skipped.map((s) => `<@${s.id}> (${s.reason})`));
      for (const uid of allowed.changed) await ch.permissionOverwrites.edit(uid, accessOptions(guild, t.parent), asMember).catch(() => undefined);
      await finishPrivate(i, summary('✅ Ahora pueden entrar:', allowed.changed, skipped));
      return;
    }
    case 'untrust': {
      requireOwner(t);
      const ids = memberOverwrites(t, 'allow');
      if (!ids.length) throw new GameError('Nadie tiene acceso especial a este canal.');
      await askPrivate(i, '➖ ¿A quién le quitás el acceso especial?',
        new StringSelectMenuBuilder().setCustomId(next('untrustset')).setPlaceholder('Elegí personas…').setMinValues(1)
          .setMaxValues(Math.min(25, ids.length)).addOptions(await namedOptions(t, ids)));
      return;
    }
    case 'untrustset': {
      requireOwner(t);
      const ids = values(i).filter((v) => SNOWFLAKE.test(v) && v !== t.temp.ownerId);
      await deferPrivate(i);
      if (remember) removeAccess(ctx, guild.id, t.temp.ownerId, ids, 'trust');
      for (const uid of ids) await ch.permissionOverwrites.delete(uid, reason).catch(() => undefined);
      await finishPrivate(i, summary('➖ Ya no tienen acceso especial:', ids, []));
      return;
    }
    case 'invite': {
      requireOwner(t);
      await askPrivate(i, '📨 ¿A quién invitás? Le doy acceso a este canal y le aviso por mensaje privado.',
        new UserSelectMenuBuilder().setCustomId(next('inviteset')).setPlaceholder('Elegí personas…').setMinValues(1).setMaxValues(5));
      return;
    }
    case 'inviteset': {
      requireOwner(t);
      const { ids, skipped } = pickedUsers(i);
      await deferPrivate(i);
      const url = `https://discord.com/channels/${guild.id}/${ch.id}`;
      const dm = {
        embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(`📨 **${clean(i.member.displayName)}** te invita a su canal de voz **${clean(ch.name)}** en **${clean(guild.name)}**.`)],
        components: [row(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel('Entrar al canal').setEmoji('🎙️'))],
      };
      const noDm: string[] = [];
      for (const uid of ids) {
        await ch.permissionOverwrites.edit(uid, accessOptions(guild, t.parent), asMember).catch(() => undefined);
        const sent = await app.client.users.send(uid, dm).then(() => true).catch(() => false);
        if (!sent) noDm.push(`<@${uid}>`);
      }
      await finishPrivate(i, [summary('📨 Invitados (ya tienen acceso):', ids, skipped),
        noDm.length ? `-# No pude mandarle mensaje privado a ${noDm.join(', ')} (tiene los MD cerrados): pasale el canal vos.` : ''].filter(Boolean).join('\n'));
      return;
    }

    // ── Expulsar / bloquear / desbloquear ──
    case 'kick': {
      requireOwner(t);
      const targets = humans(ch).filter((m) => m.id !== i.user.id && m.id !== t.temp.ownerId && (t.staff || !isStaff(m)));
      if (!targets.length) throw new GameError('No hay a quién expulsar de este canal.');
      await askPrivate(i, '👢 ¿A quién sacás del canal? (puede volver a entrar; para impedirlo usá 🚫 Bloquear)',
        new StringSelectMenuBuilder().setCustomId(next('kickset')).setPlaceholder('Elegí personas…').setMinValues(1)
          .setMaxValues(Math.min(25, targets.length)).addOptions(memberOptions(targets)));
      return;
    }
    case 'kickset': {
      requireOwner(t);
      await deferPrivate(i);
      const done: string[] = [];
      const skipped: string[] = [];
      for (const uid of values(i).filter((v) => SNOWFLAKE.test(v))) {
        const m = guild.members.cache.get(uid);
        if (!m || m.voice.channelId !== ch.id) { skipped.push(`<@${uid}> (ya no está)`); continue; }
        if (m.id === t.temp.ownerId || (!t.staff && isStaff(m))) { skipped.push(`<@${uid}> (protegido)`); continue; }
        const ok = await m.voice.disconnect(reason).then(() => true).catch(() => false);
        if (ok) done.push(uid);
        else skipped.push(`<@${uid}> (no pude desconectarlo)`);
      }
      await finishPrivate(i, summary('👢 Expulsados del canal:', done, skipped));
      return;
    }
    case 'block': {
      requireOwner(t);
      await askPrivate(i, '🚫 ¿A quién bloqueás? No va a poder ver ni entrar a tus canales (si está adentro, lo saco).',
        new UserSelectMenuBuilder().setCustomId(next('blockset')).setPlaceholder('Elegí personas…').setMinValues(1).setMaxValues(10));
      return;
    }
    case 'blockset': {
      requireOwner(t);
      const { ids, skipped } = pickedUsers(i);
      await deferPrivate(i);
      const allowedIds: string[] = [];
      for (const uid of ids) {
        const m = guild.members.cache.get(uid) ?? (await guild.members.fetch(uid).catch(() => null));
        if (uid === t.temp.ownerId) skipped.push(`<@${uid}> (es el dueño)`);
        else if (m && isStaff(m)) skipped.push(`<@${uid}> (es del staff)`);
        else allowedIds.push(uid);
      }
      const res = remember ? setAccess(ctx, guild.id, t.temp.ownerId, allowedIds, 'block') : { changed: allowedIds, skipped: [] };
      skipped.push(...res.skipped.map((s) => `<@${s.id}> (${s.reason})`));
      for (const uid of res.changed) {
        await ch.permissionOverwrites.edit(uid, { ViewChannel: false, Connect: false }, asMember).catch(() => undefined);
        const m = guild.members.cache.get(uid);
        if (m?.voice.channelId === ch.id) await m.voice.disconnect(reason).catch(() => undefined);
      }
      await finishPrivate(i, summary('🚫 Bloqueados:', res.changed, skipped));
      return;
    }
    case 'unblock': {
      requireOwner(t);
      const ids = memberOverwrites(t, 'deny');
      if (!ids.length) throw new GameError('No hay nadie bloqueado en este canal.');
      await askPrivate(i, '♻️ ¿A quién desbloqueás?',
        new StringSelectMenuBuilder().setCustomId(next('unblockset')).setPlaceholder('Elegí personas…').setMinValues(1)
          .setMaxValues(Math.min(25, ids.length)).addOptions(await namedOptions(t, ids)));
      return;
    }
    case 'unblockset': {
      requireOwner(t);
      const ids = values(i).filter((v) => SNOWFLAKE.test(v));
      await deferPrivate(i);
      if (remember) removeAccess(ctx, guild.id, t.temp.ownerId, ids, 'block');
      for (const uid of ids) await ch.permissionOverwrites.delete(uid, reason).catch(() => undefined);
      await finishPrivate(i, summary('♻️ Desbloqueados:', ids, []));
      return;
    }

    // ── Dueño: reclamar y transferir ──
    case 'claim': {
      if (t.isOwner) throw new GameError('Este canal ya es tuyo. 👑');
      if (i.member.voice.channelId !== ch.id) throw new GameError('Para reclamar un canal tenés que estar adentro.');
      if (ch.members.has(t.temp.ownerId)) throw new GameError(`<@${t.temp.ownerId}> sigue en el canal: no se puede reclamar.`);
      await deferPrivate(i);
      await changeOwner(app, t, i.member, 'reclamó');
      await finishPrivate(i, '👑 ¡Listo! Ahora manejás este canal.');
      return;
    }
    case 'transfer': {
      requireOwner(t);
      const targets = humans(ch).filter((m) => m.id !== t.temp.ownerId);
      if (!targets.length) throw new GameError('No hay nadie más en el canal para pasárselo.');
      await askPrivate(i, '🔁 ¿A quién le pasás el canal?',
        new StringSelectMenuBuilder().setCustomId(next('transferset')).setPlaceholder('Elegí a la persona…').setMinValues(1).setMaxValues(1)
          .addOptions(memberOptions(targets)));
      return;
    }
    case 'transferset': {
      requireOwner(t);
      const uid = values(i)[0] ?? '';
      const m = guild.members.cache.get(uid);
      if (!m || m.user.bot || m.voice.channelId !== ch.id) throw new GameError('Esa persona ya no está en el canal.');
      await deferPrivate(i);
      await changeOwner(app, t, m, 'recibió');
      await finishPrivate(i, `🔁 Listo: ahora <@${m.id}> maneja el canal.`);
      return;
    }

    // ── Eliminar (con confirmación) ──
    case 'delete': {
      requireOwner(t);
      await askPrivate(i, `🗑️ ¿Eliminar **${clean(ch.name)}**? Se desconecta a todos los que estén adentro.`, [
        new ButtonBuilder().setCustomId(next('delok')).setLabel('Sí, eliminar').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(cid('vc', 'delno', i.user.id)).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
      ]);
      return;
    }
    case 'delok': {
      requireOwner(t);
      await deferPrivate(i);
      await withTimeout(ch.delete(reason));
      forgetTempChannel(ctx, ch.id);
      renames.forget(ch.id);
      await sendLog(ctx, guild, 'voz', { embeds: [new EmbedBuilder().setColor(COLORS.log).setTimestamp()
        .setDescription(`🗑️ <@${i.user.id}> eliminó el canal temporal **${clean(ch.name)}** (dueño: <@${t.temp.ownerId}>).`)] });
      // Si el aviso salía del chat del canal borrado, ya no hay dónde contestar.
      await finishPrivate(i, '🗑️ Canal eliminado.').catch(() => undefined);
      return;
    }
    default:
      throw new GameError('Este botón es de una versión anterior. Usá la interfaz de nuevo.');
  }
};

// ───────────────────────── /voz (administración) ─────────────────────────

export const voiceAdminHandler: Handler = async (app, i, id) => {
  if (!i.member.permissions.has(F.ManageGuild)) throw new GameError('Necesitás el permiso **Gestionar servidor**.');
  const { ctx } = app;
  const guild = i.guild;
  const owner = i.user.id;
  const show = (notice?: string) => update(i, voiceAdminPanel(ctx, guild, owner, notice));
  switch (id.act) {
    case 'view':
      return show();
    case 'setup': {
      await deferPanel(i);
      const res = await app.guildLock.run(`voice-setup:${guild.id}`, () => setupTempVoice(app, guild, i.user.username));
      if (!res.ran) throw new GameError('Ya hay una configuración en curso. Esperá a que termine.');
      const p = voiceAdminPanel(ctx, guild, owner, res.value.report.join('\n'));
      await update(i, { ...p, components: [...p.components, maintenanceRow(owner, 'voice', res.value.duplicates)] });
      await logSystem(ctx, guild, `🔊 <@${owner}> configuró los canales de voz temporales.`, COLORS.ok);
      return;
    }
    case 'toggle': {
      const conf = getVoiceConfig(ctx, guild.id);
      if (!conf.hubChannelId) throw new GameError('Primero tocá **Configurar / reparar**.');
      saveVoiceConfig(ctx, guild.id, { enabled: !conf.enabled });
      await show(!conf.enabled ? '▶️ Canales temporales activados.' : '⏸️ Canales temporales desactivados (los que ya existen siguen hasta quedar vacíos).');
      await logSystem(ctx, guild, `🔊 <@${owner}> ${!conf.enabled ? 'activó' : 'desactivó'} los canales temporales.`);
      return;
    }
    case 'tpl': {
      if (!i.isButton()) return;
      const conf = getVoiceConfig(ctx, guild.id);
      await i.showModal(new ModalBuilder().setCustomId(cid('va', 'tplsave', owner)).setTitle('Canales nuevos').addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('tpl').setLabel('Nombre ({usuario} = nombre de quien lo crea)')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(conf.nameTemplate)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('limit').setLabel('Límite por defecto (0 = sin límite)')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2).setValue(String(conf.defaultLimit))),
      ));
      return;
    }
    case 'tplsave': {
      const c = saveVoiceConfig(ctx, guild.id, { nameTemplate: field(i, 'tpl'), defaultLimit: validateLimit(field(i, 'limit')) });
      await show(`✅ Los canales nuevos se llaman \`${c.nameTemplate}\` con límite ${c.defaultLimit || 'libre'}. (Las preferencias de cada persona tienen prioridad.)`);
      return;
    }
    case 'post': {
      const ch = guild.channels.cache.get(values(i)[0] ?? '');
      if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement)) throw new GameError('Elegí un canal de texto.');
      const me = guild.members.me!;
      if (!ch.permissionsFor(me).has([F.ViewChannel, F.SendMessages, F.EmbedLinks])) throw new GameError(`No puedo enviar mensajes con embeds en <#${ch.id}>.`);
      await deferPanel(i);
      await postInterface(app, guild, ch as TextChannel | NewsChannel);
      await show(`🎛️ Interfaz publicada en <#${ch.id}>.`);
      return;
    }
    default:
      throw new GameError('Acción desconocida.');
  }
};


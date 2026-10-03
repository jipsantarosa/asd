import {
  ActionRowBuilder, ChannelType, EmbedBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
  type TextChannel, type NewsChannel,
} from 'discord.js';
import { setActivityEnabled, setAnnounceChannel, setGameChannels, getCasinoGuild } from '../../casino/guilds';
import { GameError } from '../../services/context';
import { getSettings, setPrefix } from '../../services/guildSettings';
import { getLogConfig, saveLogConfig } from '../../services/logConfig';
import {
  addRolesToGroup, createGroup, deleteGroup, getGroup, removeReward, removeRoleFromGroup, setPublished, setReward, toggleMode, updateGroupText,
} from '../../services/roles';
import { viewerOf, type App } from '../app';
import { logSystem } from '../logging/sender';
import { casinoLevel, roleProblem } from '../roleSafety';
import { clean } from '../ui/theme';
import { mediaPanel, mediaStats } from '../ui/mediaPanels';
import { clearInfo, type ClearKind } from '../commands/premium';
import { requireTier } from '../../services/premium';
import { clearMedia } from '../../services/userMedia';
import { clearNames, recordName } from '../../services/userNames';
import { fetchAndRecord } from '../tracking/userMedia';
import { kissButtons, kissEmbed, rejectedEmbed } from '../ui/kissPanels';
import { randomKissGif } from '../fun/kissGif';
import { answeredText, claimKissReply, getKiss, kissBack, rejectKiss, returnKiss, setKissReply } from '../../services/social';
import { cid } from '../ui/ids';
import { HELP_PAGE_IDS, helpPanel, type HelpPage } from '../ui/helpPanel';
import { publicGroupMessage, rolePicker, rolesAdminPanel } from '../ui/rolesPanel';
import { settingsPanel } from '../ui/settingsPanel';
import { CASINO_HANDLERS } from '../casino/handlers';
import { stealHandler } from '../commands/steal';
import { maintenanceHandler } from '../setupMaintenance';
import { marryHandler } from '../commands/social';
import { deferPanel, field, update, values, type Handler as UiHandler, type Ix } from './util';
import { voiceAdminHandler, voiceHandler } from './voice';
import { automodHandler, modHandler } from './moderation';

export type { Ix } from './util';
type Handler = UiHandler;

// ───────────────────────── utilidades ─────────────────────────

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T {
  if (!value || !allowed.includes(value as T)) throw new GameError('Opción inválida.');
  return value as T;
}

function requirePerm(i: Ix, perm: bigint, name: string): void {
  if (!i.member.permissions.has(perm)) throw new GameError(`Necesitás el permiso **${name}**.`);
}

// ───────────────────────── ayuda ─────────────────────────

const helpHandler: Handler = async (app, i) => {
  await update(i, helpPanel(app.ctx, viewerOf(i.member), oneOf<HelpPage>(values(i)[0], HELP_PAGE_IDS)));
};

// ───────────────────────── ajustes del servidor ─────────────────────────

const settingsHandler: Handler = async (app, i, id) => {
  requirePerm(i, PermissionFlagsBits.ManageGuild, 'Gestionar servidor');
  const { ctx } = app;
  const g = i.guild;
  const show = (notice: string) => update(i, settingsPanel(ctx, g, i.user.id, notice));
  switch (id.act) {
    case 'prefix': {
      if (!i.isMessageComponent()) return;
      return i.showModal(new ModalBuilder().setCustomId(cid('st', 'pfx', i.user.id)).setTitle('Cambiar prefijo').addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('prefix').setLabel('Nuevo prefijo (1-5 caracteres)')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5).setValue(getSettings(ctx, g.id).prefix)),
      ));
    }
    case 'pfx': {
      const before = getSettings(ctx, g.id).prefix;
      const saved = setPrefix(ctx, g.id, field(i, 'prefix'));
      await show(`✅ Prefijo actualizado: \`${saved}\``);
      await logSystem(ctx, g, `⌨️ <@${i.user.id}> cambió el prefijo de \`${before}\` a \`${saved}\`.`);
      return;
    }
    case 'logmsg': {
      const cfg = getLogConfig(ctx, g.id);
      saveLogConfig(ctx, g.id, { ...cfg, logSentMessages: !cfg.logSentMessages });
      await show(`📝 Registro de mensajes enviados: **${!cfg.logSentMessages ? 'activado' : 'desactivado'}**.`);
      await logSystem(ctx, g, `📝 <@${i.user.id}> ${!cfg.logSentMessages ? 'activó' : 'desactivó'} el registro de mensajes enviados.`);
      return;
    }
    case 'announce': {
      const chId = values(i)[0] ?? null;
      if (chId) {
        const ch = g.channels.cache.get(chId);
        if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement)) throw new GameError('Elegí un canal de texto.');
        if (!ch.permissionsFor(g.members.me!).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
          throw new GameError(`No puedo enviar mensajes con embeds en <#${ch.id}>.`);
        }
      }
      setAnnounceChannel(ctx, g.id, chId);
      await show(chId ? `📢 Los anuncios del casino van a <#${chId}>.` : '📢 Sin canal de anuncios.');
      await logSystem(ctx, g, `📢 <@${i.user.id}> ${chId ? `eligió <#${chId}> como canal de anuncios del casino` : 'quitó el canal de anuncios del casino'}.`);
      return;
    }
    case 'games': {
      const saved = setGameChannels(ctx, g.id, values(i).filter((c) => g.channels.cache.get(c)?.isTextBased()));
      await show(saved.gameChannels.length ? `🎲 Los juegos solo se pueden usar en ${saved.gameChannels.map((c) => `<#${c}>`).join(' ')}.` : '🎲 Los juegos se pueden usar en cualquier canal.');
      await logSystem(ctx, g, `🎲 <@${i.user.id}> cambió los canales de juego: ${saved.gameChannels.map((c) => `<#${c}>`).join(' ') || 'cualquiera'}.`);
      return;
    }
    case 'activity': {
      const on = !getCasinoGuild(ctx, g.id).activityEnabled;
      setActivityEnabled(ctx, g.id, on);
      await show(`💬 Coins por actividad: **${on ? 'activadas' : 'desactivadas'}**.`);
      await logSystem(ctx, g, `💬 <@${i.user.id}> ${on ? 'activó' : 'desactivó'} las Coins por actividad.`);
      return;
    }
    default:
      throw new GameError('Acción desconocida.');
  }
};

// ───────────────────────── roles: administración ─────────────────────────

async function refreshPublished(app: App, i: Ix, groupId: number): Promise<void> {
  const g = getGroup(app.ctx, i.guild.id, groupId);
  if (!g.channel_id || !g.message_id) return;
  const ch = i.guild.channels.cache.get(g.channel_id);
  if (!ch?.isTextBased()) return;
  await ch.messages.edit(g.message_id, { ...publicGroupMessage(i.guild, g), allowedMentions: { parse: [] } }).catch(() => undefined);
}

const rolesAdminHandler: Handler = async (app, i, id) => {
  requirePerm(i, PermissionFlagsBits.ManageRoles, 'Gestionar roles');
  const { ctx } = app;
  const guild = i.guild;
  const owner = i.user.id;
  const gid = Number(id.args[0]);
  const show = (view: Parameters<typeof rolesAdminPanel>[3], notice?: string) => update(i, rolesAdminPanel(ctx, guild, owner, view, notice));

  switch (id.act) {
    case 'home':
      return show({ kind: 'home' });
    case 'group':
      return show({ kind: 'group', id: Number(values(i)[0] ?? id.args[0]) });
    case 'new':
    case 'edit': {
      if (!i.isMessageComponent()) return;
      const g = id.act === 'edit' ? getGroup(ctx, guild.id, gid) : null;
      const input = (cidName: string, label: string, style: TextInputStyle, max: number, value: string, required: boolean) => {
        const t = new TextInputBuilder().setCustomId(cidName).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required);
        if (value) t.setValue(value);
        return new ActionRowBuilder<TextInputBuilder>().addComponents(t);
      };
      return i.showModal(new ModalBuilder().setCustomId(g ? cid('ra', 'save', owner, g.id) : cid('ra', 'create', owner)).setTitle(g ? 'Editar grupo' : 'Nuevo grupo de roles')
        .addComponents(
          input('name', 'Nombre', TextInputStyle.Short, 60, g?.name ?? '', true),
          input('desc', 'Descripción (opcional)', TextInputStyle.Paragraph, 300, g?.description ?? '', false),
          input('level', 'Nivel mínimo del casino (0 = ninguno)', TextInputStyle.Short, 3, String(g?.min_total_level ?? 0), false),
        ));
    }
    case 'create': {
      const g = createGroup(ctx, guild.id, field(i, 'name'), field(i, 'desc'), Number(field(i, 'level') || 0));
      await logSystem(ctx, guild, `🎭 <@${owner}> creó el grupo de roles **${g.name}**.`);
      return show({ kind: 'group', id: g.id }, '✅ Grupo creado. Ahora agregale roles y publicalo en un canal.');
    }
    case 'save': {
      updateGroupText(ctx, guild.id, gid, field(i, 'name'), field(i, 'desc'), Number(field(i, 'level') || 0));
      await show({ kind: 'group', id: gid }, '✅ Grupo actualizado.');
      return refreshPublished(app, i, gid);
    }
    case 'mode': {
      const g = toggleMode(ctx, guild.id, gid);
      await show({ kind: 'group', id: gid }, `🔁 Modo cambiado a **${g.mode}**.`);
      return refreshPublished(app, i, gid);
    }
    case 'addroles': {
      const accepted: string[] = [];
      const rejected: string[] = [];
      for (const roleId of values(i)) {
        const problem = roleProblem(guild, guild.roles.cache.get(roleId));
        if (problem) rejected.push(`<@&${roleId}>: ${problem}`);
        else accepted.push(roleId);
      }
      if (accepted.length) addRolesToGroup(ctx, guild.id, gid, accepted);
      await show({ kind: 'group', id: gid }, [accepted.length ? `✅ ${accepted.length} rol(es) agregados.` : '', rejected.length ? `⛔ Rechazados:\n${rejected.join('\n')}` : ''].filter(Boolean).join('\n'));
      return refreshPublished(app, i, gid);
    }
    case 'rmrole': {
      removeRoleFromGroup(ctx, guild.id, gid, values(i)[0]);
      await show({ kind: 'group', id: gid }, '🗑️ Rol quitado del grupo.');
      return refreshPublished(app, i, gid);
    }
    case 'publish': {
      const g = getGroup(ctx, guild.id, gid);
      if (!g.roles.length) throw new GameError('Agregá al menos un rol antes de publicar.');
      const ch = guild.channels.cache.get(values(i)[0]);
      if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement)) throw new GameError('Elegí un canal de texto.');
      const me = guild.members.me!;
      if (!ch.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        throw new GameError(`No puedo enviar mensajes con embeds en <#${ch.id}>.`);
      }
      const payload = { ...publicGroupMessage(guild, g), allowedMentions: { parse: [] } };
      await deferPanel(i);
      let messageId: string | null = null;
      if (g.channel_id === ch.id && g.message_id) {
        messageId = await (ch as TextChannel | NewsChannel).messages.edit(g.message_id, payload).then((m) => m.id).catch(() => null);
      }
      if (!messageId) {
        const sent = await (ch as TextChannel | NewsChannel).send(payload);
        messageId = sent.id;
        if (g.channel_id && g.message_id) {
          const old = guild.channels.cache.get(g.channel_id);
          if (old?.isTextBased()) await old.messages.delete(g.message_id).catch(() => undefined);
        }
      }
      setPublished(ctx, guild.id, gid, ch.id, messageId);
      await logSystem(ctx, guild, `📢 <@${owner}> publicó el grupo **${g.name}** en <#${ch.id}>.`);
      return show({ kind: 'group', id: gid }, `📢 Panel publicado en <#${ch.id}>.`);
    }
    case 'del':
      return show({ kind: 'group', id: gid, confirmDelete: true }, '⚠️ ¿Seguro? Se borra el grupo y su panel publicado. Los miembros conservan sus roles.');
    case 'delok': {
      const g = deleteGroup(ctx, guild.id, gid);
      if (g.channel_id && g.message_id) {
        const ch = guild.channels.cache.get(g.channel_id);
        if (ch?.isTextBased()) await ch.messages.delete(g.message_id).catch(() => undefined);
      }
      await logSystem(ctx, guild, `🗑️ <@${owner}> eliminó el grupo de roles **${g.name}**.`);
      return show({ kind: 'home' }, `🗑️ Grupo **${g.name}** eliminado.`);
    }
    case 'rewards':
      return show({ kind: 'rewards' });
    case 'rwadd': {
      if (!i.isMessageComponent()) return;
      const roleId = values(i)[0];
      const problem = roleProblem(guild, guild.roles.cache.get(roleId));
      if (problem) throw new GameError(`No puedo usar ese rol como distinción: ${problem}.`);
      return i.showModal(new ModalBuilder().setCustomId(cid('ra', 'rwsave', owner, roleId)).setTitle('Distinción por nivel del casino').addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('level').setLabel('Nivel del casino requerido (1 a 500)')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3).setPlaceholder('10')),
      ));
    }
    case 'rwsave': {
      const roleId = id.args[0] ?? '';
      const problem = roleProblem(guild, guild.roles.cache.get(roleId));
      if (problem) throw new GameError(`No puedo usar ese rol como distinción: ${problem}.`);
      const raw = field(i, 'level').replace(/[.\s]/g, '');
      if (!/^\d{1,3}$/.test(raw)) throw new GameError('Escribí un nivel entre 1 y 500.');
      setReward(ctx, guild.id, roleId, Number(raw));
      await logSystem(ctx, guild, `🏅 <@${owner}> configuró la distinción <@&${roleId}> (nivel ${Number(raw)} del casino).`);
      return show({ kind: 'rewards' }, '✅ Distinción guardada. Se entrega al subir de nivel o al abrir el perfil.');
    }
    case 'rwdel':
      removeReward(ctx, guild.id, values(i)[0]);
      return show({ kind: 'rewards' }, '🗑️ Distinción quitada (nadie pierde el rol que ya tenía).');
    default:
      throw new GameError('Acción desconocida.');
  }
};

// ───────────────────────── roles: panel público ─────────────────────────

const rolesPublicHandler: Handler = async (app, i, id) => {
  const { ctx } = app;
  const g = getGroup(ctx, i.guild.id, Number(id.args[0]));
  const member = i.member;

  if (g.min_total_level > 0) {
    const level = casinoLevel(ctx, member.id);
    if (level < g.min_total_level) {
      throw new GameError(`Este grupo requiere nivel **${g.min_total_level}** del casino (tenés ${level}). El nivel sube con el total apostado: \`/casino\`.`);
    }
  }

  if (id.act === 'open') {
    const panel = rolePicker(i.guild, member, g);
    await i.reply({ ...panel, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }

  const usable = g.roles.filter((r) => roleProblem(i.guild, i.guild.roles.cache.get(r)) === null);
  let desired: string[];
  if (id.act === 'pick') desired = values(i).filter((r) => usable.includes(r));
  else if (id.act === 'clear') desired = [];
  else throw new GameError('Acción desconocida.');
  if (g.mode === 'unico' && desired.length > 1) desired = desired.slice(0, 1);

  const toAdd = desired.filter((r) => !member.roles.cache.has(r));
  const toRemove = usable.filter((r) => member.roles.cache.has(r) && !desired.includes(r));
  // Cambiar roles puede tardar (cola de la API): se avisa antes para no pasar los 3 s de la interacción.
  if (toAdd.length || toRemove.length) await deferPanel(i);
  let updated = member;
  if (toRemove.length) updated = await updated.roles.remove(toRemove, `Panel de roles: ${g.name}`);
  if (toAdd.length) updated = await updated.roles.add(toAdd, `Panel de roles: ${g.name}`);
  const notice = toAdd.length || toRemove.length
    ? `✅ Listo.${toAdd.length ? ` Agregados: ${toAdd.map((r) => `<@&${r}>`).join(' ')}.` : ''}${toRemove.length ? ` Quitados: ${toRemove.map((r) => `<@&${r}>`).join(' ')}.` : ''}`
    : 'Sin cambios.';
  await update(i, rolePicker(i.guild, updated, g, notice));
};

// ───────────────────────── historial de avatares/banners ─────────────────────────

const mediaHandler: Handler = async (app, i, id) => {
  const kind = oneOf<'avatar' | 'banner'>(id.args[0], ['avatar', 'banner']);
  if (id.act === 'stats') {
    // Botón público: cada uno ve SUS estadísticas, en privado.
    await i.reply({ embeds: [mediaStats(app.ctx, i.user)], flags: MessageFlags.Ephemeral });
    return;
  }
  if (id.act !== 'sel') throw new GameError('Acción desconocida.');
  const userId = id.args[1] ?? '';
  if (!/^\d{17,20}$/.test(userId)) throw new GameError('Usuario inválido.');
  const user = app.client.users.cache.get(userId) ?? (await app.client.users.fetch(userId).catch(() => null));
  if (!user) throw new GameError('No encontré a ese usuario.');
  const choice = values(i)[0] ?? 'c';
  const view = choice === 'c' ? 'collage' : Number(choice);
  if (view !== 'collage' && (!Number.isInteger(view) || view < 0 || view > 63)) throw new GameError('Opción inválida.');
  if (!i.isMessageComponent()) return;
  await i.deferUpdate();
  const panel = await mediaPanel(app.ctx, i.user.id, user, kind, view, kind === 'avatar' ? user.avatar : user.banner ?? null);
  await i.editReply({ embeds: panel.embeds, components: panel.components, files: panel.files ?? [], attachments: [] });
};

// ───────────────────────── kiss: corresponder / rechazar ─────────────────────────

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Corresponder: crea un mensaje NUEVO que responde al original ("¡h besa a salo de vuelta!", contador
 * actualizado y otro GIF) y desactiva los botones del original.
 * Anti doble clic: el beso pasa de "abierto" a "correspondido" con un UPDATE condicional dentro de la misma
 * transacción que suma el contador; el segundo clic (o un panel viejo) no suma nada. Además el candado por
 * usuario evita que dos clics de la misma persona se procesen a la vez.
 */
const kissHandler: Handler = async (app, i, id) => {
  if (!i.isButton()) throw new GameError('Acción desconocida.');
  const { ctx } = app;
  if (id.act !== 'back' && id.act !== 'no') throw new GameError('Este beso ya fue respondido. 💌');

  // Botones nuevos: g:ks:<acción>:0:<idDelBeso>. Botones viejos: g:ks:<acción>:0:<autor>:<destinatario>.
  const legacy = id.args.length === 2 && SNOWFLAKE.test(id.args[0]) && SNOWFLAKE.test(id.args[1]);
  const k = legacy ? null : getKiss(ctx, i.guild.id, Number(id.args[0]));
  if (!legacy && !k) throw new GameError('Ese beso ya no existe.');
  const authorId = legacy ? id.args[0] : k!.author_id;
  const targetId = legacy ? id.args[1] : k!.target_id;
  const nameOf = (userId: string, stored: string) => i.guild.members.cache.get(userId)?.displayName ?? stored;
  const authorName = nameOf(authorId, k?.author_name ?? 'alguien');
  const targetName = i.member.displayName;

  if (i.user.id !== targetId) {
    await i.reply({ content: `💌 Solo **${clean(nameOf(targetId, k?.target_name ?? 'quien recibió el beso'))}** puede responder este beso.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  // Ya respondido (otro clic, otra pestaña o un reinicio a mitad de camino): se dejan los botones como corresponden.
  if (k && k.state !== 'open') {
    await i.update({ components: [kissButtons(k.id, k.state)] });
    await i.followUp({ content: answeredText(k.state), flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }
  const buttons = (state: 'returned' | 'rejected') => kissButtons(k?.id ?? null, state, legacy ? id.args : []);

  if (id.act === 'no') {
    if (k) rejectKiss(ctx, i.guild.id, k.id, i.user.id);
    else claimKissReply(ctx, i.message.id, i.guild.id, i.user.id, 'rechazado');
    const original = i.message.embeds[0] ? EmbedBuilder.from(i.message.embeds[0]) : new EmbedBuilder();
    await i.update({ embeds: [rejectedEmbed(original, targetName)], components: [buttons('rejected')] });
    return;
  }

  // Corresponder: primero se marca y se cuenta (atómico); recién después se habla con Discord.
  const pair = k ? returnKiss(ctx, i.guild.id, k.id, i.user.id).result.pair : kissBack(ctx, i.message.id, i.guild.id, i.user.id, authorId).pair;
  // Desactiva los botones del original al instante (también es el acuse de la interacción).
  await i.update({ components: [buttons('returned')] });
  const gif = await randomKissGif({ exclude: [k?.gif_url, i.message.embeds[0]?.image?.url] });
  const payload = { embeds: [kissEmbed({ from: targetName, to: authorName, count: pair, gif, back: true })], allowedMentions: { parse: [], repliedUser: false } };
  const me = i.guild.members.me;
  const canSend = !!i.channel && !!me && 'permissionsFor' in i.channel
    && i.channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory]);
  let replyId: string | null = null;
  if (canSend && i.channel?.isSendable()) {
    replyId = await i.channel.send({ ...payload, reply: { messageReference: i.message.id, failIfNotExists: false } }).then((m) => m.id).catch(() => null);
  }
  // Sin permisos en el canal: el seguimiento de la interacción no los necesita y queda igual como respuesta al beso.
  if (!replyId) replyId = await i.followUp(payload).then((m) => m.id).catch(() => null);
  if (k && replyId) setKissReply(ctx, k.id, replyId);
};

// ───────────────────────── premium: confirmar limpiezas ─────────────────────────

const premiumHandler: Handler = async (app, i, id) => {
  // Estos botones solo existen en mensajes (nunca en un modal): Ix incluye ModalSubmit, así que se descarta acá.
  // Antes se llamaba a i.update() sin esta guarda y TypeScript no compilaba (TS2339), por eso el bot no arrancaba.
  if (!i.isMessageComponent()) throw new GameError('Acción desconocida.');
  if (id.act === 'cancel') {
    await i.update({ embeds: [new EmbedBuilder().setColor(0x80848e).setDescription('Cancelado. No se borró nada.')], components: [] });
    return;
  }
  if (id.act !== 'clear') throw new GameError('Acción desconocida.');
  const kind = oneOf<ClearKind>(id.args[0], ['avatars', 'names', 'tags']);
  const info = clearInfo(kind);
  // Se vuelve a verificar el nivel al confirmar (pudo vencer entre medio).
  requireTier(app.ctx, i.user.id, info.tier, info.cmd);
  // fetchAndRecord habla con la API de Discord: se avisa primero para no pasar los 3 s de la interacción.
  await i.deferUpdate();
  const n = kind === 'avatars' ? clearMedia(app.ctx, i.user.id, ['avatar', 'banner'])
    : kind === 'names' ? clearNames(app.ctx, i.user.id, ['username', 'display', 'nick'])
      : clearNames(app.ctx, i.user.id, ['tag']);
  // Lo actual se vuelve a registrar como único punto de partida.
  await fetchAndRecord(app, i.user.id, i.guild.id);
  if (kind === 'names' && i.member.nickname) recordName(app.ctx, i.user.id, 'nick', i.member.nickname, i.guild.id);
  await i.editReply({ embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(`🗑️ Listo: borré ${n} registro${n === 1 ? '' : 's'} de tu historial de ${info.label}.`)], components: [] });
};

export const HANDLERS: Record<string, Handler> = {
  md: modHandler,
  am: automodHandler,
  vc: voiceHandler,
  va: voiceAdminHandler,
  pr: premiumHandler,
  ks: kissHandler,
  av: mediaHandler,
  hp: helpHandler,
  st: settingsHandler,
  ra: rolesAdminHandler,
  rp: rolesPublicHandler,
  cx: stealHandler,
  sy: maintenanceHandler,
  mr: marryHandler,
  ...CASINO_HANDLERS,
};

import {
  ChannelType, EmbedBuilder, Events, OverwriteType, PermissionFlagsBits, PermissionsBitField,
  type CategoryChannel, type Guild, type GuildMember, type Message, type OverwriteResolvable, type PermissionOverwriteOptions,
  type PermissionsString, type TextChannel, type NewsChannel, type VoiceBasedChannel, type VoiceChannel, type VoiceState,
} from 'discord.js';
import { logger } from '../../logger';
import { KeyedLock } from '../../services/antispam';
import { GameError } from '../../services/context';
import {
  CREATE_COOLDOWN_MS, RenameLimiter, creationProblem, forgetTempChannel, getTempChannel, getVoiceConfig, getVoiceProfile, listAccess,
  listTempChannels, registerTempChannel, renderChannelName, saveVoiceConfig, saveVoiceProfile, tempChannelOf, type VoiceConfig, type VoiceProfile,
} from '../../services/tempVoice';
import type { App } from '../app';
import { logSystem, sendLog } from '../logging/sender';
import { COLORS } from '../ui/theme';
import { ownerWelcome, voiceInterface } from '../ui/voicePanels';

/**
 * Canales de voz temporales en Discord:
 * - Entrar al canal "➕ Crear canal" crea uno propio (con tus ajustes guardados) y te mueve ahí.
 * - Cuando el canal queda sin personas, se borra solo.
 * - Al arrancar (y cada 2 minutos) se reconcilia la base con lo que hay en Discord: nada queda colgado tras un reinicio.
 */

export const CATEGORY_NAME = '🔊 Canales temporales';
export const HUB_NAME = '➕ Crear canal';
export const INTERFACE_NAME = '🎛️・interfaz';

const F = PermissionFlagsBits;
/** Lo que recibe el dueño en su canal (nunca permisos de gestión: todo pasa por el bot y sus validaciones). */
const OWNER_ALLOW = [F.ViewChannel, F.Connect, F.Speak, F.Stream, F.UseVAD, F.PrioritySpeaker, F.SendMessages, F.ReadMessageHistory, F.EmbedLinks, F.AttachFiles];
/** Lo que necesita el bot dentro de cada canal temporal (explícito: una categoría privada no lo deja ciego). */
const BOT_ALLOW = [F.ViewChannel, F.Connect, F.ManageChannels, F.MoveMembers, F.SendMessages, F.EmbedLinks, F.ReadMessageHistory];
export const ACCESS_ALLOW = [F.ViewChannel, F.Connect];

export const VOICE_REQUIRED: { flag: bigint; name: string }[] = [
  { flag: F.ViewChannel, name: 'Ver canales' },
  { flag: F.ManageChannels, name: 'Gestionar canales' },
  { flag: F.ManageRoles, name: 'Gestionar roles (permisos de los canales)' },
  { flag: F.MoveMembers, name: 'Mover miembros' },
  { flag: F.Connect, name: 'Conectar' },
  { flag: F.SendMessages, name: 'Enviar mensajes' },
  { flag: F.EmbedLinks, name: 'Insertar enlaces' },
];

/** Una sola creación/borrado a la vez por persona y por canal. */
const voiceLock = new KeyedLock();
export const renames = new RenameLimiter();
const lastCreate = new Map<string, number>();
const lastNotice = new Map<string, number>();
const lastPermWarning = new Map<string, number>();

export function humans(channel: VoiceBasedChannel): GuildMember[] {
  return [...channel.members.values()].filter((m) => !m.user.bot);
}

/** Staff: no se lo puede expulsar ni bloquear desde la interfaz, y puede manejar cualquier canal temporal. */
export function isStaff(member: GuildMember): boolean {
  return member.id === member.guild.ownerId || member.permissions.any([F.Administrator, F.ManageGuild, F.ManageChannels, F.ModerateMembers, F.MoveMembers]);
}

export function missingVoicePerms(guild: Guild, parent?: CategoryChannel | null): string[] {
  const me = guild.members.me;
  if (!me) return VOICE_REQUIRED.map((p) => p.name);
  const perms = parent ? parent.permissionsFor(me) : me.permissions;
  // ManageRoles se mira a nivel servidor: en una categoría significa "gestionar permisos" y no siempre está explícito.
  return VOICE_REQUIRED.filter((p) => !(p.flag === F.ManageRoles ? me.permissions : perms).has(p.flag)).map((p) => p.name);
}

function grantable(guild: Guild, parent: CategoryChannel | null, flags: bigint[]): bigint[] {
  const me = guild.members.me!;
  const can = parent ? parent.permissionsFor(me) : me.permissions;
  // Discord solo deja otorgar en un canal los permisos que el bot mismo tiene.
  return flags.filter((f) => can.has(f));
}

/** Opciones para permissionOverwrites.edit(): { ViewChannel: true, Connect: true, … }. */
export function permOptions(flags: bigint[], value: boolean | null): PermissionOverwriteOptions {
  const out: Partial<Record<PermissionsString, boolean | null>> = {};
  for (const name of new PermissionsBitField(flags).toArray()) out[name] = value;
  return out;
}

export function ownerOptions(guild: Guild, parent: CategoryChannel | null): PermissionOverwriteOptions {
  return permOptions(grantable(guild, parent, OWNER_ALLOW), true);
}

export function accessOptions(guild: Guild, parent: CategoryChannel | null): PermissionOverwriteOptions {
  return permOptions(grantable(guild, parent, ACCESS_ALLOW), true);
}

interface Ow { id: string; type: OverwriteType; allow: bigint; deny: bigint }

/**
 * Permisos del canal nuevo: los de la categoría, más la privacidad del dueño (@everyone sin Conectar o sin Ver),
 * sus bloqueados y permitidos, el dueño y el bot (al final, para que nada los pise).
 */
export function buildOverwrites(guild: Guild, parent: CategoryChannel | null, ownerId: string, profile: VoiceProfile, trusted: string[], blocked: string[]): OverwriteResolvable[] {
  const map = new Map<string, Ow>();
  const put = (id: string, type: OverwriteType, allow: bigint, deny: bigint) => {
    const cur = map.get(id) ?? { id, type, allow: 0n, deny: 0n };
    cur.allow = (cur.allow | allow) & ~deny;
    cur.deny = (cur.deny & ~allow) | deny;
    map.set(id, cur);
  };
  if (parent) for (const o of parent.permissionOverwrites.cache.values()) map.set(o.id, { id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield });
  const privacy = (profile.locked ? F.Connect : 0n) | (profile.hidden ? F.ViewChannel : 0n);
  if (privacy) put(guild.id, OverwriteType.Role, 0n, privacy);
  const access = grantable(guild, parent, ACCESS_ALLOW).reduce((a, f) => a | f, 0n);
  for (const id of blocked) if (id !== ownerId) put(id, OverwriteType.Member, 0n, F.ViewChannel | F.Connect);
  for (const id of trusted) if (id !== ownerId) put(id, OverwriteType.Member, access, 0n);
  put(ownerId, OverwriteType.Member, grantable(guild, parent, OWNER_ALLOW).reduce((a, f) => a | f, 0n), 0n);
  put(guild.members.me!.id, OverwriteType.Member, grantable(guild, parent, BOT_ALLOW).reduce((a, f) => a | f, 0n), 0n);
  return [...map.values()].map((o) => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
}

/** ¿Está privado/oculto por el bot? (deny explícito sobre @everyone en el canal). */
export function privacyOf(channel: VoiceBasedChannel): { locked: boolean; hidden: boolean } {
  const o = channel.permissionOverwrites.cache.get(channel.guild.id);
  return { locked: !!o?.deny.has(F.Connect), hidden: !!o?.deny.has(F.ViewChannel) };
}

/** Promesa con tope de tiempo: si Discord la demora (límite de la API), se avisa en lugar de dejar el botón "pensando". */
export async function withTimeout<T>(p: Promise<T>, ms = 8000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GameError('Discord está demorando este cambio (límite de la API). Se aplicará solo en unos minutos.')), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Aviso corto en el chat del canal "Crear canal" (se borra solo). Como mucho uno cada 10 s por persona. */
async function notifyHub(hub: VoiceBasedChannel, member: GuildMember, text: string): Promise<void> {
  const key = `${hub.guild.id}:${member.id}`;
  if (Date.now() - (lastNotice.get(key) ?? 0) < 10_000) return;
  lastNotice.set(key, Date.now());
  const msg = await hub.send({ content: `<@${member.id}> ${text}`, allowedMentions: { users: [member.id] } }).catch(() => null);
  if (msg) setTimeout(() => void msg.delete().catch(() => undefined), 15_000).unref();
}

async function warnPermsOnce(app: App, guild: Guild, missing: string[]): Promise<void> {
  if (Date.now() - (lastPermWarning.get(guild.id) ?? 0) < 10 * 60_000) return;
  lastPermWarning.set(guild.id, Date.now());
  await logSystem(app.ctx, guild, `⚠️ No puedo crear canales temporales: me falta **${missing.join('**, **')}**. Dámelo y usá \`/voz\` → Configurar / reparar.`, COLORS.warn);
}

/** Crea el canal temporal de alguien que entró al hub y lo mueve ahí. */
async function createFor(app: App, member: GuildMember, hub: VoiceBasedChannel, conf: VoiceConfig): Promise<void> {
  const { ctx } = app;
  const guild = member.guild;

  // ¿Ya tiene uno? Se lo lleva a ese en lugar de crear otro.
  const existing = tempChannelOf(ctx, guild.id, member.id);
  if (existing) {
    const ch = guild.channels.cache.get(existing.channelId);
    if (ch?.isVoiceBased()) {
      await member.voice.setChannel(ch, 'Ya tenía un canal temporal').catch(() => undefined);
      return;
    }
    forgetTempChannel(ctx, existing.channelId);
  }

  const parent = hub.parent;
  const missing = missingVoicePerms(guild, parent);
  if (missing.length) {
    await notifyHub(hub, member, `⚠️ No puedo crear tu canal: me faltan permisos. Avisale a un admin.`);
    await warnPermsOnce(app, guild, missing);
    return;
  }
  const key = `${guild.id}:${member.id}`;
  if (Date.now() - (lastCreate.get(key) ?? 0) < CREATE_COOLDOWN_MS) {
    await notifyHub(hub, member, '⏳ Esperá unos segundos antes de crear otro canal.');
    return;
  }
  const problem = creationProblem(ctx, guild.id, member.id);
  if (problem) {
    await notifyHub(hub, member, `⚠️ No puedo crear tu canal: ${problem}.`);
    return;
  }
  lastCreate.set(key, Date.now());

  const profile = getVoiceProfile(ctx, guild.id, member.id);
  const trusted = listAccess(ctx, guild.id, member.id, 'trust');
  const blocked = listAccess(ctx, guild.id, member.id, 'block');
  const base = {
    name: profile.name ?? renderChannelName(conf.nameTemplate, member.displayName),
    type: ChannelType.GuildVoice as const,
    parent: parent?.id ?? null,
    userLimit: profile.limit ?? conf.defaultLimit,
    permissionOverwrites: buildOverwrites(guild, parent, member.id, profile, trusted, blocked),
    reason: `Canal temporal de ${member.user.username}`,
  };
  let channel: VoiceChannel | null = await guild.channels.create({ ...base, rtcRegion: profile.region ?? undefined }).catch(() => null);
  if (!channel && profile.region) {
    // La región guardada ya no existe: se crea en automática y se olvida esa preferencia.
    saveVoiceProfile(ctx, guild.id, member.id, { region: null });
    channel = await guild.channels.create(base).catch(() => null);
  }
  if (!channel) {
    logger.warn(`No pude crear el canal temporal de ${member.id} en ${guild.id}.`);
    await notifyHub(hub, member, '⚠️ No pude crear tu canal. Probá de nuevo en un rato.');
    return;
  }
  try {
    registerTempChannel(ctx, guild.id, channel.id, member.id);
  } catch {
    // Carrera (dos entradas casi simultáneas): ya tiene otro canal registrado. El nuevo sobra.
    await channel.delete('Canal temporal duplicado').catch(() => undefined);
    return;
  }
  const moved = await member.voice.setChannel(channel, 'Canal temporal').then(() => true).catch(() => false);
  if (!moved) {
    // Salió del hub antes de que el canal estuviera listo: no queda un canal vacío colgado.
    forgetTempChannel(ctx, channel.id);
    await channel.delete('El dueño se fue antes de entrar').catch(() => undefined);
    return;
  }
  await channel.send({ ...ownerWelcome(member.id), allowedMentions: { parse: [] } }).catch(() => undefined);
  await sendLog(ctx, guild, 'voz', { embeds: [new EmbedBuilder().setColor(COLORS.ok).setDescription(`🎙️ <@${member.id}> creó el canal temporal <#${channel.id}> (**${channel.name}**).`).setTimestamp()] });
}

/** Borra un canal temporal si sigue registrado y sin personas. Seguro de llamar varias veces. */
export async function deleteIfEmpty(app: App, channel: VoiceBasedChannel, why = 'quedó vacío'): Promise<boolean> {
  const res = await voiceLock.run(`del:${channel.id}`, async () => {
    const temp = getTempChannel(app.ctx, channel.id);
    if (!temp || humans(channel).length > 0) return false;
    const ok = await channel.delete(`Canal temporal ${why}`).then(() => true).catch((err: { code?: number }) => err.code === 10003);
    if (!ok) {
      logger.warn(`No pude borrar el canal temporal ${channel.id}: lo reintento en el próximo barrido.`);
      return false;
    }
    forgetTempChannel(app.ctx, channel.id);
    renames.forget(channel.id);
    await sendLog(app.ctx, channel.guild, 'voz', { embeds: [new EmbedBuilder().setColor(COLORS.log).setDescription(`🗑️ Se borró el canal temporal **${channel.name}** de <@${temp.ownerId}> (${why}).`).setTimestamp()] });
    return true;
  });
  return res.ran && res.value;
}

async function onVoiceState(app: App, oldS: VoiceState, newS: VoiceState): Promise<void> {
  const guild = newS.guild;
  const member = newS.member ?? oldS.member;
  if (!member || member.user.bot) return;

  // Entró (o se movió) al hub → crear su canal.
  if (newS.channelId && newS.channelId !== oldS.channelId) {
    const conf = getVoiceConfig(app.ctx, guild.id);
    if (conf.enabled && newS.channelId === conf.hubChannelId && newS.channel) {
      const hub = newS.channel;
      await voiceLock.run(`create:${guild.id}:${member.id}`, () => createFor(app, member, hub, conf));
    }
  }

  // Salió de un canal temporal → borrarlo si quedó vacío, o avisar que se puede reclamar si se fue el dueño.
  if (oldS.channelId && oldS.channelId !== newS.channelId) {
    const temp = getTempChannel(app.ctx, oldS.channelId);
    const ch = oldS.channel ?? guild.channels.cache.get(oldS.channelId);
    if (!temp || !ch?.isVoiceBased()) return;
    if (humans(ch).length === 0) await deleteIfEmpty(app, ch);
    else if (member.id === temp.ownerId) {
      await ch.send({ content: `👑 <@${temp.ownerId}> salió del canal. Cualquiera que esté adentro puede tocar **👑 Reclamar** para manejarlo.`, allowedMentions: { parse: [] } }).catch(() => undefined);
    }
  }
}

/**
 * Pone la base al día con Discord: olvida canales que ya no existen y borra los que quedaron vacíos
 * (por ejemplo, si el bot estuvo apagado cuando se fueron todos).
 */
export async function reconcile(app: App): Promise<void> {
  const now = Date.now();
  for (const t of listTempChannels(app.ctx)) {
    const guild = app.client.guilds.cache.get(t.guildId);
    if (!guild?.available) continue; // el bot no está (o el servidor no está disponible): no se toca nada
    const ch = guild.channels.cache.get(t.channelId);
    if (!ch || !ch.isVoiceBased()) {
      forgetTempChannel(app.ctx, t.channelId);
      continue;
    }
    // Margen para un canal recién creado al que el dueño todavía se está moviendo.
    if (now - t.createdAt > 15_000 && humans(ch).length === 0) await deleteIfEmpty(app, ch, 'quedó vacío mientras el bot no estaba');
  }
  renames.sweep(now);
  for (const [k, t] of lastCreate) if (now - t > CREATE_COOLDOWN_MS) lastCreate.delete(k);
  for (const [k, t] of lastNotice) if (now - t > 60_000) lastNotice.delete(k);
}

export function startTempVoice(app: App, everyMs = 120_000): NodeJS.Timeout {
  app.client.on(Events.VoiceStateUpdate, (o, n) => {
    onVoiceState(app, o, n).catch((err) => logger.warn('Canales temporales:', err));
  });
  app.client.on(Events.ChannelDelete, (channel) => {
    try {
      if (channel.isDMBased()) return;
      if (forgetTempChannel(app.ctx, channel.id)) renames.forget(channel.id);
      const conf = getVoiceConfig(app.ctx, channel.guild.id);
      if (channel.id === conf.hubChannelId) {
        saveVoiceConfig(app.ctx, channel.guild.id, { hubChannelId: null, enabled: false });
        void logSystem(app.ctx, channel.guild, '⚠️ Se borró el canal para crear salas temporales. Usá `/voz` → Configurar / reparar para recrearlo.', COLORS.warn);
      } else if (channel.id === conf.interfaceChannelId) {
        saveVoiceConfig(app.ctx, channel.guild.id, { interfaceChannelId: null, interfaceMessageId: null });
      } else if (channel.id === conf.categoryId) {
        saveVoiceConfig(app.ctx, channel.guild.id, { categoryId: null });
      }
    } catch (err) {
      logger.warn('Canales temporales (canal borrado):', err);
    }
  });
  let running = false;
  const tick = async () => {
    if (running || !app.client.isReady()) return;
    running = true;
    try {
      await reconcile(app);
    } catch (err) {
      logger.warn('Barrido de canales temporales:', err);
    } finally {
      running = false;
    }
  };
  app.client.once(Events.ClientReady, () => void tick());
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  return timer;
}

// ───────────────────────── /voz → Configurar / reparar ─────────────────────────

/** Publica (o actualiza) la interfaz en un canal de texto. */
export async function postInterface(app: App, guild: Guild, channel: TextChannel | NewsChannel, editMessageId?: string | null): Promise<Message> {
  const conf = getVoiceConfig(app.ctx, guild.id);
  const payload = { ...voiceInterface(conf.hubChannelId), allowedMentions: { parse: [] } };
  if (editMessageId) {
    const edited = await channel.messages.edit(editMessageId, payload).catch(() => null);
    if (edited) return edited;
  }
  return channel.send(payload);
}

/**
 * Crea o repara todo sin duplicar: categoría, canal para crear y canal de interfaz (con su mensaje).
 * Los IDs se guardan en la base; por nombre solo se adoptan canales que ya estén en la categoría.
 */
export async function setupTempVoice(app: App, guild: Guild, executor: string): Promise<string[]> {
  const missing = missingVoicePerms(guild);
  if (missing.length) throw new GameError(`Me faltan permisos: **${missing.join('**, **')}**. Dámelos y volvé a intentar.`);
  await guild.channels.fetch();
  const conf = getVoiceConfig(app.ctx, guild.id);
  const reason = `Canales temporales (/voz por ${executor})`;
  const report: string[] = [];
  const me = guild.members.me!;

  let category = conf.categoryId ? guild.channels.cache.get(conf.categoryId) : undefined;
  if (category?.type !== ChannelType.GuildCategory) {
    category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME);
    if (category) report.push(`🔧 Categoría <#${category.id}> recuperada`);
    else {
      category = await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory, reason });
      report.push(`🆕 Categoría **${CATEGORY_NAME}** creada`);
    }
  } else report.push(`✅ Categoría <#${category.id}> correcta`);
  const cat = category as CategoryChannel;

  let hub = conf.hubChannelId ? guild.channels.cache.get(conf.hubChannelId) : undefined;
  if (hub?.type !== ChannelType.GuildVoice) {
    hub = cat.children.cache.find((c) => c.type === ChannelType.GuildVoice && c.name === HUB_NAME);
    if (hub) report.push(`🔧 <#${hub.id}> recuperado`);
    else {
      hub = await guild.channels.create({
        name: HUB_NAME, type: ChannelType.GuildVoice, parent: cat.id, reason,
        // Nadie habla en el hub: solo se entra para que el bot cree tu canal.
        permissionOverwrites: [
          { id: guild.id, type: OverwriteType.Role, deny: [F.Speak, F.Stream] },
          { id: me.id, type: OverwriteType.Member, allow: grantable(guild, cat, BOT_ALLOW) },
        ],
      });
      report.push(`🆕 <#${hub.id}> creado`);
    }
  } else report.push(`✅ <#${hub.id}> correcto`);

  let iface = conf.interfaceChannelId ? guild.channels.cache.get(conf.interfaceChannelId) : undefined;
  if (iface?.type !== ChannelType.GuildText) {
    iface = cat.children.cache.find((c) => c.type === ChannelType.GuildText && c.name === INTERFACE_NAME);
    if (iface) report.push(`🔧 <#${iface.id}> recuperado`);
    else {
      iface = await guild.channels.create({
        name: INTERFACE_NAME, type: ChannelType.GuildText, parent: cat.id, reason, topic: 'Interfaz para manejar tu canal de voz temporal.',
        // Solo lectura: el canal es para los botones, no para charlar.
        permissionOverwrites: [
          { id: guild.id, type: OverwriteType.Role, deny: [F.SendMessages, F.CreatePublicThreads, F.CreatePrivateThreads, F.AddReactions] },
          { id: me.id, type: OverwriteType.Member, allow: [F.ViewChannel, F.SendMessages, F.EmbedLinks, F.ReadMessageHistory] },
        ],
      });
      report.push(`🆕 <#${iface.id}> creado`);
    }
  } else report.push(`✅ <#${iface.id}> correcto`);

  saveVoiceConfig(app.ctx, guild.id, { enabled: true, categoryId: cat.id, hubChannelId: hub.id, interfaceChannelId: iface.id });
  const sameChannel = conf.interfaceChannelId === iface.id;
  const msg = await postInterface(app, guild, iface as TextChannel, sameChannel ? conf.interfaceMessageId : null);
  saveVoiceConfig(app.ctx, guild.id, { interfaceMessageId: msg.id });
  report.push(`🎛️ Interfaz ${sameChannel && conf.interfaceMessageId === msg.id ? 'actualizada' : 'publicada'} en <#${iface.id}>`);
  return report;
}

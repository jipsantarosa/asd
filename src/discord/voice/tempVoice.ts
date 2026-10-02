import {
  ChannelType, EmbedBuilder, Events, OverwriteType, PermissionFlagsBits, PermissionsBitField,
  type CategoryChannel, type Guild, type GuildBasedChannel, type GuildMember, type Message, type OverwriteResolvable, type PermissionOverwriteOptions,
  type PermissionsString, type TextChannel, type NewsChannel, type VoiceBasedChannel, type VoiceChannel, type VoiceState,
} from 'discord.js';
import { logger } from '../../logger';
import { KeyedLock } from '../../services/antispam';
import { GameError } from '../../services/context';
import {
  CREATE_COOLDOWN_MS, RenameLimiter, creationProblem, forgetTempChannel, getTempChannel, getVoiceConfig, getVoiceProfile, listAccess,
  listTempChannels, planVoiceSync, registerTempChannel, renderChannelName, saveVoiceConfig, saveVoiceProfile, tempChannelOf, VOICE_NAMES,
  type VoiceConfig, type VoiceExisting, type VoiceProfile,
} from '../../services/tempVoice';
import { markSetupVersion } from '../../services/setupVersions';
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

export const CATEGORY_NAME = VOICE_NAMES.category.name;
export const HUB_NAME = VOICE_NAMES.hub.name;
export const INTERFACE_NAME = VOICE_NAMES.iface.name;
const INTERFACE_TOPIC = 'Interfaz para manejar tu canal de voz temporal.';

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

function voiceSnapshot(guild: Guild): VoiceExisting[] {
  return [...guild.channels.cache.values()].map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type === ChannelType.GuildCategory ? 'category' : c.type === ChannelType.GuildVoice ? 'voice' : c.type === ChannelType.GuildText ? 'text' : 'other',
    parentId: 'parentId' in c ? c.parentId ?? null : null,
    members: c.isVoiceBased() ? c.members.size : 0,
  }));
}

/** Sobrantes de instalaciones anteriores (recalculado en el momento: nunca incluye un canal en uso ni uno con gente). */
export function duplicateVoiceChannels(app: App, guild: Guild): GuildBasedChannel[] {
  const conf = getVoiceConfig(app.ctx, guild.id);
  const temps = new Set(listTempChannels(app.ctx, guild.id).map((t) => t.channelId));
  const plan = planVoiceSync(conf, voiceSnapshot(guild), temps);
  const inUse = new Set([conf.categoryId, conf.hubChannelId, conf.interfaceChannelId]);
  const channels = plan.duplicates.filter((id) => !inUse.has(id)).map((id) => guild.channels.cache.get(id)).filter((c): c is GuildBasedChannel => !!c);
  const gone = new Set(channels.map((c) => c.id));
  const cats = plan.duplicateCategories.map((id) => guild.channels.cache.get(id))
    .filter((c): c is CategoryChannel => c?.type === ChannelType.GuildCategory && c.children.cache.every((ch) => gone.has(ch.id)));
  return [...channels, ...cats];
}

export async function deleteVoiceDuplicates(app: App, guild: Guild, executor: string): Promise<number> {
  await guild.channels.fetch();
  let n = 0;
  const list = duplicateVoiceChannels(app, guild);
  for (const c of [...list].sort((a, b) => Number(a.type === ChannelType.GuildCategory) - Number(b.type === ChannelType.GuildCategory))) {
    // Un canal de voz pudo llenarse entre medio: se vuelve a mirar justo antes de borrar.
    if (c.isVoiceBased() && c.members.size > 0) continue;
    if (await c.delete(`Sobrante de canales temporales (por ${executor})`).then(() => true).catch(() => false)) n += 1;
  }
  return n;
}

/** Borra el canal para crear y la interfaz (los canales temporales con gente no se tocan) y los vuelve a crear. */
export async function reinstallTempVoice(app: App, guild: Guild, executor: string): Promise<{ report: string[]; duplicates: number }> {
  await guild.channels.fetch();
  const conf = getVoiceConfig(app.ctx, guild.id);
  const reason = `Reinstalación de canales temporales (por ${executor})`;
  for (const id of [conf.hubChannelId, conf.interfaceChannelId]) {
    const c = id ? guild.channels.cache.get(id) : undefined;
    if (c && !(c.isVoiceBased() && c.members.size > 0)) await c.delete(reason).catch(() => undefined);
  }
  await deleteVoiceDuplicates(app, guild, executor);
  saveVoiceConfig(app.ctx, guild.id, { hubChannelId: null, interfaceChannelId: null, interfaceMessageId: null });
  return setupTempVoice(app, guild, executor);
}

/**
 * Crea, repara y sincroniza todo con el diseño de esta versión, sin duplicar:
 * - encuentra la categoría, el canal para crear y la interfaz por ID guardado o, si se perdió la base, por nombre
 *   (también por nombres de versiones anteriores, sin importar emojis ni mayúsculas);
 * - les pone el nombre, la descripción y los permisos del bot actuales (sin pisar los permisos que agregó el staff);
 * - deja un solo panel de interfaz (borra los paneles viejos del bot en ese canal);
 * - informa sobrantes (hubs o interfaces repetidos, salas temporales huérfanas vacías): solo se borran si alguien confirma.
 */
export async function setupTempVoice(app: App, guild: Guild, executor: string, opts: { auto?: boolean } = {}): Promise<{ report: string[]; duplicates: number }> {
  const missing = missingVoicePerms(guild);
  if (missing.length) throw new GameError(`Me faltan permisos: **${missing.join('**, **')}**. Dámelos y volvé a intentar.`);
  await guild.channels.fetch();
  const conf = getVoiceConfig(app.ctx, guild.id);
  const temps = new Set(listTempChannels(app.ctx, guild.id).map((t) => t.channelId));
  const plan = planVoiceSync(conf, voiceSnapshot(guild), temps);
  const reason = `Canales temporales (/voz por ${executor})`;
  const report: string[] = [];
  const me = guild.members.me!;
  const rename = async (ch: GuildBasedChannel, name: string, what: string[]) => {
    if (ch.name !== name) {
      const old = ch.name;
      await ch.setName(name, reason);
      what.push(`renombrado (antes \`${old}\`)`);
    }
  };

  let cat: CategoryChannel;
  if (plan.category.kind === 'create') {
    cat = await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory, reason });
    report.push(`🆕 Categoría **${CATEGORY_NAME}** creada`);
  } else {
    cat = guild.channels.cache.get(plan.category.id) as CategoryChannel;
    const what: string[] = [];
    await rename(cat, CATEGORY_NAME, what);
    report.push(`${what.length || plan.category.kind === 'adopt' ? '🔧' : '✅'} Categoría <#${cat.id}> ${what.length ? what.join(', ') : plan.category.kind === 'adopt' ? 'recuperada' : 'correcta'}`);
  }

  // Permisos del bot y de @everyone en el hub y la interfaz: se actualizan sin borrar los que agregó el staff.
  const hubPerms = async (ch: VoiceChannel) => {
    await ch.permissionOverwrites.edit(guild.id, { Speak: false, Stream: false }, { reason });
    await ch.permissionOverwrites.edit(me.id, Object.fromEntries(new PermissionsBitField(grantable(guild, cat, BOT_ALLOW)).toArray().map((p) => [p, true])), { reason });
  };
  const ifacePerms = async (ch: TextChannel) => {
    await ch.permissionOverwrites.edit(guild.id, { SendMessages: false, CreatePublicThreads: false, CreatePrivateThreads: false, AddReactions: false }, { reason });
    await ch.permissionOverwrites.edit(me.id, { ViewChannel: true, SendMessages: true, EmbedLinks: true, ReadMessageHistory: true }, { reason });
  };

  let hub: VoiceChannel;
  if (plan.hub.kind === 'create') {
    hub = await guild.channels.create({
      name: HUB_NAME, type: ChannelType.GuildVoice, parent: cat.id, reason,
      // Nadie habla en el hub: solo se entra para que el bot cree tu canal.
      permissionOverwrites: [
        { id: guild.id, type: OverwriteType.Role, deny: [F.Speak, F.Stream] },
        { id: me.id, type: OverwriteType.Member, allow: grantable(guild, cat, BOT_ALLOW) },
      ],
    });
    report.push(`🆕 <#${hub.id}> creado`);
  } else {
    hub = guild.channels.cache.get(plan.hub.id) as VoiceChannel;
    const what: string[] = [];
    if (hub.parentId !== cat.id) {
      await hub.setParent(cat.id, { lockPermissions: false, reason });
      what.push('movido a la categoría');
    }
    await rename(hub, HUB_NAME, what);
    await hubPerms(hub);
    report.push(`${what.length || plan.hub.kind === 'adopt' ? '🔧' : '✅'} <#${hub.id}> ${what.length ? what.join(', ') : plan.hub.kind === 'adopt' ? 'recuperado' : 'correcto'}`);
  }

  let iface: TextChannel;
  if (plan.iface.kind === 'create') {
    iface = await guild.channels.create({
      name: INTERFACE_NAME, type: ChannelType.GuildText, parent: cat.id, reason, topic: INTERFACE_TOPIC,
      // Solo lectura: el canal es para los botones, no para charlar.
      permissionOverwrites: [
        { id: guild.id, type: OverwriteType.Role, deny: [F.SendMessages, F.CreatePublicThreads, F.CreatePrivateThreads, F.AddReactions] },
        { id: me.id, type: OverwriteType.Member, allow: [F.ViewChannel, F.SendMessages, F.EmbedLinks, F.ReadMessageHistory] },
      ],
    });
    report.push(`🆕 <#${iface.id}> creado`);
  } else {
    iface = guild.channels.cache.get(plan.iface.id) as TextChannel;
    const what: string[] = [];
    if (iface.parentId !== cat.id) {
      await iface.setParent(cat.id, { lockPermissions: false, reason });
      what.push('movido a la categoría');
    }
    await rename(iface, INTERFACE_NAME, what);
    if (iface.topic !== INTERFACE_TOPIC) {
      await iface.setTopic(INTERFACE_TOPIC, reason);
      what.push('descripción actualizada');
    }
    await ifacePerms(iface);
    report.push(`${what.length || plan.iface.kind === 'adopt' ? '🔧' : '✅'} <#${iface.id}> ${what.length ? what.join(', ') : plan.iface.kind === 'adopt' ? 'recuperado' : 'correcto'}`);
  }

  // A mano se activa; la sincronización automática respeta si el staff lo había desactivado.
  saveVoiceConfig(app.ctx, guild.id, { enabled: opts.auto ? conf.enabled : true, categoryId: cat.id, hubChannelId: hub.id, interfaceChannelId: iface.id });
  const sameChannel = conf.interfaceChannelId === iface.id;
  const msg = await postInterface(app, guild, iface, sameChannel ? conf.interfaceMessageId : null);
  saveVoiceConfig(app.ctx, guild.id, { interfaceMessageId: msg.id });
  // Un solo panel: los paneles viejos del bot en la interfaz (de instalaciones anteriores) se borran.
  const old = await iface.messages.fetch({ limit: 50 }).catch(() => null);
  const stale = old ? [...old.values()].filter((m) => m.author.id === me.id && m.id !== msg.id) : [];
  for (const m of stale) await m.delete().catch(() => undefined);
  report.push(`🎛️ Interfaz ${sameChannel && conf.interfaceMessageId === msg.id ? 'actualizada' : 'publicada'} en <#${iface.id}>${stale.length ? ` (borré ${stale.length} ${stale.length === 1 ? 'panel viejo' : 'paneles viejos'})` : ''}`);
  markSetupVersion(app.ctx, guild.id, 'voice');

  const dups = duplicateVoiceChannels(app, guild);
  if (dups.length) report.push(`\n🧹 Hay **${dups.length}** ${dups.length === 1 ? 'canal sobrante' : 'canales sobrantes'} de instalaciones anteriores: ${dups.slice(0, 10).map((c) => `<#${c.id}>`).join(' ')}. Podés borrarlos con el botón de abajo.`);
  return { report, duplicates: dups.length };
}

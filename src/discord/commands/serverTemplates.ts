import {
  AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, GuildDefaultMessageNotifications, GuildExplicitContentFilter,
  GuildVerificationLevel, InteractionContextType, OAuth2Scopes, OverwriteType, PermissionFlagsBits, SlashCommandBuilder,
  type CategoryChannel, type Guild, type GuildBasedChannel, type GuildChannelCreateOptions, type GuildMember, type OverwriteResolvable, type Role,
} from 'discord.js';
import { getAutoRoles, setAutoRole, type AutoRoles } from '../../services/autoRole';
import { getBoostConfig, saveBoostConfig } from '../../services/boost';
import { GameError } from '../../services/context';
import { getSettings } from '../../services/guildSettings';
import { getLogConfig } from '../../services/logConfig';
import { addRolesToGroup, createGroup, listGroups, setPublished } from '../../services/roles';
import {
  BUILTIN_TEMPLATE, cleanTemplateName, deleteTemplate, fillTemplateText, getTemplate, listTemplates, nameKey, parseTemplateText, permBits,
  planApply, saveTemplate, snapshotToTemplate, templateStats, templateToText, TEMPLATE_LIMITS,
  type ChannelKind, type ChannelRole, type ExistingGuild, type GuildSnapshot, type ServerTemplate, type TplChannel, type TplMessage, type TplOverwrite,
} from '../../services/serverTemplate';
import { row, type App, type Panel } from '../app';
import { update, type Handler } from '../handlers/util';
import { runSetup } from '../logging/setup';
import { logSystem } from '../logging/sender';
import { isOwner } from '../owner';
import { cid } from '../ui/ids';
import { publicGroupMessage } from '../ui/rolesPanel';
import { roleProblem } from '../roleSafety';
import { applyAutoRolesToAll } from './autoRole';
import { COLORS, clean } from '../ui/theme';
import { setupTempVoice } from '../voice/tempVoice';
import type { Command, CommandContext } from './types';

/**
 * /setupdiscord y /plantilla: arman un servidor desde una plantilla (roles, categorías, canales, permisos y mensajes)
 * y copian la estructura de un servidor para pegarla en otro. Solo los dueños del bot. Pegar nunca borra ni edita
 * lo que ya existe: reutiliza lo que tiene el mismo nombre y crea lo que falta.
 */

const F = PermissionFlagsBits;
const ONLY_OWNER = 'Solo el dueño del bot puede usar esto.';

function requireOwner(userId: string): void {
  if (!isOwner(userId)) throw new GameError(ONLY_OWNER);
}

/** Permisos que pide el enlace de invitación del bot (lo que usan sus funciones, sin Administrador). */
const INVITE_PERMS = [
  F.ViewChannel, F.SendMessages, F.SendMessagesInThreads, F.EmbedLinks, F.AttachFiles, F.ReadMessageHistory, F.AddReactions, F.UseExternalEmojis,
  F.ManageMessages, F.ManageChannels, F.ManageRoles, F.ManageWebhooks, F.ManageGuildExpressions, F.ManageNicknames, F.ViewAuditLog,
  F.KickMembers, F.BanMembers, F.ModerateMembers, F.Connect, F.MoveMembers,
];

export function botInvite(app: App): string {
  try {
    return app.client.generateInvite({ scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands], permissions: INVITE_PERMS });
  } catch {
    return `https://discord.com/oauth2/authorize?client_id=${app.client.user?.id ?? ''}&scope=bot+applications.commands`;
  }
}

// ───────────────────────── foto del servidor ─────────────────────────

export async function snapshotGuild(guild: Guild, autoRoles: AutoRoles | null = null): Promise<GuildSnapshot> {
  await guild.roles.fetch();
  await guild.channels.fetch();
  return {
    name: guild.name,
    everyoneId: guild.id,
    roles: [...guild.roles.cache.values()].map((r) => ({
      id: r.id, name: r.name, color: r.colors.primaryColor, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield, managed: r.managed, position: r.position,
    })),
    channels: [...guild.channels.cache.values()].filter((c) => !c.isThread()).map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      parentId: c.parentId,
      position: 'rawPosition' in c ? c.rawPosition : 0,
      topic: 'topic' in c ? c.topic : null,
      nsfw: 'nsfw' in c ? c.nsfw : false,
      slowmode: 'rateLimitPerUser' in c ? c.rateLimitPerUser ?? 0 : 0,
      userLimit: 'userLimit' in c ? c.userLimit : 0,
      overwrites: 'permissionOverwrites' in c
        ? [...c.permissionOverwrites.cache.values()].map((o) => ({ id: o.id, type: o.type === OverwriteType.Role ? 'role' as const : 'member' as const, allow: o.allow.bitfield, deny: o.deny.bitfield }))
        : [],
    })),
    systemChannelId: guild.systemChannelId,
    rulesChannelId: guild.rulesChannelId,
    modUpdatesChannelId: guild.publicUpdatesChannelId,
    verification: guild.verificationLevel,
    contentFilter: guild.explicitContentFilter,
    notifications: guild.defaultMessageNotifications,
    community: guild.features.includes('COMMUNITY'),
    autoRoles: autoRoles ?? undefined,
  };
}

const KIND_OF: Partial<Record<ChannelType, ChannelKind>> = {
  [ChannelType.GuildText]: 'text', [ChannelType.GuildVoice]: 'voice', [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildForum]: 'forum', [ChannelType.GuildStageVoice]: 'stage',
};

function existingOf(guild: Guild): ExistingGuild {
  const all = [...guild.channels.cache.values()].filter((c) => !c.isThread());
  return {
    roles: [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed).map((r) => r.name),
    categories: all.filter((c) => c.type === ChannelType.GuildCategory).map((c) => c.name),
    channels: all.filter((c) => c.type !== ChannelType.GuildCategory).map((c) => ({ name: c.name, kind: KIND_OF[c.type] ?? 'other', parent: c.parent?.name ?? null })),
  };
}

// ───────────────────────── vista previa y confirmación ─────────────────────────

function resolveTemplate(app: App, name: string): { name: string; tpl: ServerTemplate } {
  const saved = getTemplate(app.ctx, name);
  if (!saved) throw new GameError(`No existe la plantilla **${cleanTemplateName(name)}**. Mirá las guardadas con \`/plantilla lista\`.`);
  return { name: saved.name, tpl: saved.template };
}

const list = (names: string[], max = 12) => (names.length ? `${names.slice(0, max).map((n) => `\`${clean(n)}\``).join(', ')}${names.length > max ? ` y ${names.length - max} más` : ''}` : '—');

export async function previewPanel(app: App, guild: Guild, owner: string, name: string): Promise<Panel> {
  const { tpl } = resolveTemplate(app, name);
  await guild.roles.fetch();
  await guild.channels.fetch();
  const plan = planApply(tpl, existingOf(guild));
  const extras: string[] = [];
  if (tpl.settings?.community && !guild.features.includes('COMMUNITY')) extras.push('🌐 Activa la **Comunidad** (canales de anuncios que otros servidores pueden seguir)');
  if (tpl.settings?.verification || tpl.settings?.contentFilter) extras.push('🛡️ Ajusta la verificación y el filtro de contenido');
  if (tpl.roles.some((r) => r.selfAssign)) extras.push('🎭 Publica un panel de autorroles');
  if (tpl.bot?.logs) extras.push('📜 Configura los registros (`/setup`)');
  if (tpl.bot?.tempVoice) extras.push('🔊 Configura la voz temporal (`/voz`)');
  if (tpl.categories.some((c) => c.channels.some((ch) => ch.role === 'boost'))) extras.push('🚀 Activa el boost tracker');
  for (const r of tpl.roles.filter((x) => x.autoRole)) {
    extras.push(`👤 Autorol: ${r.autoRole === 'bots' ? 'los bots que se agreguen' : 'las personas que entren'} reciben **${clean(r.name)}**`);
  }
  const embed = new EmbedBuilder()
    .setColor(COLORS.settings)
    .setTitle(`🏗️ ${clean(tpl.name)}`)
    .setDescription(`${tpl.description ? `${clean(tpl.description)}\n\n` : ''}Esto se va a crear en **${clean(guild.name)}**.\n• **✅ Crear todo:** no borra nada; lo que tenga el mismo nombre se reutiliza.\n• **🗑️ Borrar canales y crear:** primero borra **todos** los canales y categorías del servidor (los roles se conservan).`)
    .addFields(
      { name: `🎭 Roles nuevos (${plan.createRoles.length})`, value: list(plan.createRoles.map((r) => r.name)) },
      { name: `📁 Categorías nuevas (${plan.createCategories.length})`, value: list(plan.createCategories) },
      { name: `💬 Canales nuevos (${plan.createChannels.length})`, value: list(plan.createChannels.map((c) => c.channel.name), 20) },
      { name: '♻️ Ya existen (se reutilizan)', value: `${plan.reuseRoles.length} roles · ${plan.reuseCategories.length} categorías · ${plan.reuseChannels.length} canales` },
    )
    .setFooter({ text: `Plantilla: ${name}` });
  if (extras.length) embed.addFields({ name: '⚙️ Además', value: extras.join('\n') });
  return {
    embeds: [embed],
    components: [row(
      new ButtonBuilder().setCustomId(cid('tp', 'go', owner, name)).setLabel('Crear todo').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cid('tp', 'wipe', owner, name)).setLabel('Borrar canales y crear').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(cid('tp', 'no', owner)).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
    )],
  };
}

/** Segunda confirmación antes de borrar los canales. */
export function wipeConfirmPanel(guild: Guild, owner: string, name: string): Panel {
  const all = [...guild.channels.cache.values()].filter((c) => !c.isThread());
  const cats = all.filter((c) => c.type === ChannelType.GuildCategory).length;
  return {
    embeds: [new EmbedBuilder()
      .setColor(COLORS.error)
      .setTitle('⚠️ ¿Borrar todos los canales?')
      .setDescription([
        `Se van a borrar **${all.length - cats} canales** y **${cats} categorías** de **${clean(guild.name)}**, **con todos sus mensajes**. Los mensajes borrados no se pueden recuperar.`,
        '',
        'Los roles y los miembros no se tocan.',
        'Antes de borrar, guardo la estructura actual (canales, categorías y permisos) como plantilla **respaldo-…**, así la podés volver a crear con `/plantilla pegar`.',
      ].join('\n'))],
    components: [row(
      new ButtonBuilder().setCustomId(cid('tp', 'wipeok', owner, name)).setLabel('Sí, borrar todo y crear').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(cid('tp', 'back', owner, name)).setLabel('Volver').setStyle(ButtonStyle.Secondary),
    )],
  };
}

// ───────────────────────── pegar ─────────────────────────

export interface ApplyReport {
  roles: number;
  categories: number;
  channels: number;
  messages: number;
  reused: number;
  deleted: number;
  /** Canal donde se publica el resultado si se borró el canal donde se usó el comando. */
  reportChannelId: string | null;
  notes: string[];
  warnings: string[];
}

function textBased(ch: GuildBasedChannel | undefined): ch is GuildBasedChannel & { send: (o: object) => Promise<{ id: string }> } {
  return !!ch && ch.isTextBased() && 'send' in ch;
}

/** Borra canales (primero los de adentro, después las categorías). Devuelve los que Discord no dejó borrar. */
async function deleteChannels(channels: GuildBasedChannel[], reason: string, report: ApplyReport): Promise<GuildBasedChannel[]> {
  const left: GuildBasedChannel[] = [];
  const ordered = [...channels.filter((c) => c.type !== ChannelType.GuildCategory), ...channels.filter((c) => c.type === ChannelType.GuildCategory)];
  for (const ch of ordered) {
    if (ch.isThread() || !ch.deletable) {
      left.push(ch);
      continue;
    }
    try {
      await ch.delete(reason);
      report.deleted++;
    } catch {
      left.push(ch);
    }
  }
  return left;
}

export async function applyTemplate(app: App, guild: Guild, tpl: ServerTemplate, executor: GuildMember, opts: { wipe?: boolean } = {}): Promise<ApplyReport> {
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const need: [bigint, string][] = [[F.ManageRoles, 'Gestionar roles'], [F.ManageChannels, 'Gestionar canales'], [F.ViewChannel, 'Ver canales'], [F.SendMessages, 'Enviar mensajes'], [F.EmbedLinks, 'Insertar enlaces']];
  const missing = need.filter(([f]) => !me.permissions.has(f)).map(([, n]) => n);
  if (missing.length) throw new GameError(`Me faltan permisos: **${missing.join('**, **')}**. Dámelos (o Administrador) y volvé a intentar.`);
  await guild.roles.fetch();
  await guild.channels.fetch();

  const reason = `Plantilla "${tpl.name}" (por ${executor.user.tag})`;
  const report: ApplyReport = { roles: 0, categories: 0, channels: 0, messages: 0, reused: 0, deleted: 0, reportChannelId: null, notes: [], warnings: [] };
  let leftovers: GuildBasedChannel[] = [];
  if (opts.wipe) {
    // Copia de seguridad de la estructura ANTES de borrar (si no se puede guardar, no se borra nada).
    const d = new Date(app.ctx.now());
    const p2 = (n: number) => String(n).padStart(2, '0');
    const backupName = `respaldo-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
    const backup = snapshotToTemplate(await snapshotGuild(guild, getAutoRoles(app.ctx, guild.id)), backupName);
    saveTemplate(app.ctx, backupName, backup, { by: executor.id, sourceGuild: guild.id, replace: true });
    report.notes.push(`Guardé la estructura vieja como plantilla **${backupName}** (\`/plantilla pegar nombre:${backupName}\` la vuelve a crear).`);
    leftovers = await deleteChannels([...guild.channels.cache.values()].filter((c) => !c.isThread()), `${reason} - borrar canales`, report);
    await guild.channels.fetch();
  }
  const admin = me.permissions.has(F.Administrator);
  // Sin Administrador, Discord no deja dar (ni negar en canales) permisos que el bot no tiene.
  const mask = (bits: bigint, what: string): bigint => {
    if (admin) return bits;
    const ok = bits & me.permissions.bitfield;
    if (ok !== bits) report.warnings.push(`${what}: le saqué permisos que yo no tengo (dame Administrador para copiarlos completos).`);
    return ok;
  };
  const plan = planApply(tpl, existingOf(guild));

  // ── Roles: se crean de abajo hacia arriba para que queden en el orden de la plantilla ──
  const roles = new Map<string, Role>();
  for (const r of guild.roles.cache.values()) if (r.id !== guild.id && !r.managed && !roles.has(nameKey(r.name))) roles.set(nameKey(r.name), r);
  report.reused += plan.reuseRoles.length;
  for (const r of [...plan.createRoles].reverse()) {
    try {
      const role = await guild.roles.create({
        name: r.name,
        colors: r.color ? { primaryColor: r.color } : undefined,
        hoist: r.hoist ?? false,
        mentionable: r.mentionable ?? false,
        permissions: mask(permBits(r.permissions), `Rol ${r.name}`),
        reason,
      });
      roles.set(nameKey(r.name), role);
      report.roles++;
    } catch (err) {
      report.warnings.push(`No pude crear el rol **${clean(r.name)}**: ${(err as Error).message}`);
    }
  }

  // ── Autoroles (personas y bots por separado) ──
  let autoChanged = false;
  for (const kind of ['members', 'bots'] as const) {
    const t = tpl.roles.find((r) => r.autoRole === kind);
    const role = t ? roles.get(nameKey(t.name)) : undefined;
    if (!t || !role) continue;
    const label = kind === 'bots' ? 'bots' : 'personas';
    const problem = roleProblem(guild, role);
    const current = getAutoRoles(app.ctx, guild.id)[kind];
    if (problem) report.warnings.push(`No pude activar el autorol de ${label} **${clean(role.name)}**: ${problem}.`);
    else if (!current || !guild.roles.cache.has(current) || current === role.id) {
      setAutoRole(app.ctx, guild.id, kind, role.id);
      autoChanged = true;
      report.notes.push(`Autorol de ${label}: <@&${role.id}>.`);
    } else report.notes.push(`Ya había un autorol de ${label} (<@&${current}>); no lo cambié.`);
  }
  if (autoChanged) {
    const r = await applyAutoRolesToAll(app, guild, 500).catch(() => null);
    if (r && (r.members || r.bots)) report.notes.push(`Les di el autorol a ${r.members} personas y ${r.bots} bots que ya estaban${r.pending ? `; para el resto usá \`/autorol aplicar\`` : ''}.`);
  }

  const overwritesFor = (list: TplOverwrite[] | undefined, what: string, voice: boolean): OverwriteResolvable[] | undefined => {
    if (!list) return undefined;
    const out: OverwriteResolvable[] = [];
    let hidden = false;
    for (const o of list) {
      const id = o.role === '@everyone' ? guild.id : roles.get(nameKey(o.role))?.id;
      if (!id) {
        report.warnings.push(`${what}: no existe el rol **${clean(o.role)}**, salteé su permiso.`);
        continue;
      }
      const deny = mask(permBits(o.deny), what);
      if (id === guild.id && (deny & F.ViewChannel) === F.ViewChannel) hidden = true;
      out.push({ id, allow: mask(permBits(o.allow), what), deny, type: OverwriteType.Role });
    }
    // Un canal privado tiene que seguir visible para el bot (si no, no puede escribir ni administrarlo).
    if (hidden && !admin) {
      out.push({ id: me.id, type: OverwriteType.Member, allow: [F.ViewChannel, F.SendMessages, F.EmbedLinks, F.ReadMessageHistory, F.ManageChannels, ...(voice ? [F.Connect] : [])] });
    }
    return out;
  };

  // ── Categorías ──
  const categories = new Map<string, CategoryChannel>();
  for (const c of guild.channels.cache.values()) if (c.type === ChannelType.GuildCategory && !categories.has(nameKey(c.name))) categories.set(nameKey(c.name), c);
  report.reused += plan.reuseCategories.length;
  for (const cat of tpl.categories) {
    if (categories.has(nameKey(cat.name))) continue;
    try {
      const created = await guild.channels.create({ name: cat.name, type: ChannelType.GuildCategory, permissionOverwrites: overwritesFor(cat.overwrites, `Categoría ${cat.name}`, false), reason });
      categories.set(nameKey(cat.name), created);
      report.categories++;
    } catch (err) {
      report.warnings.push(`No pude crear la categoría **${clean(cat.name)}**: ${(err as Error).message}`);
    }
  }

  // Textos con {server} {bot} {invite} {#canal} {@&rol}… (los canales se resuelven a medida que se crean).
  const invite = botInvite(app);
  function fill(text: string): string {
    return fillTemplateText(text, {
      server: guild.name,
      bot: app.client.user?.username ?? 'el bot',
      invite,
      prefix: getSettings(app.ctx, guild.id).prefix,
      user: `<@${executor.id}>`,
      channel: (n) => byKey.get(nameKey(n))?.id ?? null,
      role: (n) => roles.get(nameKey(n))?.id ?? null,
    });
  }
  // ── Canales ──
  const community = () => guild.features.includes('COMMUNITY');
  const byKey = new Map<string, GuildBasedChannel>();
  for (const c of guild.channels.cache.values()) if (!c.isThread() && c.type !== ChannelType.GuildCategory && !byKey.has(nameKey(c.name))) byKey.set(nameKey(c.name), c);
  const created = new Map<TplChannel, GuildBasedChannel>();
  const special = new Map<ChannelRole, GuildBasedChannel>();
  const toConvert: GuildBasedChannel[] = [];
  const catOf = new Map<TplChannel, { name: string; overwrites?: TplOverwrite[] } | null>();
  for (const ch of tpl.channels) catOf.set(ch, null);
  for (const cat of tpl.categories) for (const ch of cat.channels) catOf.set(ch, cat);

  for (const { channel: ch, parent } of [...plan.reuseChannels]) {
    const found = [...guild.channels.cache.values()].find((c) => !c.isThread() && nameKey(c.name) === nameKey(ch.name)
      && (parent === null ? !c.parentId : c.parent && nameKey(c.parent.name) === nameKey(parent)));
    if (found && ch.role) special.set(ch.role, found);
    report.reused++;
  }
  for (const { channel: ch, parent } of plan.createChannels) {
    const cat = catOf.get(ch) ?? null;
    const parentCh = parent ? categories.get(nameKey(parent)) ?? null : null;
    const voice = ch.type === 'voice' || ch.type === 'stage';
    let type: GuildChannelCreateOptions['type'];
    switch (ch.type) {
      case 'voice': type = ChannelType.GuildVoice; break;
      case 'stage': type = community() ? ChannelType.GuildStageVoice : ChannelType.GuildVoice; break;
      case 'announcement': type = community() ? ChannelType.GuildAnnouncement : ChannelType.GuildText; break;
      case 'forum': type = ChannelType.GuildForum; break;
      default: type = ChannelType.GuildText;
    }
    const opts: GuildChannelCreateOptions = {
      name: ch.name,
      type,
      parent: parentCh ?? undefined,
      topic: ch.topic && !voice ? fill(ch.topic) : undefined,
      nsfw: ch.nsfw,
      rateLimitPerUser: ch.slowmode && !voice ? ch.slowmode : undefined,
      userLimit: voice && ch.userLimit ? ch.userLimit : undefined,
      // Sin permisos propios, el canal hereda los de su categoría (los de la plantilla, ya resueltos).
      permissionOverwrites: overwritesFor(ch.overwrites ?? cat?.overwrites, `Canal ${ch.name}`, voice),
      reason,
    };
    let made: GuildBasedChannel | null = null;
    try {
      made = await guild.channels.create(opts);
    } catch (err) {
      if (type === ChannelType.GuildForum) {
        // Algunos servidores no permiten foros: queda como canal de texto.
        made = await guild.channels.create({ ...opts, type: ChannelType.GuildText }).catch(() => null);
        if (made) report.notes.push(`**${clean(ch.name)}** quedó como canal de texto (no pude crear un foro).`);
      }
      if (!made) report.warnings.push(`No pude crear el canal **${clean(ch.name)}**: ${(err as Error).message}`);
    }
    if (!made) continue;
    report.channels++;
    created.set(ch, made);
    byKey.set(nameKey(ch.name), made);
    if (ch.role) special.set(ch.role, made);
    if (ch.type === 'announcement' && made.type === ChannelType.GuildText) toConvert.push(made);
  }

  // ── Ajustes del servidor y Comunidad ──
  const s = tpl.settings;
  if (s && me.permissions.has(F.ManageGuild)) {
    const edit: Parameters<Guild['edit']>[0] = { reason };
    const VER = { none: GuildVerificationLevel.None, low: GuildVerificationLevel.Low, medium: GuildVerificationLevel.Medium, high: GuildVerificationLevel.High, very_high: GuildVerificationLevel.VeryHigh };
    const FIL = { off: GuildExplicitContentFilter.Disabled, no_role: GuildExplicitContentFilter.MembersWithoutRoles, all: GuildExplicitContentFilter.AllMembers };
    if (s.verification) edit.verificationLevel = VER[s.verification];
    if (s.contentFilter) edit.explicitContentFilter = FIL[s.contentFilter];
    if (s.notifications) edit.defaultMessageNotifications = s.notifications === 'all' ? GuildDefaultMessageNotifications.AllMessages : GuildDefaultMessageNotifications.OnlyMentions;
    const sys = special.get('system');
    if (sys?.type === ChannelType.GuildText) edit.systemChannel = sys.id;
    try {
      await guild.edit(edit);
      report.notes.push('Ajusté la verificación, el filtro de contenido y las notificaciones.');
    } catch (err) {
      report.warnings.push(`No pude cambiar los ajustes del servidor: ${(err as Error).message}`);
    }
    const rules = special.get('rules');
    const mod = special.get('modUpdates');
    if (s.community && !community()) {
      if (rules?.type === ChannelType.GuildText && mod?.type === ChannelType.GuildText) {
        try {
          // Discord pide verificación mínima "baja" y filtro para todos los miembros para activar la Comunidad.
          await guild.edit({
            features: [...guild.features, 'COMMUNITY'],
            rulesChannel: rules.id,
            publicUpdatesChannel: mod.id,
            verificationLevel: Math.max(GuildVerificationLevel.Low, guild.verificationLevel),
            explicitContentFilter: GuildExplicitContentFilter.AllMembers,
            reason,
          });
          report.notes.push('Activé la **Comunidad** del servidor.');
        } catch (err) {
          report.warnings.push(`No pude activar la Comunidad (los canales de anuncios quedaron como texto): ${(err as Error).message}`);
        }
      } else report.warnings.push('No activé la Comunidad: la plantilla necesita un canal de reglas y uno de avisos para moderadores.');
    }
    if (community() && leftovers.length && rules?.type === ChannelType.GuildText && mod?.type === ChannelType.GuildText) {
      // Discord no deja borrar los canales de reglas/avisos de la Comunidad: se pasan a los nuevos y se borran los viejos.
      await guild.edit({ rulesChannel: rules.id, publicUpdatesChannel: mod.id, reason }).catch(() => undefined);
      leftovers = await deleteChannels(leftovers, `${reason} - borrar canales`, report);
    }
    if (community()) {
      for (const ch of toConvert) {
        if (ch.type !== ChannelType.GuildText) continue;
        await ch.setType(ChannelType.GuildAnnouncement, reason).catch((err: Error) => report.warnings.push(`No pude convertir **${clean(ch.name)}** en canal de anuncios: ${err.message}`));
      }
    }
  } else if (s) report.warnings.push('No tengo **Gestionar servidor**: no cambié la verificación, las notificaciones ni la Comunidad.');

  // ── Mensajes (solo en los canales recién creados, para no repetirlos al volver a pegar) ──
  const render = (m: TplMessage) => {
    const embeds: EmbedBuilder[] = [];
    if (m.title || m.description) {
      const e = new EmbedBuilder().setColor(m.color ?? COLORS.casino);
      if (m.title) e.setTitle(fill(m.title).slice(0, 256));
      if (m.description) e.setDescription(fill(m.description).slice(0, 4096));
      if (m.footer) e.setFooter({ text: fill(m.footer).slice(0, 2048) });
      if (m.image) e.setImage(m.image);
      if (m.fields) e.addFields(m.fields.map((f) => ({ name: fill(f.name).slice(0, 256), value: fill(f.value).slice(0, 1024), inline: f.inline ?? false })));
      embeds.push(e);
    }
    const buttons = (m.buttons ?? [])
      .map((b) => ({ ...b, url: b.url === '{invite}' ? invite : b.url }))
      .filter((b) => /^https:\/\//.test(b.url))
      .map((b) => {
        const btn = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(b.url).setLabel(fill(b.label).slice(0, 80));
        if (b.emoji) btn.setEmoji(b.emoji);
        return btn;
      });
    return { content: m.content ? fill(m.content).slice(0, 2000) : undefined, embeds, components: buttons.length ? [row(...buttons)] : [], allowedMentions: { parse: [] } };
  };
  for (const [ch, made] of created) {
    if (!ch.messages?.length || !textBased(made)) continue;
    for (const m of ch.messages) {
      try {
        await made.send(render(m));
        report.messages++;
      } catch (err) {
        report.warnings.push(`No pude publicar un mensaje en **${clean(ch.name)}**: ${(err as Error).message}`);
      }
    }
  }

  // ── Autorroles ──
  const selfRoles = tpl.roles.filter((r) => r.selfAssign).map((r) => roles.get(nameKey(r.name))).filter((r): r is Role => !!r);
  const selfChannel = special.get('selfRoles');
  if (selfRoles.length && textBased(selfChannel)) {
    try {
      const title = tpl.bot?.selfRolesTitle ?? 'Roles';
      const existing = listGroups(app.ctx, guild.id).find((g) => nameKey(g.name) === nameKey(title));
      const group = addRolesToGroup(app.ctx, guild.id, (existing ?? createGroup(app.ctx, guild.id, title, tpl.bot?.selfRolesDescription ?? '', 0)).id, selfRoles.map((r) => r.id));
      const freshChannel = [...created.keys()].some((k) => k.role === 'selfRoles');
      if (!group.message_id || freshChannel) {
        const msg = await selfChannel.send({ ...publicGroupMessage(guild, group), allowedMentions: { parse: [] } });
        setPublished(app.ctx, guild.id, group.id, selfChannel.id, msg.id);
        report.notes.push(`Publiqué el panel de autorroles en <#${selfChannel.id}>.`);
      }
    } catch (err) {
      report.warnings.push(`No pude publicar los autorroles: ${(err as Error).message}`);
    }
  }

  // ── Roles para quien pega la plantilla ──
  for (const r of tpl.roles.filter((x) => x.giveToExecutor)) {
    const role = roles.get(nameKey(r.name));
    if (!role || executor.roles.cache.has(role.id)) continue;
    if (role.position >= me.roles.highest.position) {
      report.warnings.push(`No puedo darte **${clean(role.name)}**: está por encima de mi rol.`);
      continue;
    }
    await executor.roles.add(role, reason).then(() => report.notes.push(`Te di el rol <@&${role.id}>.`))
      .catch((err: Error) => report.warnings.push(`No pude darte **${clean(role.name)}**: ${err.message}`));
  }

  // ── Funciones del bot ──
  const boost = special.get('boost');
  if (boost && !getBoostConfig(app.ctx, guild.id).channelId) {
    saveBoostConfig(app.ctx, guild.id, { channelId: boost.id, enabled: true });
    report.notes.push(`Los boosts se anuncian en <#${boost.id}> (personalizalo con \`/boosttracker edit\`).`);
  }
  if (tpl.bot?.logs) {
    try {
      const prev = getLogConfig(app.ctx, guild.id);
      const staff = prev.staffRoleId ?? roles.get('staff')?.id ?? null;
      const res = await app.guildLock.run(`setup:${guild.id}`, () => runSetup(app.ctx, guild, { staffRoleId: staff, logSentMessages: prev.logSentMessages, executorTag: executor.user.tag }));
      report.notes.push(res.ran && res.value.ok ? 'Configuré los **registros** (`/setup`).' : 'Los registros ya se estaban configurando; corré `/setup` después.');
    } catch (err) {
      report.warnings.push(`No pude configurar los registros: ${(err as Error).message}`);
    }
  }
  if (tpl.bot?.tempVoice) {
    try {
      const res = await app.guildLock.run(`voice-setup:${guild.id}`, () => setupTempVoice(app, guild, executor.user.username));
      report.notes.push(res.ran ? 'Configuré la **voz temporal** (`/voz`).' : 'La voz temporal ya se estaba configurando.');
    } catch (err) {
      report.warnings.push(`No pude configurar la voz temporal: ${(err as Error).message}`);
    }
  }
  if (leftovers.length) report.warnings.push(`No pude borrar ${leftovers.length} canal(es): ${leftovers.slice(0, 10).map((c) => `#${clean(c.name)}`).join(', ')} (permisos o los exige Discord).`);
  const target = special.get('system') ?? [...created.values()].find((c) => c.type === ChannelType.GuildText);
  report.reportChannelId = target?.id ?? null;
  return report;
}

function reportPanel(tpl: ServerTemplate, r: ApplyReport): Panel {
  const cut = (lines: string[]) => {
    let out = '';
    for (const l of lines) {
      if (out.length + l.length > 1000) return `${out}…`;
      out += `• ${l}\n`;
    }
    return out || '—';
  };
  const e = new EmbedBuilder()
    .setColor(r.warnings.length ? COLORS.warn : COLORS.ok)
    .setTitle(`✅ Plantilla aplicada: ${clean(tpl.name)}`)
    .setDescription(`${r.deleted ? `Borré **${r.deleted}** canales y categorías viejos. ` : ''}Creé **${r.roles}** roles, **${r.categories}** categorías, **${r.channels}** canales y **${r.messages}** mensajes.${r.reused ? ` Reutilicé **${r.reused}** cosas que ya existían.` : ''}${r.deleted ? '' : ' No borré nada.'}`);
  if (r.notes.length) e.addFields({ name: '⚙️ Hecho', value: cut(r.notes) });
  if (r.warnings.length) e.addFields({ name: `⚠️ Avisos (${r.warnings.length})`, value: cut(r.warnings) });
  return { embeds: [e], components: [] };
}

// ───────────────────────── botones ─────────────────────────

export const templateHandler: Handler = async (app, i, id) => {
  requireOwner(i.user.id);
  const name = id.args[0] ?? '';
  switch (id.act) {
    case 'no':
      await update(i, { embeds: [new EmbedBuilder().setColor(COLORS.push).setDescription('Cancelado. No se creó ni se borró nada.')], components: [] });
      return;
    case 'wipe':
      await i.guild.channels.fetch();
      await update(i, wipeConfirmPanel(i.guild, i.user.id, name));
      return;
    case 'back':
      await update(i, await previewPanel(app, i.guild, i.user.id, name));
      return;
    case 'go':
    case 'wipeok':
      break;
    default:
      throw new GameError('Opción desconocida.');
  }
  const wipe = id.act === 'wipeok';
  const { tpl } = resolveTemplate(app, name);
  await update(i, { embeds: [new EmbedBuilder().setColor(COLORS.settings).setDescription(`⏳ ${wipe ? 'Borrando los canales y armando' : 'Armando'} **${clean(tpl.name)}**… puede tardar un par de minutos (Discord limita cuántos canales se crean por segundo).`)], components: [] });
  const res = await app.guildLock.run(`template:${i.guild.id}`, () => applyTemplate(app, i.guild, tpl, i.member, { wipe }));
  if (!res.ran) throw new GameError('Ya se está aplicando una plantilla en este servidor. Esperá a que termine.');
  const panel = reportPanel(tpl, res.value);
  // Si se borró el canal donde se usó el comando, la respuesta privada ya no se ve: el resultado va a un canal nuevo.
  const shown = await i.editReply({ ...panel, allowedMentions: { parse: [] } }).then(() => true, () => false);
  const target = res.value.reportChannelId ? i.guild.channels.cache.get(res.value.reportChannelId) : null;
  if ((wipe || !shown) && target?.isTextBased() && 'send' in target) {
    await target.send({ content: `<@${i.user.id}>`, embeds: panel.embeds, allowedMentions: { users: [i.user.id] } }).catch(() => undefined);
  }
  await logSystem(app.ctx, i.guild, `🏗️ <@${i.user.id}> aplicó la plantilla **${clean(name)}**${wipe ? ` (borró ${res.value.deleted} canales viejos)` : ''}.`, COLORS.ok);
};

// ───────────────────────── comandos ─────────────────────────

export const setupDiscordCmd: Command = {
  name: 'setupdiscord',
  aliases: ['setupserver', 'armarservidor'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('setupdiscord')
    .setDescription('👑 (Dueño del bot) Arma el servidor oficial del bot: roles, canales, anuncios, soporte y más.')
    .setDefaultMemberPermissions(F.Administrator)
    .addStringOption((o) => o.setName('plantilla').setDescription(`Plantilla a usar (por defecto "${BUILTIN_TEMPLATE}", el servidor oficial del bot)`).setMaxLength(32)),
  async run(c) {
    requireOwner(c.member.id);
    await c.defer(true);
    await c.reply(await previewPanel(c.app, c.guild, c.member.id, c.str('plantilla', 0) ?? BUILTIN_TEMPLATE), { ephemeral: true });
  },
};

function sub(c: CommandContext): string | null {
  return c.interaction ? c.interaction.options.getSubcommand(false) : c.args[0]?.toLowerCase() ?? null;
}

const SUB_ALIASES: Record<string, string> = {
  copiar: 'copiar', copy: 'copiar', guardar: 'copiar', save: 'copiar',
  pegar: 'pegar', paste: 'pegar', aplicar: 'pegar', apply: 'pegar',
  importar: 'importar', import: 'importar', subir: 'importar',
  archivo: 'archivo', exportar: 'archivo', export: 'archivo', descargar: 'archivo',
  lista: 'lista', list: 'lista', ls: 'lista',
  borrar: 'borrar', delete: 'borrar', eliminar: 'borrar',
};

async function readAttachment(c: CommandContext): Promise<{ text: string; fileName: string } | null> {
  const a = c.interaction ? c.interaction.options.getAttachment('archivo') : c.message?.attachments.first() ?? null;
  if (!a) return null;
  if (a.size > TEMPLATE_LIMITS.bytes) throw new GameError(`El archivo supera ${TEMPLATE_LIMITS.bytes / 1024} KB.`);
  if (!/\.json$/i.test(a.name)) throw new GameError('El archivo tiene que ser una plantilla **.json**.');
  const res = await fetch(a.url).catch(() => null);
  if (!res?.ok) throw new GameError('No pude descargar el archivo. Probá de nuevo.');
  return { text: await res.text(), fileName: a.name.replace(/\.json$/i, '') };
}

const fileOf = (name: string, tpl: ServerTemplate) => new AttachmentBuilder(Buffer.from(templateToText(tpl), 'utf8'), { name: `plantilla-${name}.json` });

export const plantillaCmd: Command = {
  name: 'plantilla',
  aliases: ['plantillas', 'template', 'templates'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('plantilla')
    .setDescription('👑 (Dueño del bot) Copiar y pegar la estructura de servidores.')
    .setDefaultMemberPermissions(F.Administrator)
    .addSubcommand((s) => s.setName('copiar').setDescription('Guarda roles, categorías, canales y permisos de este servidor como plantilla.')
      .addStringOption((o) => o.setName('nombre').setDescription('Nombre de la plantilla (letras, números y guiones)').setRequired(true).setMaxLength(32))
      .addBooleanOption((o) => o.setName('reemplazar').setDescription('Si ya existe una con ese nombre, reemplazarla')))
    .addSubcommand((s) => s.setName('pegar').setDescription('Crea en este servidor lo que tenga una plantilla (muestra una vista previa antes).')
      .addStringOption((o) => o.setName('nombre').setDescription(`Plantilla guardada ("${BUILTIN_TEMPLATE}" = servidor oficial del bot)`).setRequired(true).setMaxLength(32)))
    .addSubcommand((s) => s.setName('importar').setDescription('Guarda una plantilla desde un archivo .json (para editarla a mano o traerla de otro bot).')
      .addAttachmentOption((o) => o.setName('archivo').setDescription('Archivo .json de la plantilla').setRequired(true))
      .addStringOption((o) => o.setName('nombre').setDescription('Nombre con el que se guarda (por defecto, el del archivo)').setMaxLength(32))
      .addBooleanOption((o) => o.setName('reemplazar').setDescription('Si ya existe una con ese nombre, reemplazarla')))
    .addSubcommand((s) => s.setName('archivo').setDescription('Descarga una plantilla como .json para editarla o compartirla.')
      .addStringOption((o) => o.setName('nombre').setDescription('Nombre de la plantilla').setRequired(true).setMaxLength(32)))
    .addSubcommand((s) => s.setName('lista').setDescription('Plantillas guardadas.'))
    .addSubcommand((s) => s.setName('borrar').setDescription('Borra una plantilla guardada (no toca ningún servidor).')
      .addStringOption((o) => o.setName('nombre').setDescription('Nombre de la plantilla').setRequired(true).setMaxLength(32))),
  async run(c) {
    requireOwner(c.member.id);
    const p = c.prefix;
    const action = SUB_ALIASES[sub(c) ?? ''];
    const name = () => {
      const n = c.str('nombre', 1);
      if (!n) throw new GameError(`Falta el nombre. Ejemplo: \`${p}plantilla ${action ?? 'copiar'} mi-servidor\`.`);
      return n;
    };
    const replace = c.interaction ? c.bool('reemplazar', 2) ?? false : ['reemplazar', 'replace', 'si', 'sí'].includes(c.args[2]?.toLowerCase() ?? '');
    switch (action) {
      case 'copiar': {
        await c.defer(true);
        const tpl = snapshotToTemplate(await snapshotGuild(c.guild, getAutoRoles(c.app.ctx, c.guild.id)), name());
        const saved = saveTemplate(c.app.ctx, name(), tpl, { by: c.member.id, sourceGuild: c.guild.id, replace });
        const st = templateStats(tpl);
        await c.reply({
          content: `📋 Copié **${clean(c.guild.name)}** como plantilla **${saved.name}**: ${st.roles} roles, ${st.categories} categorías y ${st.channels} canales (con sus permisos). No copia mensajes ni miembros.\nPegala en otro servidor con \`/plantilla pegar nombre:${saved.name}\`. Abajo va el archivo por si querés editarla o guardarla.`,
          files: [fileOf(saved.name, tpl)],
        }, { ephemeral: true });
        return;
      }
      case 'importar': {
        const file = await readAttachment(c);
        if (!file) throw new GameError(`Adjuntá el archivo .json de la plantilla (por prefijo: \`${p}plantilla importar <nombre>\` con el archivo adjunto).`);
        const tpl = parseTemplateText(file.text);
        const saved = saveTemplate(c.app.ctx, c.str('nombre', 1) ?? file.fileName.replace(/^plantilla-/, ''), tpl, { by: c.member.id, replace });
        const st = templateStats(tpl);
        await c.reply({ content: `📥 Guardé la plantilla **${saved.name}** (${st.roles} roles, ${st.categories} categorías, ${st.channels} canales, ${st.messages} mensajes). Pegala con \`/plantilla pegar nombre:${saved.name}\`.` }, { ephemeral: true });
        return;
      }
      case 'pegar': {
        await c.defer(true);
        await c.reply(await previewPanel(c.app, c.guild, c.member.id, cleanTemplateName(name())), { ephemeral: true });
        return;
      }
      case 'archivo': {
        const { name: n, tpl } = resolveTemplate(c.app, name());
        await c.reply({ content: `📄 Plantilla **${n}**. Editala y volvé a subirla con \`/plantilla importar\`.`, files: [fileOf(n, tpl)] }, { ephemeral: true });
        return;
      }
      case 'lista': {
        const rows = listTemplates(c.app.ctx);
        const lines = [`• **${BUILTIN_TEMPLATE}** — servidor oficial del bot (incluida)`, ...rows.map((r) => `• **${r.name}** — ${Math.ceil(r.size / 1024)} KB · <t:${Math.floor(r.updatedAt / 1000)}:R>`)];
        await c.reply({ embeds: [new EmbedBuilder().setColor(COLORS.settings).setTitle('🗂️ Plantillas').setDescription(lines.join('\n')).setFooter({ text: `${rows.length}/${TEMPLATE_LIMITS.templates} guardadas` })] }, { ephemeral: true });
        return;
      }
      case 'borrar': {
        deleteTemplate(c.app.ctx, name());
        await c.reply({ content: `🗑️ Borré la plantilla **${cleanTemplateName(name())}**. Ningún servidor se modificó.` }, { ephemeral: true });
        return;
      }
      default:
        await c.reply({
          content: [
            '🗂️ **Plantillas de servidor** (solo el dueño del bot)',
            `\`${p}plantilla copiar <nombre>\` — guarda la estructura de este servidor`,
            `\`${p}plantilla pegar <nombre>\` — la crea en este servidor (vista previa antes; no borra nada)`,
            `\`${p}plantilla importar <nombre>\` + archivo .json — guarda una plantilla desde un archivo`,
            `\`${p}plantilla archivo <nombre>\` — descarga el .json`,
            `\`${p}plantilla lista\` · \`${p}plantilla borrar <nombre>\``,
            `\`${p}setupdiscord\` — arma el servidor oficial del bot (plantilla **${BUILTIN_TEMPLATE}**)`,
          ].join('\n'),
        }, { ephemeral: true });
    }
  },
};

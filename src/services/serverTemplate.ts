import { PermissionFlagsBits } from 'discord.js';
import { GameError, type GameContext } from './context';

/**
 * Plantillas de servidor (/setupdiscord y /plantilla). Una plantilla describe roles, categorías, canales,
 * permisos y mensajes iniciales en JSON. "Copiar" guarda la estructura de un servidor; "pegar" la crea en
 * otro. Pegar NUNCA borra ni edita lo que ya existe: lo que ya está (mismo nombre) se reutiliza y solo se
 * crea lo que falta, así que se puede volver a pegar sin duplicar nada.
 */

export type PermName = keyof typeof PermissionFlagsBits;
export type ChannelKind = 'text' | 'voice' | 'announcement' | 'forum' | 'stage';
/** Función especial de un canal en el servidor. */
export type ChannelRole = 'system' | 'rules' | 'modUpdates' | 'boost' | 'selfRoles';

export interface TplOverwrite {
  /** '@everyone' o el nombre de un rol (de la plantilla o que ya exista en el servidor). */
  role: string;
  allow?: PermName[];
  deny?: PermName[];
}

export interface TplRole {
  name: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  permissions?: PermName[];
  /** Aparece en el panel de autorroles (/setupdiscord lo publica en el canal con role "selfRoles"). */
  selfAssign?: boolean;
  /** Se le da a quien pega la plantilla (p. ej. "Fundador"). */
  giveToExecutor?: boolean;
}

export interface TplButton {
  label: string;
  /** https://… o {invite}. */
  url: string;
  emoji?: string;
}

export interface TplMessage {
  content?: string;
  title?: string;
  description?: string;
  color?: number;
  footer?: string;
  image?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  buttons?: TplButton[];
}

export interface TplChannel {
  name: string;
  type: ChannelKind;
  topic?: string;
  slowmode?: number;
  nsfw?: boolean;
  userLimit?: number;
  role?: ChannelRole;
  overwrites?: TplOverwrite[];
  /** Mensajes que se publican solo si el canal se crea en ese momento (al volver a pegar no se repiten). */
  messages?: TplMessage[];
}

export interface TplCategory {
  name: string;
  overwrites?: TplOverwrite[];
  channels: TplChannel[];
}

export interface TplSettings {
  verification?: 'none' | 'low' | 'medium' | 'high' | 'very_high';
  contentFilter?: 'off' | 'no_role' | 'all';
  notifications?: 'all' | 'mentions';
  /** Activa la Comunidad de Discord (canales de anuncios que otros servidores pueden seguir). */
  community?: boolean;
}

export interface TplBot {
  /** Corre /setup (registros) al terminar. */
  logs?: boolean;
  /** Corre la configuración de voz temporal al terminar. */
  tempVoice?: boolean;
  /** Título y descripción del panel de autorroles. */
  selfRolesTitle?: string;
  selfRolesDescription?: string;
}

export interface ServerTemplate {
  format: 'casino-template';
  version: 1;
  name: string;
  description?: string;
  roles: TplRole[];
  /** Canales sin categoría (arriba de todo). */
  channels: TplChannel[];
  categories: TplCategory[];
  settings?: TplSettings;
  bot?: TplBot;
}

export const TEMPLATE_LIMITS = {
  roles: 100, categories: 40, channels: 250, channelsPerCategory: 50, messagesPerChannel: 5, overwrites: 25,
  name: 100, topic: 1024, content: 2000, title: 256, description: 4096, footer: 2048, fields: 10, fieldName: 256, fieldValue: 1024,
  buttons: 5, buttonLabel: 80, bytes: 512 * 1024, templates: 50,
} as const;

const KINDS: readonly ChannelKind[] = ['text', 'voice', 'announcement', 'forum', 'stage'];
const CHANNEL_ROLES: readonly ChannelRole[] = ['system', 'rules', 'modUpdates', 'boost', 'selfRoles'];
const PERM_NAMES = new Set(Object.keys(PermissionFlagsBits));

// ───────────────────────── nombres ─────────────────────────

/** Clave para comparar nombres: sin emojis, separadores, mayúsculas ni tildes ("💬・General" = "general"). */
export function nameKey(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Nombres de plantillas guardadas: minúsculas, números, guiones. */
export function cleanTemplateName(raw: string): string {
  const n = raw.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!n || n.length > 32) throw new GameError('El nombre de la plantilla tiene que tener entre 1 y 32 letras, números o guiones.');
  return n;
}

// ───────────────────────── permisos ─────────────────────────

export function permBits(names: readonly PermName[] | undefined): bigint {
  let bits = 0n;
  for (const n of names ?? []) bits |= PermissionFlagsBits[n];
  return bits;
}

/** Bits → nombres, un nombre por bit (algunos permisos tienen dos nombres en discord.js). */
export function permNames(bits: bigint): PermName[] {
  const out: PermName[] = [];
  const seen = new Set<bigint>();
  for (const [name, bit] of Object.entries(PermissionFlagsBits) as [PermName, bigint][]) {
    if ((bits & bit) === bit && bit !== 0n && !seen.has(bit)) {
      seen.add(bit);
      out.push(name);
    }
  }
  return out;
}

// ───────────────────────── validación ─────────────────────────

class Check {
  constructor(private readonly where: string) {}
  fail(msg: string): never {
    throw new GameError(`Plantilla inválida (${this.where}): ${msg}`);
  }
  at(where: string): Check {
    return new Check(`${this.where} › ${where}`);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(c: Check, v: unknown, field: string, max: number, required = false): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) c.fail(`falta "${field}".`);
    return undefined;
  }
  if (typeof v !== 'string') c.fail(`"${field}" tiene que ser texto.`);
  if (required && !v.trim()) c.fail(`"${field}" está vacío.`);
  if (v.length > max) c.fail(`"${field}" supera ${max} caracteres.`);
  return v;
}

function bool(c: Check, v: unknown, field: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') c.fail(`"${field}" tiene que ser true o false.`);
  return v;
}

function int(c: Check, v: unknown, field: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) c.fail(`"${field}" tiene que ser un número entre ${min} y ${max}.`);
  return v;
}

function arr(c: Check, v: unknown, field: string, max: number): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) c.fail(`"${field}" tiene que ser una lista.`);
  if (v.length > max) c.fail(`"${field}" admite como máximo ${max} elementos.`);
  return v;
}

function perms(c: Check, v: unknown, field: string): PermName[] | undefined {
  if (v === undefined || v === null) return undefined;
  const list = arr(c, v, field, 64);
  const out: PermName[] = [];
  for (const p of list) {
    if (typeof p !== 'string' || !PERM_NAMES.has(p)) c.fail(`permiso desconocido en "${field}": ${String(p)}.`);
    if (!out.includes(p as PermName)) out.push(p as PermName);
  }
  return out;
}

function overwrites(c: Check, v: unknown): TplOverwrite[] | undefined {
  if (v === undefined || v === null) return undefined;
  return arr(c, v, 'overwrites', TEMPLATE_LIMITS.overwrites).map((o, i) => {
    const cc: Check = c.at(`permiso ${i + 1}`);
    if (!isObj(o)) cc.fail('tiene que ser un objeto.');
    return strip<TplOverwrite>({ role: str(cc, o.role, 'role', TEMPLATE_LIMITS.name, true)!, allow: perms(cc, o.allow, 'allow'), deny: perms(cc, o.deny, 'deny') });
  });
}

function url(c: Check, v: unknown, field: string, allowInvite: boolean): string | undefined {
  const s = str(c, v, field, 512);
  if (s === undefined) return undefined;
  if (allowInvite && s === '{invite}') return s;
  if (!/^https:\/\/\S+$/.test(s)) c.fail(`"${field}" tiene que ser un enlace https://${allowInvite ? ' o {invite}' : ''}.`);
  return s;
}

function message(c: Check, v: unknown): TplMessage {
  if (!isObj(v)) c.fail('tiene que ser un objeto.');
  const m: TplMessage = {
    content: str(c, v.content, 'content', TEMPLATE_LIMITS.content),
    title: str(c, v.title, 'title', TEMPLATE_LIMITS.title),
    description: str(c, v.description, 'description', TEMPLATE_LIMITS.description),
    color: int(c, v.color, 'color', 0, 0xffffff),
    footer: str(c, v.footer, 'footer', TEMPLATE_LIMITS.footer),
    image: url(c, v.image, 'image', false),
  };
  const fields = arr(c, v.fields, 'fields', TEMPLATE_LIMITS.fields).map((f, i) => {
    const cc: Check = c.at(`campo ${i + 1}`);
    if (!isObj(f)) cc.fail('tiene que ser un objeto.');
    return strip({ name: str(cc, f.name, 'name', TEMPLATE_LIMITS.fieldName, true)!, value: str(cc, f.value, 'value', TEMPLATE_LIMITS.fieldValue, true)!, inline: bool(cc, f.inline, 'inline') });
  });
  if (fields.length) m.fields = fields;
  const buttons = arr(c, v.buttons, 'buttons', TEMPLATE_LIMITS.buttons).map((b, i) => {
    const cc: Check = c.at(`botón ${i + 1}`);
    if (!isObj(b)) cc.fail('tiene que ser un objeto.');
    return strip({ label: str(cc, b.label, 'label', TEMPLATE_LIMITS.buttonLabel, true)!, url: url(cc, b.url, 'url', true)!, emoji: str(cc, b.emoji, 'emoji', 64) });
  });
  if (buttons.length) m.buttons = buttons;
  if (!m.content && !m.title && !m.description) c.fail('el mensaje necesita "content", "title" o "description".');
  return strip(m);
}

function channel(c: Check, v: unknown): TplChannel {
  if (!isObj(v)) c.fail('tiene que ser un objeto.');
  const name = str(c, v.name, 'name', TEMPLATE_LIMITS.name, true)!;
  const cc: Check = c.at(name);
  if (!KINDS.includes(v.type as ChannelKind)) cc.fail(`"type" tiene que ser ${KINDS.join(', ')}.`);
  if (v.role !== undefined && v.role !== null && !CHANNEL_ROLES.includes(v.role as ChannelRole)) cc.fail(`"role" tiene que ser ${CHANNEL_ROLES.join(', ')}.`);
  const messages = arr(cc, v.messages, 'messages', TEMPLATE_LIMITS.messagesPerChannel).map((m, i) => message(cc.at(`mensaje ${i + 1}`), m));
  return strip({
    name,
    type: v.type as ChannelKind,
    topic: str(cc, v.topic, 'topic', TEMPLATE_LIMITS.topic),
    slowmode: int(cc, v.slowmode, 'slowmode', 0, 21600),
    nsfw: bool(cc, v.nsfw, 'nsfw'),
    userLimit: int(cc, v.userLimit, 'userLimit', 0, 99),
    role: (v.role ?? undefined) as ChannelRole | undefined,
    overwrites: overwrites(cc, v.overwrites),
    messages: messages.length ? messages : undefined,
  });
}

/** Saca las claves undefined (el JSON queda limpio y los tests comparan fácil). */
function strip<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/** Valida un JSON (ya parseado) y devuelve una plantilla limpia. Tira GameError con el lugar exacto del problema. */
export function parseTemplate(raw: unknown): ServerTemplate {
  const c: Check = new Check('plantilla');
  if (!isObj(raw)) c.fail('no es un objeto JSON.');
  if (raw.format !== 'casino-template') c.fail('no es una plantilla de este bot (falta "format": "casino-template").');
  if (raw.version !== 1) c.fail('versión no soportada.');
  const roles = arr(c, raw.roles, 'roles', TEMPLATE_LIMITS.roles).map((r, i) => {
    const cc: Check = c.at(`rol ${i + 1}`);
    if (!isObj(r)) cc.fail('tiene que ser un objeto.');
    return strip<TplRole>({
      name: str(cc, r.name, 'name', TEMPLATE_LIMITS.name, true)!,
      color: int(cc, r.color, 'color', 0, 0xffffff),
      hoist: bool(cc, r.hoist, 'hoist'),
      mentionable: bool(cc, r.mentionable, 'mentionable'),
      permissions: perms(cc, r.permissions, 'permissions'),
      selfAssign: bool(cc, r.selfAssign, 'selfAssign'),
      giveToExecutor: bool(cc, r.giveToExecutor, 'giveToExecutor'),
    });
  });
  const seenRoles = new Set<string>();
  for (const r of roles) {
    const k = nameKey(r.name);
    if (!k) c.fail(`el rol "${r.name}" necesita letras o números en el nombre.`);
    if (seenRoles.has(k)) c.fail(`rol repetido: "${r.name}".`);
    seenRoles.add(k);
  }
  const channels = arr(c, raw.channels, 'channels', TEMPLATE_LIMITS.channelsPerCategory).map((ch) => channel(c.at('sin categoría'), ch));
  const categories = arr(c, raw.categories, 'categories', TEMPLATE_LIMITS.categories).map((cat, i) => {
    const cc: Check = c.at(`categoría ${i + 1}`);
    if (!isObj(cat)) cc.fail('tiene que ser un objeto.');
    const name = str(cc, cat.name, 'name', TEMPLATE_LIMITS.name, true)!;
    return strip<TplCategory>({
      name,
      overwrites: overwrites(cc.at(name), cat.overwrites),
      channels: arr(cc, cat.channels, 'channels', TEMPLATE_LIMITS.channelsPerCategory).map((ch) => channel(cc.at(name), ch)),
    });
  });
  const total = channels.length + categories.reduce((n, cat) => n + cat.channels.length + 1, 0);
  if (total > TEMPLATE_LIMITS.channels) c.fail(`tiene ${total} canales y categorías; el máximo es ${TEMPLATE_LIMITS.channels}.`);
  const tpl: ServerTemplate = {
    format: 'casino-template',
    version: 1,
    name: str(c, raw.name, 'name', 100, true)!,
    description: str(c, raw.description, 'description', 500),
    roles,
    channels,
    categories,
  };
  if (isObj(raw.settings)) {
    const s = raw.settings;
    const cc: Check = c.at('settings');
    const pick = <T extends string>(v: unknown, field: string, allowed: readonly T[]): T | undefined => {
      if (v === undefined || v === null) return undefined;
      if (!allowed.includes(v as T)) cc.fail(`"${field}" tiene que ser ${allowed.join(', ')}.`);
      return v as T;
    };
    tpl.settings = strip<TplSettings>({
      verification: pick(s.verification, 'verification', ['none', 'low', 'medium', 'high', 'very_high'] as const),
      contentFilter: pick(s.contentFilter, 'contentFilter', ['off', 'no_role', 'all'] as const),
      notifications: pick(s.notifications, 'notifications', ['all', 'mentions'] as const),
      community: bool(cc, s.community, 'community'),
    });
  }
  if (isObj(raw.bot)) {
    const cc: Check = c.at('bot');
    tpl.bot = strip<TplBot>({
      logs: bool(cc, raw.bot.logs, 'logs'),
      tempVoice: bool(cc, raw.bot.tempVoice, 'tempVoice'),
      selfRolesTitle: str(cc, raw.bot.selfRolesTitle, 'selfRolesTitle', 60),
      selfRolesDescription: str(cc, raw.bot.selfRolesDescription, 'selfRolesDescription', 300),
    });
  }
  return strip(tpl);
}

/** Lee el texto de un archivo .json (o pegado) y lo valida. */
export function parseTemplateText(text: string): ServerTemplate {
  if (Buffer.byteLength(text, 'utf8') > TEMPLATE_LIMITS.bytes) throw new GameError(`La plantilla supera ${TEMPLATE_LIMITS.bytes / 1024} KB.`);
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new GameError('El archivo no es un JSON válido.');
  }
  return parseTemplate(raw);
}

export function templateToText(tpl: ServerTemplate): string {
  return `${JSON.stringify(tpl, null, 2)}\n`;
}

export function templateStats(tpl: ServerTemplate): { roles: number; categories: number; channels: number; messages: number } {
  const all = [...tpl.channels, ...tpl.categories.flatMap((c) => c.channels)];
  return { roles: tpl.roles.length, categories: tpl.categories.length, channels: all.length, messages: all.reduce((n, ch) => n + (ch.messages?.length ?? 0), 0) };
}

// ───────────────────────── copiar (foto de un servidor) ─────────────────────────

/** Datos planos de un servidor (los arma la capa de Discord; así esto se puede testear sin Discord). */
export interface GuildSnapshot {
  name: string;
  everyoneId: string;
  roles: { id: string; name: string; color: number; hoist: boolean; mentionable: boolean; permissions: bigint; managed: boolean; position: number }[];
  /** type: número de ChannelType de Discord (0 texto, 2 voz, 4 categoría, 5 anuncios, 13 escenario, 15 foro). */
  channels: {
    id: string; name: string; type: number; parentId: string | null; position: number;
    topic?: string | null; nsfw?: boolean; slowmode?: number; userLimit?: number;
    overwrites: { id: string; type: 'role' | 'member'; allow: bigint; deny: bigint }[];
  }[];
  systemChannelId?: string | null;
  rulesChannelId?: string | null;
  modUpdatesChannelId?: string | null;
  verification?: number;
  contentFilter?: number;
  notifications?: number;
  community?: boolean;
}

const TYPE_OF: Record<number, ChannelKind> = { 0: 'text', 2: 'voice', 5: 'announcement', 13: 'stage', 15: 'forum' };
const VERIFICATION = ['none', 'low', 'medium', 'high', 'very_high'] as const;
const FILTER = ['off', 'no_role', 'all'] as const;
const NOTIF = ['all', 'mentions'] as const;

/**
 * Convierte un servidor en plantilla: roles (sin @everyone ni los de bots/integraciones), categorías, canales,
 * temas y permisos por rol. No copia mensajes, miembros ni permisos de personas puntuales.
 */
export function snapshotToTemplate(s: GuildSnapshot, name: string): ServerTemplate {
  const roleName = new Map<string, string>([[s.everyoneId, '@everyone']]);
  const roles: TplRole[] = [];
  const used = new Set<string>();
  for (const r of [...s.roles].sort((a, b) => b.position - a.position)) {
    if (r.id === s.everyoneId || r.managed) continue;
    let n = r.name.slice(0, TEMPLATE_LIMITS.name);
    if (!nameKey(n)) n = `rol-${roles.length + 1}`;
    // Dos roles con el mismo nombre: el segundo pasa a "Nombre (2)" para que los permisos no se mezclen.
    for (let i = 2; used.has(nameKey(n)); i++) n = `${r.name.slice(0, 90)} (${i})`;
    used.add(nameKey(n));
    roleName.set(r.id, n);
    if (roles.length >= TEMPLATE_LIMITS.roles) break;
    roles.push(strip<TplRole>({
      name: n,
      color: r.color || undefined,
      hoist: r.hoist || undefined,
      mentionable: r.mentionable || undefined,
      permissions: r.permissions ? permNames(r.permissions) : undefined,
    }));
  }
  const ows = (list: GuildSnapshot['channels'][number]['overwrites']): TplOverwrite[] | undefined => {
    const out = list
      .filter((o) => o.type === 'role' && roleName.has(o.id) && (o.allow || o.deny))
      .slice(0, TEMPLATE_LIMITS.overwrites)
      .map((o) => strip<TplOverwrite>({ role: roleName.get(o.id)!, allow: o.allow ? permNames(o.allow) : undefined, deny: o.deny ? permNames(o.deny) : undefined }));
    return out.length ? out : undefined;
  };
  const special = (id: string): ChannelRole | undefined =>
    id === s.systemChannelId ? 'system' : id === s.rulesChannelId ? 'rules' : id === s.modUpdatesChannelId ? 'modUpdates' : undefined;
  const toChannel = (ch: GuildSnapshot['channels'][number]): TplChannel | null => {
    const type = TYPE_OF[ch.type];
    if (!type) return null;
    return strip<TplChannel>({
      name: ch.name.slice(0, TEMPLATE_LIMITS.name),
      type,
      topic: ch.topic ? ch.topic.slice(0, TEMPLATE_LIMITS.topic) : undefined,
      slowmode: ch.slowmode || undefined,
      nsfw: ch.nsfw || undefined,
      userLimit: type === 'voice' && ch.userLimit ? Math.min(99, ch.userLimit) : undefined,
      role: special(ch.id),
      overwrites: ows(ch.overwrites),
    });
  };
  const byPos = (a: { position: number; type: number }, b: { position: number; type: number }) => {
    // Discord ordena texto antes que voz dentro de una categoría.
    const voice = (t: number) => (t === 2 || t === 13 ? 1 : 0);
    return voice(a.type) - voice(b.type) || a.position - b.position;
  };
  const cats = s.channels.filter((c) => c.type === 4).sort((a, b) => a.position - b.position).slice(0, TEMPLATE_LIMITS.categories);
  const kids = (parentId: string | null) => s.channels.filter((c) => c.type !== 4 && c.parentId === parentId).sort(byPos)
    .map(toChannel).filter((c): c is TplChannel => !!c).slice(0, TEMPLATE_LIMITS.channelsPerCategory);
  const tpl: ServerTemplate = {
    format: 'casino-template',
    version: 1,
    name: s.name.slice(0, 100) || name,
    description: `Copia de ${s.name}`.slice(0, 500),
    roles,
    channels: kids(null),
    categories: cats.map((cat) => strip<TplCategory>({ name: cat.name.slice(0, TEMPLATE_LIMITS.name), overwrites: ows(cat.overwrites), channels: kids(cat.id) })),
    settings: strip<TplSettings>({
      verification: s.verification !== undefined ? VERIFICATION[s.verification] : undefined,
      contentFilter: s.contentFilter !== undefined ? FILTER[s.contentFilter] : undefined,
      notifications: s.notifications !== undefined ? NOTIF[s.notifications] : undefined,
      community: s.community || undefined,
    }),
  };
  // Si algo se pasó de los límites, el recorte de arriba ya lo resolvió; se vuelve a validar por las dudas.
  return parseTemplate(JSON.parse(JSON.stringify(tpl)));
}

// ───────────────────────── pegar (plan) ─────────────────────────

export interface ExistingGuild {
  roles: string[];
  categories: string[];
  /** Canales con el nombre de su categoría (null = sin categoría). */
  channels: { name: string; kind: ChannelKind | 'other'; parent: string | null }[];
}

export interface ApplyPlan {
  createRoles: TplRole[];
  reuseRoles: TplRole[];
  createCategories: string[];
  reuseCategories: string[];
  createChannels: { channel: TplChannel; parent: string | null }[];
  reuseChannels: { channel: TplChannel; parent: string | null }[];
}

const sameFamily = (a: ChannelKind | 'other', b: ChannelKind): boolean => {
  const fam = (k: ChannelKind | 'other') => (k === 'voice' || k === 'stage' ? 'voice' : k === 'other' ? 'other' : 'text');
  return fam(a) === fam(b);
};

/** Qué se crea y qué se reutiliza (por nombre, sin importar emojis ni mayúsculas). Nunca hay borrados. */
export function planApply(tpl: ServerTemplate, existing: ExistingGuild): ApplyPlan {
  const roleKeys = new Set(existing.roles.map(nameKey));
  const catKeys = new Set(existing.categories.map(nameKey));
  const plan: ApplyPlan = { createRoles: [], reuseRoles: [], createCategories: [], reuseCategories: [], createChannels: [], reuseChannels: [] };
  for (const r of tpl.roles) (roleKeys.has(nameKey(r.name)) ? plan.reuseRoles : plan.createRoles).push(r);
  const has = (ch: TplChannel, parent: string | null) => existing.channels.some((e) =>
    nameKey(e.name) === nameKey(ch.name) && sameFamily(e.kind, ch.type) && (e.parent === null ? parent === null : parent !== null && nameKey(e.parent) === nameKey(parent)));
  for (const ch of tpl.channels) (has(ch, null) ? plan.reuseChannels : plan.createChannels).push({ channel: ch, parent: null });
  for (const cat of tpl.categories) {
    (catKeys.has(nameKey(cat.name)) ? plan.reuseCategories : plan.createCategories).push(cat.name);
    for (const ch of cat.channels) (has(ch, cat.name) ? plan.reuseChannels : plan.createChannels).push({ channel: ch, parent: cat.name });
  }
  return plan;
}

/** Reemplaza {server} {bot} {invite} {prefix} {user}, {#canal} y {@&rol} en los textos de los mensajes. */
export function fillTemplateText(text: string, v: {
  server: string; bot: string; invite: string; prefix: string; user: string;
  channel: (name: string) => string | null; role: (name: string) => string | null;
}): string {
  return text
    .replace(/\{#([^{}]{1,100})\}/g, (m, n: string) => { const id = v.channel(n); return id ? `<#${id}>` : `#${n}`; })
    .replace(/\{@&([^{}]{1,100})\}/g, (m, n: string) => { const id = v.role(n); return id ? `<@&${id}>` : `@${n}`; })
    .replace(/\{(server|bot|invite|prefix|user)\}/g, (m, k: 'server' | 'bot' | 'invite' | 'prefix' | 'user') => v[k]);
}

// ───────────────────────── guardadas ─────────────────────────

export interface SavedTemplate {
  name: string;
  template: ServerTemplate;
  createdBy: string;
  sourceGuild: string | null;
  createdAt: number;
  updatedAt: number;
}

interface TemplateRow { name: string; data: string; created_by: string; source_guild: string | null; created_at: number; updated_at: number }

export const BUILTIN_TEMPLATE = 'bot';

export function saveTemplate(ctx: GameContext, rawName: string, tpl: ServerTemplate, opts: { by: string; sourceGuild?: string | null; replace?: boolean }): SavedTemplate {
  const name = cleanTemplateName(rawName);
  if (name === BUILTIN_TEMPLATE) throw new GameError(`"${BUILTIN_TEMPLATE}" es la plantilla incluida en el bot; elegí otro nombre.`);
  const data = templateToText(parseTemplate(tpl));
  if (Buffer.byteLength(data, 'utf8') > TEMPLATE_LIMITS.bytes) throw new GameError(`La plantilla supera ${TEMPLATE_LIMITS.bytes / 1024} KB.`);
  return ctx.db.transaction(() => {
    const prev = ctx.db.get<TemplateRow>('SELECT * FROM server_templates WHERE name = ?', name);
    if (prev && !opts.replace) throw new GameError(`Ya existe una plantilla llamada **${name}**. Usá otro nombre o la opción de reemplazar.`);
    if (!prev) {
      const n = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM server_templates')!.n;
      if (n >= TEMPLATE_LIMITS.templates) throw new GameError(`Máximo ${TEMPLATE_LIMITS.templates} plantillas guardadas. Borrá alguna primero.`);
      ctx.db.run('INSERT INTO server_templates (name, data, created_by, source_guild, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        name, data, opts.by, opts.sourceGuild ?? null, ctx.now(), ctx.now());
    } else {
      ctx.db.run('UPDATE server_templates SET data = ?, created_by = ?, source_guild = ?, updated_at = ? WHERE name = ?', data, opts.by, opts.sourceGuild ?? null, ctx.now(), name);
    }
    return getTemplate(ctx, name)!;
  });
}

export function getTemplate(ctx: GameContext, rawName: string): SavedTemplate | null {
  const name = cleanTemplateName(rawName);
  if (name === BUILTIN_TEMPLATE) {
    return { name, template: botServerTemplate(), createdBy: 'bot', sourceGuild: null, createdAt: 0, updatedAt: 0 };
  }
  const r = ctx.db.get<TemplateRow>('SELECT * FROM server_templates WHERE name = ?', name);
  if (!r) return null;
  return { name: r.name, template: parseTemplateText(r.data), createdBy: r.created_by, sourceGuild: r.source_guild, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listTemplates(ctx: GameContext): { name: string; createdBy: string; updatedAt: number; size: number }[] {
  return ctx.db.all<{ name: string; created_by: string; updated_at: number; size: number }>(
    'SELECT name, created_by, updated_at, LENGTH(data) AS size FROM server_templates ORDER BY updated_at DESC',
  ).map((r) => ({ name: r.name, createdBy: r.created_by, updatedAt: r.updated_at, size: r.size }));
}

export function deleteTemplate(ctx: GameContext, rawName: string): void {
  const name = cleanTemplateName(rawName);
  if (name === BUILTIN_TEMPLATE) throw new GameError('La plantilla incluida en el bot no se puede borrar.');
  if (!ctx.db.run('DELETE FROM server_templates WHERE name = ?', name).changes) throw new GameError(`No existe la plantilla **${name}**.`);
}

// ───────────────────────── plantilla incluida: servidor del bot ─────────────────────────

const C = { gold: 0xf1c40f, red: 0xe74c3c, blue: 0x3498db, green: 0x2ecc71, purple: 0x9b59b6, pink: 0xf47fff, gray: 0x95a5a6, teal: 0x1abc9c, orange: 0xe67e22 };

const READ_ONLY: TplOverwrite[] = [
  { role: '@everyone', allow: ['ViewChannel', 'ReadMessageHistory', 'AddReactions'], deny: ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads'] },
  { role: '🛠️ Staff', allow: ['SendMessages'] },
];
const STAFF_ONLY: TplOverwrite[] = [
  { role: '@everyone', deny: ['ViewChannel'] },
  { role: '🛠️ Staff', allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'Connect', 'Speak'] },
];

/**
 * Servidor oficial del bot: presentación, invitación, anuncios y novedades, casino para probarlo, comunidad,
 * soporte y una zona privada del staff. Lo crea /setupdiscord.
 */
export function botServerTemplate(): ServerTemplate {
  return parseTemplate({
    format: 'casino-template',
    version: 1,
    name: 'Servidor oficial del bot',
    description: 'Servidor de soporte y promoción: anuncios, novedades, invitación, casino para probar, comunidad y soporte.',
    roles: [
      { name: '👑 Fundador', color: C.gold, hoist: true, permissions: ['Administrator'], giveToExecutor: true },
      { name: '🛠️ Staff', color: C.red, hoist: true, mentionable: true, permissions: ['ViewAuditLog', 'ManageMessages', 'ManageThreads', 'ManageNicknames', 'KickMembers', 'ModerateMembers', 'MuteMembers', 'MoveMembers', 'DeafenMembers', 'MentionEveryone'] },
      { name: '🧰 Soporte', color: C.blue, hoist: true, mentionable: true, permissions: ['ManageMessages', 'ManageThreads', 'ModerateMembers'] },
      { name: '🤝 Partner', color: C.teal, hoist: true },
      { name: '💎 VIP', color: C.pink, hoist: true },
      { name: '🧪 Beta tester', color: C.purple, selfAssign: true },
      { name: '📢 Anuncios', color: C.orange, mentionable: true, selfAssign: true },
      { name: '🆕 Novedades', color: C.green, mentionable: true, selfAssign: true },
      { name: '🏆 Torneos', color: C.gold, mentionable: true, selfAssign: true },
      { name: '🎁 Sorteos', color: C.pink, mentionable: true, selfAssign: true },
      { name: '🤖 Bots', color: C.gray, hoist: true },
      { name: '👤 Miembro', color: C.gray },
    ],
    channels: [],
    categories: [
      {
        name: '📌 Información',
        channels: [
          {
            name: '👋・bienvenida', type: 'text', role: 'system', topic: 'Bienvenidos al servidor oficial de {bot}.', overwrites: READ_ONLY,
            messages: [{
              title: '🎰 Bienvenido al servidor oficial de {bot}',
              description: '**{bot}** es un casino **virtual** para Discord: juegos con botones y animaciones, economía, trabajos, ranking, torneos, logros, casamientos y mucho más.\n\n🪙 Todo usa **Coins**, una moneda interna: no se compra, no se vende y no se cambia por dinero real.\n\n**Para empezar:**\n• Leé {#📜・reglas}\n• Elegí tus notificaciones en {#🎭・roles}\n• Probá el bot en {#🎲・casino}\n• ¿Lo querés en tu servidor? {#🔗・invitar-bot}',
              color: C.gold,
              footer: '{server}',
              buttons: [{ label: 'Invitar a {bot}', url: '{invite}', emoji: '🔗' }],
            }],
          },
          {
            name: '📜・reglas', type: 'text', role: 'rules', overwrites: READ_ONLY,
            messages: [{
              title: '📜 Reglas del servidor',
              description: '**1.** Respeto ante todo: nada de insultos, acoso, discriminación ni discursos de odio.\n**2.** Sin spam, flood ni publicidad sin permiso (fuera de {#🤝・partners}).\n**3.** Nada de contenido NSFW, gore ni ilegal.\n**4.** Las Coins son **virtuales**: está prohibido comprarlas, venderlas o intercambiarlas por dinero real o por cosas fuera del bot.\n**5.** Nada de multicuentas, bots ni scripts para farmear la economía.\n**6.** Usá cada canal para lo que es; los comandos van en {#🤖・comandos} y {#🎲・casino}.\n**7.** Seguí los [Términos de Servicio](https://discord.com/terms) y las [Normas de la Comunidad](https://discord.com/guidelines) de Discord.\n**8.** El staff tiene la última palabra. Si tenés un problema, abrí una consulta en {#❓・soporte}.',
              color: C.red,
              footer: 'Al participar aceptás estas reglas.',
            }],
          },
          {
            name: '📢・anuncios', type: 'announcement', topic: 'Anuncios oficiales de {bot}.', overwrites: READ_ONLY,
            messages: [{
              title: '🎉 ¡Abrimos el servidor oficial!',
              description: 'Este es el lugar oficial de **{bot}**: acá vas a encontrar los anuncios, las novedades de cada versión, torneos y soporte.\n\nActivá {@&📢 Anuncios} en {#🎭・roles} para que te avisemos de lo importante.',
              color: C.orange,
            }],
          },
          {
            name: '🆕・novedades', type: 'announcement', topic: 'Changelog: qué trae cada actualización del bot.', overwrites: READ_ONLY,
            messages: [{
              title: '🆕 Novedades',
              description: 'Acá se publica qué cambia en cada actualización de **{bot}**.\n\n**Lo que ya trae:**\n🎲 10 juegos de casino con botones y animaciones\n💼 `{prefix}work` con trabajos (de Cirujeando a Hacker)\n📅 Recompensas diarias y semanales\n🏆 Ranking, torneos y logros\n💍 `{prefix}marry`, `{prefix}kiss` y `{prefix}profile`\n🚀 Boost tracker y 🪝 anti-webhooks\n🌐 Español e inglés (`{prefix}setlang`)\n\nActivá {@&🆕 Novedades} en {#🎭・roles} para enterarte de cada versión.',
              color: C.green,
            }],
          },
          {
            name: '🔗・invitar-bot', type: 'text', topic: 'Agregá {bot} a tu servidor.', overwrites: READ_ONLY,
            messages: [{
              title: '🔗 Llevá {bot} a tu servidor',
              description: '1. Tocá **Invitar** y elegí tu servidor (necesitás *Gestionar servidor*).\n2. Escribí `/ayuda` para ver todo lo que hace.\n3. Configurá los registros con `/setup` y la voz temporal con `/voz`.\n\n¿Dudas? Preguntá en {#❓・soporte}.',
              color: C.blue,
              buttons: [{ label: 'Invitar', url: '{invite}', emoji: '🤖' }],
            }],
          },
          {
            name: '🎭・roles', type: 'text', role: 'selfRoles', topic: 'Elegí qué avisos querés recibir.', overwrites: READ_ONLY,
          },
          {
            name: '🚀・boosts', type: 'text', role: 'boost', topic: 'Gracias a quienes boostean el servidor 💖', overwrites: READ_ONLY,
          },
        ],
      },
      {
        name: '🎰 Casino',
        channels: [
          { name: '🎲・casino', type: 'text', topic: 'Jugá con `/casino`. Coins 100% virtuales.' },
          { name: '💼・trabajos', type: 'text', topic: 'Trabajá con `{prefix}work`, cobrá tu `{prefix}daily` y tu semanal.', slowmode: 3 },
          { name: '🏆・torneos', type: 'text', topic: 'Torneos del casino y sus resultados.', overwrites: READ_ONLY },
          { name: '🎁・sorteos', type: 'text', topic: 'Sorteos y eventos (siempre con Coins virtuales).', overwrites: READ_ONLY },
        ],
      },
      {
        name: '💬 Comunidad',
        channels: [
          { name: '💬・general', type: 'text', topic: 'Charla general. Respeto ante todo.' },
          { name: '🤖・comandos', type: 'text', topic: 'Usá los comandos del bot acá.' },
          { name: '📸・media', type: 'text', topic: 'Imágenes, clips y memes.', slowmode: 5 },
          { name: '💡・sugerencias', type: 'forum', topic: 'Una sugerencia por publicación. Votá con reacciones.' },
          { name: '🤝・partners', type: 'text', topic: 'Servidores aliados. Para ser partner, abrí una consulta en soporte.', overwrites: READ_ONLY },
        ],
      },
      {
        name: '🆘 Soporte',
        channels: [
          {
            name: '📖・preguntas-frecuentes', type: 'text', topic: 'Respuestas rápidas.', overwrites: READ_ONLY,
            messages: [{
              title: '📖 Preguntas frecuentes',
              color: C.blue,
              description: 'Antes de preguntar en {#❓・soporte}, fijate si tu duda está acá.',
              fields: [
                { name: '¿Las Coins se pueden comprar o vender?', value: 'No. Son **virtuales**: no se compran, no se retiran y no se cambian por dinero real.' },
                { name: '¿Cómo gano Coins?', value: '`{prefix}daily`, `{prefix}weekly` y `{prefix}work`. La economía es difícil a propósito.' },
                { name: '¿Cómo cambio el idioma?', value: '`{prefix}setlang es` (Español) o `{prefix}setlang en` (English).' },
                { name: '¿Cómo configuro los registros y la voz temporal?', value: '`/setup` para registros y `/voz` para la voz temporal. Al actualizar el bot se ajustan solos.' },
                { name: 'El bot no responde', value: 'Revisá que tenga permisos para ver y escribir en el canal, y probá con `/ayuda`.' },
              ],
            }],
          },
          { name: '❓・soporte', type: 'text', topic: 'Contanos tu problema con detalle (servidor, comando y qué pasó).', slowmode: 10 },
          { name: '🐛・reportar-bugs', type: 'forum', topic: 'Un bug por publicación: qué hiciste, qué esperabas y qué pasó.' },
        ],
      },
      {
        name: '🔊 Voz',
        channels: [
          { name: '🔊 General', type: 'voice' },
          { name: '🎮 Gaming', type: 'voice' },
          { name: '🎵 Música', type: 'voice' },
          { name: '🎙️ Soporte por voz', type: 'voice', userLimit: 5 },
        ],
      },
      {
        name: '🛡️ Staff',
        overwrites: STAFF_ONLY,
        channels: [
          { name: '🛡️・staff-chat', type: 'text', overwrites: STAFF_ONLY },
          { name: '📋・avisos-discord', type: 'text', role: 'modUpdates', overwrites: STAFF_ONLY, topic: 'Avisos de Discord para la moderación.' },
          { name: '🧪・pruebas-bot', type: 'text', overwrites: STAFF_ONLY, topic: 'Probar comandos y versiones nuevas del bot.' },
          { name: '🔒 Staff', type: 'voice', overwrites: STAFF_ONLY },
        ],
      },
    ],
    settings: { verification: 'medium', contentFilter: 'all', notifications: 'mentions', community: true },
    bot: {
      logs: true,
      tempVoice: true,
      selfRolesTitle: 'Notificaciones',
      selfRolesDescription: 'Elegí de qué querés enterarte. Podés cambiarlo cuando quieras.',
    },
  });
}

import type { LinkMode } from './moderation';

/**
 * Detectores del automod: puros y en memoria (sin discord.js), para probarlos sin Discord.
 * Todo tiene ventanas de tiempo y un barrido periódico: la memoria no crece sin límite.
 */

/** Minúsculas, sin espacios repetidos ni caracteres invisibles: "HOLA  " y "hola" cuentan como repetidos. */
export function normalizeContent(s: string): string {
  return s.toLowerCase().replace(/[​-‏⁠﻿]/g, '').replace(/\s+/g, ' ').trim();
}

const INVITE = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg|invite\.gg)\/[\w-]+/gi;
// URLs con esquema, o dominios "pelados" (ej: spam.ru/oferta). El dominio necesita un TLD de 2+ letras.
const BARE_URL = /\b(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?::\d{2,5})?(?:\/[^\s<>()]*)?/gi;
const SCHEME_URL = /https?:\/\/[^\s<>]+/gi;

export interface FoundLinks {
  invites: string[];
  hosts: string[];
}

/** Invitaciones de Discord y dominios de enlaces en un mensaje (ignora lo que está entre <> sin esquema y menciones). */
export function findLinks(content: string): FoundLinks {
  const invites = [...content.matchAll(INVITE)].map((m) => m[0]);
  const hosts = new Set<string>();
  // Con esquema: siempre cuenta.
  for (const m of content.matchAll(SCHEME_URL)) {
    try {
      hosts.add(new URL(m[0]).hostname.toLowerCase().replace(/^www\./, ''));
    } catch { /* URL rota: se ignora */ }
  }
  // Sin esquema: solo dominios con TLD conocido de forma laxa (evita "hola.que tal", "v1.2").
  for (const m of content.matchAll(BARE_URL)) {
    if (m.index && content[m.index - 1] === '@') continue; // un correo (nombre@dominio.com) no es un enlace
    const host = m[1].toLowerCase().replace(/^www\./, '');
    const tld = host.split('.').pop() ?? '';
    if (/^\d+$/.test(tld)) continue;
    if (m[0].startsWith('http') || COMMON_TLDS.has(tld)) hosts.add(host);
  }
  return { invites, hosts: [...hosts] };
}

const COMMON_TLDS = new Set([
  'com', 'net', 'org', 'io', 'gg', 'me', 'co', 'xyz', 'ru', 'ar', 'es', 'mx', 'cl', 'uy', 'br', 'tv', 'app', 'dev', 'info', 'link', 'site',
  'online', 'shop', 'store', 'live', 'fun', 'top', 'club', 'click', 'cc', 'ly', 'be', 'to', 'us', 'uk', 'de', 'fr', 'it', 'pe', 'co', 've', 'cn',
]);

/** Dominios de Discord que nunca se bloquean en modo "todos" (enlaces a mensajes, adjuntos y stickers). */
const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'discordapp.net', 'cdn.discordapp.com', 'media.discordapp.net'];

export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase();
  return [...DISCORD_HOSTS, ...allow].some((d) => h === d || h.endsWith(`.${d}`));
}

/** Motivo si el mensaje rompe la regla de enlaces; null si está bien. */
export function linkViolation(content: string, mode: LinkMode, allow: string[]): string | null {
  if (mode === 'off' || !content) return null;
  const found = findLinks(content);
  if (found.invites.length) return 'no se permiten invitaciones a otros servidores';
  if (mode === 'all' && found.hosts.some((h) => !hostAllowed(h, allow))) return 'no se permiten enlaces en este servidor';
  return null;
}

export function lineCount(content: string): number {
  return content ? content.split('\n').length : 0;
}

// ───────────────────────── Ráfagas de mensajes (spam y repetidos) ─────────────────────────

export interface TrackedMessage {
  id: string;
  channelId: string;
  hash: string;
  at: number;
}

/**
 * Últimos mensajes de cada persona (por servidor). Con eso se detecta:
 * - spam: más de N mensajes en X segundos;
 * - flood de repetidos: el mismo texto N veces en 30 s.
 */
export class MessageTracker {
  private readonly byKey = new Map<string, TrackedMessage[]>();

  constructor(private readonly keepMs = 60_000, private readonly maxPerKey = 50) {}

  record(key: string, msg: TrackedMessage): void {
    const list = (this.byKey.get(key) ?? []).filter((m) => msg.at - m.at < this.keepMs);
    list.push(msg);
    if (list.length > this.maxPerKey) list.splice(0, list.length - this.maxPerKey);
    this.byKey.set(key, list);
  }

  /** Mensajes de los últimos `windowMs`. */
  recent(key: string, now: number, windowMs: number): TrackedMessage[] {
    return (this.byKey.get(key) ?? []).filter((m) => m.at <= now && now - m.at < windowMs);
  }

  /** Cuántas veces se repitió `hash` en los últimos `windowMs` (incluido el último). */
  duplicates(key: string, hash: string, now: number, windowMs = 30_000): number {
    return this.recent(key, now, windowMs).filter((m) => m.hash === hash && hash !== '').length;
  }

  clear(key: string): void {
    this.byKey.delete(key);
  }

  sweep(now: number): void {
    for (const [k, list] of this.byKey) if (list.every((m) => now - m.at >= this.keepMs)) this.byKey.delete(k);
  }

  get size(): number {
    return this.byKey.size;
  }
}

/** Infracciones recientes por persona (para convertir varias infracciones leves en una advertencia). */
export class StrikeTracker {
  private readonly byKey = new Map<string, number[]>();

  constructor(private readonly windowMs = 10 * 60_000) {}

  add(key: string, now: number): number {
    const list = (this.byKey.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.byKey.set(key, list);
    return list.length;
  }

  reset(key: string): void {
    this.byKey.delete(key);
  }

  sweep(now: number): void {
    for (const [k, list] of this.byKey) if (list.every((t) => now - t >= this.windowMs)) this.byKey.delete(k);
  }
}

// ───────────────────────── Raids (muchas entradas juntas) ─────────────────────────

export class JoinTracker {
  private readonly byGuild = new Map<string, { userId: string; at: number }[]>();

  constructor(private readonly keepMs = 10 * 60_000) {}

  /** Registra una entrada y devuelve cuántas hubo en los últimos `windowMs`. */
  record(guildId: string, userId: string, now: number, windowMs: number): number {
    const list = (this.byGuild.get(guildId) ?? []).filter((j) => now - j.at < this.keepMs);
    list.push({ userId, at: now });
    if (list.length > 500) list.splice(0, list.length - 500);
    this.byGuild.set(guildId, list);
    return list.filter((j) => now - j.at < windowMs).length;
  }

  recent(guildId: string, now: number, windowMs: number): string[] {
    return (this.byGuild.get(guildId) ?? []).filter((j) => j.at <= now && now - j.at < windowMs).map((j) => j.userId);
  }

  sweep(now: number): void {
    for (const [k, list] of this.byGuild) if (list.every((j) => now - j.at >= this.keepMs)) this.byGuild.delete(k);
  }
}

/** ¿La cuenta es "nueva" para el modo raid? (0 días = todas las cuentas cuentan). */
export function isNewAccount(createdAt: number, now: number, days: number): boolean {
  return days <= 0 || now - createdAt < days * 86_400_000;
}

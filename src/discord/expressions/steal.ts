import {
  GuildPremiumTier, PermissionFlagsBits, StickerFormatType, StickerType, type Guild, type GuildMember, type Message, type Sticker,
} from 'discord.js';
import { GameError } from '../../services/context';

/**
 * !steal — copia emojis personalizados o stickers de un mensaje a este servidor, dentro de lo que Discord permite:
 * - hace falta el permiso de crear/gestionar expresiones (la persona y el bot);
 * - se respetan los lugares libres según el nivel de mejoras del servidor;
 * - los stickers Lottie y los oficiales de Discord no se pueden subir (Discord no lo permite): se avisa en lugar de intentarlo;
 * - las imágenes se descargan solo del CDN de Discord, con límite de tamaño y de tiempo.
 */

export interface EmojiRef {
  kind: 'emoji';
  id: string;
  name: string;
  animated: boolean;
}

export interface StickerRef {
  kind: 'sticker';
  id: string;
  name: string;
  format: StickerFormatType;
  /** null = sticker oficial de Discord (no se puede copiar). */
  guildId: string | null;
  tags: string | null;
}

export type Expression = EmojiRef | StickerRef;

export const MAX_PER_STEAL = 10;
const EMOJI_MAX_BYTES = 256 * 1024;
const STICKER_MAX_BYTES = 512 * 1024;

/** Emojis personalizados de un texto (<:nombre:id> y <a:nombre:id>), sin repetir. */
export function parseCustomEmojis(text: string): EmojiRef[] {
  const out = new Map<string, EmojiRef>();
  for (const m of text.matchAll(/<(a?):(\w{2,32}):(\d{17,20})>/g)) {
    if (!out.has(m[3])) out.set(m[3], { kind: 'emoji', id: m[3], name: m[2], animated: m[1] === 'a' });
  }
  return [...out.values()];
}

export function stickerRef(s: Sticker): StickerRef {
  return { kind: 'sticker', id: s.id, name: s.name, format: s.format, guildId: s.type === StickerType.Standard ? null : s.guildId ?? 'otro', tags: s.tags };
}

/** Lugares de emojis (por tipo: estáticos y animados por separado) y de stickers según las mejoras del servidor. */
export function emojiSlots(tier: GuildPremiumTier): number {
  return [50, 100, 150, 250][tier] ?? 50;
}

export function stickerSlots(tier: GuildPremiumTier): number {
  return [5, 15, 30, 60][tier] ?? 5;
}

/** Nombre válido de emoji: 2 a 32 caracteres, letras, números o guion bajo. */
export function cleanEmojiName(raw: string): string {
  const n = raw.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').slice(0, 32);
  return n.length >= 2 ? n : `emoji_${n}`.slice(0, 32);
}

export function cleanStickerName(raw: string): string {
  const n = raw.replace(/[\n\r@#:`]/g, ' ').trim().slice(0, 30);
  return n.length >= 2 ? n : `sticker ${n}`.trim();
}

export function expressionUrl(e: Expression): string {
  if (e.kind === 'emoji') return `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=128&quality=lossless`;
  return `https://media.discordapp.net/stickers/${e.id}.${e.format === StickerFormatType.GIF ? 'gif' : 'png'}?size=320`;
}

/** Motivo por el que no se puede copiar (o null si se puede). */
export function unsupportedReason(guild: Guild, e: Expression): string | null {
  if (e.kind === 'emoji') return guild.emojis.cache.has(e.id) ? 'ya es de este servidor' : null;
  if (e.guildId === null) return 'es un sticker oficial de Discord';
  if (e.format === StickerFormatType.Lottie) return 'es un sticker animado Lottie (Discord no permite subirlos)';
  if (guild.stickers.cache.has(e.id)) return 'ya es de este servidor';
  return null;
}

export function assertCanSteal(member: GuildMember): void {
  const can = (m: GuildMember) => m.permissions.has(PermissionFlagsBits.CreateGuildExpressions) || m.permissions.has(PermissionFlagsBits.ManageGuildExpressions);
  if (!can(member)) throw new GameError('Necesitás el permiso **Crear expresiones** (o **Gestionar expresiones**) para agregar emojis y stickers.');
  const me = member.guild.members.me;
  if (!me || !can(me)) throw new GameError('Me falta el permiso **Crear expresiones** (o **Gestionar expresiones**) en este servidor.');
}

/** Todo lo copiable de un mensaje (emojis del texto y stickers). */
export function expressionsOf(msg: Message): Expression[] {
  return [...parseCustomEmojis(msg.content), ...msg.stickers.map(stickerRef)];
}

async function download(url: string, maxBytes: number): Promise<Buffer> {
  const host = new URL(url).hostname;
  if (host !== 'cdn.discordapp.com' && host !== 'media.discordapp.net') throw new GameError('Solo se copian imágenes del CDN de Discord.');
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new GameError(`Discord no devolvió la imagen (${res.status}).`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new GameError(`la imagen pesa más de ${Math.round(maxBytes / 1024)} KB`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new GameError(`la imagen pesa más de ${Math.round(maxBytes / 1024)} KB`);
  return buf;
}

export interface StealResult {
  ok: string[];
  failed: string[];
}

/** Copia las expresiones elegidas. `rename` solo se usa si se copia una sola. */
export async function stealExpressions(member: GuildMember, items: Expression[], rename: string | null): Promise<StealResult> {
  assertCanSteal(member);
  const guild = member.guild;
  // Los lugares libres se cuentan sobre la lista real (la caché puede estar desactualizada).
  await Promise.all([guild.emojis.fetch().catch(() => undefined), guild.stickers.fetch().catch(() => undefined)]);
  const reason = `!steal por ${member.user.username}`;
  const res: StealResult = { ok: [], failed: [] };
  for (const e of items.slice(0, MAX_PER_STEAL)) {
    const label = e.kind === 'emoji' ? `:${e.name}:` : `sticker "${e.name}"`;
    const problem = unsupportedReason(guild, e);
    if (problem) {
      res.failed.push(`${label}: ${problem}`);
      continue;
    }
    try {
      if (e.kind === 'emoji') {
        const used = guild.emojis.cache.filter((x) => !!x.animated === e.animated).size;
        if (used >= emojiSlots(guild.premiumTier)) throw new GameError(`no quedan lugares para emojis ${e.animated ? 'animados' : 'estáticos'}`);
        const name = cleanEmojiName(items.length === 1 && rename ? rename : e.name);
        const created = await guild.emojis.create({ attachment: await download(expressionUrl(e), EMOJI_MAX_BYTES), name, reason });
        res.ok.push(`${created.toString()} \`:${created.name}:\``);
      } else {
        if (guild.stickers.cache.size >= stickerSlots(guild.premiumTier)) throw new GameError('no quedan lugares para stickers');
        const name = cleanStickerName(items.length === 1 && rename ? rename : e.name);
        const file = await download(expressionUrl(e), STICKER_MAX_BYTES);
        const created = await guild.stickers.create({ file: { attachment: file, name: `${name}.${e.format === StickerFormatType.GIF ? 'gif' : 'png'}` }, name, tags: e.tags?.trim() || '⭐', reason });
        res.ok.push(`sticker **${created.name}**`);
      }
    } catch (err) {
      const msg = err instanceof GameError ? err.message : err instanceof Error ? err.message : String(err);
      res.failed.push(`${label}: ${msg.slice(0, 150)}`);
    }
  }
  return res;
}

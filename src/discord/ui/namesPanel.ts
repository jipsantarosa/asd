import { EmbedBuilder, type Guild, type User } from 'discord.js';
import type { GameContext } from '../../services/context';
import { nameHistory, type NameEntry } from '../../services/userNames';

const ACCENT = 0xe0418a;
const d = (ms: number) => `<t:${Math.floor(ms / 1000)}:d>`;

function sinceText(ctx: GameContext): string {
  const t = ctx.db.get<{ t: number | null }>('SELECT MIN(first_seen_at) AS t FROM user_names')?.t;
  return t ? new Date(t).toLocaleDateString('es-AR') : 'hoy';
}

function list(entries: NameEntry[], current: string | null | undefined, max = 8, fmt: (e: NameEntry) => string = (e) => `\`${e.value}\``): string {
  if (!entries.length) return '*Nada registrado todavía.*';
  const lines = entries.slice(0, max).map((e) => `${e.value === current ? '🟢' : '•'} ${fmt(e)} — ${d(e.firstSeenAt)}`);
  if (entries.length > max) lines.push(`-# …y ${entries.length - max} más.`);
  return lines.join('\n');
}

/** Historial de nombres: @usuario, nombre visible y apodos en ESTE servidor. Solo lo que el bot vio. */
export function namesEmbed(ctx: GameContext, user: User, guild: Guild): EmbedBuilder {
  const member = guild.members.cache.get(user.id);
  const name = user.displayName ?? user.username;
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setAuthor({ name, iconURL: user.displayAvatarURL({ size: 64 }) })
    .setDescription(`🪪 Aquí está el historial de nombres de **${name}**`)
    .addFields(
      { name: '👤 Usuario (@)', value: list(nameHistory(ctx, user.id, ['username']), user.username, 8, (e) => `\`@${e.value}\``), inline: true },
      { name: '✏️ Nombre visible', value: list(nameHistory(ctx, user.id, ['display']), user.globalName), inline: true },
      { name: `🏷️ Apodos en ${guild.name}`.slice(0, 256), value: list(nameHistory(ctx, user.id, ['nick'], guild.id), member?.nickname) },
    )
    .setFooter({ text: `🟢 actual · El bot registra nombres desde el ${sinceText(ctx)}; no incluye cambios anteriores.` });
}

/** Historial de tags de servidor (el "clan" junto al nombre). */
export function tagsEmbed(ctx: GameContext, user: User, guildName: (id: string) => string | null, currentTag: string | null): EmbedBuilder {
  const name = user.displayName ?? user.username;
  const tags = nameHistory(ctx, user.id, ['tag']);
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setAuthor({ name, iconURL: user.displayAvatarURL({ size: 64 }) })
    .setDescription(`🏷️ Aquí está el historial de tags de **${name}**\n\n${list(tags, currentTag, 15, (e) => `**${e.value}**${e.scope && guildName(e.scope) ? ` · ${guildName(e.scope)}` : ''}`)}`)
    .setFooter({ text: `🟢 actual · El bot registra tags desde el ${sinceText(ctx)}.` });
}

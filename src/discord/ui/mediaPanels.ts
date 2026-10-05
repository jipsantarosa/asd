import { AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, type User } from 'discord.js';
import type { GameContext } from '../../services/context';
import { mediaHistory, trackingSince, type MediaEntry, type MediaKind } from '../../services/userMedia';
import { row, type Panel } from '../app';
import { buildCollage, type Collage } from '../media/collage';
import { ensureArchived } from '../media/archive';
import { getMediaFile } from '../../services/mediaArchive';
import { cid } from './ids';
import { COLORS } from './theme';

const LABEL: Record<MediaKind, { one: string; many: string; manyLower: string; emoji: string }> = {
  avatar: { one: 'avatar', many: 'Avatares', manyLower: 'avatares', emoji: '🖼️' },
  banner: { one: 'banner', many: 'Banners', manyLower: 'banners', emoji: '🎏' },
};
const ACCENT = 0xe0418a;

const t = (ms: number, style: 'f' | 'R' | 'd') => `<t:${Math.floor(ms / 1000)}:${style}>`;

// Caché chica del collage (10 min): cambiar de vista en el menú no vuelve a descargar todo.
const cache = new Map<string, { at: number; collage: Collage }>();
async function cachedCollage(ctx: GameContext, userId: string, kind: MediaKind, entries: MediaEntry[]): Promise<Collage | null> {
  const key = `${userId}:${kind}:${entries.map((e) => e.hash).join(',')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 600_000 && !hit.collage.missing) return hit.collage;
  const collage = await buildCollage(entries, kind, undefined, (e) => getMediaFile(ctx, userId, kind, e.hash)?.png ?? null);
  if (collage) {
    if (cache.size > 100) cache.clear();
    cache.set(key, { at: Date.now(), collage });
  }
  return collage;
}

export type MediaView = 'collage' | number;

/**
 * Historial de avatares/banners: collage de todo lo detectado + menú para ver cada uno en grande
 * + "Mis estadísticas". Solo lo que el bot vio: nunca historial inventado.
 */
export async function mediaPanel(ctx: GameContext, owner: string, user: User, kind: MediaKind, view: MediaView = 'collage', currentHash?: string | null): Promise<Panel> {
  const L = LABEL[kind];
  const history = mediaHistory(ctx, user.id, kind, 64);
  const since = trackingSince(ctx);
  const name = user.displayName ?? user.username;
  const embed = new EmbedBuilder().setColor(user.accentColor ?? ACCENT)
    .setAuthor({ name, iconURL: user.displayAvatarURL({ size: 64 }) });
  const sinceText = since ? new Date(since).toLocaleDateString('es-AR') : 'hoy';
  const statsRow = row(new ButtonBuilder().setCustomId(cid('av', 'stats', '0', kind)).setLabel('Mis estadísticas').setEmoji('📊').setStyle(ButtonStyle.Secondary));

  if (!history.length) {
    if (kind === 'avatar') embed.setDescription(`${L.emoji} **${name}** usa el avatar por defecto de Discord.`).setImage(user.displayAvatarURL({ size: 1024 }));
    else embed.setDescription(`${L.emoji} **${name}** no tiene banner${user.banner === undefined ? ' visible para el bot' : ''}.${user.hexAccentColor ? `\nColor de perfil: \`${user.hexAccentColor}\`` : ''}`);
    embed.setFooter({ text: `El bot registra ${L.manyLower} desde el ${sinceText}.` });
    return { embeds: [embed], components: [statsRow] };
  }

  // Lo que todavía no está guardado se guarda ahora (si Discord todavía lo tiene).
  for (const e of history) ensureArchived(user.id, kind, e.hash);

  const select = new StringSelectMenuBuilder().setCustomId(cid('av', 'sel', owner, kind, user.id)).setPlaceholder(L.many)
    .addOptions(
      new StringSelectMenuOptionBuilder().setValue('c').setLabel('Ver todos (collage)').setEmoji('🧩').setDefault(view === 'collage'),
      ...history.slice(0, 24).map((e, i) => new StringSelectMenuOptionBuilder().setValue(String(i))
        .setLabel(`#${i + 1}${(currentHash ? e.hash === currentHash : i === 0) ? ' · Actual' : ''}${e.hash.startsWith('a_') ? ' · animado' : ''}`)
        .setDescription(`Detectado el ${new Date(e.firstSeenAt).toLocaleDateString('es-AR')}`).setDefault(view === i)),
    );
  const components = [row(select), statsRow];

  if (view === 'collage') {
    const collage = await cachedCollage(ctx, user.id, kind, history);
    embed.setDescription([
      `${L.emoji} Aquí está el historial de ${L.manyLower} de **${name}**`,
      `-# ${history.length} detectado${history.length === 1 ? '' : 's'} desde el ${sinceText} · el más reciente arriba a la izquierda`,
      collage?.missing ? `-# ⬛ ${collage.missing} ya no ${collage.missing === 1 ? 'estaba' : 'estaban'} en Discord cuando el bot intentó guardarl${collage.missing === 1 ? 'a' : 'as'} (de antes de esta versión).` : '',
    ].filter(Boolean).join('\n'));
    embed.setFooter({ text: `Elegí uno en el menú para verlo en grande · No incluye cambios anteriores al ${sinceText}.` });
    if (collage) {
      const fileName = `historial_${L.manyLower}.png`;
      embed.setImage(`attachment://${fileName}`);
      return { embeds: [embed], components, files: [new AttachmentBuilder(collage.png, { name: fileName })] };
    }
    embed.setImage(history[0].url);
    return { embeds: [embed], components };
  }

  const i = Math.min(Math.max(0, view), history.length - 1);
  const e = history[i];
  const isCurrent = currentHash ? e.hash === currentHash : i === 0;
  // La copia guardada por el bot (la de Discord desaparece cuando la persona cambia la imagen).
  const saved = getMediaFile(ctx, user.id, kind, e.hash);
  const files: AttachmentBuilder[] = [];
  if (saved) {
    const fileName = `${kind}_${i + 1}.${saved.gif ? 'gif' : 'png'}`;
    files.push(new AttachmentBuilder(saved.gif ?? saved.png!, { name: fileName }));
    embed.setImage(`attachment://${fileName}`);
  } else embed.setImage(e.url);
  embed
    .setDescription([
      `${L.emoji} **${L.one[0].toUpperCase()}${L.one.slice(1)} #${i + 1}** de **${name}** · ${isCurrent ? '🟢 Actual' : 'Anterior'}${e.hash.startsWith('a_') ? ' · animado' : ''}`,
      `Detectado por primera vez ${t(e.firstSeenAt, 'f')}`,
      e.lastSeenAt !== e.firstSeenAt ? `Visto por última vez ${t(e.lastSeenAt, 'R')}` : '',
      saved ? '💾 Guardada por el bot' : '⬛ El bot no llegó a guardar esta imagen (puede que ya no esté en Discord).',
      isCurrent ? `[Abrir en tamaño completo](${e.url.replace(/size=\d+/, 'size=4096')})` : '',
    ].filter(Boolean).join('\n'))
    .setFooter({ text: 'El bot guarda una copia de cada imagen apenas la detecta.' });
  return { embeds: [embed], components, files };
}

/** "Mis estadísticas": lo que el bot detectó de quien toca el botón (respuesta privada). */
export function mediaStats(ctx: GameContext, user: User): EmbedBuilder {
  const av = mediaHistory(ctx, user.id, 'avatar', 200);
  const bn = mediaHistory(ctx, user.id, 'banner', 200);
  const since = trackingSince(ctx);
  const first = [...av, ...bn].reduce((m, e) => Math.min(m, e.firstSeenAt), Infinity);
  const last = [...av, ...bn].reduce((m, e) => Math.max(m, e.firstSeenAt), 0);
  const animated = av.filter((e) => e.hash.startsWith('a_')).length;
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setAuthor({ name: `Estadísticas de ${user.displayName ?? user.username}`, iconURL: user.displayAvatarURL({ size: 64 }) })
    .addFields(
      { name: '🖼️ Avatares', value: `${av.length} detectado${av.length === 1 ? '' : 's'}${animated ? ` · ${animated} animado${animated === 1 ? '' : 's'}` : ''}`, inline: true },
      { name: '🎏 Banners', value: `${bn.length} detectado${bn.length === 1 ? '' : 's'}`, inline: true },
      { name: '🔄 Cambios', value: `${Math.max(0, av.length - 1)} de avatar · ${Math.max(0, bn.length - 1)} de banner`, inline: true },
      { name: '📅 Primer registro', value: Number.isFinite(first) ? t(first, 'f') : '—', inline: true },
      { name: '🆕 Último cambio', value: last ? t(last, 'R') : '—', inline: true },
    )
    .setFooter({ text: `El bot registra desde el ${since ? new Date(since).toLocaleDateString('es-AR') : 'hoy'}.` });
}

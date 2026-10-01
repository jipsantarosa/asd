import { ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { kissTimes, type KissState, type KissStats } from '../../services/social';
import { row, type Row } from '../app';
import type { Gif } from '../fun/kissGif';
import { cid } from './ids';
import { clean } from './theme';

export const KISS_COLOR = 0xe0418a;
const ANSWERED_COLOR = 0x80848e;

/**
 * Tarjeta de un beso:
 *   **salo** besa a **h**.
 *   -# salo y h se han besado 9 veces.
 *   [GIF]
 *   Anime: <nombre>
 * Al corresponder: "¡**h** besa a **salo** de vuelta!" con el contador ya actualizado.
 */
export function kissEmbed(opts: { from: string; to: string; count: number; gif: Gif | null; back?: boolean }): EmbedBuilder {
  const from = clean(opts.from);
  const to = clean(opts.to);
  const e = new EmbedBuilder()
    .setColor(KISS_COLOR)
    .setDescription([
      opts.back ? `¡**${from}** besa a **${to}** de vuelta!` : `**${from}** besa a **${to}**.`,
      `-# ${from} y ${to} se han besado ${kissTimes(opts.count)}.`,
    ].join('\n'));
  if (opts.gif) {
    e.setImage(opts.gif.url);
    if (opts.gif.anime) e.setFooter({ text: `Anime: ${opts.gif.anime}`.slice(0, 2048) });
  } else {
    e.setFooter({ text: 'No pude traer un GIF esta vez, pero el beso cuenta 💕' });
  }
  return e;
}

/** Agrega al embed original quién lo rechazó y lo pasa a gris. */
export function rejectedEmbed(original: EmbedBuilder, targetName: string): EmbedBuilder {
  const text = original.data.description ?? '';
  return original.setColor(ANSWERED_COLOR).setDescription(`${text}\n-# 💔 ${clean(targetName)} rechazó el beso.`.slice(0, 4000));
}

/**
 * Botones del beso. Llevan solo el id del beso (el resto se valida en la base).
 * Cuando el beso ya se respondió, los dos quedan desactivados y el elegido cambia de texto.
 */
export function kissButtons(kissId: number | null, state: KissState, legacyArgs: string[] = []): Row {
  const args = kissId ? [kissId] : legacyArgs;
  const answered = state !== 'open';
  return row(
    new ButtonBuilder().setCustomId(cid('ks', 'back', '0', ...args))
      .setLabel(state === 'returned' ? 'Correspondido' : 'Corresponder').setEmoji(state === 'returned' ? '💞' : '💋')
      .setStyle(state === 'returned' ? ButtonStyle.Success : ButtonStyle.Primary).setDisabled(answered),
    new ButtonBuilder().setCustomId(cid('ks', 'no', '0', ...args))
      .setLabel(state === 'rejected' ? 'Rechazado' : 'Rechazar').setEmoji('💔')
      .setStyle(state === 'rejected' ? ButtonStyle.Danger : ButtonStyle.Secondary).setDisabled(answered),
  );
}

/** /besos: besos dados y recibidos, y con quién más. */
export function kissStatsEmbed(name: string, avatar: string, s: KissStats): EmbedBuilder {
  const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
  return new EmbedBuilder()
    .setColor(KISS_COLOR)
    .setAuthor({ name: `Besos de ${name}`, iconURL: avatar })
    .setDescription([
      `💋 Dio **${s.given.toLocaleString('es-AR')}** · 💌 Recibió **${s.received.toLocaleString('es-AR')}**`,
      s.pending ? `-# ${s.pending} ${s.pending === 1 ? 'beso espera' : 'besos esperan'} su respuesta.` : '',
      '',
      s.partners.length
        ? `**Con quién más**\n${s.partners.map((p, n) => `${medals[n]} <@${p.userId}> — ${kissTimes(p.count)}`).join('\n')}`
        : '*Todavía no hay besos por acá.*',
    ].filter((x, i) => x !== '' || i === 2).join('\n'));
}

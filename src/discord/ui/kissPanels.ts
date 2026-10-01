import { ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { KissResult } from '../../services/social';
import { row, type Row } from '../app';
import type { Gif } from '../fun/kissGif';
import { cid } from './ids';

export const KISS_COLOR = 0xe0418a;
const fmt = (n: number) => n.toLocaleString('es-AR');

/**
 * Embed del beso, estilo tarjeta: "**A** se besa con **B**.", el GIF, el contador de la pareja
 * (con menciones) y, abajo, el anime de donde sale el GIF.
 */
export function kissEmbed(opts: {
  authorName: string; targetName: string; authorId: string; targetId: string; result: KissResult; gif: Gif | null; back?: boolean;
}): EmbedBuilder {
  const { authorName, targetName, authorId, targetId, result, gif, back } = opts;
  const e = new EmbedBuilder()
    .setColor(KISS_COLOR)
    .setDescription([
      back ? `**${authorName}** le devolvió el beso a **${targetName}**. 💘` : `**${authorName}** se besa con **${targetName}**.`,
      '',
      `💋 Besos entre <@${authorId}> y <@${targetId}>: **${fmt(result.pair)}**`,
      `-# ${authorName} dio ${fmt(result.given)} ${result.given === 1 ? 'beso' : 'besos'} en total · ${targetName} recibió ${fmt(result.received)}`,
    ].join('\n'))
    .setFooter({ text: gif?.anime ? `Anime: ${gif.anime}` : gif ? `GIF: ${gif.source}` : 'No pude traer un GIF esta vez, pero el beso cuenta 💕' });
  if (gif) e.setImage(gif.url);
  return e;
}

/** Botones para quien recibe el beso. Son públicos, pero solo los puede usar el destinatario. */
export function kissButtons(authorId: string, targetId: string): Row {
  return row(
    new ButtonBuilder().setCustomId(cid('ks', 'back', '0', authorId, targetId)).setLabel('Corresponder').setEmoji('💘').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('ks', 'no', '0', authorId, targetId)).setLabel('Rechazar').setEmoji('❌').setStyle(ButtonStyle.Secondary),
  );
}

export function kissAnsweredRow(response: 'correspondido' | 'rechazado'): Row {
  return row(new ButtonBuilder().setCustomId(cid('ks', 'done', '0')).setDisabled(true).setStyle(ButtonStyle.Secondary)
    .setLabel(response === 'correspondido' ? 'Correspondido' : 'Rechazado').setEmoji(response === 'correspondido' ? '💘' : '💔'));
}

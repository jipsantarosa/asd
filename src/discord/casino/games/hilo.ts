import { ButtonStyle } from 'discord.js';
import { cardLabel } from '../../../casino/games/cards';
import { hiloMultiplier, hiloOdds, MAX_SKIPS, type HiloState } from '../../../casino/games/hilo';
import { pct } from '../../../casino/games/util';
import { row } from '../../app';
import { coins, mult } from '../../ui/theme';
import { actButton, gameEmbed, potential, resultLines } from '../format';
import type { Screen } from '../screen';
import { endRows, infoOf, isOver, rulesEmbed, type GameScreens, type RenderOpts } from './base';

const trailText = (s: HiloState) => (s.trail.length ? `-# Anteriores: ${s.trail.map((c) => `\`${cardLabel(c)}\``).join(' ')}` : '');

export const hiloScreens: GameScreens<HiloState> = {
  render(o: RenderOpts<HiloState>): Screen {
    const { round, state: s } = o.view;
    const over = isOver(o.view);
    if (!s) {
      const info = infoOf(o.view);
      return { embeds: [gameEmbed(round, o.viewer, info).setDescription(resultLines(o.ctx, round, info, o.view.balance).join('\n'))], components: endRows(o, []) };
    }
    const e = gameEmbed(round, o.viewer, over ? infoOf(o.view) : null);
    const now = hiloMultiplier(s, round.rtp);
    if (!over) {
      const odds = hiloOdds(s, round.rtp);
      e.setDescription([
        `# \`${cardLabel(s.current)}\``,
        trailText(s),
        '',
        `⬆️ **Más alta:** ${pct(odds.higher)}${odds.higherMult ? ` → **${mult(odds.higherMult)}**` : ' (imposible)'}`,
        `⬇️ **Más baja:** ${pct(odds.lower)}${odds.lowerMult ? ` → **${mult(odds.lowerMult)}**` : ' (imposible)'}`,
        `🟰 Igual: ${pct(odds.equal)} (no se gana ni se pierde)`,
        '',
        s.correct ? `✅ ${s.correct} ${s.correct === 1 ? 'acierto' : 'aciertos'} · **${mult(now)}** · cobrás **${coins(potential(round, now))}**` : '🔮 Adiviná la próxima carta.',
      ].filter((l, i) => l !== '' || i !== 1).join('\n'));
      return {
        embeds: [e],
        components: [
          row(
            actButton(round, o.ownerId, 'higher').setLabel(odds.higherMult ? `Más alta · ${mult(odds.higherMult)}` : 'Más alta').setEmoji('⬆️').setStyle(ButtonStyle.Primary).setDisabled(!odds.higherMult),
            actButton(round, o.ownerId, 'lower').setLabel(odds.lowerMult ? `Más baja · ${mult(odds.lowerMult)}` : 'Más baja').setEmoji('⬇️').setStyle(ButtonStyle.Primary).setDisabled(!odds.lowerMult),
          ),
          row(
            actButton(round, o.ownerId, 'skip').setLabel(`Saltar (${MAX_SKIPS - s.skips})`).setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(s.skips >= MAX_SKIPS),
            actButton(round, o.ownerId, 'cash').setLabel(s.correct ? `Cobrar · ${coins(potential(round, now))}` : 'Cobrar').setEmoji('💰').setStyle(ButtonStyle.Success).setDisabled(s.correct === 0),
          ),
        ],
      };
    }
    const info = infoOf(o.view);
    e.setDescription([
      `# \`${cardLabel(s.current)}\`${s.lostOn !== null ? ' ❌' : ''}`,
      trailText(s),
      '',
      ...(round.status === 'refunded' ? ['↩️ **Partida interrumpida:** se te devolvió la apuesta.'] : resultLines(o.ctx, round, info, o.view.balance)),
    ].join('\n'));
    return { embeds: [e], components: endRows(o, []) };
  },

  rules: (ctx, prefix) => rulesEmbed(ctx, 'hilo', prefix, [
    'Ves una carta: adiviná si la próxima es **más alta** o **más baja**. As es la más baja; Rey, la más alta.',
    '• Se juega con mazos reales: las probabilidades cambian según las cartas que ya salieron.',
    '• Cada acierto multiplica tu premio; **lo menos probable paga más**. Si sale una carta igual, no pasa nada.',
    `• **Saltar** cambia la carta sin apostar (hasta ${MAX_SKIPS} por ronda). **Cobrá** cuando quieras.`,
  ]),
};

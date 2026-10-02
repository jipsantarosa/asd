import { ButtonStyle } from 'discord.js';
import { canDouble, canSplit, handValue, type BjState } from '../../../casino/games/blackjack';
import { handText } from '../../../casino/games/cards';
import { row } from '../../app';
import { coins } from '../../ui/theme';
import { actButton, gameEmbed, resultLines } from '../format';
import type { Screen } from '../screen';
import { endRows, infoOf, isOver, rulesEmbed, type GameScreens, type RenderOpts } from './base';

const RESULT_TEXT = { win: '✅ ganó', loss: '❌ perdió', push: '🤝 empate', blackjack: '🃏 ¡blackjack!' } as const;

function valueText(cards: number[]): string {
  const v = handValue(cards);
  if (v.total > 21) return `**${v.total}** (se pasó)`;
  if (cards.length === 2 && v.total === 21) return '**21** (blackjack)';
  return `**${v.total}**${v.soft && v.total < 21 ? ' (blanda)' : ''}`;
}

function table(s: BjState, over: boolean, revealDealer: boolean): string {
  const dealer = revealDealer
    ? `${handText(s.dealer)} → ${valueText(s.dealer)}`
    : `${handText(s.dealer.slice(0, 1))} \`🂠\` → **${handValue(s.dealer.slice(0, 1)).total}**`;
  const hands = s.hands.map((h, i) => {
    const label = s.hands.length > 1 ? `Mano ${i + 1}` : 'Tu mano';
    const marker = !over && i === s.active ? ' 👈' : '';
    const res = over && s.results?.[i] ? ` · ${RESULT_TEXT[s.results[i]]}` : '';
    return `**${label}** · ${coins(h.bet)}${h.doubled ? ' (doblada)' : ''}${marker}\n${handText(h.cards)} → ${valueText(h.cards)}${res}`;
  });
  return [`**Crupier**\n${dealer}`, '', ...hands].join('\n');
}

export const blackjackScreens: GameScreens<BjState> = {
  render(o: RenderOpts<BjState>): Screen {
    const { round, state } = o.view;
    const over = isOver(o.view);
    if (!state) {
      const info = infoOf(o.view);
      return { embeds: [gameEmbed(round, o.viewer, info).setDescription([`${round.summary ?? ''}`, '', ...resultLines(o.ctx, round, info, o.view.balance)].join('\n'))], components: endRows(o, []) };
    }
    if (!over) {
      const hand = state.hands[state.active];
      const e = gameEmbed(round, o.viewer, null).setDescription([table(state, false, false), '', `Apostado: ${coins(round.totalBet)} · Saldo: ${coins(o.view.balance)}`].join('\n'));
      const afford = o.view.balance >= hand.bet;
      return {
        embeds: [e],
        components: [row(
          actButton(round, o.ownerId, 'hit').setLabel('Pedir').setEmoji('🃏').setStyle(ButtonStyle.Primary),
          actButton(round, o.ownerId, 'stand').setLabel('Plantarse').setEmoji('✋').setStyle(ButtonStyle.Secondary),
          actButton(round, o.ownerId, 'double').setLabel(`Doblar · ${coins(hand.bet)}`).setEmoji('💰').setStyle(ButtonStyle.Success).setDisabled(!canDouble(state) || !afford),
          actButton(round, o.ownerId, 'split').setLabel('Dividir').setEmoji('✂️').setStyle(ButtonStyle.Success).setDisabled(!canSplit(state) || !afford),
        )],
      };
    }
    const info = infoOf(o.view);
    const e = gameEmbed(round, o.viewer, info).setDescription([table(state, true, true), '', ...resultLines(o.ctx, round, info, o.view.balance)].join('\n'));
    return { embeds: [e], components: endRows(o, []) };
  },

  /** Al terminar: primero se da vuelta la carta del crupier, después el resultado. */
  frames(o: RenderOpts<BjState>): Screen[] {
    const { round, state } = o.view;
    if (!state || state.dealer.length <= 2 || state.hands.every((h) => handValue(h.cards).total > 21)) return [];
    const reveal: BjState = { ...state, dealer: state.dealer.slice(0, 2), results: undefined };
    return [{ embeds: [gameEmbed(round, o.viewer, null, 'juega el crupier…').setDescription(table(reveal, true, true))], components: [] }];
  },

  rules: (ctx, prefix) => rulesEmbed(ctx, 'blackjack', prefix, [
    'Llegá más cerca de **21** que el crupier sin pasarte. Figuras valen 10; el As, 1 u 11.',
    '• **Blackjack** (As + 10 de entrada) paga **3:2** (2,5x). Ganar paga 2x; empatar devuelve la apuesta.',
    '• El crupier pide hasta 17 y se planta en **17 blando**. Si tiene blackjack, se ve al instante.',
    '• **Doblar:** con tus dos primeras cartas, duplicás la apuesta y recibís una sola carta más.',
    '• **Dividir:** con un par del mismo valor, lo separás en dos manos (una vez; los ases reciben una carta cada uno).',
    '• 6 mazos. Si abandonás la partida, el bot se planta por vos.',
  ]),
};

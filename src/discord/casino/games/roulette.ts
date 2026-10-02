import type { RouletteBet } from '../../../casino/games/roulette';
import { colorEmoji, colorOf, ROULETTE_HELP } from '../../../casino/games/roulette';
import { mult } from '../../ui/theme';
import { gameEmbed, resultLines } from '../format';
import type { Screen } from '../screen';
import { endRows, infoOf, rulesEmbed, type GameScreens, type RenderOpts } from './base';

/** Orden real de los números en una ruleta europea. */
export const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];

function windowAt(index: number, highlight: boolean): string {
  const cells: string[] = [];
  for (let d = -3; d <= 3; d++) {
    const n = WHEEL[(index + d + WHEEL.length * 2) % WHEEL.length];
    const cell = `${colorEmoji(n)}${n}`;
    cells.push(d === 0 && highlight ? `**[${cell}]**` : cell);
  }
  return cells.join(' ');
}

function describe(n: number): string {
  if (n === 0) return 'Cero (verde)';
  const parts = [colorOf(n) === 'red' ? 'Rojo' : 'Negro', n % 2 === 0 ? 'Par' : 'Impar', n <= 18 ? '1–18' : '19–36', `Docena ${Math.ceil(n / 12)}`, `Columna ${((n - 1) % 3) + 1}`];
  return parts.join(' · ');
}

function betLine(p: RouletteBet): string {
  return `🎯 Apuesta a **${p.label}** · cubre ${p.numbers.length} ${p.numbers.length === 1 ? 'número' : 'números'} · paga **${mult(36 / p.numbers.length)}**`;
}

export const rouletteScreens: GameScreens = {
  render(o: RenderOpts): Screen {
    const { round } = o.view;
    const p = round.params as RouletteBet;
    const n = (round.result?.number as number | undefined) ?? 0;
    const info = infoOf(o.view);
    const e = gameEmbed(round, o.viewer, info)
      .setDescription([
        windowAt(WHEEL.indexOf(n), true),
        '',
        `## ${colorEmoji(n)} ${n}`,
        describe(n),
        '',
        betLine(p),
        '',
        ...resultLines(o.ctx, round, info, o.view.balance),
      ].join('\n'));
    return { embeds: [e], components: endRows(o, []) };
  },

  /** La bola gira y frena: cada cuadro se acerca al número que salió (no hay azar en la animación). */
  frames(o: RenderOpts): Screen[] {
    const { round } = o.view;
    const n = (round.result?.number as number | undefined) ?? 0;
    const target = WHEEL.indexOf(n);
    return [-17, -7, -2].map((off) => ({
      embeds: [gameEmbed(round, o.viewer, null, 'girando…').setDescription([windowAt(target + off, false), '', betLine(round.params as RouletteBet)].join('\n'))],
      components: [],
    }));
  },

  rules: (ctx, prefix) => rulesEmbed(ctx, 'roulette', prefix, [
    'Ruleta **europea** (un solo cero). Cada apuesta paga **36 ÷ números cubiertos**:',
    '• Pleno (1 número) **36x** · 2 números 18x · 3 números 12x · 4 números 9x · 6 números 6x',
    '• Docena o columna **3x** · rojo/negro, par/impar, 1–18/19–36 **2x**',
    '• El 0 hace perder todo lo que no lo incluya: esa es la ventaja de la casa (2,7 %).',
    '',
    `**Apuestas:** ${ROULETTE_HELP}`,
  ]),
};

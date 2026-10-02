import { getCasinoConfig, rtpOf } from '../../../casino/config';
import { plinkoTable, RISK_LABEL, ROWS_MAX, ROWS_MIN, type PlinkoParams, type PlinkoRisk } from '../../../casino/games/plinko';
import { mult } from '../../ui/theme';
import { gameEmbed, resultLines } from '../format';
import type { Screen } from '../screen';
import { endRows, infoOf, rulesEmbed, type GameScreens, type RenderOpts } from './base';

/** Tablero en texto: cada fila muestra las posiciones posibles y el recorrido de la bola hasta `upto` filas. */
export function board(path: number[], upto: number): string {
  const n = path.length;
  const lines: string[] = [];
  let pos = 0;
  for (let r = 0; r <= n; r++) {
    const cells = Array.from({ length: r + 1 }, (_, i) => (r <= upto && i === pos ? (r === upto ? '●' : '○') : '·'));
    lines.push(' '.repeat(n - r) + cells.join(' '));
    if (r < n) pos += path[r];
  }
  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

function bucketsLine(table: number[], hit: number | null): string {
  return table.map((m, i) => (i === hit ? `**[${m}x]**` : `${m}x`)).join(' · ');
}

export const plinkoScreens: GameScreens = {
  render(o: RenderOpts): Screen {
    const { round } = o.view;
    const p = round.params as PlinkoParams;
    const path = (round.result?.path as number[] | undefined) ?? [];
    const table = (round.result?.table as number[] | undefined) ?? plinkoTable(p.risk, p.rows, round.rtp);
    const bucket = (round.result?.bucket as number | undefined) ?? null;
    const info = infoOf(o.view);
    const e = gameEmbed(round, o.viewer, info, `riesgo ${RISK_LABEL[p.risk]} · ${p.rows} filas`)
      .setDescription([board(path, path.length), bucketsLine(table, bucket), '', ...resultLines(o.ctx, round, info, o.view.balance)].join('\n'));
    return { embeds: [e], components: endRows(o, []) };
  },

  frames(o: RenderOpts): Screen[] {
    const { round } = o.view;
    const p = round.params as PlinkoParams;
    const path = (round.result?.path as number[] | undefined) ?? [];
    const table = (round.result?.table as number[] | undefined) ?? plinkoTable(p.risk, p.rows, round.rtp);
    return [0, Math.ceil(path.length / 3), Math.ceil((2 * path.length) / 3)].map((k) => ({
      embeds: [gameEmbed(round, o.viewer, null, 'cayendo…').setDescription(`${board(path, k)}\n${bucketsLine(table, null)}`)],
      components: [],
    }));
  },

  rules(ctx, prefix) {
    const rtp = rtpOf(getCasinoConfig(ctx), 'plinko');
    const sample = (risk: PlinkoRisk, rows: number) => {
      const t = plinkoTable(risk, rows, rtp);
      return `**${RISK_LABEL[risk]} · ${rows} filas:** ${mult(t[0])} en los bordes … ${mult(t[Math.floor(rows / 2)])} en el centro`;
    };
    return rulesEmbed(ctx, 'plinko', prefix, [
      `La bola cae por ${ROWS_MIN} a ${ROWS_MAX} filas de pines; en cada una va a la izquierda o a la derecha (50 % / 50 %).`,
      'Los bordes son poco probables y pagan mucho; el centro es lo más común y paga poco.',
      '',
      sample('low', 8), sample('medium', 12), sample('high', 16),
      '',
      'Riesgo `bajo`, `medio` o `alto` y filas de 8 a 16 (por defecto medio, 12 filas).',
    ]);
  },
};

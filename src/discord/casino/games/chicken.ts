import { ButtonStyle } from 'discord.js';
import { getCasinoConfig, rtpOf } from '../../../casino/config';
import { chickenMultiplier, DIFF_LABEL, LANES, SURVIVAL, type ChickenParams, type ChickenState } from '../../../casino/games/chicken';
import { pct } from '../../../casino/games/util';
import { row } from '../../app';
import { coins, mult } from '../../ui/theme';
import { actButton, gameEmbed, potential, resultLines } from '../format';
import type { Screen } from '../screen';
import { endRows, infoOf, isOver, rulesEmbed, type GameScreens, type RenderOpts } from './base';

/** La ruta: 🐔 donde está el pollo, ✅ carriles cruzados, 🚗 donde lo atropellaron, ⬛ lo que falta. */
function road(s: ChickenState, over: boolean): string {
  const cells: string[] = [s.lane === 0 ? '🐔' : '🏠'];
  for (let lane = 1; lane <= LANES; lane++) {
    if (lane < s.lane) cells.push('✅');
    else if (lane === s.lane) cells.push(over && s.deathLane === lane ? '💥' : '🐔');
    else cells.push(over && s.deathLane === lane ? '🚗' : '⬛');
  }
  cells.push('🏁');
  return cells.join('');
}

function laneTable(d: ChickenParams['difficulty'], current: number, rtp: number): string {
  return Array.from({ length: LANES }, (_, i) => {
    const lane = i + 1;
    const m = mult(chickenMultiplier(d, lane, rtp));
    return lane === current + 1 ? `**▸ ${lane}: ${m}**` : lane <= current ? `~~${lane}: ${m}~~` : `${lane}: ${m}`;
  }).join(' · ');
}

export const chickenScreens: GameScreens<ChickenState> = {
  render(o: RenderOpts<ChickenState>): Screen {
    const { round, state } = o.view;
    const p = round.params as ChickenParams;
    const s: ChickenState = state ?? { deathLane: null, lane: 0 };
    const over = isOver(o.view);
    const e = gameEmbed(round, o.viewer, over ? infoOf(o.view) : null, `dificultad ${DIFF_LABEL[p.difficulty]}`);
    if (!over) {
      const now = chickenMultiplier(p.difficulty, s.lane, round.rtp);
      const next = chickenMultiplier(p.difficulty, s.lane + 1, round.rtp);
      e.setDescription([
        road(s, false),
        '',
        s.lane ? `🐔 Carril **${s.lane}/${LANES}** · **${mult(now)}** · retirándote cobrás **${coins(potential(round, now))}**` : '🐔 El pollo espera para cruzar.',
        `➡️ Próximo carril: **${mult(next)}** · probabilidad de pasar ${pct(SURVIVAL[p.difficulty][s.lane])}`,
        '',
        `-# ${laneTable(p.difficulty, s.lane, round.rtp)}`,
      ].join('\n'));
      return {
        embeds: [e],
        components: [row(
          actButton(round, o.ownerId, 'go').setLabel(`Avanzar · ${mult(next)}`).setEmoji('➡️').setStyle(ButtonStyle.Primary),
          actButton(round, o.ownerId, 'cash').setLabel(s.lane ? `Retirarse · ${coins(potential(round, now))}` : 'Retirarse').setEmoji('💰').setStyle(ButtonStyle.Success).setDisabled(s.lane === 0),
        )],
      };
    }
    const info = infoOf(o.view);
    e.setDescription([road(s, true), '', ...(round.status === 'refunded' ? ['↩️ **Partida interrumpida:** se te devolvió la apuesta.'] : resultLines(o.ctx, round, info, o.view.balance))].join('\n'));
    return { embeds: [e], components: endRows(o, []) };
  },

  rules(ctx, prefix) {
    const rtp = rtpOf(getCasinoConfig(ctx), 'chicken');
    return rulesEmbed(ctx, 'chicken', prefix, [
      `Hacé cruzar al pollo por **${LANES} carriles**. Cada carril que pasa sube el multiplicador; si lo atropellan, perdés.`,
      '• **Retirate** cuando quieras y cobrás lo acumulado. Cada carril es más peligroso que el anterior.',
      ...(['easy', 'medium', 'hard'] as const).map((d) => `• **${DIFF_LABEL[d]}:** carril 1 ${mult(chickenMultiplier(d, 1, rtp))} · carril 5 ${mult(chickenMultiplier(d, 5, rtp))} · carril 10 ${mult(chickenMultiplier(d, 10, rtp))}`),
    ]);
  },
};

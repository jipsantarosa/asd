import { ButtonStyle } from 'discord.js';
import { getCasinoConfig, rtpOf } from '../../../casino/config';
import { DIFFICULTY, FLOORS, towerMultiplier, type TowerParams, type TowerState } from '../../../casino/games/tower';
import { pct } from '../../../casino/games/util';
import { row } from '../../app';
import { coins, mult } from '../../ui/theme';
import { actButton, gameEmbed, potential, resultLines } from '../format';
import type { Row, Screen } from '../screen';
import { endRows, infoOf, isOver, rulesEmbed, type GameScreens, type RenderOpts } from './base';

function floors(s: TowerState, p: TowerParams, over: boolean, rtp: number): string {
  const { tiles } = DIFFICULTY[p.difficulty];
  const lines: string[] = [];
  for (let f = FLOORS - 1; f >= 0; f--) {
    const safe = s.safe[f] ?? [];
    const cells = Array.from({ length: tiles }, (_, i) => {
      if (f < s.floor) return s.picks[f] === i ? '💎' : over ? (safe.includes(i) ? '▫️' : '🐉') : '▫️';
      if (f === s.floor && over && s.hit === i) return '🔥';
      if (over) return safe.includes(i) ? '▫️' : '🐉';
      return f === s.floor ? '⬛' : '▫️';
    }).join('');
    const marker = !over && f === s.floor ? ' ◀' : '';
    lines.push(`\`${f + 1}\` ${cells} · **${mult(towerMultiplier(p.difficulty, f + 1, rtp))}**${marker}`);
  }
  return lines.join('\n');
}

export const towerScreens: GameScreens<TowerState> = {
  render(o: RenderOpts<TowerState>): Screen {
    const { round, state } = o.view;
    const p = round.params as TowerParams;
    const d = DIFFICULTY[p.difficulty];
    const s: TowerState = state ?? { safe: [], floor: 0, picks: [], hit: null };
    const over = isOver(o.view);
    const e = gameEmbed(round, o.viewer, over ? infoOf(o.view) : null, `dificultad ${d.label}`);
    if (!over) {
      const now = towerMultiplier(p.difficulty, s.floor, round.rtp);
      e.setDescription([
        floors(s, p, false, round.rtp),
        '',
        s.floor ? `🐉 Piso **${s.floor}/${FLOORS}** · **${mult(now)}** · cobrás **${coins(potential(round, now))}**` : '🐉 Elegí una casilla del piso 1.',
        `➡️ ${d.safe} de ${d.tiles} casillas son seguras · probabilidad ${pct(d.safe / d.tiles)}`,
      ].join('\n'));
      const rows: Row[] = [
        row(...Array.from({ length: d.tiles }, (_, i) => actButton(round, o.ownerId, 'tile', i).setLabel(String(i + 1)).setEmoji('🥚').setStyle(ButtonStyle.Secondary))),
        row(actButton(round, o.ownerId, 'cash').setLabel(s.floor ? `Cobrar · ${coins(potential(round, now))}` : 'Cobrar').setEmoji('💰').setStyle(ButtonStyle.Success).setDisabled(s.floor === 0)),
      ];
      return { embeds: [e], components: rows };
    }
    const info = infoOf(o.view);
    e.setDescription([floors(s, p, true, round.rtp), '', ...(round.status === 'refunded' ? ['↩️ **Partida interrumpida:** se te devolvió la apuesta.'] : resultLines(o.ctx, round, info, o.view.balance))].join('\n'));
    return { embeds: [e], components: endRows(o, []) };
  },

  rules(ctx, prefix) {
    const rtp = rtpOf(getCasinoConfig(ctx), 'tower');
    return rulesEmbed(ctx, 'tower', prefix, [
      `Subí los **${FLOORS} pisos** de la torre eligiendo una casilla por piso. Si despertás al dragón 🐉, perdés.`,
      '• **Cobrá** cuando quieras. Llegar arriba paga el máximo.',
      ...(Object.keys(DIFFICULTY) as (keyof typeof DIFFICULTY)[]).map((k) => {
        const d = DIFFICULTY[k];
        return `• **${d.label}:** ${d.safe} seguras de ${d.tiles} · piso 1 ${mult(towerMultiplier(k, 1, rtp))} · piso ${FLOORS} ${mult(towerMultiplier(k, FLOORS, rtp))}`;
      }),
    ]);
  },
};

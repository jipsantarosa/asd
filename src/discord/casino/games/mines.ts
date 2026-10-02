import { ButtonBuilder, ButtonStyle, ContainerBuilder, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder } from 'discord.js';
import { getCasinoConfig, rtpOf } from '../../../casino/config';
import { minesMultiplier, survival, TILES, type MinesParams, type MinesState } from '../../../casino/games/mines';
import { pct } from '../../../casino/games/util';
import { row } from '../../app';
import { cid } from '../../ui/ids';
import { coins, mult } from '../../ui/theme';
import { actButton, gameMeta, outcomeColor, potential, rebetRow, resultLines } from '../format';
import type { Row, Screen } from '../screen';
import { infoOf, isOver, rulesEmbed, type GameScreens, type RenderOpts } from './base';

/**
 * Minas usa Components V2: 5 filas de 5 casillas dentro de un contenedor + la fila de cobrar
 * (los mensajes clásicos solo admiten 5 filas de botones). Total ≤ 40 componentes, como pide Discord.
 */

const td = (text: string) => new TextDisplayBuilder().setContent(text);

function tile(o: RenderOpts<MinesState>, s: MinesState, idx: number, over: boolean): ButtonBuilder {
  const revealed = s.revealed.includes(idx);
  const mine = s.mines.includes(idx);
  if (!over) {
    return revealed
      ? new ButtonBuilder().setCustomId(cid('cs', 'noop', o.ownerId, o.view.round.id, idx)).setEmoji('💎').setStyle(ButtonStyle.Success).setDisabled(true)
      : actButton(o.view.round, o.ownerId, 'pick', idx).setEmoji('⬛').setStyle(ButtonStyle.Secondary);
  }
  const b = new ButtonBuilder().setCustomId(cid('cs', 'noop', o.ownerId, o.view.round.id, idx)).setDisabled(true);
  if (mine) return b.setEmoji(s.hit === idx ? '💥' : '💣').setStyle(s.hit === idx ? ButtonStyle.Danger : ButtonStyle.Secondary);
  return b.setEmoji('💎').setStyle(revealed ? ButtonStyle.Success : ButtonStyle.Secondary);
}

export const minesScreens: GameScreens<MinesState> = {
  render(o: RenderOpts<MinesState>): Screen {
    const { round, state } = o.view;
    const p = round.params as MinesParams;
    const g = gameMeta('mines');
    const over = isOver(o.view);
    const s: MinesState = state ?? { mines: [], revealed: [], hit: null };
    const k = s.revealed.length;
    const info = over ? infoOf(o.view) : null;
    const header = [`### ${g.emoji} ${g.name} · ${p.mines} ${p.mines === 1 ? 'mina' : 'minas'}`, `**${o.viewer.name}** · apuesta ${coins(round.totalBet)}`];
    let body: string[];
    if (!over) {
      const now = minesMultiplier(p.mines, k, round.rtp);
      const next = minesMultiplier(p.mines, k + 1, round.rtp);
      const chance = survival(p.mines, k + 1) / survival(p.mines, k);
      body = [
        k ? `💎 ${k} ${k === 1 ? 'casilla' : 'casillas'} · **${mult(now)}** · cobrás **${coins(potential(round, now))}**` : '💎 Destapá una casilla para empezar.',
        `➡️ Próxima: **${mult(next)}** (${coins(potential(round, next))}) · probabilidad ${pct(chance)}`,
      ];
    } else if (round.status === 'refunded') {
      body = ['↩️ **Partida interrumpida:** se te devolvió la apuesta.', `💼 Saldo: **${coins(o.view.balance)}**`];
    } else {
      body = resultLines(o.ctx, round, info!, o.view.balance);
    }
    const grid: Row[] = [];
    for (let r = 0; r < 5; r++) grid.push(row(...Array.from({ length: 5 }, (_, c) => tile(o, s, r * 5 + c, over))));
    const box = new ContainerBuilder()
      .setAccentColor(outcomeColor(info, g.color))
      .addTextDisplayComponents(td([...header, ...body].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addActionRowComponents(...grid)
      .addTextDisplayComponents(td(`-# Ronda #${round.id} · nonce ${round.nonce} · RTP ${(round.rtp * 100).toLocaleString('es-AR', { maximumFractionDigits: 2 })} % · azar verificable (!fairness)`));
    const bottom = over
      ? rebetRow(round, o.ownerId, o.view.balance)
      : row(actButton(round, o.ownerId, 'cash').setLabel(k ? `Cobrar · ${coins(potential(round, minesMultiplier(p.mines, k, round.rtp)))}` : 'Cobrar').setEmoji('💰')
        .setStyle(ButtonStyle.Success).setDisabled(k === 0));
    return { v2: true, components: [box, bottom] };
  },

  rules(ctx, prefix) {
    const rtp = rtpOf(getCasinoConfig(ctx), 'mines');
    const ex = (m: number, k: number) => `${m} ${m === 1 ? 'mina' : 'minas'}, ${k} ${k === 1 ? 'casilla' : 'casillas'}: **${mult(minesMultiplier(m, k, rtp))}**`;
    return rulesEmbed(ctx, 'mines', prefix, [
      `Tablero de ${TILES} casillas con 1 a 24 minas escondidas (se ubican al apostar).`,
      '• Destapá casillas: cada 💎 sube el multiplicador. Si tocás una 💣, perdés la apuesta.',
      '• **Cobrá** cuando quieras. Más minas = multiplicadores más altos.',
      `• Ejemplos: ${ex(3, 1)} · ${ex(3, 5)} · ${ex(10, 3)} · ${ex(24, 1)}`,
      '• Si abandonás la partida, se cobra lo que ya habías ganado (o se devuelve la apuesta si no destapaste nada).',
    ]);
  },
};

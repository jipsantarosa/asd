import { ButtonStyle } from 'discord.js';
import { getCasinoConfig, rtpOf } from '../../../casino/config';
import { balloonsMultiplier, LEVELS, NEEDLES, PER_LEVEL, type BalloonsState } from '../../../casino/games/balloons';
import { pct } from '../../../casino/games/util';
import { row } from '../../app';
import { coins, mult } from '../../ui/theme';
import { actButton, gameEmbed, potential, resultLines } from '../format';
import type { Row, Screen } from '../screen';
import { endRows, infoOf, isOver, rulesEmbed, type GameScreens, type RenderOpts } from './base';

/** Niveles de arriba hacia abajo: lo reventado, lo que falta y (al terminar) dónde estaban las agujas. */
function levels(s: BalloonsState, over: boolean, rtp: number): string {
  const lines: string[] = [];
  for (let lvl = LEVELS - 1; lvl >= 0; lvl--) {
    const cells = Array.from({ length: PER_LEVEL }, (_, i) => {
      const needle = s.needles[lvl]?.includes(i);
      if (lvl < s.level) return s.picks[lvl] === i ? '💨' : over && needle ? '📍' : '🎈';
      if (lvl === s.level && over && s.hit === i) return '💥';
      if (over) return needle ? '📍' : '🎈';
      return lvl === s.level ? '🎈' : '▫️';
    }).join('');
    const marker = !over && lvl === s.level ? ' ◀' : '';
    lines.push(`\`${lvl + 1}\` ${cells} · ${NEEDLES[lvl]}📍 · **${mult(balloonsMultiplier(lvl + 1, rtp))}**${marker}`);
  }
  return lines.join('\n');
}

export const balloonsScreens: GameScreens<BalloonsState> = {
  render(o: RenderOpts<BalloonsState>): Screen {
    const { round, state } = o.view;
    const s: BalloonsState = state ?? { needles: [], level: 0, picks: [], hit: null };
    const over = isOver(o.view);
    const e = gameEmbed(round, o.viewer, over ? infoOf(o.view) : null);
    if (!over) {
      const now = balloonsMultiplier(s.level, round.rtp);
      const safe = (PER_LEVEL - NEEDLES[s.level]) / PER_LEVEL;
      e.setDescription([
        levels(s, false, round.rtp),
        '',
        s.level ? `🎈 Nivel **${s.level}/${LEVELS}** · **${mult(now)}** · cobrás **${coins(potential(round, now))}**` : '🎈 Reventá un globo del nivel 1.',
        `➡️ Este nivel tiene **${NEEDLES[s.level]}** ${NEEDLES[s.level] === 1 ? 'aguja' : 'agujas'} · probabilidad de pasar ${pct(safe)}`,
      ].join('\n'));
      const pop = (i: number) => actButton(round, o.ownerId, 'pop', i).setLabel(String(i + 1)).setEmoji('🎈').setStyle(ButtonStyle.Secondary);
      const rows: Row[] = [row(pop(0), pop(1), pop(2)), row(pop(3), pop(4), pop(5))];
      rows.push(row(actButton(round, o.ownerId, 'cash').setLabel(s.level ? `Cobrar · ${coins(potential(round, now))}` : 'Cobrar').setEmoji('💰').setStyle(ButtonStyle.Success).setDisabled(s.level === 0)));
      return { embeds: [e], components: rows };
    }
    const info = infoOf(o.view);
    e.setDescription([levels(s, true, round.rtp), '', ...(round.status === 'refunded' ? ['↩️ **Partida interrumpida:** se te devolvió la apuesta.'] : resultLines(o.ctx, round, info, o.view.balance))].join('\n'));
    return { embeds: [e], components: endRows(o, []) };
  },

  rules(ctx, prefix) {
    const rtp = rtpOf(getCasinoConfig(ctx), 'balloons');
    return rulesEmbed(ctx, 'balloons', prefix, [
      `**${LEVELS} niveles** de ${PER_LEVEL} globos. En cada nivel reventás uno: si tenía una aguja 📍, perdés.`,
      `• Las agujas aumentan nivel a nivel (${NEEDLES.join(', ')}): el riesgo sube progresivamente.`,
      '• **Cobrá** cuando quieras. Superar los 8 niveles paga el máximo.',
      `• Multiplicadores: ${NEEDLES.map((_, i) => `${i + 1}: ${mult(balloonsMultiplier(i + 1, rtp))}`).join(' · ')}`,
    ]);
  },
};

import { getCasinoConfig, rtpOf } from '../../../casino/config';
import { paytable } from '../../../casino/games/slots';
import { jackpotAmount } from '../../../casino/jackpot';
import { coins, mult } from '../../ui/theme';
import { gameEmbed, resultLines } from '../format';
import type { Screen } from '../screen';
import { endRows, infoOf, rulesEmbed, type GameScreens, type RenderOpts } from './base';

const SPIN = '🔄';

function grid(rows: string[][]): string {
  return [
    `┃ ${rows[0].join(' ┃ ')} ┃`,
    `▶ ${rows[1].join(' ┃ ')} ◀`,
    `┃ ${rows[2].join(' ┃ ')} ┃`,
  ].join('\n');
}

export const slotsScreens: GameScreens = {
  render(o: RenderOpts): Screen {
    const { round } = o.view;
    const g = (round.result?.grid as string[][] | undefined) ?? [[SPIN, SPIN, SPIN], [SPIN, SPIN, SPIN], [SPIN, SPIN, SPIN]];
    const info = infoOf(o.view);
    const kind = round.result?.kind as string | undefined;
    const e = gameEmbed(round, o.viewer, info, info.jackpot ? '💰 JACKPOT 💰' : '')
      .setDescription([
        grid(g),
        '',
        kind === 'triple' ? '✨ **¡Trío!**' : kind === 'pair' ? '🍒 **Dos cerezas**' : '',
        ...resultLines(o.ctx, round, info, o.view.balance),
        '',
        `-# 💰 Jackpot progresivo: ${coins(jackpotAmount(o.ctx))}`,
      ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'));
    return { embeds: [e], components: endRows(o, []) };
  },

  /** Los tres rodillos giran y frenan de a uno. */
  frames(o: RenderOpts): Screen[] {
    const { round } = o.view;
    const g = round.result?.grid as string[][] | undefined;
    if (!g) return [];
    const stopAfter = (k: number) => g.map((r) => r.map((s, i) => (i < k ? s : SPIN)));
    return [0, 1, 2].map((k) => ({
      embeds: [gameEmbed(round, o.viewer, null, 'girando…').setDescription(`${grid(stopAfter(k))}\n\n-# 💰 Jackpot: ${coins(jackpotAmount(o.ctx))}`)],
      components: [],
    }));
  },

  rules(ctx, prefix) {
    const cfg = getCasinoConfig(ctx);
    const rtp = rtpOf(cfg, 'slots') - cfg.jackpot.contributionPct / 100;
    return rulesEmbed(ctx, 'slots', prefix, [
      'Tres rodillos; paga la **línea del medio**. ⭐ es **comodín** (completa cualquier trío).',
      '',
      ...paytable(rtp).map((p) => `${p.emoji} **${mult(p.multiplier)}**${p.label ? ` · ${p.label}` : ''}`),
      '',
      `💰 **Jackpot progresivo:** ${coins(jackpotAmount(ctx))}. Sale con 7️⃣7️⃣7️⃣ reales (sin comodín). Crece con el ${cfg.jackpot.contributionPct} % de cada apuesta;`,
      `para cobrarlo entero hay que apostar al menos ${coins(cfg.jackpot.fullBet)} (con menos, la parte proporcional).`,
    ]);
  },
};

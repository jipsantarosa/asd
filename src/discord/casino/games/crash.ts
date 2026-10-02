import { ButtonStyle } from 'discord.js';
import { getCasinoConfig, rtpOf } from '../../../casino/config';
import type { RoundView } from '../../../casino/engine';
import { MIN_CASHOUT, multiplierAt, type CrashParams, type CrashState } from '../../../casino/games/crash';
import type { GameContext } from '../../../services/context';
import { row } from '../../app';
import { bar, coins, mult } from '../../ui/theme';
import { actButton, gameEmbed, potential, resultLines } from '../format';
import type { Screen } from '../screen';
import { endRows, infoOf, isOver, rulesEmbed, type GameScreens, type RenderOpts } from './base';

/** Últimos puntos de explosión (de todos los jugadores): el "historial reciente" del Crash. */
export function recentCrashes(ctx: GameContext, limit = 12): number[] {
  return ctx.db.all<{ result: string | null }>("SELECT result FROM casino_rounds WHERE game = 'crash' AND status IN ('won', 'lost') ORDER BY id DESC LIMIT ?", limit)
    .map((r) => {
      try {
        return Number((JSON.parse(r.result ?? '{}') as { crash?: number }).crash);
      } catch {
        return Number.NaN;
      }
    })
    .filter((x) => Number.isFinite(x));
}

export function crashHistoryLine(points: number[]): string {
  if (!points.length) return '*Todavía no hubo vuelos.*';
  return points.map((x) => `${x >= 10 ? '🟣' : x >= 2 ? '🟢' : '🔴'} ${x.toFixed(2)}x`).join(' · ');
}

/** Cohete en vuelo: altura proporcional al logaritmo del multiplicador (hasta 100x). */
function rocket(m: number, exploded: boolean): string {
  const height = Math.min(10, Math.round((Math.log(m) / Math.log(100)) * 10));
  return `${exploded ? '💥' : '🚀'} ${bar(height, 10, 10)}`;
}

export const crashScreens: GameScreens<CrashState> = {
  render(o: RenderOpts<CrashState>): Screen {
    const { round, state } = o.view;
    const p = round.params as CrashParams;
    if (!isOver(o.view) && state) {
      const now = multiplierAt(o.ctx.now() - state.startedAt);
      const e = gameEmbed(round, o.viewer, null, 'en vuelo')
        .setDescription([
          `# ${mult(now)}`,
          rocket(now, false),
          '',
          `Apuesta ${coins(round.totalBet)} · ahora vale **${coins(potential(round, now))}**`,
          p.auto ? `🤖 Retiro automático en **${mult(p.auto)}** (${coins(potential(round, p.auto))})` : '🖐️ Retiro manual: tocá **Retirar** antes de que explote.',
          '',
          '-# El servidor decide con su reloj: lo que ves puede llegar un instante tarde.',
        ].join('\n'));
      return {
        embeds: [e],
        components: [row(actButton(round, o.ownerId, 'cashout').setLabel(`Retirar · ${coins(potential(round, Math.max(now, MIN_CASHOUT)))}`).setEmoji('💰').setStyle(ButtonStyle.Success))],
      };
    }
    const info = infoOf(o.view);
    const crashAt = (round.result?.crash as number | undefined) ?? 0;
    const cashout = (round.result?.cashout as number | null | undefined) ?? null;
    const lines = round.status === 'refunded'
      ? ['↩️ **Partida interrumpida:** se te devolvió la apuesta.', `Saldo: **${coins(o.view.balance)}**`]
      : [
        `# ${cashout ? `✅ ${mult(cashout)}` : `💥 ${mult(crashAt)}`}`,
        rocket(Math.max(1, cashout ?? crashAt), !cashout),
        cashout ? `Retiraste en **${mult(cashout)}**${round.result?.auto ? ' (automático)' : ''} · el cohete explotó en **${mult(crashAt)}**` : `El cohete explotó en **${mult(crashAt)}**.`,
        '',
        ...resultLines(o.ctx, round, info, o.view.balance),
      ];
    const e = gameEmbed(round, o.viewer, info).setDescription([...lines, '', `-# Últimos vuelos: ${crashHistoryLine(recentCrashes(o.ctx, 8))}`].join('\n'));
    return { embeds: [e], components: endRows(o, []) };
  },

  rules(ctx, prefix) {
    const rtp = rtpOf(getCasinoConfig(ctx), 'crash');
    return rulesEmbed(ctx, 'crash', prefix, [
      'El cohete despega en **1,00x** y el multiplicador sube cada vez más rápido (se duplica cada 6 s) hasta que **explota**.',
      '• Tocá **Retirar** antes de la explosión y cobrás apuesta × multiplicador. Si explota antes, perdés la apuesta.',
      '• **Retiro automático:** `!crash 500 2.5x` retira solo en 2,50x si el cohete llega.',
      `• La probabilidad de llegar a x es ${(rtp * 100).toLocaleString('es-AR', { maximumFractionDigits: 1 })} % ÷ x: llegar a 2x ≈ ${((rtp / 2) * 100).toFixed(1)} %, a 10x ≈ ${((rtp / 10) * 100).toFixed(1)} %.`,
      '• Si el bot se reinicia en pleno vuelo: con retiro automático alcanzable se paga; si no, se devuelve la apuesta.',
      '',
      `**Últimos vuelos:** ${crashHistoryLine(recentCrashes(ctx))}`,
    ]);
  },
};

export type CrashView = RoundView<CrashState>;

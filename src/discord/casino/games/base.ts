import { EmbedBuilder } from 'discord.js';
import { getCasinoConfig, rtpOf, type GameId } from '../../../casino/config';
import type { RoundView, SettleInfo } from '../../../casino/engine';
import { outcomeOf } from '../../../casino/users';
import type { GameContext } from '../../../services/context';
import type { Viewer } from '../../app';
import { COLORS, coins, num } from '../../ui/theme';
import { gameMeta, rebetRow } from '../format';
import type { Row, Screen } from '../screen';

export interface RenderOpts<S = unknown> {
  ctx: GameContext;
  view: RoundView<S>;
  viewer: Viewer;
  /** Dueño de los botones (quien juega). */
  ownerId: string;
}

export interface GameScreens<S = unknown> {
  /** Pantalla de la ronda (en curso o terminada). */
  render(o: RenderOpts<S>): Screen;
  /** Cuadros de animación antes de mostrar el resultado (solo al terminar). */
  frames?(o: RenderOpts<S>): Screen[];
  /** Reglas, pagos y límites (sin apuesta: `!crash`). */
  rules(ctx: GameContext, prefix: string): EmbedBuilder;
}

/** Datos del resultado: los de la liquidación recién hecha, o reconstruidos de la ronda guardada. */
export function infoOf(view: RoundView): SettleInfo {
  if (view.settled) return view.settled;
  const r = view.round;
  return {
    payout: r.payout, profit: r.payout - r.totalBet, multiplier: r.multiplier, outcome: r.status === 'refunded' ? 'push' : outcomeOf(r.totalBet, r.payout),
    summary: r.summary ?? '', jackpot: 0, capped: false, achievements: [], levelUp: null, tournaments: [], bigWin: false, flags: [],
  };
}

export const isOver = (view: RoundView) => view.round.status !== 'active';

/** Filas finales: repetir (si terminó) o las de la partida en curso. */
export function endRows(o: RenderOpts, playing: Row[]): Row[] {
  return isOver(o.view) ? [rebetRow(o.view.round, o.ownerId, o.view.balance)] : playing;
}

/** Encabezado de reglas: apuesta mínima y máxima, RTP y si está cerrado. */
export function rulesEmbed(ctx: GameContext, id: GameId, prefix: string, body: string[]): EmbedBuilder {
  const g = gameMeta(id);
  const cfg = getCasinoConfig(ctx);
  const gs = cfg.games[id];
  const rtp = g.fixedEdge ? `ventaja de la casa ${g.fixedEdge}` : `RTP ${(rtpOf(cfg, id) * 100).toLocaleString('es-AR', { maximumFractionDigits: 2 })} %`;
  return new EmbedBuilder()
    .setColor(gs.enabled ? g.color : COLORS.push)
    .setTitle(`${g.emoji} ${g.name}${gs.enabled ? '' : ' · 🔒 cerrado'}`)
    .setDescription([
      `*${g.tagline}*`,
      '',
      ...body,
      '',
      `**Cómo jugar:** \`${prefix}${commandOf(id)} ${g.usage}\``,
      `-# Apuesta ${coins(gs.minBet)} a ${coins(gs.maxBet)} · ${rtp} · premio máximo por ronda ${coins(cfg.maxPayout)} · espera ${num(gs.cooldownMs / 1000)} s`,
    ].join('\n'));
}

const COMMAND_OF: Record<GameId, string> = {
  blackjack: 'bj', roulette: 'ruleta', slots: 'slots', crash: 'crash', plinko: 'plinko', mines: 'minas', chicken: 'pollo', balloons: 'globos', hilo: 'hilo', tower: 'dragon',
};
export const commandOf = (id: GameId) => COMMAND_OF[id];

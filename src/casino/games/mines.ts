import { GameError } from '../../services/context';
import type { ActContext, CasinoGame, PlayContext, Settlement, Step } from '../engine';
import type { FairRng } from '../rng';
import { floor2, intOption } from './util';

/**
 * Minas: tablero de 5 × 5 con 1 a 24 minas (se ubican al apostar, con el azar verificable).
 * Después de k casillas seguras, la probabilidad de haber llegado es C(25−m, k) / C(25, k);
 * el multiplicador es RTP / esa probabilidad, así cobrar en cualquier momento tiene el mismo valor esperado.
 */

export const TILES = 25;
export const MINES_MIN = 1;
export const MINES_MAX = 24;

export interface MinesParams {
  mines: number;
}

export interface MinesState {
  mines: number[];
  revealed: number[];
  /** Casilla con mina que se tocó (al perder). */
  hit: number | null;
}

/** Probabilidad de sobrevivir k casillas con m minas. */
export function survival(mines: number, k: number): number {
  let p = 1;
  for (let i = 0; i < k; i++) p *= (TILES - mines - i) / (TILES - i);
  return p;
}

export function minesMultiplier(mines: number, k: number, rtp: number): number {
  return k === 0 ? 1 : floor2(rtp / survival(mines, k));
}

export function placeMines(rng: FairRng, mines: number): number[] {
  return rng.shuffle(Array.from({ length: TILES }, (_, i) => i)).slice(0, mines).sort((a, b) => a - b);
}

function cash(s: MinesState, c: ActContext<MinesParams> | PlayContext<MinesParams>, mines: number): Settlement {
  const k = s.revealed.length;
  const multiplier = minesMultiplier(mines, k, c.rtp);
  return {
    multiplier,
    summary: `💣 ${k} ${k === 1 ? 'casilla' : 'casillas'} con ${mines} ${mines === 1 ? 'mina' : 'minas'} · ${multiplier.toFixed(2)}x`,
    result: { mines: s.mines, revealed: s.revealed, cashed: true },
    flags: mines >= 20 && k >= 1 ? ['mines_extreme'] : [],
  };
}

export const mines: CasinoGame<MinesParams, MinesState> = {
  id: 'mines',
  name: 'Minas',
  emoji: '💣',
  color: 0x2c3e50,
  kind: 'interactive',
  tagline: 'Destapá casillas sin pisar una mina. Más minas, más multiplicador.',
  usage: '<apuesta> [minas 1-24]',
  parseParams: (args) => ({ mines: intOption(args[0], MINES_MIN, MINES_MAX, 3, 'La cantidad de minas') }),
  describeParams: (p) => `${p.mines} ${p.mines === 1 ? 'mina' : 'minas'}`,

  start(c: PlayContext<MinesParams>): Step<MinesState> {
    return { state: { mines: placeMines(c.rng, c.params.mines), revealed: [], hit: null } };
  },

  act(s: MinesState, action, c: ActContext<MinesParams>): Step<MinesState> {
    const m = c.params.mines;
    if (action.type === 'cash') {
      if (!s.revealed.length) throw new GameError('Destapá al menos una casilla antes de cobrar.');
      return { state: s, settle: cash(s, c, m) };
    }
    if (action.type !== 'pick') throw new GameError('Acción inválida.');
    const idx = action.arg ?? -1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= TILES) throw new GameError('Casilla inválida.');
    if (s.revealed.includes(idx)) throw new GameError('Esa casilla ya está destapada.');
    if (s.mines.includes(idx)) {
      s.hit = idx;
      return { state: s, settle: { multiplier: 0, summary: `💣 Mina en la casilla ${s.revealed.length + 1} (${m} ${m === 1 ? 'mina' : 'minas'})`, result: { mines: s.mines, revealed: s.revealed, hit: idx } } };
    }
    s.revealed.push(idx);
    // Todas las seguras destapadas: se cobra solo el máximo.
    if (s.revealed.length === TILES - m) return { state: s, settle: cash(s, c, m) };
    return { state: s };
  },

  resolveAbandoned(s, c): Settlement | 'refund' {
    return s.revealed.length ? cash(s, c, c.params.mines) : 'refund';
  },

  fairSummary(rng, params): string {
    return `Minas en las casillas ${placeMines(rng, params.mines).map((i) => i + 1).join(', ')} (1 = arriba a la izquierda)`;
  },
};

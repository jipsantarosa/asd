import { GameError } from '../../services/context';
import type { ActContext, CasinoGame, PlayContext, Settlement, Step } from '../engine';
import type { FairRng } from '../rng';
import { floor2, pickOption } from './util';

/**
 * Pollo: cruza una ruta de 10 carriles. Cada carril tiene su probabilidad de pasar, cada vez más baja.
 * El multiplicador después de k carriles es RTP / P(cruzar los k), así que retirarse en cualquier carril
 * tiene el mismo valor esperado; seguir es más riesgo por más premio.
 */

export type ChickenDifficulty = 'easy' | 'medium' | 'hard';
export const LANES = 10;
export const DIFF_LABEL: Record<ChickenDifficulty, string> = { easy: 'fácil', medium: 'normal', hard: 'difícil' };

/** Probabilidad de pasar cada carril. */
export const SURVIVAL: Record<ChickenDifficulty, number[]> = {
  easy: [0.94, 0.93, 0.92, 0.91, 0.9, 0.88, 0.86, 0.84, 0.82, 0.8],
  medium: [0.88, 0.88, 0.85, 0.83, 0.8, 0.75, 0.7, 0.65, 0.6, 0.5],
  hard: [0.8, 0.78, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4],
};

export interface ChickenParams {
  difficulty: ChickenDifficulty;
}

export interface ChickenState {
  /** Carril (1–10) donde lo atropellan; null = cruza todo. Se decide al apostar. */
  deathLane: number | null;
  lane: number;
}

export function chickenMultiplier(d: ChickenDifficulty, lane: number, rtp: number): number {
  if (lane === 0) return 1;
  const p = SURVIVAL[d].slice(0, lane).reduce((a, b) => a * b, 1);
  return floor2(rtp / p);
}

/** Siempre se usan 10 números (uno por carril), aunque el pollo caiga antes: así se verifica igual. */
export function deathLane(rng: FairRng, d: ChickenDifficulty): number | null {
  const rolls = Array.from({ length: LANES }, () => rng.next());
  const i = rolls.findIndex((f, lane) => f >= SURVIVAL[d][lane]);
  return i === -1 ? null : i + 1;
}

function cash(s: ChickenState, c: ActContext<ChickenParams>): Settlement {
  const multiplier = chickenMultiplier(c.params.difficulty, s.lane, c.rtp);
  return {
    multiplier,
    summary: `🐔 cruzó ${s.lane} ${s.lane === 1 ? 'carril' : 'carriles'} (${DIFF_LABEL[c.params.difficulty]}) · ${multiplier.toFixed(2)}x`,
    result: { lane: s.lane, deathLane: s.deathLane },
    flags: s.lane === LANES ? ['chicken_complete'] : [],
  };
}

export const chicken: CasinoGame<ChickenParams, ChickenState> = {
  id: 'chicken',
  name: 'Pollo',
  emoji: '🐔',
  color: 0xf39c12,
  kind: 'interactive',
  tagline: 'Hacé cruzar al pollo carril por carril. Retirate antes de que lo pisen.',
  usage: '<apuesta> [fácil|normal|difícil]',
  parseParams: (args) => ({ difficulty: pickOption<ChickenDifficulty>(args[0], { easy: ['facil', 'fácil', 'f', 'e'], medium: ['normal', 'medio', 'n', 'm'], hard: ['dificil', 'difícil', 'd', 'h'] }, 'medium', 'Dificultad') }),
  describeParams: (p) => DIFF_LABEL[p.difficulty],

  start(c: PlayContext<ChickenParams>): Step<ChickenState> {
    return { state: { deathLane: deathLane(c.rng, c.params.difficulty), lane: 0 } };
  },

  act(s: ChickenState, action, c: ActContext<ChickenParams>): Step<ChickenState> {
    if (action.type === 'cash') {
      if (s.lane === 0) throw new GameError('Avanzá al menos un carril antes de retirarte.');
      return { state: s, settle: cash(s, c) };
    }
    if (action.type !== 'go') throw new GameError('Acción inválida.');
    s.lane += 1;
    if (s.deathLane === s.lane) {
      return { state: s, settle: { multiplier: 0, summary: `🐔 💥 lo atropellaron en el carril ${s.lane} (${DIFF_LABEL[c.params.difficulty]})`, result: { lane: s.lane, deathLane: s.deathLane } } };
    }
    if (s.lane === LANES) return { state: s, settle: cash(s, c) };
    return { state: s };
  },

  resolveAbandoned: (s, c) => (s.lane > 0 ? cash(s, c) : 'refund'),

  fairSummary(rng, params): string {
    const d = deathLane(rng, params.difficulty);
    return d === null ? 'El pollo cruzaba los 10 carriles' : `Lo atropellaban en el carril ${d}`;
  },
};

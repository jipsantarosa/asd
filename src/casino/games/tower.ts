import { GameError } from '../../services/context';
import type { ActContext, CasinoGame, PlayContext, Settlement, Step } from '../engine';
import type { FairRng } from '../rng';
import { floor2, pickOption } from './util';

/**
 * Dragon Tower: 9 pisos. En cada uno elegís una casilla; las seguras dependen de la dificultad.
 * El multiplicador del piso k es RTP / (seguras / casillas)^k. Completar los 9 da el máximo.
 */

export type TowerDifficulty = 'easy' | 'medium' | 'hard' | 'expert';
export const FLOORS = 9;
export const DIFFICULTY: Record<TowerDifficulty, { tiles: number; safe: number; label: string }> = {
  easy: { tiles: 4, safe: 3, label: 'fácil' },
  medium: { tiles: 3, safe: 2, label: 'medio' },
  hard: { tiles: 2, safe: 1, label: 'difícil' },
  expert: { tiles: 3, safe: 1, label: 'experto' },
};

export interface TowerParams {
  difficulty: TowerDifficulty;
}

export interface TowerState {
  /** Casillas seguras de cada piso (se deciden al apostar). */
  safe: number[][];
  floor: number;
  picks: number[];
  /** Casilla con dragón que se eligió (al perder). */
  hit: number | null;
}

export function towerMultiplier(d: TowerDifficulty, floor: number, rtp: number): number {
  if (floor === 0) return 1;
  const { tiles, safe } = DIFFICULTY[d];
  return floor2(rtp / (safe / tiles) ** floor);
}

export function buildTower(rng: FairRng, d: TowerDifficulty): number[][] {
  const { tiles, safe } = DIFFICULTY[d];
  return Array.from({ length: FLOORS }, () => rng.shuffle(Array.from({ length: tiles }, (_, i) => i)).slice(0, safe).sort((a, b) => a - b));
}

function cash(s: TowerState, c: ActContext<TowerParams>): Settlement {
  const d = c.params.difficulty;
  const multiplier = towerMultiplier(d, s.floor, c.rtp);
  const complete = s.floor === FLOORS;
  return {
    multiplier,
    summary: `🐉 piso ${s.floor}/${FLOORS} (${DIFFICULTY[d].label}) · ${multiplier.toFixed(2)}x`,
    result: { floor: s.floor, safe: s.safe },
    flags: complete ? ['tower_complete', ...(d === 'expert' ? ['tower_expert'] : [])] : [],
  };
}

export const tower: CasinoGame<TowerParams, TowerState> = {
  id: 'tower',
  name: 'Dragon Tower',
  emoji: '🐉',
  color: 0x8e44ad,
  kind: 'interactive',
  tagline: 'Subí los 9 pisos de la torre sin despertar al dragón.',
  usage: '<apuesta> [fácil|medio|difícil|experto]',
  parseParams: (args) => ({
    difficulty: pickOption<TowerDifficulty>(args[0], {
      easy: ['facil', 'fácil', 'f', 'e'], medium: ['medio', 'normal', 'm'], hard: ['dificil', 'difícil', 'd', 'h'], expert: ['experto', 'x', 'pro'],
    }, 'medium', 'Dificultad'),
  }),
  describeParams: (p) => DIFFICULTY[p.difficulty].label,

  start(c: PlayContext<TowerParams>): Step<TowerState> {
    return { state: { safe: buildTower(c.rng, c.params.difficulty), floor: 0, picks: [], hit: null } };
  },

  act(s: TowerState, action, c: ActContext<TowerParams>): Step<TowerState> {
    if (action.type === 'cash') {
      if (s.floor === 0) throw new GameError('Subí al menos un piso antes de cobrar.');
      return { state: s, settle: cash(s, c) };
    }
    if (action.type !== 'tile') throw new GameError('Acción inválida.');
    const { tiles } = DIFFICULTY[c.params.difficulty];
    const idx = action.arg ?? -1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= tiles) throw new GameError('Casilla inválida.');
    if (!s.safe[s.floor].includes(idx)) {
      s.hit = idx;
      return { state: s, settle: { multiplier: 0, summary: `🐉 🔥 el dragón en el piso ${s.floor + 1} (${DIFFICULTY[c.params.difficulty].label})`, result: { floor: s.floor, safe: s.safe, hit: idx } } };
    }
    s.picks.push(idx);
    s.floor += 1;
    if (s.floor === FLOORS) return { state: s, settle: cash(s, c) };
    return { state: s };
  },

  resolveAbandoned: (s, c) => (s.floor > 0 ? cash(s, c) : 'refund'),

  fairSummary(rng, params): string {
    return `Casillas seguras por piso: ${buildTower(rng, params.difficulty).map((f, i) => `${i + 1}:[${f.map((x) => x + 1).join(',')}]`).join(' ')}`;
  },
};

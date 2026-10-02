import { GameError } from '../../services/context';
import type { ActContext, CasinoGame, PlayContext, Settlement, Step } from '../engine';
import type { FairRng } from '../rng';
import { floor2 } from './util';

/**
 * Globos: 8 niveles con 6 globos cada uno. En cada nivel algunos globos tienen una aguja, y son cada vez más
 * (1, 1, 1, 2, 2, 3, 3, 4): el riesgo sube progresivamente. Reventás un globo por nivel; si era seguro, subís
 * y el multiplicador crece. El multiplicador del nivel k es RTP / P(pasar los k niveles).
 */

export const PER_LEVEL = 6;
export const NEEDLES = [1, 1, 1, 2, 2, 3, 3, 4];
export const LEVELS = NEEDLES.length;

export interface BalloonsState {
  /** Posiciones con aguja en cada nivel (se deciden al apostar). */
  needles: number[][];
  level: number;
  /** Globo elegido en cada nivel superado. */
  picks: number[];
  /** Globo con aguja que se reventó (al perder). */
  hit: number | null;
}

export function balloonsMultiplier(level: number, rtp: number): number {
  if (level === 0) return 1;
  let p = 1;
  for (let i = 0; i < level; i++) p *= (PER_LEVEL - NEEDLES[i]) / PER_LEVEL;
  return floor2(rtp / p);
}

export function placeNeedles(rng: FairRng): number[][] {
  return NEEDLES.map((n) => rng.shuffle([0, 1, 2, 3, 4, 5]).slice(0, n).sort((a, b) => a - b));
}

function cash(s: BalloonsState, c: ActContext<Record<string, never>>): Settlement {
  const multiplier = balloonsMultiplier(s.level, c.rtp);
  return {
    multiplier,
    summary: `🎈 ${s.level} ${s.level === 1 ? 'nivel' : 'niveles'} · ${multiplier.toFixed(2)}x`,
    result: { level: s.level, needles: s.needles },
    flags: s.level === LEVELS ? ['balloons_complete'] : [],
  };
}

export const balloons: CasinoGame<Record<string, never>, BalloonsState> = {
  id: 'balloons',
  name: 'Globos',
  emoji: '🎈',
  color: 0xe91e63,
  kind: 'interactive',
  tagline: 'Reventá un globo por nivel sin dar con la aguja. Cada nivel hay más agujas.',
  usage: '<apuesta>',
  parseParams: () => ({}),

  start(c: PlayContext<Record<string, never>>): Step<BalloonsState> {
    return { state: { needles: placeNeedles(c.rng), level: 0, picks: [], hit: null } };
  },

  act(s: BalloonsState, action, c: ActContext<Record<string, never>>): Step<BalloonsState> {
    if (action.type === 'cash') {
      if (s.level === 0) throw new GameError('Reventá al menos un globo antes de cobrar.');
      return { state: s, settle: cash(s, c) };
    }
    if (action.type !== 'pop') throw new GameError('Acción inválida.');
    const idx = action.arg ?? -1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= PER_LEVEL) throw new GameError('Globo inválido.');
    if (s.needles[s.level].includes(idx)) {
      s.hit = idx;
      return { state: s, settle: { multiplier: 0, summary: `🎈 💥 aguja en el nivel ${s.level + 1}`, result: { level: s.level, needles: s.needles, hit: idx } } };
    }
    s.picks.push(idx);
    s.level += 1;
    if (s.level === LEVELS) return { state: s, settle: cash(s, c) };
    return { state: s };
  },

  resolveAbandoned: (s, c) => (s.level > 0 ? cash(s, c) : 'refund'),

  fairSummary(rng): string {
    return `Agujas por nivel: ${placeNeedles(rng).map((n, i) => `${i + 1}:[${n.map((x) => x + 1).join(',')}]`).join(' ')}`;
  },
};

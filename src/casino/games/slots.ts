import type { CasinoGame, PlayContext, Settlement } from '../engine';
import type { FairRng } from '../rng';
import { floor2 } from './util';

/**
 * Tragamonedas de 3 rodillos, una línea de pago (la del medio).
 * Cada rodillo es una tira fija de 100 símbolos con estas frecuencias; el azar elige dónde para cada uno,
 * así las filas de arriba y de abajo también son las reales del rodillo.
 *
 * - ⭐ es comodín: completa cualquier trío (tres ⭐ pagan su propio premio).
 * - Tres 7️⃣ reales pagan el máximo **y el jackpot progresivo** (con un comodín pagan el máximo sin jackpot).
 * - Dos 🍒 en la línea pagan una parte.
 * La tabla base está calculada para un retorno del 95 %; se escala exacto al RTP configurado (ver slotsRtp()).
 */

export interface SlotSymbol {
  id: string;
  emoji: string;
  weight: number;
  /** Premio base del trío. */
  triple: number;
  wild?: boolean;
}

export const SYMBOLS: SlotSymbol[] = [
  { id: 'cherry', emoji: '🍒', weight: 30, triple: 3 },
  { id: 'lemon', emoji: '🍋', weight: 25, triple: 5 },
  { id: 'bell', emoji: '🔔', weight: 20, triple: 8 },
  { id: 'diamond', emoji: '💎', weight: 12, triple: 25 },
  { id: 'seven', emoji: '7️⃣', weight: 7, triple: 60 },
  { id: 'star', emoji: '⭐', weight: 6, triple: 30, wild: true },
];

export const CHERRY_PAIR = 1.5;
const STAR = SYMBOLS.findIndex((s) => s.wild);
const SEVEN = SYMBOLS.findIndex((s) => s.id === 'seven');
const CHERRY = SYMBOLS.findIndex((s) => s.id === 'cherry');

/** Tira del rodillo: los símbolos repartidos de forma pareja (siempre la misma, no depende del azar). */
export const STRIP: number[] = (() => {
  const strip: number[] = [];
  const left = SYMBOLS.map((s) => s.weight);
  const total = left.reduce((a, b) => a + b, 0);
  const credit = SYMBOLS.map(() => 0);
  for (let i = 0; i < total; i++) {
    for (let k = 0; k < SYMBOLS.length; k++) credit[k] += SYMBOLS[k].weight;
    let best = -1;
    for (let k = 0; k < SYMBOLS.length; k++) if (left[k] > 0 && (best === -1 || credit[k] > credit[best])) best = k;
    credit[best] -= total;
    left[best] -= 1;
    strip.push(best);
  }
  return strip;
})();

export interface LineResult {
  base: number;
  kind: string;
  jackpot: boolean;
}

/** Premio base de una línea (índices de símbolo). */
export function evaluateLine(line: number[]): LineResult {
  if (line.every((s) => s === SEVEN)) return { base: SYMBOLS[SEVEN].triple, kind: 'triple', jackpot: true };
  const real = line.filter((s) => s !== STAR);
  if (!real.length) return { base: SYMBOLS[STAR].triple, kind: 'triple', jackpot: false };
  if (real.every((s) => s === real[0])) return { base: SYMBOLS[real[0]].triple, kind: 'triple', jackpot: false };
  if (line.filter((s) => s === CHERRY).length === 2) return { base: CHERRY_PAIR, kind: 'pair', jackpot: false };
  return { base: 0, kind: 'none', jackpot: false };
}

/** Retorno exacto de la tabla base (enumera las 6³ combinaciones con su probabilidad). */
export function slotsRtp(scale = 1): number {
  const total = SYMBOLS.reduce((s, x) => s + x.weight, 0);
  let rtp = 0;
  for (let a = 0; a < SYMBOLS.length; a++) for (let b = 0; b < SYMBOLS.length; b++) for (let c = 0; c < SYMBOLS.length; c++) {
    const p = (SYMBOLS[a].weight * SYMBOLS[b].weight * SYMBOLS[c].weight) / total ** 3;
    rtp += p * floor2(evaluateLine([a, b, c]).base * scale);
  }
  return rtp;
}

const BASE_RTP = slotsRtp(1);

/** Factor para llevar la tabla base al RTP pedido. */
export function slotsScale(rtp: number): number {
  return rtp / BASE_RTP;
}

export function paytable(rtp: number): { emoji: string; label: string; multiplier: number }[] {
  const k = slotsScale(rtp);
  return [
    ...[...SYMBOLS].sort((a, b) => b.triple - a.triple).map((s) => ({ emoji: `${s.emoji}${s.emoji}${s.emoji}`, label: s.id === 'seven' ? 'máximo + JACKPOT' : s.wild ? 'comodín' : '', multiplier: floor2(s.triple * k) })),
    { emoji: '🍒🍒', label: 'dos cerezas', multiplier: floor2(CHERRY_PAIR * k) },
  ];
}

/** Paradas de los tres rodillos y la ventana visible (3 filas × 3 rodillos). */
export function spinReels(rng: FairRng): { stops: number[]; grid: number[][] } {
  const stops = [0, 1, 2].map(() => rng.int(STRIP.length));
  const at = (i: number) => STRIP[(i + STRIP.length) % STRIP.length];
  const grid = [-1, 0, 1].map((d) => stops.map((s) => at(s + d)));
  return { stops, grid };
}

export const emojiGrid = (grid: number[][]) => grid.map((row) => row.map((s) => SYMBOLS[s].emoji));

export const slots: CasinoGame<Record<string, never>, never> = {
  id: 'slots',
  name: 'Slots',
  emoji: '🎰',
  color: 0x9b59b6,
  kind: 'instant',
  tagline: 'Tres rodillos, comodín ⭐ y jackpot progresivo con 7️⃣7️⃣7️⃣.',
  usage: '<apuesta>',
  jackpot: true,
  parseParams: () => ({}),

  play(c: PlayContext<Record<string, never>>): Settlement {
    const { grid } = spinReels(c.rng);
    const line = grid[1];
    const r = evaluateLine(line);
    const multiplier = floor2(r.base * slotsScale(c.rtp));
    return {
      multiplier,
      summary: `🎰 ${line.map((s) => SYMBOLS[s].emoji).join(' ')}${r.jackpot ? ' · JACKPOT' : ''}`,
      result: { grid: emojiGrid(grid), kind: r.kind },
      flags: r.jackpot ? ['jackpot'] : [],
    };
  },

  fairSummary(rng): string {
    const { grid } = spinReels(rng);
    return `Línea: ${grid[1].map((s) => SYMBOLS[s].emoji).join(' ')}`;
  },
};

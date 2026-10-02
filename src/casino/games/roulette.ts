import { GameError } from '../../services/context';
import type { CasinoGame, PlayContext, Settlement } from '../engine';
import type { FairRng } from '../rng';
import { floor2 } from './util';

/**
 * Ruleta europea (un solo 0). Una apuesta cubre k números y paga 36 / k veces lo apostado:
 * pleno 36x, docena o columna 3x, color, paridad o mitad 2x. Rangos y listas personalizadas usan la misma regla.
 * El 0 hace perder las apuestas externas: esa es la ventaja de la casa (1/37 = 2,7 %), igual para todas las apuestas.
 */

export const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export function colorOf(n: number): 'green' | 'red' | 'black' {
  return n === 0 ? 'green' : RED.has(n) ? 'red' : 'black';
}

export function colorEmoji(n: number): string {
  return { green: '🟢', red: '🔴', black: '⚫' }[colorOf(n)];
}

export interface RouletteBet {
  /** Texto para mostrar: "rojo", "docena 2", "7, 17, 23". */
  label: string;
  numbers: number[];
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ALL = range(1, 36);

const NAMED: { keys: string[]; label: string; numbers: number[] }[] = [
  { keys: ['rojo', 'red', 'r', 'rojos'], label: 'rojo', numbers: ALL.filter((n) => RED.has(n)) },
  { keys: ['negro', 'black', 'n', 'b', 'negros'], label: 'negro', numbers: ALL.filter((n) => !RED.has(n)) },
  { keys: ['par', 'even', 'pares'], label: 'par', numbers: ALL.filter((n) => n % 2 === 0) },
  { keys: ['impar', 'odd', 'impares'], label: 'impar', numbers: ALL.filter((n) => n % 2 === 1) },
  { keys: ['bajo', 'low', 'falta', '1-18'], label: '1–18', numbers: range(1, 18) },
  { keys: ['alto', 'high', 'pasa', '19-36'], label: '19–36', numbers: range(19, 36) },
  { keys: ['d1', 'docena1', '1d', '1-12', 'primera'], label: 'docena 1 (1–12)', numbers: range(1, 12) },
  { keys: ['d2', 'docena2', '2d', '13-24', 'segunda'], label: 'docena 2 (13–24)', numbers: range(13, 24) },
  { keys: ['d3', 'docena3', '3d', '25-36', 'tercera'], label: 'docena 3 (25–36)', numbers: range(25, 36) },
  { keys: ['c1', 'col1', 'columna1'], label: 'columna 1', numbers: ALL.filter((n) => n % 3 === 1) },
  { keys: ['c2', 'col2', 'columna2'], label: 'columna 2', numbers: ALL.filter((n) => n % 3 === 2) },
  { keys: ['c3', 'col3', 'columna3'], label: 'columna 3', numbers: ALL.filter((n) => n % 3 === 0) },
];

export const ROULETTE_HELP = 'rojo · negro · par · impar · bajo (1–18) · alto (19–36) · d1/d2/d3 (docenas) · c1/c2/c3 (columnas) · un número (0–36) · varios (7,17,23) · un rango (5-12)';

export function parseRouletteBet(args: string[]): RouletteBet {
  const raw = args.join(',').toLowerCase().replace(/\s+/g, '').replace(/,+/g, ',').replace(/^,|,$/g, '');
  if (!raw) throw new GameError(`¿A qué apostás? ${ROULETTE_HELP}.`);
  const named = NAMED.find((b) => b.keys.includes(raw));
  if (named) return { label: named.label, numbers: named.numbers };
  const set = new Set<number>();
  for (const part of raw.split(',')) {
    const m = part.match(/^(\d{1,2})(?:-(\d{1,2}))?$/);
    if (!m) throw new GameError(`No entendí "${part}". Apuestas posibles: ${ROULETTE_HELP}.`);
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    if (a > 36 || b > 36 || b < a) throw new GameError('Los números van del 0 al 36 (y un rango de menor a mayor).');
    for (let n = a; n <= b; n++) set.add(n);
  }
  if (set.size > 36) throw new GameError('Podés cubrir como máximo 36 números.');
  const numbers = [...set].sort((x, y) => x - y);
  const label = numbers.length <= 6 ? numbers.join(', ') : `${numbers.length} números (${raw})`;
  return { label, numbers };
}

export function rouletteMultiplier(bet: RouletteBet): number {
  return floor2(36 / bet.numbers.length);
}

export function spin(rng: FairRng): number {
  return rng.int(37);
}

export const roulette: CasinoGame<RouletteBet, never> = {
  id: 'roulette',
  name: 'Ruleta',
  emoji: '🎡',
  color: 0xc0392b,
  kind: 'instant',
  tagline: 'Rojo, negro, docenas, columnas o plenos. Ruleta europea.',
  usage: '<apuesta> <rojo|negro|par|impar|bajo|alto|d1-3|c1-3|número|7,17,23|5-12>',
  fixedEdge: '2,7 % (el 0)',
  parseParams: parseRouletteBet,
  describeParams: (p) => p.label,

  play(c: PlayContext<RouletteBet>): Settlement {
    const n = spin(c.rng);
    const hit = c.params.numbers.includes(n);
    const multiplier = hit ? rouletteMultiplier(c.params) : 0;
    return {
      multiplier,
      summary: `🎡 ${n} ${colorEmoji(n)} · a ${c.params.label}`,
      result: { number: n, color: colorOf(n), hit, numbers: c.params.numbers.length },
      flags: hit && c.params.numbers.length === 1 ? ['roulette_straight'] : [],
    };
  },

  fairSummary(rng): string {
    const n = spin(rng);
    return `Salió el ${n} ${colorEmoji(n)}`;
  },
};

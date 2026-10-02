import { GameError } from '../../services/context';
import type { CasinoGame, PlayContext, Settlement } from '../engine';
import type { FairRng } from '../rng';
import { pickOption } from './util';

/**
 * Plinko: la bola cae por `filas` hileras de pines y en cada una va a la izquierda o a la derecha (50 % / 50 %).
 * Termina en una de filas + 1 casillas; la casilla k tiene probabilidad C(n, k) / 2ⁿ.
 *
 * Tablas propias (no copiadas de ningún casino): para cada riesgo se fija el multiplicador del centro y el de
 * los bordes, y entre medio crece como  centro × (borde / centro)^(dᵖ), con d = distancia al centro (0 a 1).
 * La curvatura p se busca para que el retorno esperado (con los valores ya redondeados) quede justo en el RTP.
 * Más riesgo: centro más bajo y bordes mucho más altos.
 */

export type PlinkoRisk = 'low' | 'medium' | 'high';
export const ROWS_MIN = 8;
export const ROWS_MAX = 16;
export const RISK_LABEL: Record<PlinkoRisk, string> = { low: 'bajo', medium: 'medio', high: 'alto' };

export interface PlinkoParams {
  risk: PlinkoRisk;
  rows: number;
}

/** Centro y borde de cada riesgo según las filas (más filas = bordes más extremos). */
const SHAPE: Record<PlinkoRisk, { center: (n: number) => number; edge: (n: number) => number }> = {
  low: { center: () => 0.5, edge: (n) => 5.6 * (16 / 5.6) ** ((n - 8) / 8) },
  medium: { center: (n) => 0.4 - (0.1 * (n - 8)) / 8, edge: (n) => 13 * (110 / 13) ** ((n - 8) / 8) },
  high: { center: () => 0.2, edge: (n) => 29 * (1_000 / 29) ** ((n - 8) / 8) },
};

/** Redondeo "lindo" hacia abajo: enteros desde 100, un decimal desde 10, dos decimales debajo. */
export function niceFloor(v: number): number {
  if (v >= 100) return Math.floor(v);
  if (v >= 10) return Math.floor(v * 10 + 1e-9) / 10;
  return Math.floor(v * 100 + 1e-9) / 100;
}

export function binomial(n: number): number[] {
  const row = [1];
  for (let i = 0; i < n; i++) {
    for (let k = row.length - 1; k > 0; k--) row[k] += row[k - 1];
    row.push(1);
  }
  const total = 2 ** n;
  return row.map((c) => c / total);
}

function buildTable(n: number, risk: PlinkoRisk, curvature: number): number[] {
  const c = SHAPE[risk].center(n);
  const e = niceFloor(SHAPE[risk].edge(n));
  return Array.from({ length: n + 1 }, (_, k) => {
    const d = Math.abs(k - n / 2) / (n / 2);
    return niceFloor(c * (e / c) ** (d ** curvature));
  });
}

export function tableRtp(table: number[]): number {
  const p = binomial(table.length - 1);
  return table.reduce((s, m, k) => s + m * p[k], 0);
}

const cache = new Map<string, number[]>();

/** Tabla de multiplicadores para un riesgo, una cantidad de filas y un RTP. */
export function plinkoTable(risk: PlinkoRisk, rows: number, rtp: number): number[] {
  const key = `${risk}:${rows}:${rtp.toFixed(4)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // El retorno baja a medida que sube la curvatura: se busca la menor curvatura que no supere el RTP.
  let lo = 0.05;
  let hi = 60;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (tableRtp(buildTable(rows, risk, mid)) > rtp) lo = mid;
    else hi = mid;
  }
  const table = buildTable(rows, risk, hi);
  cache.set(key, table);
  return table;
}

/** Recorrido de la bola: 0 = izquierda, 1 = derecha. La casilla final es la cantidad de "derechas". */
export function dropBall(rng: FairRng, rows: number): { path: number[]; bucket: number } {
  const path = Array.from({ length: rows }, () => (rng.next() < 0.5 ? 0 : 1));
  return { path, bucket: path.reduce((s: number, x) => s + x, 0) };
}

export function parsePlinko(args: string[]): PlinkoParams {
  let risk: PlinkoRisk = 'medium';
  let rows = 12;
  for (const a of args.slice(0, 2)) {
    if (/^\d+$/.test(a)) {
      const n = Number(a);
      if (n < ROWS_MIN || n > ROWS_MAX) throw new GameError(`Las filas van de ${ROWS_MIN} a ${ROWS_MAX}.`);
      rows = n;
    } else {
      risk = pickOption<PlinkoRisk>(a, { low: ['bajo', 'b', 'l'], medium: ['medio', 'm', 'normal'], high: ['alto', 'a', 'h'] }, 'medium', 'Riesgo');
    }
  }
  return { risk, rows };
}

export const plinko: CasinoGame<PlinkoParams, never> = {
  id: 'plinko',
  name: 'Plinko',
  emoji: '🔵',
  color: 0x3498db,
  kind: 'instant',
  tagline: 'Soltá la bola y mirá dónde cae. Riesgo bajo, medio o alto · 8 a 16 filas.',
  usage: '<apuesta> [bajo|medio|alto] [8-16 filas]',
  parseParams: parsePlinko,
  describeParams: (p) => `riesgo ${RISK_LABEL[p.risk]} · ${p.rows} filas`,

  play(c: PlayContext<PlinkoParams>): Settlement {
    const table = plinkoTable(c.params.risk, c.params.rows, c.rtp);
    const { path, bucket } = dropBall(c.rng, c.params.rows);
    const multiplier = table[bucket];
    return {
      multiplier,
      summary: `🔵 ${multiplier}x · riesgo ${RISK_LABEL[c.params.risk]}, ${c.params.rows} filas`,
      result: { path, bucket, table },
      flags: bucket === 0 || bucket === c.params.rows ? ['plinko_max'] : [],
    };
  },

  fairSummary(rng, params, rtp): string {
    const { path, bucket } = dropBall(rng, params.rows);
    return `Recorrido ${path.map((x) => (x ? 'D' : 'I')).join('')} → casilla ${bucket} (${plinkoTable(params.risk, params.rows, rtp)[bucket]}x)`;
  },
};

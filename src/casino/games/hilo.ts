import { GameError } from '../../services/context';
import type { ActContext, CasinoGame, PlayContext, Settlement, Step } from '../engine';
import type { FairRng } from '../rng';
import { cardLabel, rankOf, shuffledShoe, type Card } from './cards';
import { floor2 } from './util';

/**
 * Hilo (más alta / más baja). Se juega con mazos reales de 52 cartas: las probabilidades se calculan sobre las
 * cartas que QUEDAN en el mazo (la composición cambia a medida que salen). Cuando un mazo se termina, se pasa
 * al siguiente (ya mezclado al apostar).
 *
 * - As es la más baja y Rey la más alta.
 * - Si sale una carta del mismo valor, no se gana ni se pierde: sigue la ronda con el mismo multiplicador.
 * - Cada acierto multiplica por (más + menos) / opción elegida (su probabilidad sin contar los empates):
 *   lo menos probable paga más. El RTP se aplica una sola vez sobre el total: cobrar en cualquier
 *   momento vale lo mismo en promedio.
 * - "Saltar" cambia la carta sin apostar (hasta 20 veces por ronda).
 */

export const DECKS = 2;
export const MAX_SKIPS = 20;
export const MAX_MULTIPLIER = 10_000;

export interface HiloState {
  /** Mazos restantes, cada uno en su orden (se deciden al apostar). */
  decks: Card[][];
  current: Card;
  /** Producto de los factores justos de los aciertos (el multiplicador es RTP × fair). */
  fair: number;
  correct: number;
  skips: number;
  /** Últimas cartas (para mostrar). */
  trail: Card[];
  /** Carta que hizo perder. */
  lostOn: Card | null;
}

export interface HiloOdds {
  higher: number;
  lower: number;
  equal: number;
  /** Multiplicador total si se acierta (null si es imposible). */
  higherMult: number | null;
  lowerMult: number | null;
}

/** Cartas que pueden salir después: lo que queda del mazo actual, o el mazo siguiente entero. */
function upcoming(s: HiloState): Card[] {
  return s.decks[0]?.length ? s.decks[0] : s.decks[1] ?? [];
}

export function hiloOdds(s: HiloState, rtp: number): HiloOdds {
  const cur = rankOf(s.current);
  const pool = upcoming(s);
  const total = pool.length || 1;
  const higher = pool.filter((c) => rankOf(c) > cur).length;
  const lower = pool.filter((c) => rankOf(c) < cur).length;
  const equal = pool.length - higher - lower;
  const mult = (n: number) => (n === 0 ? null : Math.min(MAX_MULTIPLIER, floor2(rtp * s.fair * ((higher + lower) / n))));
  return { higher: higher / total, lower: lower / total, equal: equal / total, higherMult: mult(higher), lowerMult: mult(lower) };
}

export function hiloMultiplier(s: HiloState, rtp: number): number {
  return s.correct === 0 ? 1 : Math.min(MAX_MULTIPLIER, floor2(rtp * s.fair));
}

function draw(s: HiloState): Card | null {
  while (s.decks.length && !s.decks[0].length) s.decks.shift();
  const c = s.decks[0]?.shift();
  return c === undefined ? null : c;
}

export function dealDecks(rng: FairRng): Card[][] {
  return Array.from({ length: DECKS }, () => shuffledShoe(rng, 1));
}

function cash(s: HiloState, c: ActContext<Record<string, never>>): Settlement {
  const multiplier = hiloMultiplier(s, c.rtp);
  return {
    multiplier,
    summary: `🃏 Hilo: ${s.correct} ${s.correct === 1 ? 'acierto' : 'aciertos'} · ${multiplier.toFixed(2)}x`,
    result: { correct: s.correct, last: cardLabel(s.current) },
    flags: s.correct >= 10 ? ['hilo_10'] : [],
  };
}

export const hilo: CasinoGame<Record<string, never>, HiloState> = {
  id: 'hilo',
  name: 'Hilo',
  emoji: '🔮',
  color: 0x16a085,
  kind: 'interactive',
  tagline: '¿La próxima carta es más alta o más baja? Lo menos probable paga más.',
  usage: '<apuesta>',
  parseParams: () => ({}),

  start(c: PlayContext<Record<string, never>>): Step<HiloState> {
    const decks = dealDecks(c.rng);
    const s: HiloState = { decks, current: 0, fair: 1, correct: 0, skips: 0, trail: [], lostOn: null };
    s.current = draw(s)!;
    return { state: s };
  },

  act(s: HiloState, action, c: ActContext<Record<string, never>>): Step<HiloState> {
    if (action.type === 'cash') {
      if (s.correct === 0) throw new GameError('Acertá al menos una carta antes de cobrar.');
      return { state: s, settle: cash(s, c) };
    }
    if (action.type === 'skip') {
      if (s.skips >= MAX_SKIPS) throw new GameError(`Podés saltar hasta ${MAX_SKIPS} cartas por ronda.`);
      const next = draw(s);
      if (next === null) return { state: s, settle: s.correct ? cash(s, c) : { multiplier: 1, summary: '🃏 Hilo: se terminó el mazo (se devuelve la apuesta)' } };
      s.trail = [...s.trail, s.current].slice(-6);
      s.current = next;
      s.skips += 1;
      return { state: s };
    }
    if (action.type !== 'higher' && action.type !== 'lower') throw new GameError('Acción inválida.');
    const factorBase = upcoming(s);
    const cur = rankOf(s.current);
    const higherN = factorBase.filter((x) => rankOf(x) > cur).length;
    const lowerN = factorBase.filter((x) => rankOf(x) < cur).length;
    const chosenN = action.type === 'higher' ? higherN : lowerN;
    if (chosenN === 0) throw new GameError(action.type === 'higher' ? 'No hay ninguna carta más alta posible.' : 'No hay ninguna carta más baja posible.');
    const next = draw(s);
    if (next === null) return { state: s, settle: s.correct ? cash(s, c) : { multiplier: 1, summary: '🃏 Hilo: se terminó el mazo (se devuelve la apuesta)' } };
    const r = rankOf(next);
    s.trail = [...s.trail, s.current].slice(-6);
    const prev = s.current;
    s.current = next;
    if (r === cur) return { state: s }; // empate: sigue igual
    const won = action.type === 'higher' ? r > cur : r < cur;
    if (!won) {
      s.lostOn = next;
      return { state: s, settle: { multiplier: 0, summary: `🃏 Hilo: ${cardLabel(prev)} → ${cardLabel(next)} ❌ (${s.correct} ${s.correct === 1 ? 'acierto' : 'aciertos'})`, result: { correct: s.correct } } };
    }
    s.fair *= (higherN + lowerN) / chosenN;
    s.correct += 1;
    if (hiloMultiplier(s, c.rtp) >= MAX_MULTIPLIER) return { state: s, settle: cash(s, c) };
    return { state: s };
  },

  resolveAbandoned: (s, c) => (s.correct > 0 ? cash(s, c) : 'refund'),

  fairSummary(rng): string {
    const [first] = dealDecks(rng);
    return `Orden del primer mazo: ${first.slice(0, 12).map(cardLabel).join(' ')} …`;
  },
};

import { GameError } from '../../services/context';
import type { ActContext, CasinoGame, PlayContext, Settlement, Step } from '../engine';
import { cardLabel, rankOf, shuffledShoe, type Card } from './cards';

/**
 * Blackjack: 6 mazos, el crupier se planta en 17 blando, blackjack paga 3:2, doblar con dos cartas
 * (también después de dividir), dividir una vez pares del mismo rango (los ases reciben una carta cada uno).
 * Si el crupier tiene blackjack se revela al instante (equivale a "mirar" la carta tapada): solo se pierde la apuesta inicial.
 * Ventaja aproximada de la casa con estas reglas: 0,5 %.
 */

export interface BjHand {
  cards: Card[];
  bet: number;
  doubled: boolean;
  done: boolean;
  fromSplit: boolean;
}

export interface BjState {
  shoe: Card[];
  dealer: Card[];
  hands: BjHand[];
  active: number;
  /** Al terminar: resultado de cada mano. */
  results?: ('win' | 'loss' | 'push' | 'blackjack')[];
}

export function cardValue(c: Card): number {
  const r = rankOf(c);
  return r === 1 ? 11 : Math.min(10, r);
}

export function handValue(cards: Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += cardValue(c);
    if (rankOf(c) === 1) aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

export const isBlackjack = (cards: Card[]) => cards.length === 2 && handValue(cards).total === 21;

function draw(s: BjState): Card {
  const c = s.shoe.shift();
  if (c === undefined) throw new Error('Blackjack: se acabó el mazo');
  return c;
}

export function canDouble(s: BjState): boolean {
  const h = s.hands[s.active];
  return !!h && !h.done && h.cards.length === 2 && !(h.fromSplit && rankOf(h.cards[0]) === 1);
}

export function canSplit(s: BjState): boolean {
  const h = s.hands[s.active];
  return s.hands.length === 1 && !!h && !h.done && h.cards.length === 2 && rankOf(h.cards[0]) === rankOf(h.cards[1]);
}

/** El crupier juega (si queda alguna mano viva) y se liquida cada mano. */
function finish(s: BjState): Settlement {
  const alive = s.hands.some((h) => handValue(h.cards).total <= 21);
  if (alive) while (handValue(s.dealer).total < 17) s.dealer.push(draw(s));
  const d = handValue(s.dealer).total;
  let payout = 0;
  s.results = s.hands.map((h) => {
    const p = handValue(h.cards).total;
    if (p > 21) return 'loss';
    if (d > 21 || p > d) { payout += h.bet * 2; return 'win'; }
    if (p === d) { payout += h.bet; return 'push'; }
    return 'loss';
  });
  const parts = s.hands.map((h, i) => `${s.hands.length > 1 ? `M${i + 1} ` : 'Vos '}${handValue(h.cards).total > 21 ? 'se pasó' : handValue(h.cards).total}${s.results![i] === 'win' ? ' ✅' : s.results![i] === 'push' ? ' 🤝' : ' ❌'}`);
  return { payout, summary: `🃏 ${parts.join(' · ')} · Crupier ${d > 21 ? 'se pasó' : d}`, result: { dealer: d, hands: s.hands.map((h) => handValue(h.cards).total) } };
}

function advance(s: BjState): Step<BjState> {
  const next = s.hands.findIndex((h) => !h.done);
  if (next === -1) return { state: s, settle: finish(s) };
  s.active = next;
  // Un 21 se planta solo.
  if (handValue(s.hands[next].cards).total === 21) {
    s.hands[next].done = true;
    return advance(s);
  }
  return { state: s };
}

export const blackjack: CasinoGame<Record<string, never>, BjState> = {
  id: 'blackjack',
  name: 'Blackjack',
  emoji: '🃏',
  color: 0x1f8b4c,
  kind: 'interactive',
  tagline: 'Llegá a 21 sin pasarte. Blackjack paga 3:2.',
  usage: '<apuesta>',
  fixedEdge: '≈0,5 % (reglas)',
  parseParams: () => ({}),

  start(c: PlayContext<Record<string, never>>): Step<BjState> {
    const shoe = shuffledShoe(c.rng, 6).slice(0, 60);
    const s: BjState = { shoe, dealer: [], hands: [{ cards: [], bet: c.bet, doubled: false, done: false, fromSplit: false }], active: 0 };
    s.hands[0].cards.push(draw(s));
    s.dealer.push(draw(s));
    s.hands[0].cards.push(draw(s));
    s.dealer.push(draw(s));
    const player = isBlackjack(s.hands[0].cards);
    const dealer = isBlackjack(s.dealer);
    if (player || dealer) {
      s.hands[0].done = true;
      s.results = [player && dealer ? 'push' : player ? 'blackjack' : 'loss'];
      const payout = player && dealer ? c.bet : player ? Math.floor(c.bet * 2.5) : 0;
      return {
        state: s,
        settle: {
          payout,
          summary: player && dealer ? '🃏 Blackjack los dos: empate' : player ? '🃏 ¡Blackjack!' : '🃏 El crupier tiene blackjack',
          result: { dealer: 21, hands: [handValue(s.hands[0].cards).total], natural: player },
          flags: player && !dealer ? ['bj_natural'] : [],
        },
      };
    }
    return advance(s);
  },

  act(s: BjState, action, _c: ActContext<Record<string, never>>): Step<BjState> {
    const h = s.hands[s.active];
    if (!h || h.done) throw new GameError('Esa mano ya terminó.');
    switch (action.type) {
      case 'hit': {
        h.cards.push(draw(s));
        if (handValue(h.cards).total >= 21) h.done = true;
        return advance(s);
      }
      case 'stand':
        h.done = true;
        return advance(s);
      case 'double': {
        if (!canDouble(s)) throw new GameError('Solo podés doblar con tus dos primeras cartas.');
        const extra = h.bet;
        h.bet *= 2;
        h.doubled = true;
        h.cards.push(draw(s));
        h.done = true;
        return { ...advance(s), extraBet: extra };
      }
      case 'split': {
        if (!canSplit(s)) throw new GameError('Solo podés dividir dos cartas del mismo valor, una vez por mano.');
        const [a, b] = h.cards;
        const aces = rankOf(a) === 1;
        s.hands = [
          { cards: [a, draw(s)], bet: h.bet, doubled: false, done: aces, fromSplit: true },
          { cards: [b, draw(s)], bet: h.bet, doubled: false, done: aces, fromSplit: true },
        ];
        s.active = 0;
        return { ...advance(s), extraBet: h.bet };
      }
      default:
        throw new GameError('Acción inválida.');
    }
  },

  /** Abandonada: se planta en todas las manos que quedan y juega el crupier. */
  resolveAbandoned(s: BjState): Settlement {
    for (const h of s.hands) h.done = true;
    return finish(s);
  },

  fairSummary(rng): string {
    return `Primeras cartas del mazo: ${shuffledShoe(rng, 6).slice(0, 10).map(cardLabel).join(' ')} (orden: vos, crupier, vos, crupier, …)`;
  },
};

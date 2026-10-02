import type { FairRng } from '../rng';

/**
 * Cartas como números 0–51: rango = floor(c / 4) + 1 (1 = As … 13 = Rey), palo = c % 4.
 * Compacto para guardar el estado de la partida en la base.
 */
export type Card = number;

export const SUITS = ['♠', '♥', '♦', '♣'] as const;
const RANK_LABEL = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export function rankOf(c: Card): number {
  return Math.floor(c / 4) + 1;
}

export function suitOf(c: Card): number {
  return c % 4;
}

export function cardLabel(c: Card): string {
  return `${RANK_LABEL[rankOf(c)]}${SUITS[suitOf(c)]}`;
}

/** Texto de una mano: `A♠` `K♥` */
export function handText(cards: Card[]): string {
  return cards.map((c) => `\`${cardLabel(c)}\``).join(' ');
}

export function rankName(rank: number): string {
  return RANK_LABEL[rank];
}

/** `decks` mazos mezclados con el azar verificable. */
export function shuffledShoe(rng: FairRng, decks: number): Card[] {
  const cards: Card[] = [];
  for (let d = 0; d < decks; d++) for (let c = 0; c < 52; c++) cards.push(c);
  return rng.shuffle(cards);
}

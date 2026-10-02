import { registerGame, type CasinoGame } from '../engine';
import type { GameId } from '../config';
import { balloons } from './balloons';
import { blackjack } from './blackjack';
import { chicken } from './chicken';
import { crash } from './crash';
import { hilo } from './hilo';
import { mines } from './mines';
import { plinko } from './plinko';
import { roulette } from './roulette';
import { slots } from './slots';
import { tower } from './tower';

/**
 * Registro de juegos. Agregar uno nuevo (Dice, Keno, Limbo…) = un archivo con su CasinoGame,
 * su id en GAME_IDS (config.ts), una línea acá y su pantalla en discord/casino/games.
 */
export const GAMES: Record<GameId, CasinoGame<any, any>> = { // eslint-disable-line @typescript-eslint/no-explicit-any
  blackjack, roulette, slots, crash, plinko, mines, chicken, balloons, hilo, tower,
};

let registered = false;
export function registerAllGames(): void {
  if (registered) return;
  registered = true;
  for (const g of Object.values(GAMES)) registerGame(g as CasinoGame);
}

registerAllGames();

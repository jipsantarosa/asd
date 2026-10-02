import type { GameId } from '../../../casino/config';
import type { GameScreens } from './base';
import { balloonsScreens } from './balloons';
import { blackjackScreens } from './blackjack';
import { chickenScreens } from './chicken';
import { crashScreens } from './crash';
import { hiloScreens } from './hilo';
import { minesScreens } from './mines';
import { plinkoScreens } from './plinko';
import { rouletteScreens } from './roulette';
import { slotsScreens } from './slots';
import { towerScreens } from './tower';

/** Pantalla de cada juego. Un juego nuevo agrega su archivo y una línea acá. */
export const SCREENS: Record<GameId, GameScreens<any>> = { // eslint-disable-line @typescript-eslint/no-explicit-any
  blackjack: blackjackScreens,
  roulette: rouletteScreens,
  slots: slotsScreens,
  crash: crashScreens,
  plinko: plinkoScreens,
  mines: minesScreens,
  chicken: chickenScreens,
  balloons: balloonsScreens,
  hilo: hiloScreens,
  tower: towerScreens,
};

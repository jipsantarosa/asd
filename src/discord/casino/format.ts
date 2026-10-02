import { ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { getCasinoConfig, type GameId } from '../../casino/config';
import { payoutFor, type CasinoGame, type Round, type SettleInfo } from '../../casino/engine';
import { GAMES } from '../../casino/games';
import { GameError, type GameContext } from '../../services/context';
import { row, type Viewer } from '../app';
import { cid } from '../ui/ids';
import { COLORS, coins, mult, num, signedCoins } from '../ui/theme';
import type { Row } from './screen';

/** Nombres de comando de cada juego (el primero es el principal). */
export const GAME_COMMANDS: Record<GameId, string[]> = {
  blackjack: ['blackjack', 'bj', '21'],
  roulette: ['ruleta', 'roulette', 'rl'],
  slots: ['slots', 'slot', 'tragamonedas', 'tragaperras'],
  crash: ['crash', 'cohete'],
  plinko: ['plinko', 'pk'],
  mines: ['minas', 'mines', 'buscaminas'],
  chicken: ['pollo', 'chicken', 'gallina'],
  balloons: ['globos', 'balloons', 'globo'],
  hilo: ['hilo', 'hl', 'highlow'],
  tower: ['dragon', 'tower', 'torre', 'dragontower'],
};

export function gameFromName(raw: string | null | undefined): GameId | null {
  if (!raw) return null;
  const v = raw.toLowerCase();
  for (const [id, names] of Object.entries(GAME_COMMANDS) as [GameId, string[]][]) if (id === v || names.includes(v)) return id;
  return null;
}

export const gameMeta = (id: GameId): CasinoGame => GAMES[id];
export const gameLabel = (id: GameId) => `${GAMES[id].emoji} ${GAMES[id].name}`;

/** Cantidad de Coins escrita a mano: 1000, 1.000, 1k, 2.5k, 1m (siempre un entero exacto, sin coma flotante). */
export function parseAmount(raw: string | null | undefined): number | null {
  const t = (raw ?? '').toLowerCase().trim().replace(/\s+/g, '');
  let m = t.match(/^(\d{1,3}(?:\.\d{3})+)$/);
  if (m) return Number(m[1].replace(/\./g, ''));
  m = t.match(/^(\d{1,9})(?:[.,](\d{1,3}))?([km])$/);
  if (m) {
    // "2.5k" = 2 × 1000 + 5 × 100: con enteros, sin errores de redondeo.
    const unit = m[3] === 'k' ? 1_000 : 1_000_000;
    const frac = m[2] ?? '';
    return Number(m[1]) * unit + (frac ? (Number(frac) * unit) / 10 ** frac.length : 0);
  }
  if (/^\d{1,15}$/.test(t)) return Number(t);
  return null;
}

/**
 * Apuesta escrita por la persona → entero. Además de parseAmount acepta "mitad" y "todo"
 * ("todo" usa el saldo hasta la apuesta máxima del juego). El motor vuelve a validar mínimo, máximo y saldo.
 */
export function parseBet(raw: string | null | undefined, balance: number, maxBet: number): number {
  const t = (raw ?? '').toLowerCase().trim();
  if (!t) throw new GameError('Falta la apuesta (por ejemplo `100`, `1k`, `mitad` o `todo`).');
  if (['todo', 'all', 'allin', 'max', 'a'].includes(t)) return Math.min(balance, maxBet);
  if (['mitad', 'half', 'h'].includes(t)) return Math.floor(balance / 2);
  const n = parseAmount(t);
  if (n === null) throw new GameError(`No entendí la apuesta "${raw}". Usá un número (\`500\`, \`1.000\`, \`2.5k\`), \`mitad\` o \`todo\`.`);
  return n;
}

/** Color según el resultado. */
export function outcomeColor(info: SettleInfo | null, base: number): number {
  if (!info) return base;
  if (info.jackpot) return 0xf1c40f;
  return info.outcome === 'win' ? COLORS.win : info.outcome === 'push' ? COLORS.push : COLORS.loss;
}

/** Encabezado común de una pantalla de juego. */
export function gameEmbed(round: Round, viewer: Viewer, info: SettleInfo | null, extraTitle = ''): EmbedBuilder {
  const g = gameMeta(round.game);
  return new EmbedBuilder()
    .setColor(outcomeColor(info, g.color))
    .setAuthor({ name: viewer.name, iconURL: viewer.avatar })
    .setTitle(`${g.emoji} ${g.name}${extraTitle ? ` · ${extraTitle}` : ''}`)
    .setFooter({ text: `Ronda #${round.id} · nonce ${round.nonce} · RTP ${(round.rtp * 100).toLocaleString('es-AR', { maximumFractionDigits: 2 })} % · azar verificable (!fairness)` });
}

/** Bloque de resultado: ganancia o pérdida, saldo, nivel, logros y torneos. */
export function resultLines(ctx: GameContext, round: Round, info: SettleInfo, balance: number): string[] {
  const lines: string[] = [];
  const bet = `Apuesta ${coins(round.totalBet)}`;
  if (info.outcome === 'win') lines.push(`🏆 **¡Ganaste ${coins(info.payout)}!** (${mult(info.multiplier)}) · ${bet} · ${signedCoins(info.profit)}`);
  else if (info.outcome === 'push') lines.push(`🤝 **Empate:** recuperás ${coins(info.payout)} · ${bet}`);
  else lines.push(`💸 **Perdiste** ${coins(round.totalBet - info.payout)}${info.payout > 0 ? ` (recuperás ${coins(info.payout)})` : ''}`);
  if (info.jackpot) lines.push(`🎰 **¡JACKPOT!** +${coins(info.jackpot)}`);
  if (info.capped) lines.push(`-# El premio llegó al máximo por ronda (${coins(getCasinoConfig(ctx).maxPayout)}).`);
  lines.push(`💼 Saldo: **${coins(balance)}**`);
  if (info.levelUp) lines.push(`⭐ **¡Subiste al nivel ${info.levelUp.to}!**${info.levelUp.reward ? ` +${coins(info.levelUp.reward)}` : ''}`);
  for (const a of info.achievements) lines.push(`🏅 Logro: **${a.def.emoji} ${a.def.name}**${a.reward ? ` +${coins(a.reward)}` : ''}`);
  if (info.tournaments.length) lines.push(`-# 🏆 Suma en: ${info.tournaments.join(', ')}`);
  return lines;
}

/** Botones al terminar: repetir la apuesta, el doble o la mitad. */
export function rebetRow(round: Round, ownerId: string, balance: number): Row {
  const g = gameMeta(round.game);
  const half = Math.max(1, Math.floor(round.bet / 2));
  return row(
    new ButtonBuilder().setCustomId(cid('cs', 'rebet', ownerId, round.id, 1)).setLabel(`Repetir · ${num(round.bet)}`).setEmoji('🔁').setStyle(ButtonStyle.Primary)
      .setDisabled(round.rebetUsed || balance < round.bet),
    new ButtonBuilder().setCustomId(cid('cs', 'rebet', ownerId, round.id, 2)).setLabel(`×2 · ${num(round.bet * 2)}`).setStyle(ButtonStyle.Secondary)
      .setDisabled(round.rebetUsed || balance < round.bet * 2),
    new ButtonBuilder().setCustomId(cid('cs', 'rebet', ownerId, round.id, 0)).setLabel(`½ · ${num(half)}`).setStyle(ButtonStyle.Secondary)
      .setDisabled(round.rebetUsed || balance < half || half === round.bet),
    new ButtonBuilder().setCustomId(cid('cs', 'rules', ownerId, g.id)).setEmoji('📖').setStyle(ButtonStyle.Secondary),
  );
}

/** Botón de acción de una partida en curso: g:cs:act:<dueño>:<ronda>:<versión>:<acción>[:<arg>] */
export function actButton(round: Round, ownerId: string, action: string, arg?: number): ButtonBuilder {
  return new ButtonBuilder().setCustomId(arg === undefined ? cid('cs', 'act', ownerId, round.id, round.version, action) : cid('cs', 'act', ownerId, round.id, round.version, action, arg));
}

/** Lo que pagaría el motor con ese multiplicador. */
export function potential(round: Round, multiplier: number): number {
  return payoutFor(round.totalBet, multiplier);
}

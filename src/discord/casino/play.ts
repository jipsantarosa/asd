import { ButtonBuilder, ButtonStyle, EmbedBuilder, type Guild, type GuildMember } from 'discord.js';
import { getCasinoConfig, type GameId } from '../../casino/config';
import {
  ActiveRoundError, actOnRound, claimRebet, gameOf, getRound, playInstant, setRoundMessage, startRound, tickLiveRound, viewOf,
  type BetRequest, type GameAction, type RoundView,
} from '../../casino/engine';
import { getBalance } from '../../casino/economy';
import { canPlayIn, getCasinoGuild } from '../../casino/guilds';
import { touchUser } from '../../casino/users';
import { logger } from '../../logger';
import { GameError, type GameContext } from '../../services/context';
import { row, viewerOf, type App, type Viewer } from '../app';
import { syncRewardRoles } from '../roleSafety';
import { cid } from '../ui/ids';
import { COLORS, clean, coins, mult } from '../ui/theme';
import { gameLabel } from './format';
import { SCREENS } from './games';
import { animate, payloadOf, sleep, type Screen, type ScreenHandle } from './screen';

/**
 * Flujo de juego en Discord. El orden es siempre el mismo: primero el motor resuelve y guarda (una transacción),
 * después se muestra. Si Discord falla a mitad de una animación, el dinero ya quedó bien.
 */

export interface PlayOpts {
  app: App;
  member: GuildMember;
  channelId: string;
  /** Canal padre (hilos): hereda el permiso de los canales de juego. */
  parentId: string | null;
  game: GameId;
  bet: number;
  params: unknown;
  /** Muestra la primera pantalla (comando, botón…) y devuelve cómo editarla. */
  send: (s: Screen) => Promise<ScreenHandle>;
  /** Se ejecuta dentro de la transacción de la apuesta (p. ej. marcar "repetir" como usado). */
  inTx?: () => void;
}

export function render(ctx: GameContext, view: RoundView, viewer: Viewer): Screen {
  return SCREENS[view.round.game].render({ ctx, view, viewer, ownerId: view.round.userId });
}

function frames(ctx: GameContext, view: RoundView, viewer: Viewer): Screen[] {
  return SCREENS[view.round.game].frames?.({ ctx, view, viewer, ownerId: view.round.userId }) ?? [];
}

export function assertChannel(ctx: GameContext, guild: Guild, channelId: string, parentId: string | null): void {
  const g = getCasinoGuild(ctx, guild.id);
  if (!canPlayIn(g, channelId, parentId)) {
    throw new GameError(`🎰 En este servidor los juegos se usan en ${g.gameChannels.map((c) => `<#${c}>`).join(' ')}.`);
  }
}

/** Pantalla para una partida que ya estaba abierta: retomarla en un mensaje nuevo. */
export function activeRoundScreen(e: ActiveRoundError, ownerId: string): Screen {
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.warn).setDescription(`⏸️ Tenés una partida de **${gameLabel(e.game)}** abierta (#${e.roundId}). Terminala antes de empezar otra.`)],
    components: [row(new ButtonBuilder().setCustomId(cid('cs', 'resume', ownerId, e.roundId)).setLabel('Retomar partida').setEmoji('▶️').setStyle(ButtonStyle.Primary))],
  };
}

/** Apuesta y muestra una ronda nueva. */
export async function playGame(o: PlayOpts): Promise<void> {
  const { app, member } = o;
  const ctx = app.ctx;
  assertChannel(ctx, member.guild, o.channelId, o.parentId);
  const req: BetRequest = { userId: member.id, guildId: member.guild.id, channelId: o.channelId, game: o.game, bet: o.bet, params: o.params };
  const game = gameOf(o.game);
  let view: RoundView;
  try {
    view = ctx.db.transaction(() => {
      o.inTx?.();
      return game.kind === 'instant' ? playInstant(ctx, req) : startRound(ctx, req);
    });
  } catch (err) {
    if (err instanceof ActiveRoundError) {
      await o.send(activeRoundScreen(err, member.id));
      return;
    }
    throw err;
  }
  touchUser(ctx, member.id, member.guild.id);
  const viewer = viewerOf(member);
  const final = render(ctx, view, viewer);

  if (view.settled) {
    // Terminó al apostar (juego instantáneo o blackjack natural): animación y resultado.
    const f = frames(ctx, view, viewer);
    const h = await o.send(f[0] ?? final);
    setRoundMessage(ctx, view.round.id, o.channelId, h.message?.id ?? null);
    if (f.length) await animate(h, f.slice(1), final);
    void afterSettle(app, member, view);
    return;
  }
  const h = await o.send(final);
  setRoundMessage(ctx, view.round.id, o.channelId, h.message?.id ?? null);
  if (game.kind === 'live') startLiveRunner(app, view.round.id, h, viewer, member);
}

/** Una decisión dentro de la partida (botón). Devuelve la vista y las pantallas a mostrar. */
export function playAction(ctx: GameContext, userId: string, roundId: number, version: number, action: GameAction, viewer: Viewer): { view: RoundView; frames: Screen[]; final: Screen } {
  const view = actOnRound(ctx, { userId, roundId, version, action });
  return { view, frames: view.settled ? frames(ctx, view, viewer) : [], final: render(ctx, view, viewer) };
}

/** "Repetir": misma partida (juego y parámetros) con la apuesta ×1, ×2 o ½. Cada mensaje se repite una sola vez. */
export async function rebet(app: App, member: GuildMember, roundId: number, factor: number, channelId: string, parentId: string | null, send: PlayOpts['send']): Promise<RoundView> {
  const old = getRound(app.ctx, roundId);
  if (!old || old.userId !== member.id) throw new GameError('Esa ronda no es tuya.');
  if (old.status === 'active') throw new GameError('Esa partida todavía está en curso.');
  const bet = factor === 2 ? old.bet * 2 : factor === 0 ? Math.max(1, Math.floor(old.bet / 2)) : old.bet;
  const cfg = getCasinoConfig(app.ctx).games[old.game];
  const capped = Math.min(Math.max(bet, cfg.minBet), cfg.maxBet);
  await playGame({ app, member, channelId, parentId, game: old.game, bet: capped, params: old.params, send, inTx: () => { claimRebet(app.ctx, roundId, member.id); } });
  return viewOf(app.ctx, roundId);
}

// ───────────────────────── Después de liquidar ─────────────────────────

/** Distinciones por nivel y anuncio de grandes premios (nada de esto toca el dinero). */
export async function afterSettle(app: App, member: GuildMember, view: RoundView): Promise<void> {
  const info = view.settled;
  if (!info) return;
  try {
    if (info.levelUp) await syncRewardRoles(app.ctx, member);
    if (info.bigWin) await announceBigWin(app, member, view);
  } catch (err) {
    logger.warn('Después de la ronda:', err);
  }
}

async function announceBigWin(app: App, member: GuildMember, view: RoundView): Promise<void> {
  const g = getCasinoGuild(app.ctx, member.guild.id);
  if (!g.announceChannelId) return;
  const ch = member.guild.channels.cache.get(g.announceChannelId);
  if (!ch?.isTextBased() || !ch.isSendable()) return;
  const info = view.settled!;
  const e = new EmbedBuilder()
    .setColor(info.jackpot ? 0xf1c40f : COLORS.win)
    .setAuthor({ name: member.displayName, iconURL: member.displayAvatarURL({ size: 64 }) })
    .setTitle(info.jackpot ? '🎰 ¡JACKPOT!' : '🎉 ¡Gran premio!')
    .setDescription(`**${clean(member.displayName)}** ganó **${coins(info.payout)}** (${mult(info.multiplier)}) en ${gameLabel(view.round.game)} apostando ${coins(view.round.totalBet)}.`)
    .setFooter({ text: `Ronda #${view.round.id}` });
  await ch.send({ embeds: [e], allowedMentions: { parse: [] } }).catch(() => undefined);
}

// ───────────────────────── Crash en vivo ─────────────────────────

/**
 * Vuelo del Crash: cada 1,5 s el servidor avanza la partida (tickLiveRound) y se edita el mensaje.
 * Todas las ediciones de una ronda pasan por una cola: así una edición "en vuelo" vieja nunca pisa el resultado.
 */
interface LiveRunner {
  handle: ScreenHandle;
  queue: Promise<void>;
  done: boolean;
  /** Hay una edición "en vuelo" pendiente: no se encola otra (si Discord va lento, no se acumulan). */
  busy: boolean;
}

const runners = new Map<number, LiveRunner>();
export const LIVE_TICK_MS = 1_500;

export function hasLiveRunner(roundId: number): boolean {
  return runners.has(roundId);
}

function enqueue(r: LiveRunner, s: Screen, final: boolean): Promise<void> {
  r.queue = r.queue.then(async () => {
    if (r.done && !final) return;
    if (final) r.done = true;
    await r.handle.edit(s);
  });
  return r.queue;
}

function startLiveRunner(app: App, roundId: number, handle: ScreenHandle, viewer: Viewer, member: GuildMember): void {
  const r: LiveRunner = { handle, queue: Promise.resolve(), done: false, busy: false };
  runners.set(roundId, r);
  const ctx = app.ctx;
  void (async () => {
    try {
      for (;;) {
        await sleep(LIVE_TICK_MS);
        if (r.done) return;
        const settled = tickLiveRound(ctx, roundId);
        if (settled) {
          await enqueue(r, render(ctx, settled, viewer), true);
          void afterSettle(app, member, settled);
          return;
        }
        const round = getRound(ctx, roundId);
        if (!round || round.status !== 'active') return; // la liquidó el botón "Retirar"
        if (!r.busy) {
          r.busy = true;
          void enqueue(r, render(ctx, viewOf(ctx, roundId), viewer), false).finally(() => { r.busy = false; });
        }
      }
    } catch (err) {
      logger.error(`Crash en vivo (ronda ${roundId}):`, err);
    } finally {
      setTimeout(() => runners.delete(roundId), 10_000).unref();
    }
  })();
}

/** Muestra el resultado de una ronda en vivo liquidada por un botón (respetando la cola del vuelo). */
export async function finishLive(roundId: number, s: Screen): Promise<boolean> {
  const r = runners.get(roundId);
  if (!r) return false;
  await enqueue(r, s, true);
  return true;
}

/** Edita el mensaje guardado de una ronda (recuperación tras reinicio o partida abandonada). */
export async function refreshRoundMessage(app: App, view: RoundView): Promise<void> {
  const { round } = view;
  if (!round.guildId || !round.channelId || !round.messageId) return;
  const guild = app.client.guilds.cache.get(round.guildId);
  const ch = guild?.channels.cache.get(round.channelId);
  if (!guild || !ch?.isTextBased()) return;
  const member = await guild.members.fetch(round.userId).catch(() => null);
  const user = member?.user ?? (await app.client.users.fetch(round.userId).catch(() => null));
  const viewer: Viewer = member ? viewerOf(member) : {
    guildId: guild.id, userId: round.userId, name: user?.username ?? 'Jugador', avatar: user?.displayAvatarURL({ size: 64 }) ?? 'https://cdn.discordapp.com/embed/avatars/0.png',
  };
  const v = { ...view, balance: getBalance(app.ctx, round.userId) };
  await ch.messages.edit(round.messageId, payloadOf(render(app.ctx, v, viewer))).catch(() => undefined);
}

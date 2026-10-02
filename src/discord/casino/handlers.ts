import { ActionRowBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, type Guild } from 'discord.js';
import { logAdmin } from '../../casino/admin';
import { claimDaily, claimRescue, claimWeekly } from '../../casino/bonus';
import { activityToday } from '../../casino/activity';
import { getCasinoConfig, isGameId, saveCasinoConfig, setConfigNumber, type GameId } from '../../casino/config';
import { getRound, viewOf } from '../../casino/engine';
import { claimDrop, getDrop } from '../../casino/events';
import { TOP_CATEGORIES, type TopCategory } from '../../casino/leaderboard';
import { CLIENT_SEED_RE, rotateSeed } from '../../casino/rng';
import { joinTournament, requireTournament } from '../../casino/tournaments';
import { GameError } from '../../services/context';
import { viewerOf, type App, type Panel } from '../app';
import type { Handler, Ix } from '../handlers/util';
import { deferPanel, deferPrivate, field, finishPrivate, update, values } from '../handlers/util';
import { isOwner } from '../owner';
import { syncRewardRoles } from '../roleSafety';
import { cid } from '../ui/ids';
import { dropPanel } from './admin';
import { bonusEmbed } from './commands';
import { gameMeta, parseAmount } from './format';
import { SCREENS } from './games';
import { afterSettle, finishLive, hasLiveRunner, playAction, rebet, render } from './play';
import { animate, payloadOf, sendFromButton, updateFromButton } from './screen';
import { configPanel } from './ui/admin';
import { fairnessPanel, verifyPanel } from './ui/fairness';
import { lobbyGamePanel, lobbyPanel, walletPanel } from './ui/lobby';
import { achievementsPanel, historyPanel, profilePanel, statsPanel, type Target } from './ui/profile';
import { pageOf, topPanel, type TopScope } from './ui/top';
import { tournamentListPanel, tournamentPanel } from './ui/tournaments';
import { getSettings } from '../../services/guildSettings';

const int = (raw: string | undefined, what = 'Dato'): number => {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new GameError(`${what} inválido.`);
  return n;
};

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T {
  if (!value || !allowed.includes(value as T)) throw new GameError('Opción inválida.');
  return value as T;
}

async function ephemeral(i: Ix, panel: Panel): Promise<void> {
  await i.reply({ embeds: panel.embeds, components: panel.components, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

const channelOf = (i: Ix) => ({ channelId: i.channelId ?? '', parentId: i.channel?.isThread() ? i.channel.parentId : null });

// ───────────────────────── Juegos ─────────────────────────

const gameHandler: Handler = async (app, i, id) => {
  if (!i.isMessageComponent()) throw new GameError('Acción desconocida.');
  const ctx = app.ctx;
  const viewer = viewerOf(i.member);
  switch (id.act) {
    case 'act': {
      const [roundRaw, versionRaw, action, argRaw] = id.args;
      const roundId = int(roundRaw, 'Ronda');
      const version = int(versionRaw, 'Versión');
      if (!/^[a-z]{1,12}$/.test(action ?? '')) throw new GameError('Acción inválida.');
      const arg = argRaw === undefined ? undefined : int(argRaw, 'Casilla');
      const live = hasLiveRunner(roundId);
      const { view, frames, final } = playAction(ctx, i.user.id, roundId, version, { type: action, arg }, viewer);
      if (live && view.settled) {
        // Crash: el resultado pasa por la cola del vuelo para que ninguna edición vieja lo pise.
        await i.deferUpdate();
        await finishLive(roundId, final);
      } else if (frames.length) {
        const h = await updateFromButton(i, frames[0]);
        void animate(h, frames.slice(1), final);
      } else {
        await updateFromButton(i, final);
      }
      if (view.settled) void afterSettle(app, i.member, view);
      return;
    }
    case 'rebet': {
      const roundId = int(id.args[0], 'Ronda');
      const factor = int(id.args[1], 'Factor');
      if (![0, 1, 2].includes(factor)) throw new GameError('Opción inválida.');
      const { channelId, parentId } = channelOf(i);
      const old = await rebet(app, i.member, roundId, factor, channelId, parentId, (s) => sendFromButton(i, s));
      // El mensaje viejo ya no ofrece "repetir" (se usó).
      await i.message.edit(payloadOf(render(ctx, old, viewer))).catch(() => undefined);
      return;
    }
    case 'resume': {
      const round = getRound(ctx, int(id.args[0], 'Ronda'));
      if (!round || round.userId !== i.user.id) throw new GameError('Esa partida no es tuya.');
      if (round.status !== 'active') throw new GameError('Esa partida ya terminó.');
      const view = viewOf(ctx, round.id);
      const h = await sendFromButton(i, render(ctx, view, viewer));
      if (h.message) ctx.db.run('UPDATE casino_rounds SET channel_id = ?, message_id = ? WHERE id = ?', h.message.channelId, h.message.id, round.id);
      return;
    }
    case 'rules': {
      const game = id.args[0];
      if (!isGameId(game)) throw new GameError('Juego inválido.');
      await i.reply({ embeds: [SCREENS[game].rules(ctx, getSettings(ctx, i.guildId).prefix)], flags: MessageFlags.Ephemeral });
      return;
    }
    case 'noop':
      await i.deferUpdate();
      return;
    default:
      throw new GameError('Acción desconocida.');
  }
};

// ───────────────────────── Lobby, billetera, perfil, top, fairness ─────────────────────────

async function targetById(app: App, guild: Guild, userId: string): Promise<Target> {
  if (!/^\d{17,20}$/.test(userId)) throw new GameError('Usuario inválido.');
  const m = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  if (m) return { id: m.id, name: m.displayName, avatar: m.displayAvatarURL({ size: 128 }) };
  const u = await app.client.users.fetch(userId).catch(() => null);
  if (!u) throw new GameError('No encontré a esa persona.');
  return { id: u.id, name: u.globalName ?? u.username, avatar: u.displayAvatarURL({ size: 128 }) };
}

const TABS = ['profile', 'stats', 'history', 'ach'] as const;
const SCOPES: readonly TopScope[] = ['g', 's'];

const lobbyHandler: Handler = async (app, i, id) => {
  const ctx = app.ctx;
  const v = viewerOf(i.member);
  const prefix = getSettings(ctx, i.guildId).prefix;
  const me: Target = { id: v.userId, name: v.name, avatar: v.avatar };
  switch (id.act) {
    case 'lobby':
      return update(i, lobbyPanel(ctx, v, prefix));
    case 'game': {
      const g = values(i)[0];
      if (!isGameId(g)) throw new GameError('Juego inválido.');
      return update(i, lobbyGamePanel(ctx, v, g, prefix));
    }
    case 'open': {
      const what = oneOf(id.args[0], ['wallet', 'profile', 'top', 'tour', 'history'] as const);
      // El top busca nombres en Discord: se avisa antes para no pasar los 3 s de la interacción.
      if (what === 'top') await deferPrivate(i);
      const panel = what === 'wallet' ? walletPanel(ctx, v, activityToday(ctx, v.userId))
        : what === 'profile' ? profilePanel(ctx, v, me)
          : what === 'top' ? await topPanel(app, i.guild, v, 'richest', 0, 'g')
            : what === 'history' ? historyPanel(ctx, v, me, 'all', 0)
              : tournamentListPanel(ctx, v, isOwner(v.userId));
      // Desde un panel privado se reemplaza; desde uno público se abre uno privado aparte.
      if (i.deferred) return finishPrivate(i, '', panel);
      if (i.isMessageComponent() && i.message.flags.has(MessageFlags.Ephemeral)) return update(i, panel);
      return ephemeral(i, panel);
    }
    case 'bonus': {
      const kind = oneOf(id.args[0], ['daily', 'weekly', 'rescue'] as const);
      const r = { daily: claimDaily, weekly: claimWeekly, rescue: claimRescue }[kind](ctx, v.userId, i.guildId);
      const label = { daily: '🎁 Diario', weekly: '📅 Semanal', rescue: '🛟 Rescate' }[kind];
      await update(i, walletPanel(ctx, v, activityToday(ctx, v.userId), `${label}: **+🪙 ${r.amount.toLocaleString('es-AR')}**${kind === 'daily' ? ` · racha ${r.streak}` : ''}`));
      if (r.achievements.length) {
        await i.followUp({ embeds: [bonusEmbed(kind, r, v.name)], flags: MessageFlags.Ephemeral }).catch(() => undefined);
        await syncRewardRoles(ctx, i.member);
      }
      return;
    }
    case 'tab': {
      const t = await targetById(app, i.guild, id.args[0] ?? '');
      const tab = oneOf(id.args[1], TABS);
      const panel = tab === 'profile' ? profilePanel(ctx, v, t) : tab === 'stats' ? statsPanel(ctx, v, t, null) : tab === 'history' ? historyPanel(ctx, v, t, 'all', 0) : achievementsPanel(ctx, v, t);
      return update(i, panel);
    }
    case 'stats': {
      const t = await targetById(app, i.guild, id.args[0] ?? '');
      const g = values(i)[0];
      return update(i, statsPanel(ctx, v, t, g === 'all' ? null : isGameId(g) ? g : null));
    }
    case 'histg':
    case 'hist': {
      const t = await targetById(app, i.guild, id.args[0] ?? '');
      const raw = id.act === 'histg' ? values(i)[0] : id.args[1];
      const filter: GameId | 'all' | 'tx' = raw === 'tx' || raw === 'all' ? raw : isGameId(raw) ? raw : 'all';
      // Los movimientos de la billetera son privados: solo los ve su dueño.
      if (filter === 'tx' && t.id !== v.userId) throw new GameError('Los movimientos de la billetera solo los ve su dueño.');
      return update(i, historyPanel(ctx, v, t, filter, id.act === 'hist' ? int(id.args[2], 'Página') : 0));
    }
    case 'topc': {
      const cat = oneOf<TopCategory>(values(i)[0], TOP_CATEGORIES);
      await deferPanel(i);
      return update(i, await topPanel(app, i.guild, v, cat, 0, oneOf(id.args[0], SCOPES)));
    }
    case 'top': {
      const cat = oneOf<TopCategory>(id.args[0], TOP_CATEGORIES);
      await deferPanel(i);
      return update(i, await topPanel(app, i.guild, v, cat, int(id.args[1], 'Página'), oneOf(id.args[2], SCOPES)));
    }
    case 'me': {
      const cat = oneOf<TopCategory>(id.args[0], TOP_CATEGORIES);
      const scope = oneOf(id.args[1], SCOPES);
      await deferPanel(i);
      return update(i, await topPanel(app, i.guild, v, cat, pageOf(app, cat, v.userId, scope === 's' ? i.guildId : null), scope));
    }
    case 'fair': {
      const act = oneOf(id.args[0], ['rotate', 'client', 'verify'] as const);
      if (act === 'rotate') {
        const r = rotateSeed(ctx, v.userId);
        return update(i, fairnessPanel(ctx, v, `🔄 Semilla rotada. La anterior era \`${r.revealed.serverSeed}\`.`));
      }
      if (!i.isMessageComponent()) return;
      const input = act === 'client'
        ? new TextInputBuilder().setCustomId('seed').setLabel('Nueva semilla del cliente (1-32: letras, números, - y _)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32)
        : new TextInputBuilder().setCustomId('round').setLabel('Número de ronda').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12);
      return i.showModal(new ModalBuilder().setCustomId(cid('cl', act === 'client' ? 'fairc' : 'fairv', v.userId)).setTitle(act === 'client' ? 'Semilla del cliente' : 'Verificar una ronda')
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
    }
    case 'fairc': {
      const seed = field(i, 'seed');
      if (!CLIENT_SEED_RE.test(seed)) throw new GameError('La semilla del cliente puede tener de 1 a 32 caracteres: letras, números, guion o guion bajo.');
      const r = rotateSeed(ctx, v.userId, seed);
      return update(i, fairnessPanel(ctx, v, `✏️ Nueva semilla del cliente \`${seed}\`. La semilla del servidor anterior era \`${r.revealed.serverSeed}\`.`));
    }
    case 'fairv': {
      const round = getRound(ctx, int(field(i, 'round').replace(/^#/, ''), 'Ronda'));
      if (!round || round.userId !== v.userId) throw new GameError('No encontré esa ronda entre las tuyas.');
      if (round.status === 'active') throw new GameError('Esa partida todavía está en curso.');
      return ephemeral(i, verifyPanel(ctx, round));
    }
    default:
      throw new GameError('Acción desconocida.');
  }
};

// ───────────────────────── Torneos ─────────────────────────

const tournamentHandler: Handler = async (app, i, id) => {
  const ctx = app.ctx;
  const v = viewerOf(i.member);
  switch (id.act) {
    case 'list':
      return update(i, tournamentListPanel(ctx, v, isOwner(v.userId)));
    case 'pick': {
      const t = requireTournament(ctx, int(values(i)[0], 'Torneo'));
      await deferPanel(i);
      return update(i, await tournamentPanel(app, i.guild, v, t));
    }
    case 'view':
      await deferPanel(i);
      return update(i, await tournamentPanel(app, i.guild, v, requireTournament(ctx, int(id.args[0], 'Torneo')), Math.max(0, Number(id.args[1]) || 0)));
    case 'join': {
      const t = joinTournament(ctx, int(id.args[0], 'Torneo'), v.userId);
      await deferPanel(i);
      return update(i, await tournamentPanel(app, i.guild, v, t, 0, `🎟️ ¡Estás adentro de **${t.name}**!`));
    }
    default:
      throw new GameError('Acción desconocida.');
  }
};

// ───────────────────────── Lluvia de monedas ─────────────────────────

const dropHandler: Handler = async (app, i, id) => {
  if (id.act !== 'claim' || !i.isMessageComponent()) throw new GameError('Acción desconocida.');
  const dropId = int(id.args[0], 'Evento');
  const r = claimDrop(app.ctx, dropId, i.user.id, i.user.createdTimestamp);
  await i.reply({ content: `🪙 ¡Agarraste **${r.amount.toLocaleString('es-AR')}** Coins! Saldo: **${r.balance.toLocaleString('es-AR')}**.`, flags: MessageFlags.Ephemeral });
  const d = getDrop(app.ctx, dropId);
  if (d) await i.message.edit({ ...dropPanel(d, d.claims), allowedMentions: { parse: [] } }).catch(() => undefined);
};

// ───────────────────────── Configuración (dueño del bot) ─────────────────────────

const adminHandler: Handler = async (app, i, id) => {
  if (!isOwner(i.user.id)) throw new GameError('Solo el dueño del bot.');
  const ctx = app.ctx;
  if (id.act === 'game') {
    const g = values(i)[0];
    if (!isGameId(g) || !i.isMessageComponent()) throw new GameError('Juego inválido.');
    const s = getCasinoConfig(ctx).games[g];
    const input = (cidName: string, label: string, value: string) => new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(cidName).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16).setValue(value));
    return i.showModal(new ModalBuilder().setCustomId(cid('ca', 'gsave', i.user.id, g)).setTitle(`Editar ${gameMeta(g).name}`.slice(0, 45)).addComponents(
      input('enabled', 'Abierto (si / no)', s.enabled ? 'si' : 'no'),
      input('min', 'Apuesta mínima', String(s.minBet)),
      input('max', 'Apuesta máxima', String(s.maxBet)),
      input('edge', 'Ventaja de la casa (%)', String(s.edgePct)),
      input('cooldown', 'Espera entre rondas (ms)', String(s.cooldownMs)),
    ));
  }
  if (id.act === 'gsave') {
    const g = id.args[0];
    if (!isGameId(g)) throw new GameError('Juego inválido.');
    const num = (name: string, label: string) => {
      const n = parseAmount(field(i, name)) ?? Number(field(i, name).replace(',', '.'));
      if (!Number.isFinite(n)) throw new GameError(`${label}: número inválido.`);
      return n;
    };
    const before = structuredClone(getCasinoConfig(ctx).games[g]);
    const enabled = ['si', 'sí', 'yes', 'true', '1', 'abierto'].includes(field(i, 'enabled').toLowerCase());
    const min = num('min', 'Apuesta mínima');
    const max = num('max', 'Apuesta máxima');
    if (min > max) throw new GameError('La mínima no puede superar a la máxima.');
    // Se fija primero la que no choca con el valor actual (si no, una validación intermedia fallaría).
    if (min > before.maxBet) {
      setConfigNumber(ctx, `games.${g}.maxBet`, max, i.user.id);
      setConfigNumber(ctx, `games.${g}.minBet`, min, i.user.id);
    } else {
      setConfigNumber(ctx, `games.${g}.minBet`, min, i.user.id);
      setConfigNumber(ctx, `games.${g}.maxBet`, max, i.user.id);
    }
    setConfigNumber(ctx, `games.${g}.edgePct`, num('edge', 'Ventaja'), i.user.id);
    setConfigNumber(ctx, `games.${g}.cooldownMs`, Math.round(num('cooldown', 'Espera')), i.user.id);
    const cfg = structuredClone(getCasinoConfig(ctx));
    cfg.games[g].enabled = enabled;
    saveCasinoConfig(ctx, cfg, i.user.id);
    logAdmin(ctx, { actorId: i.user.id, action: 'game.edit', details: { game: g, before, after: getCasinoConfig(ctx).games[g] }, guildId: i.guildId });
    return update(i, configPanel(ctx, i.user.id, `✅ ${gameMeta(g).name} actualizado.`));
  }
  throw new GameError('Acción desconocida.');
};

export const CASINO_HANDLERS: Record<string, Handler> = {
  cs: gameHandler,
  cl: lobbyHandler,
  ct: tournamentHandler,
  cd: dropHandler,
  ca: adminHandler,
};

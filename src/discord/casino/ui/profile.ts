import { ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { ACHIEVEMENTS, unlockedAchievements } from '../../../casino/achievements';
import { GAME_IDS, isGameId, type GameId } from '../../../casino/config';
import { countRounds, recentRounds } from '../../../casino/engine';
import { getTransactions, type TxType } from '../../../casino/economy';
import { rankOf } from '../../../casino/leaderboard';
import { favoriteGame, gameStats, getCasinoUser, levelProgress, MAX_LEVEL, rankFor, wageredForLevel } from '../../../casino/users';
import type { GameContext } from '../../../services/context';
import { row, type Panel, type Viewer } from '../../app';
import { cid } from '../../ui/ids';
import { COLORS, bar, coins, mult, num, rel, signedCoins } from '../../ui/theme';
import { gameLabel, gameMeta } from '../format';

export interface Target {
  id: string;
  name: string;
  avatar: string;
}

const pctText = (a: number, b: number) => (b ? `${((a / b) * 100).toLocaleString('es-AR', { maximumFractionDigits: 1 })} %` : '—');
const date = (ms: number, style = 'D') => `<t:${Math.floor(ms / 1000)}:${style}>`;

/** Pestañas del perfil (Estadísticas · Historial · Logros). */
export function profileTabs(owner: string, targetId: string, current: 'profile' | 'stats' | 'history' | 'ach'): ButtonBuilder[] {
  const tab = (id: typeof current, label: string, emoji: string) => new ButtonBuilder().setCustomId(cid('cl', 'tab', owner, targetId, id)).setLabel(label).setEmoji(emoji)
    .setStyle(id === current ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(id === current);
  return [tab('profile', 'Perfil', '👤'), tab('stats', 'Estadísticas', '📊'), tab('history', 'Historial', '📜'), tab('ach', 'Logros', '🏅')];
}

function noAccount(target: Target): Panel {
  return { embeds: [new EmbedBuilder().setColor(COLORS.push).setDescription(`**${target.name}** todavía no entró al casino.`)], components: [] };
}

export function profilePanel(ctx: GameContext, viewer: Viewer, target: Target): Panel {
  const u = getCasinoUser(ctx, target.id);
  if (!u) return noAccount(target);
  const lp = levelProgress(u.totalWagered);
  const rank = rankFor(lp.level);
  const pos = rankOf(ctx, 'richest', target.id);
  const fav = favoriteGame(ctx, target.id);
  const achieved = unlockedAchievements(ctx, target.id).size;
  const next = lp.level >= MAX_LEVEL ? 'nivel máximo' : `faltan ${coins(Math.max(0, wageredForLevel(lp.level + 1) - u.totalWagered))} apostadas para el nivel ${lp.level + 1}`;
  const e = new EmbedBuilder()
    .setColor(rank.color)
    .setAuthor({ name: `Perfil de ${target.name}`, iconURL: target.avatar })
    .setThumbnail(target.avatar)
    .setTitle(`${rank.emoji} ${rank.name} · Nivel ${lp.level}`)
    .setDescription(`${bar(lp.pct, 1, 12)} ${Math.floor(lp.pct * 100)} %\n-# ${next}`)
    .addFields(
      { name: '💼 Saldo', value: coins(u.balance), inline: true },
      { name: '📈 Beneficio histórico', value: signedCoins(u.netProfit), inline: true },
      { name: '🏅 Puesto (más ricos)', value: pos.rank ? `#${num(pos.rank)} de ${num(pos.total)}` : '—', inline: true },
      { name: '💸 Total apostado', value: coins(u.totalWagered), inline: true },
      { name: '🏦 Total ganado', value: coins(u.totalWon), inline: true },
      { name: '🕳️ Total perdido', value: coins(u.totalLost), inline: true },
      { name: '🎲 Partidas', value: `${num(u.rounds)} · ✅ ${num(u.wins)} · ❌ ${num(u.losses)} · 🤝 ${num(u.pushes)}\n-# victorias ${pctText(u.wins, u.rounds)}`, inline: true },
      { name: '🔥 Racha', value: `actual **${u.currentStreak}** · mejor **${u.bestStreak}**`, inline: true },
      { name: '🎯 Mayor apuesta', value: coins(u.biggestBet), inline: true },
      { name: '💎 Mayor premio', value: coins(u.biggestPayout), inline: true },
      { name: '✖️ Mayor multiplicador', value: u.biggestMultiplier ? mult(u.biggestMultiplier) : '—', inline: true },
      { name: '🏆 Torneos', value: `${num(u.tournamentsPlayed)} jugados · ${num(u.tournamentsWon)} ganados`, inline: true },
      { name: '🎮 Juego favorito', value: fav ? gameLabel(fav) : '—', inline: true },
      { name: '🏅 Logros', value: `${achieved}/${ACHIEVEMENTS.length}`, inline: true },
      { name: '🎁 Bonos recibidos', value: coins(u.bonusTotal), inline: true },
    )
    .setFooter({ text: 'Cuenta del casino creada' })
    .setTimestamp(u.createdAt);
  e.addFields({ name: '⏱️ Última actividad', value: `${rel(u.lastActiveAt)} · miembro desde ${date(u.createdAt)}` });
  return { embeds: [e], components: [row(...profileTabs(viewer.userId, target.id, 'profile'))] };
}

function gameSelect(owner: string, targetId: string, act: 'stats' | 'histg', current: string, withTx = false): StringSelectMenuBuilder {
  const opts = [
    new StringSelectMenuOptionBuilder().setValue('all').setLabel('Todos los juegos').setEmoji('🎰').setDefault(current === 'all'),
    ...GAME_IDS.map((id) => new StringSelectMenuOptionBuilder().setValue(id).setLabel(gameMeta(id).name).setEmoji(gameMeta(id).emoji).setDefault(current === id)),
  ];
  if (withTx) opts.push(new StringSelectMenuOptionBuilder().setValue('tx').setLabel('Movimientos de la billetera').setEmoji('💳').setDefault(current === 'tx'));
  return new StringSelectMenuBuilder().setCustomId(cid('cl', act, owner, targetId)).setPlaceholder('Elegí un juego…').addOptions(opts);
}

export function statsPanel(ctx: GameContext, viewer: Viewer, target: Target, game: GameId | null): Panel {
  const u = getCasinoUser(ctx, target.id);
  if (!u) return noAccount(target);
  const all = gameStats(ctx, target.id);
  const e = new EmbedBuilder().setColor(COLORS.profile).setAuthor({ name: `Estadísticas de ${target.name}`, iconURL: target.avatar });
  if (!game) {
    e.setTitle('📊 Todos los juegos').setDescription(all.length
      ? all.map((s) => `${gameLabel(s.game)} — **${num(s.rounds)}** rondas · victorias ${pctText(s.wins, s.rounds)} · ${signedCoins(s.profit)}`).join('\n')
      : '*Todavía no jugó ninguna ronda.*')
      .setFooter({ text: `${num(u.rounds)} rondas · apostado ${num(u.totalWagered)} · retorno ${pctText(u.totalPayout, u.totalWagered)}` });
  } else {
    const s = all.find((x) => x.game === game);
    e.setTitle(`📊 ${gameLabel(game)}`);
    if (!s) e.setDescription('*Todavía no jugó este juego.*');
    else {
      e.addFields(
        { name: '🎲 Rondas', value: `${num(s.rounds)} · ✅ ${num(s.wins)} · ❌ ${num(s.losses)} · 🤝 ${num(s.pushes)}`, inline: true },
        { name: '🏅 Victorias', value: pctText(s.wins, s.rounds), inline: true },
        { name: '📈 Beneficio', value: signedCoins(s.profit), inline: true },
        { name: '💸 Apostado', value: coins(s.wagered), inline: true },
        { name: '🏦 Ganado', value: coins(s.won), inline: true },
        { name: '🕳️ Perdido', value: coins(s.lost), inline: true },
        { name: '🎯 Mayor apuesta', value: coins(s.biggestBet), inline: true },
        { name: '💎 Mayor premio', value: coins(s.biggestPayout), inline: true },
        { name: '✖️ Mayor multiplicador', value: s.biggestMultiplier ? mult(s.biggestMultiplier) : '—', inline: true },
        { name: '🔁 Retorno real', value: pctText(s.payout, s.wagered), inline: true },
        { name: '⏱️ Última partida', value: s.lastPlayedAt ? rel(s.lastPlayedAt) : '—', inline: true },
      );
    }
  }
  return { embeds: [e], components: [row(gameSelect(viewer.userId, target.id, 'stats', game ?? 'all')), row(...profileTabs(viewer.userId, target.id, 'stats'))] };
}

export const HISTORY_PAGE = 10;
const OUTCOME_EMOJI = { won: '✅', lost: '❌', push: '🤝', refunded: '↩️', active: '⏸️' } as const;
const TX_LABEL: Record<TxType, string> = {
  STARTER: '🎉 Saldo inicial', BET: '🎲 Apuesta', WIN: '🏆 Premio', LOSS: '❌ Pérdida', PUSH: '🤝 Empate', REFUND: '↩️ Devolución', BONUS: '🎁 Bono',
  ACTIVITY: '💬 Actividad', LEVEL_REWARD: '⭐ Nivel', ACHIEVEMENT_REWARD: '🏅 Logro', TOURNAMENT_REWARD: '🏆 Torneo', TOURNAMENT_ENTRY: '🎟️ Entrada a torneo',
  JACKPOT: '💰 Jackpot', DROP: '🌧️ Lluvia de monedas', ADMIN_ADJUSTMENT: '🛠️ Ajuste del administrador', WORK: '🧰 Trabajo', FINE: '🚨 Multa',
};

/** Historial de rondas (filtrable por juego) o de movimientos de la billetera. */
export function historyPanel(ctx: GameContext, viewer: Viewer, target: Target, filter: GameId | 'all' | 'tx', page: number): Panel {
  const e = new EmbedBuilder().setColor(COLORS.profile).setAuthor({ name: `Historial de ${target.name}`, iconURL: target.avatar });
  const owner = viewer.userId;
  let pages = 1;
  let pg = Math.max(0, page);
  if (filter === 'tx') {
    const txs = getTransactions(ctx, target.id, 15);
    e.setTitle('💳 Últimos movimientos').setDescription(txs.length
      ? txs.map((t) => `${TX_LABEL[t.type]}${t.game && isGameId(t.game) ? ` · ${gameMeta(t.game).emoji}` : ''} **${signedCoins(t.amount)}** → ${coins(t.after)} · ${rel(t.createdAt)}`).join('\n')
      : '*Sin movimientos.*');
    pg = 0;
  } else {
    const game = filter === 'all' ? null : filter;
    const total = countRounds(ctx, target.id, game);
    pages = Math.max(1, Math.ceil(total / HISTORY_PAGE));
    pg = Math.min(pg, pages - 1);
    const rounds = recentRounds(ctx, target.id, { game, limit: HISTORY_PAGE, offset: pg * HISTORY_PAGE });
    e.setTitle(game ? `📜 ${gameLabel(game)}` : '📜 Últimas rondas').setDescription(rounds.length
      ? rounds.map((r) => `${OUTCOME_EMOJI[r.status]} \`#${r.id}\` ${r.summary ?? gameLabel(r.game)}\n-# ${coins(r.totalBet)} → ${coins(r.payout)} (${mult(r.multiplier)}) · ${rel(r.settledAt ?? r.createdAt)}`).join('\n')
      : '*Sin rondas.*')
      .setFooter({ text: `Página ${pg + 1}/${pages} · ${num(total)} rondas · verificá cualquiera con !fairness verificar <ronda>` });
  }
  const rows = [row(gameSelect(owner, target.id, 'histg', filter, target.id === viewer.userId))];
  if (pages > 1) {
    rows.push(row(
      new ButtonBuilder().setCustomId(cid('cl', 'hist', owner, target.id, filter, pg - 1)).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(pg === 0),
      new ButtonBuilder().setCustomId(cid('cl', 'hist', owner, target.id, filter, pg + 1)).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(pg >= pages - 1),
    ));
  }
  rows.push(row(...profileTabs(owner, target.id, 'history')));
  return { embeds: [e], components: rows };
}

export function achievementsPanel(ctx: GameContext, viewer: Viewer, target: Target): Panel {
  const have = unlockedAchievements(ctx, target.id);
  const lines = ACHIEVEMENTS.map((a) => {
    const at = have.get(a.id);
    if (at) return `✅ ${a.emoji} **${a.name}** — ${a.description} · +${coins(a.reward)} · ${date(at, 'd')}`;
    if (a.hidden) return '🔒 ❔ **Logro oculto** — seguí jugando para descubrirlo.';
    return `🔒 ${a.emoji} **${a.name}** — ${a.description} · ${coins(a.reward)}`;
  });
  const e = new EmbedBuilder().setColor(COLORS.profile).setAuthor({ name: `Logros de ${target.name}`, iconURL: target.avatar })
    .setTitle(`🏅 ${have.size}/${ACHIEVEMENTS.length} logros`).setDescription(lines.join('\n'))
    .setFooter({ text: 'Cada logro paga su premio una sola vez.' });
  return { embeds: [e], components: [row(...profileTabs(viewer.userId, target.id, 'ach'))] };
}

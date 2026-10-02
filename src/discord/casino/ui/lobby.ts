import { ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { bonusStatus } from '../../../casino/bonus';
import { GAME_IDS, getCasinoConfig, type GameId } from '../../../casino/config';
import { activeRounds } from '../../../casino/engine';
import { jackpotAmount } from '../../../casino/jackpot';
import { listTournaments } from '../../../casino/tournaments';
import { getCasinoUser, levelProgress, rankFor } from '../../../casino/users';
import type { GameContext } from '../../../services/context';
import { row, type Panel, type Viewer } from '../../app';
import { cid } from '../../ui/ids';
import { COLORS, bar, coins, rel } from '../../ui/theme';
import { gameLabel, gameMeta } from '../format';
import { SCREENS } from '../games';
import { commandOf } from '../games/base';

const VIRTUAL = '-# Coins 🪙 es una moneda virtual del bot: no se compra, no se retira y no se cambia por dinero real.';

/** Botones de navegación del casino (abren paneles privados). */
export function casinoNav(owner: string): ButtonBuilder[] {
  return [
    new ButtonBuilder().setCustomId(cid('cl', 'open', owner, 'wallet')).setLabel('Billetera').setEmoji('💼').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('cl', 'open', owner, 'profile')).setLabel('Perfil').setEmoji('👤').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('cl', 'open', owner, 'top')).setLabel('Top').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('cl', 'open', owner, 'tour')).setLabel('Torneos').setEmoji('🏟️').setStyle(ButtonStyle.Secondary),
  ];
}

function gameSelect(owner: string, current: GameId | null) {
  return new StringSelectMenuBuilder().setCustomId(cid('cl', 'game', owner)).setPlaceholder('Ver las reglas de un juego…')
    .addOptions(GAME_IDS.map((id) => new StringSelectMenuOptionBuilder().setValue(id).setLabel(gameMeta(id).name).setEmoji(gameMeta(id).emoji)
      .setDescription(gameMeta(id).tagline.slice(0, 100)).setDefault(id === current)));
}

/** Lobby: saldo, jackpot, torneos en curso y la lista de juegos. */
export function lobbyPanel(ctx: GameContext, v: Viewer, prefix: string): Panel {
  const cfg = getCasinoConfig(ctx);
  const u = getCasinoUser(ctx, v.userId);
  const lp = levelProgress(u?.totalWagered ?? 0);
  const rank = rankFor(lp.level);
  const tours = listTournaments(ctx, ['active'], 5);
  const open = activeRounds(ctx, v.userId);
  const games = GAME_IDS.map((id) => {
    const g = gameMeta(id);
    const gs = cfg.games[id];
    return `${g.emoji} **${g.name}** \`${prefix}${commandOf(id)}\`${gs.enabled ? '' : ' 🔒'} — ${g.tagline}`;
  });
  const e = new EmbedBuilder()
    .setColor(COLORS.casino)
    .setTitle('🎰 Casino')
    .setAuthor({ name: v.name, iconURL: v.avatar })
    .setDescription([
      `💼 **${coins(u?.balance ?? cfg.startingBalance)}** · ${rank.emoji} ${rank.name} · nivel **${lp.level}** ${bar(lp.pct, 1, 8)}`,
      `💰 Jackpot de Slots: **${coins(jackpotAmount(ctx))}**`,
      ...(open.length ? [`⏸️ Partidas abiertas: ${open.map((r) => gameLabel(r.game)).join(', ')} (retomalas con el comando del juego)`] : []),
      '',
      ...games,
      '',
      tours.length ? `🏟️ **Torneos en curso:** ${tours.map((t) => `${t.name} (termina ${rel(t.endsAt)})`).join(' · ')}` : '🏟️ Sin torneos en curso.',
      `🎁 Bonos: \`${prefix}daily\` · \`${prefix}weekly\` · \`${prefix}rescate\` — Ayuda: \`${prefix}ayuda\``,
      '',
      VIRTUAL,
    ].join('\n'));
  return { embeds: [e], components: [row(gameSelect(v.userId, null)), row(...casinoNav(v.userId))] };
}

/** Reglas de un juego dentro del lobby. */
export function lobbyGamePanel(ctx: GameContext, v: Viewer, game: GameId, prefix: string): Panel {
  return {
    embeds: [SCREENS[game].rules(ctx, prefix)],
    components: [
      row(gameSelect(v.userId, game)),
      row(new ButtonBuilder().setCustomId(cid('cl', 'lobby', v.userId)).setLabel('Volver al lobby').setEmoji('🎰').setStyle(ButtonStyle.Secondary)),
    ],
  };
}

/** Billetera: saldo, bonos disponibles y lo ganado hoy por actividad. */
export function walletPanel(ctx: GameContext, v: Viewer, activity: { coins: number; cap: number }, notice?: string): Panel {
  const cfg = getCasinoConfig(ctx);
  const u = getCasinoUser(ctx, v.userId);
  const b = bonusStatus(ctx, v.userId);
  const now = ctx.now();
  const ready = (at: number) => at <= now;
  const e = new EmbedBuilder()
    .setColor(COLORS.casino)
    .setAuthor({ name: `Billetera de ${v.name}`, iconURL: v.avatar })
    .setDescription([
      ...(notice ? [notice, ''] : []),
      `# ${coins(u?.balance ?? cfg.startingBalance)}`,
      '',
      `🎁 **Diario:** ${ready(b.dailyAt) ? '✅ disponible' : `en ${rel(b.dailyAt)}`}${b.dailyStreak ? ` · racha ${b.dailyStreak} ${b.dailyStreak === 1 ? 'día' : 'días'}` : ''}`,
      `📅 **Semanal:** ${ready(b.weeklyAt) ? '✅ disponible' : `en ${rel(b.weeklyAt)}`}`,
      `🛟 **Rescate:** ${b.rescueAt === null ? `solo con menos de ${coins(cfg.rescue.below)}` : ready(b.rescueAt) ? '✅ disponible' : `en ${rel(b.rescueAt)}`}`,
      `💬 **Actividad hoy:** ${coins(activity.coins)} / ${coins(activity.cap)}${cfg.boost.until > now ? ` · ⚡ boost ×${cfg.boost.activity} hasta ${rel(cfg.boost.until)}` : ''}`,
      '',
      ...(u ? [`-# Apostado ${coins(u.totalWagered)} · ganado ${coins(u.totalWon)} · perdido ${coins(u.totalLost)} · beneficio ${coins(u.netProfit)}`] : []),
      VIRTUAL,
    ].join('\n'));
  return {
    embeds: [e],
    components: [row(
      new ButtonBuilder().setCustomId(cid('cl', 'bonus', v.userId, 'daily')).setLabel(`Diario`).setEmoji('🎁').setStyle(ButtonStyle.Success).setDisabled(!ready(b.dailyAt)),
      new ButtonBuilder().setCustomId(cid('cl', 'bonus', v.userId, 'weekly')).setLabel('Semanal').setEmoji('📅').setStyle(ButtonStyle.Success).setDisabled(!ready(b.weeklyAt)),
      new ButtonBuilder().setCustomId(cid('cl', 'bonus', v.userId, 'rescue')).setLabel('Rescate').setEmoji('🛟').setStyle(ButtonStyle.Secondary).setDisabled(b.rescueAt === null || !ready(b.rescueAt)),
      new ButtonBuilder().setCustomId(cid('cl', 'open', v.userId, 'history')).setLabel('Historial').setEmoji('📜').setStyle(ButtonStyle.Secondary),
    )],
  };
}

import { ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, type Guild } from 'discord.js';
import {
  finalPrizes, listTournaments, METRIC_META, participants, prizeLine, standingOf, standings, type Standing, type Tournament, type TournamentStatus,
} from '../../../casino/tournaments';
import type { GameContext } from '../../../services/context';
import { row, type App, type Panel, type Viewer } from '../../app';
import { cid } from '../../ui/ids';
import { COLORS, clean, coins, mult, num, rel, signedCoins } from '../../ui/theme';
import { gameLabel } from '../format';

const STATUS: Record<TournamentStatus, string> = {
  draft: '📝 borrador', scheduled: '📅 programado', active: '🟢 en curso', finished: '🏁 terminado', cancelled: '🚫 cancelado',
};
const KIND = { daily: '🌅 Diario', weekly: '🗓️ Semanal', special: '⭐ Especial' } as const;

export function scoreText(t: Tournament, score: number): string {
  if (t.metric === 'multiplier') return mult(score);
  if (t.metric === 'wins') return `${num(score)} victorias`;
  return t.metric === 'profit' ? signedCoins(score) : coins(score);
}

export function tournamentLine(ctx: GameContext, t: Tournament): string {
  const when = t.status === 'active' ? `termina ${rel(t.endsAt)}` : t.status === 'scheduled' ? `empieza ${rel(t.startsAt)}` : t.status === 'finished' ? `terminó ${rel(t.endsAt)}` : STATUS[t.status];
  return `**#${t.id} ${clean(t.name)}** · ${METRIC_META[t.metric].emoji} ${METRIC_META[t.metric].label}${t.game ? ` · ${gameLabel(t.game)}` : ''} · ${when} · 👥 ${num(participants(ctx, t.id))}`;
}

export function tournamentListPanel(ctx: GameContext, v: Viewer, includeDrafts = false): Panel {
  const statuses: TournamentStatus[] = includeDrafts ? ['active', 'scheduled', 'draft'] : ['active', 'scheduled'];
  const open = listTournaments(ctx, statuses, 15);
  const recent = listTournaments(ctx, ['finished'], 3);
  const e = new EmbedBuilder()
    .setColor(COLORS.tournament)
    .setTitle('🏟️ Torneos')
    .setDescription([
      open.length ? open.map((t) => tournamentLine(ctx, t)).join('\n') : '*No hay torneos en curso ni programados.*',
      ...(recent.length ? ['', '**Últimos terminados:**', ...recent.map((t) => tournamentLine(ctx, t))] : []),
      '',
      '-# Los torneos sin entrada te inscriben solos con tu primera apuesta válida. Elegí uno para ver la tabla.',
    ].join('\n'));
  const pickable = [...open, ...recent].slice(0, 25);
  return {
    embeds: [e],
    components: pickable.length ? [row(new StringSelectMenuBuilder().setCustomId(cid('ct', 'pick', v.userId)).setPlaceholder('Ver un torneo…')
      .addOptions(pickable.map((t) => new StringSelectMenuOptionBuilder().setValue(String(t.id)).setLabel(`#${t.id} ${t.name}`.slice(0, 100))
        .setDescription(`${STATUS[t.status]} · ${METRIC_META[t.metric].label}`.slice(0, 100)))))] : [],
  };
}

async function nameOf(app: App, guild: Guild, id: string): Promise<string> {
  const m = guild.members.cache.get(id);
  if (m) return m.displayName;
  const u = app.client.users.cache.get(id) ?? (await app.client.users.fetch(id).catch(() => null));
  return u ? u.globalName ?? u.username : `Jugador ${id.slice(-4)}`;
}

const MEDALS = ['🥇', '🥈', '🥉'];

export async function tournamentPanel(app: App, guild: Guild, v: Viewer, t: Tournament, page = 0, notice?: string): Promise<Panel> {
  const ctx = app.ctx;
  const prizes = finalPrizes(ctx, t);
  const rows = standings(ctx, t, 10, page * 10);
  const me = standingOf(ctx, t, v.userId);
  const total = participants(ctx, t.id);
  const pages = Math.max(1, Math.ceil(total / 10));
  const line = async (s: Standing) => {
    const badge = MEDALS[s.rank - 1] ?? `\`#${s.rank}\``;
    const prize = s.prize ? ` · 🎁 ${coins(s.prize)}` : '';
    const q = s.qualified ? '' : ' · ⏳';
    return `${badge} **${clean(await nameOf(app, guild, s.userId))}**${s.userId === v.userId ? ' ⬅️' : ''} — ${scoreText(t, s.score)} · ${num(s.rounds)} rondas${prize}${q}`;
  };
  const lines = await Promise.all(rows.map(line));
  const rules = [
    `${KIND[t.kind]} · ${STATUS[t.status]} · ${METRIC_META[t.metric].emoji} **${METRIC_META[t.metric].label}**`,
    `🎮 ${t.game ? gameLabel(t.game) : 'Todos los juegos'}${t.minBet ? ` · apuesta mínima ${coins(t.minBet)}` : ''}${t.maxBet ? ` · máxima ${coins(t.maxBet)}` : ''}`,
    `🗓️ ${t.status === 'scheduled' || t.status === 'draft' ? `empieza <t:${Math.floor(t.startsAt / 1000)}:f>` : `desde <t:${Math.floor(t.startsAt / 1000)}:f>`} · ${t.status === 'finished' ? 'terminó' : 'termina'} <t:${Math.floor(t.endsAt / 1000)}:f> (${rel(t.endsAt)})`,
    `🎁 ${prizeLine(prizes)}`,
    `${t.entryFee ? `🎟️ Entrada ${coins(t.entryFee)}${t.feesToPool ? ' (suma al pozo)' : ''} · ` : ''}mínimo **${t.minRounds}** rondas para cobrar premio`,
  ];
  const e = new EmbedBuilder()
    .setColor(COLORS.tournament)
    .setTitle(`🏟️ ${clean(t.name)}`)
    .setDescription([
      ...(notice ? [notice, ''] : []),
      ...(t.description ? [clean(t.description), ''] : []),
      ...rules,
      '',
      lines.join('\n') || '*Todavía no hay participantes.*',
    ].join('\n'))
    .setFooter({ text: `👥 ${num(total)} participantes · página ${page + 1}/${pages}${me ? ` · tu puesto: #${me.rank} (${scoreText(t, me.score)}, ${me.rounds} rondas)` : ''} · ⏳ = sin rondas mínimas` });
  const buttons: ButtonBuilder[] = [
    new ButtonBuilder().setCustomId(cid('ct', 'view', v.userId, t.id, page - 1)).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(cid('ct', 'view', v.userId, t.id, page + 1)).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    new ButtonBuilder().setCustomId(cid('ct', 'view', v.userId, t.id, page)).setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  ];
  if (t.entryFee > 0 && (t.status === 'active' || t.status === 'scheduled') && !me) {
    buttons.push(new ButtonBuilder().setCustomId(cid('ct', 'join', v.userId, t.id)).setLabel(`Unirme · ${coins(t.entryFee)}`).setEmoji('🎟️').setStyle(ButtonStyle.Success));
  }
  buttons.push(new ButtonBuilder().setCustomId(cid('ct', 'list', v.userId)).setLabel('Todos').setEmoji('🏟️').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: [row(...buttons)] };
}

/** Anuncio público al terminar un torneo. */
export async function finishedEmbed(app: App, guild: Guild, t: Tournament, winners: { userId: string; rank: number; prize: number; score: number }[], total: number): Promise<EmbedBuilder> {
  const lines = await Promise.all(winners.map(async (w) => `${MEDALS[w.rank - 1] ?? `#${w.rank}`} **${clean(await nameOf(app, guild, w.userId))}** — ${scoreText(t, w.score)} · 🎁 ${coins(w.prize)}`));
  return new EmbedBuilder()
    .setColor(COLORS.tournament)
    .setTitle(`🏁 Terminó: ${clean(t.name)}`)
    .setDescription([
      `${METRIC_META[t.metric].emoji} ${METRIC_META[t.metric].label}${t.game ? ` · ${gameLabel(t.game)}` : ''} · 👥 ${num(total)} participantes`,
      '',
      lines.join('\n') || '*Nadie cumplió las rondas mínimas: no hubo premios.*',
    ].join('\n'));
}

export function startedEmbed(t: Tournament, prefix: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.tournament)
    .setTitle(`🏟️ ¡Empezó un torneo! ${clean(t.name)}`)
    .setDescription([
      ...(t.description ? [clean(t.description), ''] : []),
      `${METRIC_META[t.metric].emoji} **${METRIC_META[t.metric].label}** · ${t.game ? gameLabel(t.game) : 'todos los juegos'}`,
      `🎁 ${prizeLine(t.prizes)}`,
      `⏱️ Termina ${rel(t.endsAt)} · mínimo ${t.minRounds} rondas`,
      t.entryFee ? `🎟️ Entrada ${coins(t.entryFee)}: \`${prefix}torneo ${t.id}\` para unirte.` : `Participás con solo jugar. Tabla: \`${prefix}torneo ${t.id}\``,
    ].join('\n'));
}

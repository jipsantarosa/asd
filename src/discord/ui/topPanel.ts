import { EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, type Guild } from 'discord.js';
import type { GameContext } from '../../services/context';
import { gameConfig } from '../../services/guildSettings';
import { TOP_CATEGORIES, TOP_META, leaderboard, playerCount, rankOf, type TopCategory } from '../../services/leaderboard';
import { navRow, row, type Panel, type Viewer } from '../app';
import { cid } from './ids';
import { COLORS, clean, num, truncate } from './theme';

const MEDALS = ['🥇', '🥈', '🥉'];

export async function topPanel(ctx: GameContext, guild: Guild, v: Viewer, category: TopCategory = 'total'): Promise<Panel> {
  const cfg = gameConfig(ctx, guild.id);
  const meta = TOP_META[category];
  const top = leaderboard(ctx, guild.id, category, 10);
  const members = top.length ? await guild.members.fetch({ user: top.map((e) => e.userId) }).catch(() => null) : null;
  const fmt = (value: number) => (category === 'monedas' ? `${cfg.currency.emoji} ${num(value)}` : `${num(value)} ${meta.unit}`);
  const lines = top.map((e) => {
    const name = members?.get(e.userId)?.displayName ?? guild.members.cache.get(e.userId)?.displayName ?? 'Jugador';
    const me = e.userId === v.userId;
    return `${MEDALS[e.rank - 1] ?? `\`#${e.rank}\``} ${me ? '**' : ''}${clean(truncate(name, 32))}${me ? '** ← vos' : ''} — ${fmt(e.value)}`;
  });
  const mine = rankOf(ctx, guild.id, v.userId, category);
  const embed = new EmbedBuilder()
    .setColor(COLORS.golden)
    .setAuthor({ name: `Top de ${guild.name}`, iconURL: guild.iconURL() ?? undefined })
    .setTitle(`${meta.emoji} ${meta.label}`)
    .setDescription(lines.join('\n') || '*Nadie jugó todavía. ¡Sé el primero con `/granja` o `/pesca`!*')
    .setFooter({ text: `${mine ? `Tu posición: #${mine.rank} · ` : 'Todavía no estás en el ranking · '}${num(playerCount(ctx, guild.id))} jugadores` });
  return {
    embeds: [embed],
    components: [
      row(new StringSelectMenuBuilder().setCustomId(cid('tp', 'cat', v.userId)).setPlaceholder('Categoría…')
        .addOptions(TOP_CATEGORIES.map((c) => new StringSelectMenuOptionBuilder().setValue(c).setLabel(TOP_META[c].label).setEmoji(TOP_META[c].emoji).setDefault(c === category)))),
      navRow(v.userId, null),
    ],
  };
}

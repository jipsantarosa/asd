import { ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, type Guild } from 'discord.js';
import { rankOf, TOP_CATEGORIES, TOP_META, topPage, type TopCategory } from '../../../casino/leaderboard';
import { row, type App, type Panel, type Viewer } from '../../app';
import { cid } from '../../ui/ids';
import { COLORS, clean, coins, mult, num, signedCoins } from '../../ui/theme';

export type TopScope = 'g' | 's';
const MEDALS = ['🥇', '🥈', '🥉'];

function valueText(cat: TopCategory, v: number): string {
  const k = TOP_META[cat].kind;
  if (k === 'multiplier') return mult(v);
  if (k === 'count') return num(v);
  return cat === 'profit' ? signedCoins(v) : coins(v);
}

/** Nombres para mostrar (los del servidor si están; si no, el nombre de usuario). Nunca menciona a nadie. */
async function names(app: App, guild: Guild, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of ids) {
    const m = guild.members.cache.get(id);
    if (m) {
      out.set(id, m.displayName);
      continue;
    }
    const u = app.client.users.cache.get(id) ?? (await app.client.users.fetch(id).catch(() => null));
    out.set(id, u ? u.globalName ?? u.username : `Jugador ${id.slice(-4)}`);
  }
  return out;
}

export async function topPanel(app: App, guild: Guild, viewer: Viewer, cat: TopCategory, page: number, scope: TopScope): Promise<Panel> {
  const ctx = app.ctx;
  const guildId = scope === 's' ? guild.id : null;
  const p = topPage(ctx, cat, { guildId, page });
  const n = await names(app, guild, p.rows.map((r) => r.userId));
  const meta = TOP_META[cat];
  const me = rankOf(ctx, cat, viewer.userId, guildId);
  const lines = p.rows.map((r) => {
    const badge = MEDALS[r.rank - 1] ?? `\`#${r.rank}\``;
    const name = clean(n.get(r.userId) ?? r.userId);
    return `${badge} ${r.userId === viewer.userId ? `**${name}** ⬅️` : `**${name}**`} — ${valueText(cat, r.value)}`;
  });
  const e = new EmbedBuilder()
    .setColor(COLORS.casino)
    .setTitle(meta.title)
    .setDescription(lines.join('\n') || '*Todavía no hay nadie en este ranking.*')
    .setFooter({ text: `${scope === 's' ? `Solo ${guild.name}` : 'Global'} · página ${p.page + 1}/${p.pages} · ${me.rank ? `tu puesto: #${num(me.rank)} (${valueText(cat, me.value).replace(/\*\*/g, '')})` : 'todavía no figurás'}` });
  const owner = viewer.userId;
  return {
    embeds: [e],
    components: [
      row(new StringSelectMenuBuilder().setCustomId(cid('cl', 'topc', owner, scope)).setPlaceholder('Categoría…')
        .addOptions(TOP_CATEGORIES.map((c) => new StringSelectMenuOptionBuilder().setValue(c).setLabel(TOP_META[c].label).setEmoji(TOP_META[c].emoji).setDefault(c === cat)))),
      row(
        new ButtonBuilder().setCustomId(cid('cl', 'top', owner, cat, p.page - 1, scope)).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(p.page === 0),
        new ButtonBuilder().setCustomId(cid('cl', 'top', owner, cat, p.page + 1, scope)).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(p.page >= p.pages - 1),
        new ButtonBuilder().setCustomId(cid('cl', 'top', owner, cat, 0, scope === 's' ? 'g' : 's')).setLabel(scope === 's' ? 'Ver global' : 'Solo este servidor')
          .setEmoji(scope === 's' ? '🌎' : '🏠').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(cid('cl', 'me', owner, cat, scope)).setLabel('Mi puesto').setEmoji('📍').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

/** Página donde está una persona en un ranking. */
export function pageOf(app: App, cat: TopCategory, userId: string, guildId: string | null): number {
  const r = rankOf(app.ctx, cat, userId, guildId);
  return r.rank ? Math.floor((r.rank - 1) / 10) : 0;
}

/** !rank: el puesto de una persona en cada ranking. */
export function rankPanel(app: App, guild: Guild, target: { id: string; name: string; avatar: string }): Panel {
  const lines = TOP_CATEGORIES.map((c) => {
    const g = rankOf(app.ctx, c, target.id);
    const s = rankOf(app.ctx, c, target.id, guild.id);
    return `${TOP_META[c].emoji} **${TOP_META[c].label}:** ${g.rank ? `#${num(g.rank)} global` : '—'}${s.rank ? ` · #${num(s.rank)} en el servidor` : ''} · ${valueText(c, g.value)}`;
  });
  const e = new EmbedBuilder().setColor(COLORS.casino).setAuthor({ name: `Puestos de ${target.name}`, iconURL: target.avatar }).setDescription(lines.join('\n'));
  return { embeds: [e], components: [] };
}

import { ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import type { GameContext } from '../../services/context';
import { getSettings } from '../../services/guildSettings';
import { row, type Panel, type Viewer } from '../app';
import type { Command } from '../commands/types';
import { cid } from './ids';
import { COLORS } from './theme';

/**
 * !help: portada con las categorías, `!help <categoría>` con sus comandos y `!help <comando>` con el detalle.
 * Se arma con la lista real de comandos: un comando nuevo aparece solo (si no tiene categoría, va a "Otros").
 */

export interface HelpCategory {
  id: string;
  name: string;
  emoji: string;
  blurb: string;
  commands: string[];
}

export const HELP_CATEGORIES: HelpCategory[] = [
  { id: 'casino', name: 'Casino', emoji: '🎰', blurb: 'Saldo, bonos y trabajos.', commands: ['casino', 'balance', 'daily', 'weekly', 'rescate', 'work'] },
  { id: 'juegos', name: 'Juegos', emoji: '🎲', blurb: 'Los 10 juegos del casino.', commands: ['blackjack', 'ruleta', 'slots', 'crash', 'plinko', 'minas', 'pollo', 'globos', 'hilo', 'dragon'] },
  { id: 'progreso', name: 'Progreso', emoji: '🏆', blurb: 'Rankings, estadísticas, logros y torneos.', commands: ['top', 'rank', 'stats', 'history', 'logros', 'torneo', 'fairness'] },
  { id: 'social', name: 'Social', emoji: '💞', blurb: 'Perfil, casamientos y besos.', commands: ['profile', 'marry', 'divorce', 'kiss', 'besos'] },
  { id: 'perfiles', name: 'Historiales', emoji: '🕵️', blurb: 'Avatares, banners, nombres y tags.', commands: ['avatares', 'banners', 'names', 'tags'] },
  { id: 'diversion', name: 'Diversión', emoji: '🎮', blurb: 'GIFs, emojis y estadísticas de juegos.', commands: ['gif', 'uservalo', 'cs2', 'steal'] },
  { id: 'premium', name: 'Premium', emoji: '💎', blurb: 'Funciones extra para quien tiene premium.', commands: ['premium', 'clearavatars', 'clearnames', 'cleartags', 'mstats', 'ghostmode', 'botperfil'] },
  { id: 'voz', name: 'Voz', emoji: '🔊', blurb: 'Canales de voz temporales.', commands: ['canal', 'voz'] },
  { id: 'moderacion', name: 'Moderación', emoji: '🛡️', blurb: 'Sanciones, casos, automod y limpieza.', commands: ['mod', 'warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'modlogs', 'caso', 'purgar', 'automod'] },
  { id: 'config', name: 'Configuración', emoji: '⚙️', blurb: 'Ajustes del servidor y del bot.', commands: ['ayuda', 'prefijo', 'setlang', 'ajustes', 'setup', 'roles', 'autorol', 'rolespremium', 'boosttracker', 'anti-webhooks'] },
  { id: 'dueno', name: 'Dueño del bot', emoji: '👑', blurb: 'Solo para el dueño del bot.', commands: ['setupdiscord', 'plantilla'] },
];

/** Descripción de los comandos que solo existen por prefijo (no tienen comando de barra). */
const PREFIX_ONLY: Record<string, { desc: string; usage: string }> = {
  warn: { desc: '⚠️ Advertir a alguien (queda un caso).', usage: '@usuario [motivo]' },
  timeout: { desc: '🔇 Aislar a alguien por un tiempo.', usage: '@usuario <tiempo> [motivo]' },
  untimeout: { desc: '🔊 Quitar el aislamiento.', usage: '@usuario [motivo]' },
  kick: { desc: '👢 Expulsar a alguien del servidor.', usage: '@usuario [motivo]' },
  ban: { desc: '🔨 Banear a alguien.', usage: '@usuario [motivo]' },
  unban: { desc: '♻️ Desbanear por ID.', usage: '<ID> [motivo]' },
  modlogs: { desc: '📋 Casos de moderación de alguien.', usage: '@usuario' },
  caso: { desc: '🗂️ Ver un caso para editar el motivo o anularlo.', usage: '<número>' },
};

let commands: Command[] = [];
const byName = new Map<string, Command>();

/** Lo llama commands/index.ts con la lista completa (así no hay importación circular). */
export function registerHelpCommands(list: Command[]): void {
  commands = list;
  byName.clear();
  for (const c of list) for (const n of [c.name, ...c.aliases]) byName.set(n.toLowerCase(), c);
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/^[!/]/, '').trim();

function categories(): HelpCategory[] {
  const known = new Set(HELP_CATEGORIES.flatMap((c) => c.commands));
  const exists = (n: string) => commands.some((c) => c.name === n);
  const list = HELP_CATEGORIES.map((c) => ({ ...c, commands: c.commands.filter(exists) })).filter((c) => c.commands.length);
  const others = commands.filter((c) => !known.has(c.name)).map((c) => c.name);
  if (others.length) list.push({ id: 'otros', name: 'Otros', emoji: '📦', blurb: 'Más comandos.', commands: others });
  return list;
}

export function findHelpCategory(raw: string): HelpCategory | null {
  const v = norm(raw);
  return categories().find((c) => c.id === v || norm(c.name) === v) ?? null;
}

export function findHelpCommand(raw: string): Command | null {
  return byName.get(norm(raw)) ?? null;
}

function descOf(c: Command): string {
  return c.data?.toJSON().description ?? PREFIX_ONLY[c.name]?.desc ?? 'Sin descripción.';
}

/** Formas de uso: `!cmd <obligatorio> [opcional]`, una por subcomando. */
export function usageOf(c: Command, p: string): string[] {
  const head = c.prefix ? `${p}${c.name}` : `/${c.name}`;
  if (!c.data) return [`${head}${PREFIX_ONLY[c.name] ? ` ${PREFIX_ONLY[c.name].usage}` : ''}`];
  type Opt = { type: number; name: string; required?: boolean; options?: Opt[] };
  const opts = (c.data.toJSON().options ?? []) as Opt[];
  const args = (list: Opt[] = []) => list.map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`)).join(' ');
  const subs = opts.filter((o) => o.type === 1 || o.type === 2);
  if (!subs.length) return [`${head} ${args(opts)}`.trim()];
  return subs.flatMap((s) => (s.type === 2 ? (s.options ?? []).map((x) => `${head} ${s.name} ${x.name} ${args(x.options)}`.trim()) : [`${head} ${s.name} ${args(s.options)}`.trim()]));
}

function components(owner: string, current: string | null): Panel['components'] {
  const select = new StringSelectMenuBuilder().setCustomId(cid('hm', 'cat', owner)).setPlaceholder('Elegí una categoría…')
    .addOptions(
      new StringSelectMenuOptionBuilder().setValue('inicio').setLabel('Inicio').setEmoji('🏠').setDefault(current === null),
      ...categories().map((c) => new StringSelectMenuOptionBuilder().setValue(c.id).setLabel(c.name).setEmoji(c.emoji)
        .setDescription(`${c.commands.length} comandos · ${c.blurb}`.slice(0, 100)).setDefault(current === c.id)),
    );
  const guide = new ButtonBuilder().setCustomId(cid('hm', 'guide', owner)).setLabel('Guía del casino').setEmoji('📖').setStyle(ButtonStyle.Secondary);
  return [row(select), row(guide)];
}

/** Portada: cuántos comandos hay y la lista de categorías. */
export function helpHome(ctx: GameContext, v: Viewer, botAvatar?: string): Panel {
  const { prefix: p } = getSettings(ctx, v.guildId);
  const cats = categories();
  const width = Math.max(...cats.map((c) => `${p}help ${c.id}`.length));
  const e = new EmbedBuilder()
    .setColor(COLORS.help)
    .setTitle('📚 Mis comandos')
    .setDescription([
      '**» Menú de ayuda**',
      `¡Tengo \`${cats.length}\` **categorías** y \`${commands.length}\` **comandos** listos para vos! 🎰`,
      `Funcionan con \`${p}\` (el prefijo de este servidor) y la mayoría también con \`/\`.`,
      '',
      `Lista de comandos: \`${p}help <categoría>\``,
      `Detalles de un comando: \`${p}help <comando>\``,
      '',
      '**» Categorías**',
      ...cats.map((c) => `\`${`${p}help ${c.id}`.padEnd(width, ' ')}\` :: ${c.emoji} ${c.name}`),
    ].join('\n'))
    .setFooter({ text: 'Las Coins son 100 % virtuales: no se compran ni se cambian por dinero real.' });
  if (botAvatar) e.setThumbnail(botAvatar);
  return { embeds: [e], components: components(v.userId, null) };
}

export function helpCategory(ctx: GameContext, v: Viewer, cat: HelpCategory): Panel {
  const { prefix: p } = getSettings(ctx, v.guildId);
  const lines = cat.commands.map((n) => byName.get(n)!).filter(Boolean).map((c) => {
    const alias = c.aliases.length ? ` · ${c.aliases.slice(0, 3).map((a) => `\`${a}\``).join(' ')}` : '';
    return `**\`${c.prefix ? p : '/'}${c.name}\`**${alias}\n-# ${descOf(c)}`;
  });
  const e = new EmbedBuilder()
    .setColor(COLORS.help)
    .setTitle(`${cat.emoji} ${cat.name}`)
    .setDescription([`${cat.blurb} \`${cat.commands.length}\` comandos.`, '', ...lines].join('\n').slice(0, 4096))
    .setFooter({ text: `Detalles de un comando: ${p}help <comando>` });
  return { embeds: [e], components: components(v.userId, cat.id) };
}

export function helpCommand(ctx: GameContext, v: Viewer, c: Command): Panel {
  const { prefix: p } = getSettings(ctx, v.guildId);
  const cat = categories().find((x) => x.commands.includes(c.name));
  const usage = usageOf(c, p);
  const e = new EmbedBuilder()
    .setColor(COLORS.help)
    .setTitle(`${cat?.emoji ?? '📦'} ${c.prefix ? p : '/'}${c.name}`)
    .setDescription(descOf(c))
    .addFields(
      { name: 'Uso', value: usage.slice(0, 12).map((u) => `\`${u}\``).join('\n').slice(0, 1024) || '—' },
      { name: 'Alias', value: c.aliases.length ? c.aliases.map((a) => `\`${a}\``).join(' ').slice(0, 1024) : '—', inline: true },
      { name: 'Barra', value: c.data ? `\`/${c.name}\`` : 'solo con prefijo', inline: true },
      { name: 'Permiso', value: c.permissionName ?? (cat?.id === 'dueno' ? 'Dueño del bot' : 'Todos'), inline: true },
    )
    .setFooter({ text: '<obligatorio> · [opcional]' });
  return { embeds: [e], components: components(v.userId, cat?.id ?? null) };
}

/** `!help`, `!help <categoría>` o `!help <comando>`. */
export function helpFor(ctx: GameContext, v: Viewer, query: string | null, botAvatar?: string): Panel | null {
  if (!query) return helpHome(ctx, v, botAvatar);
  const cat = findHelpCategory(query);
  if (cat) return helpCategory(ctx, v, cat);
  const cmd = findHelpCommand(query);
  return cmd ? helpCommand(ctx, v, cmd) : null;
}

import { ButtonBuilder, ButtonStyle, EmbedBuilder, InteractionContextType, SlashCommandBuilder, type SlashCommandOptionsOnlyBuilder } from 'discord.js';
import { activityToday } from '../../casino/activity';
import { claimDaily, claimRescue, claimWeekly, type BonusResult } from '../../casino/bonus';
import { GAME_IDS, getCasinoConfig, isGameId, type GameId } from '../../casino/config';
import { activeRoundOf, getRound, gameOf } from '../../casino/engine';
import { ensureCasinoUser, getBalance } from '../../casino/economy';
import { parseTopCategory, TOP_CATEGORIES, TOP_META } from '../../casino/leaderboard';
import { CLIENT_SEED_RE, rotateSeed } from '../../casino/rng';
import { touchUser } from '../../casino/users';
import { GameError } from '../../services/context';
import { row } from '../app';
import type { Command, CommandContext } from '../commands/types';
import { isOwner } from '../owner';
import { syncRewardRoles } from '../roleSafety';
import { COLORS, coins, rel } from '../ui/theme';
import { cid } from '../ui/ids';
import { casinoAdmin, balanceAdmin } from './admin';
import { GAME_COMMANDS, gameFromName, parseBet } from './format';
import { SCREENS } from './games';
import { playGame } from './play';
import { sendFromCommand } from './screen';
import { tournamentCommand } from './tournamentCommands';
import { workCommand } from './work';
import { fairnessPanel, verifyPanel } from './ui/fairness';
import { lobbyPanel, walletPanel } from './ui/lobby';
import { achievementsPanel, historyPanel, profilePanel, statsPanel, type Target } from './ui/profile';
import { rankPanel, topPanel } from './ui/top';

const guildOnly = (b: SlashCommandBuilder) => b.setContexts(InteractionContextType.Guild);

/** Persona objetivo de un comando (mención, ID o uno mismo). Los bots no juegan. */
async function targetOf(c: CommandContext, index: number): Promise<Target> {
  const member = await c.member_('usuario', index);
  if (member) {
    if (member.user.bot) throw new GameError('Los bots no juegan en el casino.');
    return { id: member.id, name: member.displayName, avatar: member.displayAvatarURL({ size: 128 }) };
  }
  const user = c.interaction ? null : await c.user_('usuario', index);
  if (user) {
    if (user.bot) throw new GameError('Los bots no juegan en el casino.');
    return { id: user.id, name: user.globalName ?? user.username, avatar: user.displayAvatarURL({ size: 128 }) };
  }
  return { id: c.member.id, name: c.member.displayName, avatar: c.member.displayAvatarURL({ size: 128 }) };
}

/** ¿El argumento en esa posición parece una persona (mención o ID)? */
const looksLikeUser = (raw: string | undefined) => !!raw && /^(<@!?\d{17,20}>|\d{17,20})$/.test(raw);

function channelIds(c: CommandContext): { channelId: string; parentId: string | null } {
  const ch = c.interaction?.channel ?? c.message?.channel ?? null;
  if (!ch) throw new GameError('No pude identificar el canal.');
  return { channelId: ch.id, parentId: ch.isThread() ? ch.parentId : null };
}

// ───────────────────────── Juegos ─────────────────────────

type OptionBuilder = (b: SlashCommandOptionsOnlyBuilder) => SlashCommandOptionsOnlyBuilder;

const DIFF = (choices: [string, string][]): OptionBuilder => (b) =>
  b.addStringOption((o) => o.setName('dificultad').setDescription('Dificultad').addChoices(...choices.map(([name, value]) => ({ name, value }))));

/** Opciones propias de cada juego en slash, y cómo convertirlas en los argumentos del prefijo. */
const SLASH: Record<GameId, { build?: OptionBuilder; args: (c: CommandContext) => string[] }> = {
  blackjack: { args: () => [] },
  slots: { args: () => [] },
  hilo: { args: () => [] },
  balloons: { args: () => [] },
  roulette: {
    build: (b) => b.addStringOption((o) => o.setName('a').setDescription('rojo, negro, par, impar, bajo, alto, d1-d3, c1-c3, un número, 7,17,23 o 5-12').setMaxLength(100)),
    args: (c) => (c.str('a', 0) ?? '').split(/\s+/).filter(Boolean),
  },
  crash: {
    build: (b) => b.addStringOption((o) => o.setName('auto').setDescription('Retiro automático (ej: 2.5x)').setMaxLength(10)),
    args: (c) => [c.str('auto', 0) ?? ''].filter(Boolean),
  },
  plinko: {
    build: (b) => b
      .addStringOption((o) => o.setName('riesgo').setDescription('Riesgo').addChoices({ name: 'bajo', value: 'bajo' }, { name: 'medio', value: 'medio' }, { name: 'alto', value: 'alto' }))
      .addIntegerOption((o) => o.setName('filas').setDescription('Filas (8 a 16)').setMinValue(8).setMaxValue(16)),
    args: (c) => [c.str('riesgo', 0) ?? '', c.interaction?.options.getInteger('filas')?.toString() ?? ''].filter(Boolean),
  },
  mines: {
    build: (b) => b.addIntegerOption((o) => o.setName('minas').setDescription('Cantidad de minas (1 a 24)').setMinValue(1).setMaxValue(24)),
    args: (c) => [c.interaction?.options.getInteger('minas')?.toString() ?? ''].filter(Boolean),
  },
  chicken: { build: DIFF([['fácil', 'facil'], ['normal', 'normal'], ['difícil', 'dificil']]), args: (c) => [c.str('dificultad', 0) ?? ''].filter(Boolean) },
  tower: { build: DIFF([['fácil', 'facil'], ['medio', 'medio'], ['difícil', 'dificil'], ['experto', 'experto']]), args: (c) => [c.str('dificultad', 0) ?? ''].filter(Boolean) },
};

function gameCommand(id: GameId): Command {
  const g = gameOf(id);
  const [name, ...aliases] = GAME_COMMANDS[id];
  const base = guildOnly(new SlashCommandBuilder().setName(name).setDescription(`${g.emoji} ${g.tagline}`.slice(0, 100)))
    .addStringOption((o) => o.setName('apuesta').setDescription('Cuánto apostar: 500, 1k, mitad o todo (vacío = ver las reglas)').setMaxLength(20));
  const spec = SLASH[id];
  return {
    name,
    aliases,
    prefix: true,
    data: spec.build ? spec.build(base) : base,
    async run(c) {
      const ctx = c.app.ctx;
      const rawBet = c.interaction ? c.interaction.options.getString('apuesta') : c.args[0] ?? null;
      if (!rawBet || ['reglas', 'rules', 'ayuda', 'help', 'info'].includes(rawBet.toLowerCase())) {
        const open = activeRoundOf(ctx, c.member.id, id);
        const resume = open ? [row(new ButtonBuilder().setCustomId(cid('cs', 'resume', c.member.id, open.id)).setLabel('Retomar mi partida').setEmoji('▶️').setStyle(ButtonStyle.Primary))] : [];
        await c.reply({ embeds: [SCREENS[id].rules(ctx, c.prefix)], components: resume });
        return;
      }
      const args = c.interaction ? spec.args(c) : c.args.slice(1);
      const params = g.parseParams(args);
      ensureCasinoUser(ctx, c.member.id);
      const cfg = getCasinoConfig(ctx).games[id];
      const bet = parseBet(rawBet, getBalance(ctx, c.member.id), cfg.maxBet);
      const { channelId, parentId } = channelIds(c);
      await playGame({ app: c.app, member: c.member, channelId, parentId, game: id, bet, params, send: (s) => sendFromCommand(c, s) });
    },
  };
}

export const GAME_COMMAND_LIST: Command[] = GAME_IDS.map(gameCommand);

// ───────────────────────── Lobby, billetera y bonos ─────────────────────────

const casino: Command = {
  name: 'casino',
  aliases: ['lobby', 'juegos', 'games'],
  prefix: true,
  data: guildOnly(new SlashCommandBuilder().setName('casino').setDescription('🎰 Lobby del casino: tu saldo, los juegos, el jackpot y los torneos.')),
  async run(c) {
    if (c.args.length && isOwner(c.member.id)) return casinoAdmin(c);
    ensureCasinoUser(c.app.ctx, c.member.id);
    touchUser(c.app.ctx, c.member.id, c.guild.id);
    await c.reply(lobbyPanel(c.app.ctx, c.viewer, c.prefix));
  },
};

const balance: Command = {
  name: 'balance',
  aliases: ['bal', 'saldo', 'coins', 'wallet', 'billetera', 'cartera'],
  prefix: true,
  data: guildOnly(new SlashCommandBuilder().setName('balance').setDescription('💼 Tu saldo, tus bonos y lo ganado hoy.'))
    .addUserOption((o) => o.setName('usuario').setDescription('Ver el saldo de otra persona')),
  async run(c) {
    const sub = c.args[0]?.toLowerCase();
    if (sub && ['add', 'remove', 'set', 'sumar', 'quitar', 'fijar'].includes(sub)) {
      if (!isOwner(c.member.id)) throw new GameError('Solo el dueño del bot puede ajustar saldos.');
      return balanceAdmin(c);
    }
    const t = await targetOf(c, 0);
    ensureCasinoUser(c.app.ctx, t.id);
    if (t.id === c.member.id) {
      touchUser(c.app.ctx, c.member.id, c.guild.id);
      await c.reply(walletPanel(c.app.ctx, c.viewer, activityToday(c.app.ctx, c.member.id)));
      return;
    }
    const e = new EmbedBuilder().setColor(COLORS.casino).setAuthor({ name: t.name, iconURL: t.avatar }).setDescription(`💼 **${coins(getBalance(c.app.ctx, t.id))}**`);
    await c.reply({ embeds: [e] });
  },
};

export function bonusEmbed(kind: 'daily' | 'weekly' | 'rescue', r: BonusResult, name: string): EmbedBuilder {
  const title = { daily: '🎁 Bono diario', weekly: '📅 Bono semanal', rescue: '🛟 Rescate' }[kind];
  return new EmbedBuilder().setColor(COLORS.win).setTitle(title).setDescription([
    `**${name}** recibió **${coins(r.amount)}**.`,
    kind === 'daily' ? `🔥 Racha: **${r.streak}** ${r.streak === 1 ? 'día' : 'días'} (volvé mañana para mantenerla)` : '',
    `💼 Saldo: **${coins(r.balance)}**`,
    `⏱️ Próximo: ${rel(r.nextAt)}`,
    ...r.achievements.map((a) => `🏅 Logro: **${a.def.emoji} ${a.def.name}** +${coins(a.reward)}`),
  ].filter(Boolean).join('\n'));
}

function bonusCommand(kind: 'daily' | 'weekly' | 'rescue', name: string, aliases: string[], description: string): Command {
  return {
    name,
    aliases,
    prefix: true,
    data: guildOnly(new SlashCommandBuilder().setName(name).setDescription(description)),
    async run(c) {
      const claim = { daily: claimDaily, weekly: claimWeekly, rescue: claimRescue }[kind];
      const r = claim(c.app.ctx, c.member.id, c.guild.id);
      touchUser(c.app.ctx, c.member.id, c.guild.id);
      await c.reply({ embeds: [bonusEmbed(kind, r, c.member.displayName)] });
      if (r.achievements.length) await syncRewardRoles(c.app.ctx, c.member);
    },
  };
}

// ───────────────────────── Perfil, ranking, estadísticas ─────────────────────────

const top: Command = {
  name: 'top',
  aliases: ['ranking', 'leaderboard', 'lb', 'ricos'],
  prefix: true,
  data: guildOnly(new SlashCommandBuilder().setName('top').setDescription('🏆 Ranking: 💰 los más ricos y otras categorías.'))
    .addStringOption((o) => o.setName('categoria').setDescription('Qué ranking ver').addChoices(...TOP_CATEGORIES.map((id) => ({ name: TOP_META[id].label, value: id }))))
    .addIntegerOption((o) => o.setName('pagina').setDescription('Página').setMinValue(1).setMaxValue(1000))
    .addBooleanOption((o) => o.setName('servidor').setDescription('Solo jugadores de este servidor')),
  async run(c) {
    // Prefijo: !top · !top 2 · !top ganancias · !top ganancias 3 · !top servidor
    let cat = parseTopCategory(c.interaction ? c.interaction.options.getString('categoria') : null) ?? 'richest';
    let page = c.interaction?.options.getInteger('pagina') ?? 1;
    let scope: 'g' | 's' = c.interaction?.options.getBoolean('servidor') ? 's' : 'g';
    if (!c.interaction) {
      for (const a of c.args) {
        if (/^\d{1,4}$/.test(a)) page = Number(a);
        else if (['servidor', 'server', 'local', 'aca', 'acá'].includes(a.toLowerCase())) scope = 's';
        else {
          const k = parseTopCategory(a);
          if (!k) throw new GameError(`No conozco la categoría "${a}". Opciones: ${TOP_CATEGORIES.map((x) => TOP_META[x].aliases[0]).join(', ')}.`);
          cat = k;
        }
      }
    }
    await c.defer();
    await c.reply(await topPanel(c.app, c.guild, c.viewer, cat, Math.max(0, page - 1), scope));
  },
};

const rank: Command = {
  name: 'rank',
  aliases: ['rango', 'puesto', 'posicion', 'posición'],
  prefix: true,
  data: guildOnly(new SlashCommandBuilder().setName('rank').setDescription('📍 Tu puesto en cada ranking (global y del servidor).'))
    .addUserOption((o) => o.setName('usuario').setDescription('Ver el puesto de otra persona')),
  async run(c) {
    const t = await targetOf(c, 0);
    await c.reply(rankPanel(c.app, c.guild, t));
  },
};

const stats: Command = {
  name: 'stats',
  aliases: ['estadisticas', 'estadísticas', 'est'],
  prefix: true,
  data: guildOnly(new SlashCommandBuilder().setName('stats').setDescription('📊 Estadísticas por juego.'))
    .addStringOption((o) => o.setName('juego').setDescription('Juego').addChoices(...GAME_IDS.map((id) => ({ name: gameOf(id).name, value: id }))))
    .addUserOption((o) => o.setName('usuario').setDescription('De otra persona')),
  async run(c) {
    const rawGame = c.interaction ? c.interaction.options.getString('juego') : c.args.find((a) => !looksLikeUser(a)) ?? null;
    const game = rawGame ? gameFromName(rawGame) : null;
    if (rawGame && !game) throw new GameError(`No conozco el juego "${rawGame}".`);
    const t = await targetOf(c, c.interaction ? 0 : c.args.findIndex(looksLikeUser));
    await c.reply(statsPanel(c.app.ctx, c.viewer, t, game));
  },
};

const history: Command = {
  name: 'history',
  aliases: ['historial', 'hist', 'jugadas', 'rondas'],
  prefix: true,
  data: guildOnly(new SlashCommandBuilder().setName('history').setDescription('📜 Tus últimas rondas (filtrables por juego) y movimientos.'))
    .addStringOption((o) => o.setName('juego').setDescription('Juego').addChoices(...GAME_IDS.map((id) => ({ name: gameOf(id).name, value: id })), { name: 'Movimientos de la billetera', value: 'tx' }))
    .addIntegerOption((o) => o.setName('pagina').setDescription('Página').setMinValue(1).setMaxValue(10_000)),
  async run(c) {
    let filter: GameId | 'all' | 'tx' = 'all';
    let page = c.interaction?.options.getInteger('pagina') ?? 1;
    const raw = c.interaction ? c.interaction.options.getString('juego') : null;
    if (raw === 'tx') filter = 'tx';
    else if (raw && isGameId(raw)) filter = raw;
    if (!c.interaction) {
      for (const a of c.args) {
        if (/^\d{1,5}$/.test(a)) page = Number(a);
        else if (['tx', 'movimientos', 'billetera'].includes(a.toLowerCase())) filter = 'tx';
        else {
          const g = gameFromName(a);
          if (!g) throw new GameError(`No conozco el juego "${a}".`);
          filter = g;
        }
      }
    }
    const me: Target = { id: c.member.id, name: c.member.displayName, avatar: c.member.displayAvatarURL({ size: 128 }) };
    await c.reply(historyPanel(c.app.ctx, c.viewer, me, filter, Math.max(0, page - 1)));
  },
};

const logros: Command = {
  name: 'logros',
  aliases: ['achievements', 'ach', 'insignias'],
  prefix: true,
  data: guildOnly(new SlashCommandBuilder().setName('logros').setDescription('🏅 Logros del casino.'))
    .addUserOption((o) => o.setName('usuario').setDescription('De otra persona')),
  async run(c) {
    const t = await targetOf(c, 0);
    await c.reply(achievementsPanel(c.app.ctx, c.viewer, t));
  },
};

const fairness: Command = {
  name: 'fairness',
  aliases: ['justo', 'provablyfair', 'pf', 'semilla', 'seed', 'verificar'],
  prefix: true,
  data: guildOnly(new SlashCommandBuilder().setName('fairness').setDescription('🔐 Azar verificable: tus semillas, rotarlas y verificar rondas.'))
    .addIntegerOption((o) => o.setName('verificar').setDescription('Número de ronda a verificar').setMinValue(1)),
  async run(c) {
    const ctx = c.app.ctx;
    ensureCasinoUser(ctx, c.member.id);
    const verifyId = c.interaction?.options.getInteger('verificar') ?? null;
    const sub = c.args[0]?.toLowerCase();
    const roundArg = verifyId ?? (sub && ['verificar', 'verify', 'v'].includes(sub) ? Number(c.args[1]) : sub && /^\d+$/.test(sub) ? Number(sub) : null);
    if (roundArg !== null) {
      const round = getRound(ctx, roundArg);
      if (!round || round.userId !== c.member.id) throw new GameError('No encontré esa ronda entre las tuyas.');
      if (round.status === 'active') throw new GameError('Esa partida todavía está en curso.');
      await c.reply(verifyPanel(ctx, round));
      return;
    }
    if (sub && ['rotar', 'rotate', 'nueva', 'cliente', 'client'].includes(sub)) {
      const seed = c.args[1] ?? null;
      if (seed !== null && !CLIENT_SEED_RE.test(seed)) throw new GameError('La semilla del cliente puede tener de 1 a 32 caracteres: letras, números, guion o guion bajo.');
      const r = rotateSeed(ctx, c.member.id, seed);
      await c.reply(fairnessPanel(ctx, c.viewer, `🔄 Semilla rotada. La anterior era \`${r.revealed.serverSeed}\` (hash \`${r.revealed.serverSeedHash.slice(0, 16)}…\`).`));
      return;
    }
    await c.reply(fairnessPanel(ctx, c.viewer));
  },
};

export const CASINO_COMMANDS: Command[] = [
  casino, balance,
  bonusCommand('daily', 'daily', ['diario', 'd'], '🎁 Cobrá tu bono diario (con racha).'),
  bonusCommand('weekly', 'weekly', ['semanal', 'w'], '📅 Cobrá tu bono semanal.'),
  bonusCommand('rescue', 'rescate', ['rescue', 'ayudita'], '🛟 Un rescate si te quedaste casi sin Coins.'),
  workCommand, top, rank, stats, history, logros, fairness, tournamentCommand,
  ...GAME_COMMAND_LIST,
];


import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { logAdmin } from '../../casino/admin';
import { getCasinoConfig, TOURNAMENT_METRICS, type GameId, type TournamentMetric } from '../../casino/config';
import {
  cancelTournament, createTournament, joinTournament, requireTournament, startTournament, updateTournament, type TournamentInput,
} from '../../casino/tournaments';
import { GameError, type GameContext } from '../../services/context';
import type { Command, CommandContext } from '../commands/types';
import { isOwner } from '../owner';
import { closeAndAnnounce, startAndAnnounce } from './announce';
import { gameFromName, parseAmount } from './format';
import { tournamentListPanel, tournamentPanel } from './ui/tournaments';

/**
 * !torneo — para todos: lista, tabla y unirse. Para el dueño del bot: create, edit, start, stop, cancel.
 *
 *   !torneo create Plinko Weekend juego=plinko metrica=multiplicador duracion=2d premios=50k,25k,10k minbet=100 rondas=20 | Descripción
 *   !torneo edit 5 premios=60k,30k fin=+1d nombre=Plinko_Weekend_XL
 *   !torneo start 5 · !torneo stop 5 · !torneo cancel 5 · !torneo list · !torneo leaderboard 5
 *
 * Claves: juego, metrica (beneficio|apostado|multiplicador|victorias), duracion (90m, 12h, 3d), inicio (+2h o 2026-10-05T20:00),
 * fin (+1d o fecha), premios, minbet, maxbet, entrada, pozo (si|no), rondas, nombre (con _ en lugar de espacios).
 */

const METRIC_ALIASES: Record<string, TournamentMetric> = {
  profit: 'profit', beneficio: 'profit', ganancia: 'profit',
  wagered: 'wagered', apostado: 'wagered', volumen: 'wagered',
  multiplier: 'multiplier', multiplicador: 'multiplier', multi: 'multiplier', x: 'multiplier',
  wins: 'wins', victorias: 'wins', ganadas: 'wins',
};

export function parseDuration(raw: string): number {
  const m = raw.toLowerCase().match(/^(\d{1,4})(m|min|h|d)$/);
  if (!m) throw new GameError(`Duración inválida "${raw}": usá 90m, 12h o 3d.`);
  const n = Number(m[1]);
  return n * (m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : 60_000);
}

/** "+2h" (desde ahora) o "2026-10-05T20:00" (hora del casino). */
export function parseWhen(ctx: GameContext, raw: string, base = ctx.now()): number {
  if (raw.startsWith('+')) return base + parseDuration(raw.slice(1));
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T_](\d{2}):(\d{2}))?$/);
  if (!m) throw new GameError(`Fecha inválida "${raw}": usá +2h o 2026-10-05T20:00.`);
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  if (!Number.isFinite(utc)) throw new GameError(`Fecha inválida "${raw}".`);
  return utc - getCasinoConfig(ctx).timezoneOffsetMinutes * 60_000;
}

function amount(raw: string, what: string): number {
  const n = parseAmount(raw);
  if (n === null) throw new GameError(`${what}: escribí un número entero (ej: 5000 o 5k).`);
  return n;
}

export interface ParsedTournament {
  name: string;
  description?: string;
  patch: Partial<TournamentInput>;
  duration?: number;
}

/** Separa "nombre libre clave=valor … | descripción". */
export function parseTournamentArgs(ctx: GameContext, words: string[]): ParsedTournament {
  const text = words.join(' ');
  const [main, ...descParts] = text.split('|');
  const description = descParts.join('|').trim() || undefined;
  const nameWords: string[] = [];
  const patch: Partial<TournamentInput> = {};
  let duration: number | undefined;
  let start: string | undefined;
  let end: string | undefined;
  for (const w of main.trim().split(/\s+/).filter(Boolean)) {
    const kv = w.match(/^([a-záéíóú]+)=(.+)$/i);
    if (!kv) {
      nameWords.push(w);
      continue;
    }
    const [, k, v] = kv;
    switch (k.toLowerCase()) {
      case 'juego':
      case 'game': {
        if (['todos', 'all', 'cualquiera'].includes(v.toLowerCase())) patch.game = null;
        else {
          const g = gameFromName(v);
          if (!g) throw new GameError(`No conozco el juego "${v}".`);
          patch.game = g as GameId;
        }
        break;
      }
      case 'metrica':
      case 'métrica':
      case 'metric': {
        const m = METRIC_ALIASES[v.toLowerCase()];
        if (!m) throw new GameError(`Métricas: ${Object.keys(METRIC_ALIASES).filter((x) => !TOURNAMENT_METRICS.includes(x as TournamentMetric)).join(', ')}.`);
        patch.metric = m;
        break;
      }
      case 'duracion':
      case 'duración':
        duration = parseDuration(v);
        break;
      case 'inicio':
      case 'start':
        start = v;
        break;
      case 'fin':
      case 'end':
        end = v;
        break;
      case 'premios':
      case 'prizes':
        patch.prizes = v.split(',').map((x) => amount(x, 'Cada premio'));
        break;
      case 'minbet':
        patch.minBet = amount(v, 'La apuesta mínima');
        break;
      case 'maxbet':
        patch.maxBet = ['no', 'sin', '0'].includes(v.toLowerCase()) ? null : amount(v, 'La apuesta máxima');
        break;
      case 'entrada':
      case 'fee':
        patch.entryFee = amount(v, 'La entrada');
        break;
      case 'pozo':
        patch.feesToPool = !['no', 'false', '0'].includes(v.toLowerCase());
        break;
      case 'rondas':
      case 'rounds':
        patch.minRounds = amount(v, 'Las rondas mínimas');
        break;
      case 'nombre':
      case 'name':
        patch.name = v.replace(/_/g, ' ');
        break;
      default:
        throw new GameError(`No conozco la opción "${k}".`);
    }
  }
  if (start) patch.startsAt = parseWhen(ctx, start);
  if (end) patch.endsAt = parseWhen(ctx, end, patch.startsAt ?? ctx.now());
  if (duration !== undefined) patch.endsAt = (patch.startsAt ?? ctx.now()) + duration;
  if (description !== undefined) patch.description = description;
  return { name: nameWords.join(' '), description, patch, duration };
}

function idArg(raw: string | undefined): number {
  const n = Number((raw ?? '').replace(/^#/, ''));
  if (!Number.isSafeInteger(n) || n < 1) throw new GameError('Falta el número del torneo (ej: `!torneo start 5`).');
  return n;
}

async function ownerAction(c: CommandContext, sub: string, rest: string[]): Promise<boolean> {
  const ctx = c.app.ctx;
  const log = (action: string, details: unknown) => logAdmin(ctx, { actorId: c.member.id, action, details, guildId: c.guild.id });
  switch (sub) {
    case 'create':
    case 'crear': {
      const p = parseTournamentArgs(ctx, rest);
      const name = p.patch.name ?? p.name;
      if (!name) throw new GameError('Uso: `!torneo create <nombre> juego=… metrica=… duracion=2d premios=50k,25k,10k [minbet=… entrada=… rondas=… inicio=+1h] | descripción`');
      const startsAt = p.patch.startsAt ?? ctx.now();
      const input: TournamentInput = {
        name, description: p.description ?? '', metric: p.patch.metric ?? 'profit', game: p.patch.game ?? null, minBet: p.patch.minBet ?? 0,
        maxBet: p.patch.maxBet ?? null, entryFee: p.patch.entryFee ?? 0, feesToPool: p.patch.feesToPool ?? true, prizes: p.patch.prizes ?? [],
        minRounds: p.patch.minRounds ?? 0, startsAt, endsAt: p.patch.endsAt ?? startsAt + 86_400_000,
      };
      const scheduled = p.patch.startsAt !== undefined && startsAt > ctx.now();
      const t = createTournament(ctx, input, c.member.id, scheduled ? 'scheduled' : 'draft');
      log('tournament.create', { id: t.id, ...input });
      await c.reply(await tournamentPanel(c.app, c.guild, c.viewer, t, 0,
        scheduled ? `📅 Torneo #${t.id} programado: empieza solo <t:${Math.floor(t.startsAt / 1000)}:R>.` : `📝 Torneo #${t.id} creado como borrador. Iniciálo con \`${c.prefix}torneo start ${t.id}\`.`));
      return true;
    }
    case 'edit':
    case 'editar': {
      const id = idArg(rest[0]);
      const p = parseTournamentArgs(ctx, rest.slice(1));
      if (p.name && !p.patch.name) throw new GameError('Para cambiar el nombre usá `nombre=Nuevo_nombre` (con _ en lugar de espacios).');
      const t = updateTournament(ctx, id, p.patch);
      log('tournament.edit', { id, patch: p.patch });
      await c.reply(await tournamentPanel(c.app, c.guild, c.viewer, t, 0, '✏️ Torneo actualizado.'));
      return true;
    }
    case 'start':
    case 'iniciar': {
      const id = idArg(rest[0]);
      const t = await startAndAnnounce(c.app, id);
      log('tournament.start', { id });
      await c.reply(await tournamentPanel(c.app, c.guild, c.viewer, t, 0, `▶️ Torneo iniciado. Termina <t:${Math.floor(t.endsAt / 1000)}:R>.`));
      return true;
    }
    case 'schedule':
    case 'programar': {
      const id = idArg(rest[0]);
      const t = startTournament(ctx, id, false);
      log('tournament.schedule', { id });
      await c.reply(await tournamentPanel(c.app, c.guild, c.viewer, t, 0, t.status === 'active' ? '▶️ Ya era la hora: torneo iniciado.' : '📅 Torneo programado.'));
      return true;
    }
    case 'stop':
    case 'terminar':
    case 'finish': {
      const id = idArg(rest[0]);
      const r = await closeAndAnnounce(c.app, id);
      if (!r) throw new GameError('Ese torneo no está en curso.');
      log('tournament.stop', { id, winners: r.winners.map((w) => ({ user: w.userId, prize: w.prize })) });
      await c.reply(await tournamentPanel(c.app, c.guild, c.viewer, r.tournament, 0, `🏁 Torneo terminado: ${r.winners.length} premios repartidos.`));
      return true;
    }
    case 'cancel':
    case 'cancelar': {
      const id = idArg(rest[0]);
      const r = cancelTournament(ctx, id);
      log('tournament.cancel', { id, refunded: r.refunded });
      await c.reply(await tournamentPanel(c.app, c.guild, c.viewer, r.tournament, 0, `🚫 Torneo cancelado. Entradas devueltas: ${r.refunded}.`));
      return true;
    }
    default:
      return false;
  }
}

export const tournamentCommand: Command = {
  name: 'torneo',
  aliases: ['tournament', 'torneos', 'tournaments', 't'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('torneo').setDescription('🏟️ Torneos del casino: lista, tabla y unirse.')
    .addIntegerOption((o) => o.setName('id').setDescription('Número de torneo (vacío = lista)').setMinValue(1)),
  async run(c) {
    const ctx = c.app.ctx;
    const owner = isOwner(c.member.id);
    const sub = c.args[0]?.toLowerCase();
    // Las tablas buscan nombres en Discord y los cierres anuncian en varios servidores: puede tardar más de 3 s.
    await c.defer();
    if (sub && owner && (await ownerAction(c, sub, c.args.slice(1)))) return;
    if (sub && ['join', 'unirme', 'unirse', 'entrar'].includes(sub)) {
      const t = joinTournament(ctx, idArg(c.args[1]), c.member.id);
      await c.reply(await tournamentPanel(c.app, c.guild, c.viewer, t, 0, `🎟️ ¡Estás adentro de **${t.name}**!`));
      return;
    }
    const idRaw = c.interaction?.options.getInteger('id') ?? (sub && ['leaderboard', 'tabla', 'ranking', 'ver', 'lb'].includes(sub) ? idArg(c.args[1]) : sub && /^#?\d+$/.test(sub) ? idArg(sub) : null);
    if (idRaw !== null) {
      await c.reply(await tournamentPanel(c.app, c.guild, c.viewer, requireTournament(ctx, idRaw)));
      return;
    }
    if (sub && !['list', 'lista'].includes(sub)) throw new GameError(owner ? 'Subcomandos: list, leaderboard <id>, join <id>, create, edit, start, schedule, stop, cancel.' : 'Uso: `!torneo`, `!torneo <id>` o `!torneo join <id>`.');
    await c.reply(tournamentListPanel(ctx, c.viewer, owner));
  },
};

import { ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { adjustBalance, logAdmin, type AdjustMode } from '../../casino/admin';
import {
  GAME_IDS, getCasinoConfig, readConfigNumber, saveCasinoConfig, setConfigNumber, TOURNAMENT_METRICS, type GameId, type TournamentMetric,
} from '../../casino/config';
import { createDrop, setActivityBoost, setDropMessage, type Drop } from '../../casino/events';
import { FLAG_BLOCKED, FLAG_HIDDEN, setFlag } from '../../casino/users';
import { logger } from '../../logger';
import { GameError } from '../../services/context';
import { row } from '../app';
import type { CommandContext } from '../commands/types';
import { cid } from '../ui/ids';
import { COLORS, coins, num, rel } from '../ui/theme';
import { gameFromName, gameLabel, parseAmount } from './format';
import { adminLogPanel, auditPanel, configPanel } from './ui/admin';

/**
 * Comandos del dueño del bot (`!casino …` y `!balance add|remove|set`). Cada cambio queda en el
 * registro administrativo (`!casino log`) con quién lo hizo, cuándo y qué valores tenía.
 */

const USAGE = '`!casino config` · `enable|disable <juego|all>` · `minbet|maxbet <juego|all> <n>` · `edge <juego> <%>` · `cooldown <juego> <ms>` · '
  + '`set <ruta> <valor>` · `auto daily|weekly on|off|metric <m>|prizes a,b,c|rounds <n>` · `drop <monto> <personas> [minutos]` · `boost <x> <horas>` · '
  + '`hide|unhide|block|unblock @x` · `audit` · `log [@x]`';

function gamesArg(raw: string | undefined): GameId[] {
  if (!raw) throw new GameError('Falta el juego (o `all`).');
  if (['all', 'todos', 'todo'].includes(raw.toLowerCase())) return [...GAME_IDS];
  const g = gameFromName(raw);
  if (!g) throw new GameError(`No conozco el juego "${raw}".`);
  return [g];
}

function amountArg(raw: string | undefined, what: string): number {
  const n = parseAmount(raw);
  if (n === null) throw new GameError(`${what}: escribí un número entero (\`1000\`, \`1.000\`, \`5k\`).`);
  return n;
}

function userIdArg(raw: string | undefined): string {
  const m = raw?.match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
  const id = m?.[1] ?? m?.[2];
  if (!id) throw new GameError('Mencioná a la persona (o poné su ID).');
  return id;
}

async function done(c: CommandContext, text: string): Promise<void> {
  await c.reply({ embeds: [new EmbedBuilder().setColor(COLORS.ok).setDescription(text)] });
}

export function dropPanel(d: Drop, claimers: number): { embeds: EmbedBuilder[]; components: ReturnType<typeof row>[] } {
  const open = d.status === 'open' && d.claims < d.maxClaims;
  const e = new EmbedBuilder()
    .setColor(open ? COLORS.casino : COLORS.push)
    .setTitle(open ? '🌧️ ¡Lluvia de monedas!' : '🌤️ La lluvia de monedas terminó')
    .setDescription([
      `Las primeras **${d.maxClaims}** personas reciben **${coins(d.amountEach)}** cada una.`,
      `Cobraron: **${claimers}/${d.maxClaims}**${open ? ` · termina ${rel(d.expiresAt)}` : ''}`,
      `-# Cuentas de Discord de menos de ${d.minAccountDays} días no pueden cobrar. Una vez por persona.`,
    ].join('\n'));
  return {
    embeds: [e],
    components: [row(new ButtonBuilder().setCustomId(cid('cd', 'claim', '0', d.id)).setLabel(open ? 'Agarrar monedas' : 'Terminada').setEmoji('🪙').setStyle(ButtonStyle.Success).setDisabled(!open))],
  };
}

export async function casinoAdmin(c: CommandContext): Promise<void> {
  const ctx = c.app.ctx;
  const actor = c.member.id;
  const [subRaw, a1, a2, a3] = c.args;
  const sub = subRaw.toLowerCase();
  const log = (action: string, details: unknown, targetId: string | null = null) => {
    logAdmin(ctx, { actorId: actor, action, targetId, details, guildId: c.guild.id });
    logger.info(`[casino admin] ${c.member.user.tag} ${action} ${JSON.stringify(details)}`);
  };

  switch (sub) {
    case 'config':
    case 'ajustes':
      await c.reply(configPanel(ctx, actor));
      return;
    case 'enable':
    case 'disable':
    case 'abrir':
    case 'cerrar': {
      const on = sub === 'enable' || sub === 'abrir';
      const games = gamesArg(a1);
      const cfg = structuredClone(getCasinoConfig(ctx));
      for (const g of games) cfg.games[g].enabled = on;
      saveCasinoConfig(ctx, cfg, actor);
      log(on ? 'game.enable' : 'game.disable', { games });
      await done(c, `${on ? '✅ Abiertos' : '🔒 Cerrados'}: ${games.map(gameLabel).join(', ')}. ${on ? '' : 'Las partidas en curso se pueden terminar.'}`);
      return;
    }
    case 'minbet':
    case 'maxbet': {
      const games = gamesArg(a1);
      const n = amountArg(a2, 'La apuesta');
      const field = sub === 'minbet' ? 'minBet' : 'maxBet';
      const before = games.map((g) => readConfigNumber(getCasinoConfig(ctx), `games.${g}.${field}`));
      for (const g of games) setConfigNumber(ctx, `games.${g}.${field}`, n, actor);
      log(`game.${field}`, { games, value: n, before });
      await done(c, `✅ ${sub === 'minbet' ? 'Apuesta mínima' : 'Apuesta máxima'} de ${games.length === GAME_IDS.length ? 'todos los juegos' : games.map(gameLabel).join(', ')}: ${coins(n)}.`);
      return;
    }
    case 'edge':
    case 'cooldown': {
      const games = gamesArg(a1);
      const raw = (a2 ?? '').replace(',', '.').replace(/%$/, '');
      let value = Number(sub === 'cooldown' && /s$/i.test(raw) ? Number(raw.slice(0, -1)) * 1000 : raw);
      if (!raw || !Number.isFinite(value)) throw new GameError(sub === 'edge' ? 'Escribí la ventaja en % (ej: `2.5`).' : 'Escribí la espera en ms (ej: `1500`) o en segundos (`2s`).');
      if (sub === 'cooldown') value = Math.round(value);
      const field = sub === 'edge' ? 'edgePct' : 'cooldownMs';
      for (const g of games) setConfigNumber(ctx, `games.${g}.${field}`, value, actor);
      log(`game.${field}`, { games, value });
      const fixed = games.filter((g) => ['roulette', 'blackjack'].includes(g));
      await done(c, `✅ ${sub === 'edge' ? `Ventaja de la casa: ${value} %` : `Espera entre rondas: ${num(value)} ms`} en ${games.map(gameLabel).join(', ')}.` +
        (sub === 'edge' && fixed.length ? `\n-# ${fixed.map(gameLabel).join(' y ')} ${fixed.length > 1 ? 'tienen' : 'tiene'} la ventaja en sus reglas: este valor no cambia sus pagos.` : '') +
        (sub === 'edge' ? '\n-# Las partidas ya empezadas mantienen el RTP con el que empezaron.' : ''));
      return;
    }
    case 'set': {
      if (!a1 || a2 === undefined) throw new GameError('Uso: `!casino set <ruta> <valor>` (ej: `!casino set daily.amount 1500`). Las rutas están en `!casino config`.');
      const value = Number(a2.replace(',', '.'));
      const before = readConfigNumber(getCasinoConfig(ctx), a1);
      setConfigNumber(ctx, a1, value, actor);
      log('config.set', { path: a1, value, before });
      await done(c, `✅ \`${a1}\`: ${before ?? '—'} → **${value}**`);
      return;
    }
    case 'auto': {
      const kind = a1?.toLowerCase();
      if (kind !== 'daily' && kind !== 'weekly') throw new GameError('Uso: `!casino auto daily|weekly on|off|metric <métrica>|prizes 15000,9000,6000|rounds <n>`.');
      const cfg = structuredClone(getCasinoConfig(ctx));
      const t = cfg.tournaments[kind];
      const what = a2?.toLowerCase();
      if (what === 'on' || what === 'off') t.enabled = what === 'on';
      else if (what === 'metric' || what === 'metrica') {
        if (!TOURNAMENT_METRICS.includes(a3 as TournamentMetric)) throw new GameError(`Métricas: ${TOURNAMENT_METRICS.join(', ')}.`);
        t.metric = a3 as TournamentMetric;
      } else if (what === 'prizes' || what === 'premios') {
        const prizes = (a3 ?? '').split(',').map((x) => parseAmount(x));
        if (!prizes.length || prizes.length > 10 || prizes.some((p) => p === null || p <= 0)) throw new GameError('Premios: de 1 a 10 montos separados por coma (ej: `15000,9000,6000`).');
        t.prizes = prizes as number[];
      } else if (what === 'rounds' || what === 'rondas') {
        t.minRounds = amountArg(a3, 'Las rondas');
      } else throw new GameError('Opciones: `on`, `off`, `metric`, `prizes`, `rounds`.');
      saveCasinoConfig(ctx, cfg, actor);
      log(`auto.${what}`, { kind, value: a3 ?? what });
      await done(c, `✅ Torneo automático ${kind === 'daily' ? 'diario' : 'semanal'} actualizado. Se aplica desde el próximo período.`);
      return;
    }
    case 'drop':
    case 'lluvia': {
      const amount = amountArg(a1, 'El monto');
      const people = amountArg(a2, 'La cantidad de personas');
      const minutes = a3 ? amountArg(a3, 'Los minutos') : 10;
      const ch = c.interaction?.channel ?? c.message?.channel;
      if (!ch || !ch.isSendable()) throw new GameError('Usalo en un canal de texto.');
      const me = c.guild.members.me;
      if (!me || !('permissionsFor' in ch) || !ch.permissionsFor(me).has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) throw new GameError('No puedo enviar embeds en este canal.');
      const d = createDrop(ctx, { guildId: c.guild.id, channelId: ch.id, amountEach: amount, maxClaims: people, minutes, createdBy: actor });
      const msg = await ch.send({ ...dropPanel(d, 0), allowedMentions: { parse: [] } });
      setDropMessage(ctx, d.id, msg.id);
      log('drop.create', { drop: d.id, amount, people, minutes, channel: ch.id });
      return;
    }
    case 'boost': {
      const x = Number((a1 ?? '').replace(/x$/i, '').replace(',', '.'));
      const hours = Number((a2 ?? '').replace(/h$/i, '').replace(',', '.'));
      const b = setActivityBoost(ctx, x, hours, actor);
      log('boost', b);
      await done(c, `⚡ Coins por actividad ×${b.multiplier} hasta ${rel(b.until)}.`);
      return;
    }
    case 'hide':
    case 'unhide':
    case 'block':
    case 'unblock': {
      const id = userIdArg(a1);
      const flag = sub.endsWith('hide') ? FLAG_HIDDEN : FLAG_BLOCKED;
      const on = !sub.startsWith('un');
      setFlag(ctx, id, flag, on);
      log(`user.${sub}`, { reason: c.args.slice(2).join(' ') || null }, id);
      await done(c, `✅ <@${id}> ${flag === FLAG_HIDDEN ? (on ? 'ya no aparece en los rankings' : 'vuelve a aparecer en los rankings') : on ? 'quedó suspendido del casino (no puede apostar ni cobrar bonos)' : 'puede volver a jugar'}.`);
      return;
    }
    case 'audit':
    case 'auditoria':
      await c.reply(auditPanel(ctx));
      return;
    case 'log':
    case 'registro':
      await c.reply(adminLogPanel(ctx, a1 ? userIdArg(a1) : undefined));
      return;
    default:
      throw new GameError(`Subcomandos del dueño: ${USAGE}`);
  }
}

const MODE: Record<string, AdjustMode> = { add: 'add', sumar: 'add', remove: 'remove', quitar: 'remove', set: 'set', fijar: 'set' };

export async function balanceAdmin(c: CommandContext): Promise<void> {
  const [subRaw, who, amountRaw, ...reason] = c.args;
  const mode = MODE[subRaw.toLowerCase()];
  const targetId = userIdArg(who);
  const amount = amountArg(amountRaw, 'La cantidad');
  const r = adjustBalance(c.app.ctx, { actorId: c.member.id, targetId, mode, amount, reason: reason.join(' '), guildId: c.guild.id });
  logger.info(`[casino admin] ${c.member.user.tag} balance.${mode} ${targetId} ${amount} (${r.before} → ${r.after})`);
  await done(c, `🛠️ Saldo de <@${targetId}>: ${coins(r.before)} → **${coins(r.after)}**${reason.length ? `\n-# Motivo: ${reason.join(' ').slice(0, 200)}` : ''}`);
}


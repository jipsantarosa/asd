import { EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { adminLog } from '../../../casino/admin';
import { GAME_IDS, getCasinoConfig } from '../../../casino/config';
import { ledgerAudit } from '../../../casino/economy';
import { jackpotAmount } from '../../../casino/jackpot';
import { METRIC_META } from '../../../casino/tournaments';
import type { GameContext } from '../../../services/context';
import { row, type Panel } from '../../app';
import { cid } from '../../ui/ids';
import { COLORS, coins, num, rel } from '../../ui/theme';
import { gameMeta } from '../format';

const pctTxt = (n: number) => `${n.toLocaleString('es-AR', { maximumFractionDigits: 2 })} %`;

/** !casino config: toda la configuración global de un vistazo, con un menú para editar cada juego. */
export function configPanel(ctx: GameContext, owner: string, notice?: string): Panel {
  const c = getCasinoConfig(ctx);
  const games = GAME_IDS.map((id) => {
    const g = c.games[id];
    const m = gameMeta(id);
    return `${m.emoji} **${m.name}** ${g.enabled ? '✅' : '🔒'} · ${num(g.minBet)}–${num(g.maxBet)} · ventaja ${m.fixedEdge ? m.fixedEdge : pctTxt(g.edgePct)} · espera ${num(g.cooldownMs)} ms`;
  });
  const auto = (k: 'daily' | 'weekly') => {
    const a = c.tournaments[k];
    return `${k === 'daily' ? '🌅 Diario' : '🗓️ Semanal'}: ${a.enabled ? '✅' : '⏸️'} · ${METRIC_META[a.metric].label} · premios ${a.prizes.map(num).join(' / ')} · mínimo ${a.minRounds} rondas`;
  };
  const e = new EmbedBuilder()
    .setColor(COLORS.settings)
    .setTitle('🛠️ Configuración del casino (global)')
    .setDescription([
      ...(notice ? [notice, ''] : []),
      '**Juegos**',
      ...games,
      '',
      '**Economía**',
      `Saldo inicial ${coins(c.startingBalance)} · premio máximo por ronda ${coins(c.maxPayout)}`,
      `Diario ${coins(c.daily.amount)} (+${c.daily.streakPct} %/día, hasta ${c.daily.streakMaxDays} días) · semanal ${coins(c.weekly.amount)}`,
      `Rescate ${coins(c.rescue.amount)} con menos de ${coins(c.rescue.below)} cada ${c.rescue.cooldownHours} h · nivel: ${num(c.levels.rewardPerLevel)} × nivel`,
      `Actividad ${c.activity.enabled ? '✅' : '⏸️'}: ${c.activity.min}–${c.activity.max} por mensaje, cada ${c.activity.cooldownSeconds} s, tope ${num(c.activity.dailyCap)}/día, mitad desde ${c.activity.decayAfter} mensajes`,
      `Jackpot ${coins(jackpotAmount(ctx))} (inicial ${coins(c.jackpot.seed)}, ${pctTxt(c.jackpot.contributionPct)} de cada apuesta, entero desde ${coins(c.jackpot.fullBet)})`,
      `Anuncios desde ${num(c.bigWin.multiplier)}x o ${coins(c.bigWin.amount)} · abandono ${c.abandonMinutes} min · huso ${c.timezoneOffsetMinutes} min`,
      c.boost.until > ctx.now() ? `⚡ Boost de actividad ×${c.boost.activity} hasta ${rel(c.boost.until)}` : '⚡ Sin boost activo',
      '',
      '**Torneos automáticos**',
      auto('daily'),
      auto('weekly'),
      '',
      '-# `!casino enable|disable <juego|all>` · `minbet|maxbet <juego|all> <n>` · `edge <juego> <%>` · `cooldown <juego> <ms>` · `set <ruta> <valor>` · `auto daily|weekly on|off|metric|prizes|rounds` · `drop` · `boost` · `hide|block @x` · `audit` · `log`',
    ].join('\n'));
  return {
    embeds: [e],
    components: [row(new StringSelectMenuBuilder().setCustomId(cid('ca', 'game', owner)).setPlaceholder('Editar un juego…')
      .addOptions(GAME_IDS.map((id) => new StringSelectMenuOptionBuilder().setValue(id).setLabel(gameMeta(id).name).setEmoji(gameMeta(id).emoji))))],
  };
}

/** !casino audit: la cuenta de la economía (suma de saldos = suma de transacciones) y números generales. */
export function auditPanel(ctx: GameContext): Panel {
  const a = ledgerAudit(ctx);
  const stats = ctx.db.get<{ rounds: number; wagered: number | null; payout: number | null }>(
    "SELECT COUNT(*) AS rounds, SUM(total_bet) AS wagered, SUM(payout) AS payout FROM casino_rounds WHERE status <> 'active'",
  )!;
  const open = ctx.db.get<{ n: number; s: number | null }>("SELECT COUNT(*) AS n, SUM(total_bet) AS s FROM casino_rounds WHERE status = 'active'")!;
  const byType = ctx.db.all<{ type: string; s: number }>('SELECT type, SUM(amount) AS s FROM casino_transactions GROUP BY type ORDER BY type');
  const wagered = stats.wagered ?? 0;
  const payout = stats.payout ?? 0;
  const e = new EmbedBuilder()
    .setColor(a.ok ? COLORS.ok : COLORS.error)
    .setTitle(a.ok ? '✅ Auditoría: la economía cuadra' : '❌ Auditoría: DESCUADRE')
    .setDescription([
      `Saldos: ${coins(a.wallets)} · transacciones: ${coins(a.ledger)} · cuentas: ${num(a.users)}`,
      `Rondas: ${num(stats.rounds)} · apostado ${coins(wagered)} · pagado ${coins(payout)} · retorno real ${wagered ? pctTxt((payout / wagered) * 100) : '—'}`,
      `Partidas abiertas: ${num(open.n)} (${coins(open.s ?? 0)} en juego)`,
      '',
      '**Por tipo de movimiento:**',
      ...byType.map((t) => `\`${t.type}\` ${t.s >= 0 ? '+' : ''}${num(t.s)}`),
    ].join('\n'));
  return { embeds: [e], components: [] };
}

export function adminLogPanel(ctx: GameContext, targetId?: string): Panel {
  const rows = adminLog(ctx, 15, targetId);
  const e = new EmbedBuilder().setColor(COLORS.log).setTitle('📋 Registro administrativo del casino')
    .setDescription(rows.length
      ? rows.map((r) => `\`${r.action}\` por <@${r.actorId}>${r.targetId ? ` → <@${r.targetId}>` : ''} · ${rel(r.createdAt)}${r.details ? `\n-# ${r.details.slice(0, 180)}` : ''}`).join('\n')
      : '*Sin acciones registradas.*');
  return { embeds: [e], components: [] };
}

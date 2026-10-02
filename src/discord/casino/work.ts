import { EmbedBuilder, InteractionContextType, SlashCommandBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { getCasinoConfig } from '../../casino/config';
import { doWork, expectedPay, jobOf, JOBS, workStatus, type WorkResult } from '../../casino/work';
import { GameError, type GameContext } from '../../services/context';
import { row, viewerOf, type Panel, type Viewer } from '../app';
import type { Command } from '../commands/types';
import type { Handler } from '../handlers/util';
import { update, values } from '../handlers/util';
import { cid } from '../ui/ids';
import { COLORS, coins, rel } from '../ui/theme';

const KIND_COLOR = { ok: COLORS.ok, great: COLORS.casino, bad: COLORS.warn, fine: COLORS.error } as const;

/** Lista de trabajos: sueldo aproximado, requisito y si ya se puede trabajar. */
export function workPanel(ctx: GameContext, v: Viewer, result?: WorkResult): Panel {
  const cfg = getCasinoConfig(ctx);
  const st = result?.status ?? workStatus(ctx, v.userId);
  const lines = JOBS.map((j) => {
    const locked = st.shifts < j.requires;
    return `${locked ? '🔒' : j.emoji} **${j.name}** · ~${coins(Math.round(expectedPay(j, cfg.work.payPct)))} por turno${locked ? ` · requiere ${j.requires} turnos` : ''}\n-# ${j.description}`;
  });
  const e = new EmbedBuilder()
    .setColor(result ? KIND_COLOR[result.kind] : COLORS.casino)
    .setAuthor({ name: `Trabajos de ${v.name}`, iconURL: v.avatar })
    .setDescription([
      ...(result ? [
        `${result.job.emoji} **${result.job.name}:** ${result.text}`,
        result.amount > 0 ? `💵 Cobraste **${coins(result.amount)}**.` : result.amount < 0 ? `🚨 Pagaste una multa de **${coins(-result.amount)}**.` : '💸 No ganaste nada esta vez.',
        `💼 Saldo: **${coins(result.balance)}**`,
        ...result.unlocked.map((j) => `🔓 ¡Desbloqueaste **${j.emoji} ${j.name}**!`),
        '',
      ] : []),
      ...lines,
      '',
      `🧰 Experiencia: **${st.shifts}** turnos · hoy ${st.todayShifts}/${st.maxPerDay}`,
      st.readyAt ? `⏳ Podés volver a trabajar ${rel(st.readyAt)}.` : '✅ Podés trabajar ahora.',
      `-# Un turno cada ${cfg.work.cooldownMinutes} min (para todos los trabajos) y como máximo ${st.maxPerDay} por día.`,
    ].join('\n'));
  const menu = new StringSelectMenuBuilder().setCustomId(cid('cw', 'job', v.userId)).setPlaceholder(st.readyAt ? 'Todavía estás cansado…' : 'Elegí un trabajo…')
    .setDisabled(!!st.readyAt)
    .addOptions(JOBS.map((j) => new StringSelectMenuOptionBuilder().setValue(j.id).setLabel(j.name).setEmoji(st.shifts < j.requires ? '🔒' : j.emoji)
      .setDescription(st.shifts < j.requires ? `Requiere ${j.requires} turnos` : `~${Math.round(expectedPay(j, cfg.work.payPct))} Coins por turno`)));
  return { embeds: [e], components: [row(menu)] };
}

export const workCommand: Command = {
  name: 'work',
  aliases: ['trabajar', 'trabajo', 'laburo', 'laburar', 'chamba'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('work').setDescription('🧰 Trabajá para ganar unas pocas Coins.')
    .addStringOption((o) => o.setName('trabajo').setDescription('Trabajo (vacío = ver la lista)')
      .addChoices(...JOBS.map((j) => ({ name: `${j.name}${j.requires ? ` (${j.requires} turnos)` : ''}`, value: j.id })))),
  async run(c) {
    const raw = c.interaction ? c.interaction.options.getString('trabajo') : c.args.join(' ') || null;
    if (!raw) {
      await c.reply(workPanel(c.app.ctx, c.viewer));
      return;
    }
    const job = jobOf(raw);
    if (!job) throw new GameError(`No conozco ese trabajo. Opciones: ${JOBS.map((j) => j.name).join(', ')}.`);
    const r = doWork(c.app.ctx, c.member.id, c.guild.id, job.id, c.member.user.createdTimestamp);
    await c.reply(workPanel(c.app.ctx, c.viewer, r));
  },
};

export const workHandler: Handler = async (app, i, id) => {
  if (id.act !== 'job') throw new GameError('Acción desconocida.');
  const job = jobOf(values(i)[0]);
  if (!job) throw new GameError('Ese trabajo no existe.');
  const r = doWork(app.ctx, i.user.id, i.guildId, job.id, i.user.createdTimestamp);
  await update(i, workPanel(app.ctx, viewerOf(i.member), r));
};

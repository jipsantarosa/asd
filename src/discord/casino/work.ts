import { EmbedBuilder, InteractionContextType, SlashCommandBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { doWork, jobOf, JOBS, RISK_EMOJI, workStatus, type Job, type WorkResult } from '../../casino/work';
import { GameError, type GameContext } from '../../services/context';
import { getSettings } from '../../services/guildSettings';
import { row, viewerOf, type Panel, type Viewer } from '../app';
import type { Command } from '../commands/types';
import type { Handler } from '../handlers/util';
import { update, values } from '../handlers/util';
import { cid } from '../ui/ids';
import { COLORS, coins, rel } from '../ui/theme';

const num = (n: number) => n.toLocaleString('es-AR');

function jobLine(j: Job, readyAt: number): string {
  const pay = `${num(j.min)}–${num(j.max)}`;
  return `${j.emoji} **${j.name}** — ${RISK_EMOJI[j.risk]} ${j.risk} · ${j.chance}% · ${pay} 🪙${j.bail ? ` · fianza ${num(j.bail)}` : ''}\n${readyAt ? `⏰ ${rel(readyAt)}` : '✅ listo'}`;
}

/** Lista de trabajos (con el resultado del último turno arriba, si hay). */
export function workPanel(ctx: GameContext, v: Viewer, prefix: string, result?: WorkResult): Panel {
  const st = result?.status ?? workStatus(ctx, v.userId);
  const head: string[] = [];
  if (result) {
    const j = result.job;
    if (result.success) {
      head.push(`✅ ${j.emoji} **${j.name}:** ${result.text}`, `💵 Cobraste **${coins(result.amount)}**${st.streakBonusPct ? ` (incluye +${st.streakBonusPct}% de racha)` : ''}${result.capped ? ' · llegaste al cupo de hoy' : ''}.`);
    } else {
      head.push(`❌ ${j.emoji} **${j.name}:** ${result.text}`, result.amount < 0 ? `💸 Perdiste la fianza de **${coins(-result.amount)}**.` : '💸 Esta vez no cobraste nada.');
    }
    head.push(`💼 Saldo: **${coins(result.balance)}**`, '');
  }
  const e = new EmbedBuilder()
    .setColor(result ? (result.success ? COLORS.win : COLORS.loss) : COLORS.casino)
    .setAuthor({ name: v.name, iconURL: v.avatar })
    .setTitle('💼 Trabajos')
    .setDescription([...head, ...JOBS.map((j) => jobLine(j, st.jobs[j.id]))].join('\n\n').replace(/\n\n\n/g, '\n\n'))
    .setFooter({ text: `Racha: ${st.streak} ${st.streak === 1 ? 'día' : 'días'}${st.streakBonusPct ? ` (+${st.streakBonusPct}%)` : ''} · Cupo restante hoy: ${num(st.remaining)} · ${prefix}work <nombre>` });
  const menu = new StringSelectMenuBuilder().setCustomId(cid('cw', 'job', v.userId))
    .setPlaceholder(st.remaining <= 0 ? 'Llegaste al cupo de hoy' : st.readyCount ? 'Elegí un trabajo…' : 'Todos tus trabajos están descansando…')
    .setDisabled(st.remaining <= 0 || !st.readyCount)
    .addOptions(JOBS.map((j) => new StringSelectMenuOptionBuilder().setValue(j.id).setLabel(j.name).setEmoji(st.jobs[j.id] ? '⏰' : j.emoji)
      .setDescription(`${j.risk} · ${j.chance}% · ${num(j.min)}–${num(j.max)}${j.bail ? ` · fianza ${num(j.bail)}` : ''}${st.jobs[j.id] ? ' · descansando' : ''}`)));
  return { embeds: [e], components: [row(menu)] };
}

export const workCommand: Command = {
  name: 'work',
  aliases: ['trabajar', 'trabajo', 'trabajos', 'laburo', 'laburar', 'chamba'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('work').setDescription('💼 Trabajá: cada trabajo tiene su riesgo, su sueldo y su espera de 1 hora.')
    .addStringOption((o) => o.setName('trabajo').setDescription('Trabajo (vacío = ver la lista)')
      .addChoices(...JOBS.map((j) => ({ name: `${j.name} (${j.chance}% · ${j.min}-${j.max}${j.bail ? ` · fianza ${j.bail}` : ''})`, value: j.id })))),
  async run(c) {
    const raw = c.interaction ? c.interaction.options.getString('trabajo') : c.args.join(' ') || null;
    if (!raw) {
      await c.reply(workPanel(c.app.ctx, c.viewer, c.prefix));
      return;
    }
    const job = jobOf(raw);
    if (!job) throw new GameError(`No conozco ese trabajo. Opciones: ${JOBS.map((j) => j.name).join(', ')}.`);
    const r = doWork(c.app.ctx, c.member.id, c.guild.id, job.id, c.member.user.createdTimestamp);
    await c.reply(workPanel(c.app.ctx, c.viewer, c.prefix, r));
  },
};

export const workHandler: Handler = async (app, i, id) => {
  if (id.act !== 'job') throw new GameError('Acción desconocida.');
  const job = jobOf(values(i)[0]);
  if (!job) throw new GameError('Ese trabajo no existe.');
  const r = doWork(app.ctx, i.user.id, i.guildId, job.id, i.user.createdTimestamp);
  await update(i, workPanel(app.ctx, viewerOf(i.member), getSettings(app.ctx, i.guildId).prefix, r));
};

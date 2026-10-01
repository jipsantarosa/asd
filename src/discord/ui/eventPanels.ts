import { ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, type Guild } from 'discord.js';
import type { EventRewardDef, GameConfig } from '../../game/types';
import type { GameContext } from '../../services/context';
import { getEventConfig, recentEvents, type EventResult, type EventRow } from '../../services/events';
import { gameConfig } from '../../services/guildSettings';
import { row, type Panel } from '../app';
import { cid } from './ids';
import { COLORS, rel } from './theme';

export function rewardText(cfg: GameConfig, r: EventRewardDef): string {
  switch (r.kind) {
    case 'coins': return `${r.emoji} **${r.label}**: ${r.min.toLocaleString('es-AR')}–${r.max.toLocaleString('es-AR')} ${cfg.currency.name} (más si tenés más nivel)`;
    case 'bait': return `${r.emoji} **${r.label}**: ${r.min}–${r.max} de carnada`;
    case 'item': return `${r.emoji} **${r.label}** ×${r.min === r.max ? r.min : `${r.min}–${r.max}`}`;
    case 'xp': return `${r.emoji} **${r.label}**: ${Math.round(r.min * 100)}–${Math.round(r.max * 100)}% de tu nivel de pesca`;
    case 'buff': {
      const b = cfg.buffs.find((x) => x.id === r.buffId);
      return `${r.emoji} **${r.label}**${b ? `: ${b.description} (${b.minutes} min)` : ''}`;
    }
    default: return r.label;
  }
}

/** Mensaje público de un sorteo abierto. */
export function openEventMessage(cfg: GameConfig, e: EventRow, reward: EventRewardDef): Panel {
  const t = cfg.tuning.events;
  const reqs = [
    t.minTotalLevel ? `nivel total ${t.minTotalLevel}` : '',
    t.minAccountDays ? `cuenta de ${t.minAccountDays}+ días` : '',
    t.minMemberHours ? `${t.minMemberHours}+ h en el servidor` : '',
  ].filter(Boolean).join(' · ');
  const embed = new EmbedBuilder()
    .setColor(COLORS.golden)
    .setTitle('🎁 ¡Sorteo en El Valle!')
    .setDescription(`Se sortea:\n${rewardText(cfg, reward)}\n\n🏆 **${e.winners}** ${e.winners === 1 ? 'ganador' : 'ganadores'} · cierra ${rel(e.ends_at)}\nTocá **Participar** para entrar. Una vez por persona.`)
    .setFooter({ text: `Requisitos: ${reqs || 'ninguno'} · máx. ${t.dailyWinCap} premios por persona por día` });
  return {
    embeds: [embed],
    components: [row(new ButtonBuilder().setCustomId(cid('ev', 'join', '0', e.id)).setLabel('Participar').setEmoji('🎁').setStyle(ButtonStyle.Success))],
  };
}

export function closedEventMessage(cfg: GameConfig, res: EventResult): Panel {
  const lines = res.winners.length
    ? res.winners.map((w) => `🏆 <@${w.userId}> — ${w.text}`).join('\n')
    : '*Nadie cumplía los requisitos o no hubo participantes.*';
  const embed = new EmbedBuilder()
    .setColor(res.winners.length ? COLORS.ok : COLORS.log)
    .setTitle('🎁 Sorteo terminado')
    .setDescription(`Premio: ${rewardText(cfg, res.reward)}\n👥 ${res.participants} participantes\n\n${lines}`)
    .setTimestamp();
  return {
    embeds: [embed],
    components: [row(new ButtonBuilder().setCustomId(cid('ev', 'join', '0', res.event.id)).setLabel('Terminado').setEmoji('🔒').setStyle(ButtonStyle.Secondary).setDisabled(true))],
  };
}

export function mareaMessage(cfg: GameConfig, e: EventRow): Panel {
  const b = cfg.buffs.find((x) => x.id === cfg.events.guildBoostBuffId);
  const embed = new EmbedBuilder()
    .setColor(0xf5a623)
    .setTitle(`${b?.emoji ?? '🌅'} ¡${b?.name ?? 'Marea dorada'}!`)
    .setDescription(`${b?.description ?? ''}\nActiva para **todo el servidor** hasta ${rel(e.ends_at)}. ¡Es el momento de usar \`/pesca\`!`);
  return { embeds: [embed], components: [] };
}

export function eventsAdminPanel(ctx: GameContext, guild: Guild, owner: string, notice?: string): Panel {
  const cfg = gameConfig(ctx, guild.id);
  const conf = getEventConfig(ctx, guild.id);
  const t = cfg.tuning.events;
  const recent = recentEvents(ctx, guild.id, 5).map((e) => {
    const r = JSON.parse(e.reward_json) as EventRewardDef;
    return `${e.kind === 'marea' ? '🌅' : e.state === 'open' ? '🟢' : '🎁'} ${r.label} · ${rel(e.created_at)}`;
  });
  const embed = new EmbedBuilder()
    .setColor(COLORS.settings)
    .setTitle('🎉 Eventos automáticos')
    .setDescription([
      notice ? `${notice}\n` : '',
      `**Estado:** ${conf.enabled ? '🟢 activados' : '🔴 desactivados'}`,
      `**Canal:** ${conf.channel_id ? `<#${conf.channel_id}>` : 'sin elegir'}`,
      `**Próximo evento:** ${conf.enabled && conf.next_at ? rel(conf.next_at) : '—'}`,
      `**Intervalo:** entre ${t.minMinutes} y ${t.maxMinutes} min (al azar) · sorteos de ${Math.round(t.joinSeconds / 60)} min con hasta ${t.maxWinners} ganadores`,
      `**Marea dorada:** ${Math.round(t.boostChance * 100)}% de los eventos, ${t.boostMinutes} min para todo el servidor`,
      `**Anti cuentas alternativas:** cuenta ${t.minAccountDays}+ días · ${t.minMemberHours}+ h en el servidor · nivel total ${t.minTotalLevel}+ · máx. ${t.dailyWinCap} premios/día`,
      '',
      recent.length ? `**Últimos eventos:**\n${recent.join('\n')}` : '*Todavía no hubo eventos.*',
    ].filter((x) => x !== '').join('\n'))
    .setFooter({ text: 'Los intervalos, premios y requisitos se ajustan en /ajustes → Eventos.' });
  return {
    embeds: [embed],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId(cid('ev', 'chan', owner)).setPlaceholder('Canal de los eventos…')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
      row(
        new ButtonBuilder().setCustomId(cid('ev', 'toggle', owner)).setLabel(conf.enabled ? 'Desactivar' : 'Activar')
          .setEmoji(conf.enabled ? '⏸️' : '▶️').setStyle(conf.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId(cid('ev', 'launch', owner)).setLabel('Lanzar uno ahora').setEmoji('🎁').setStyle(ButtonStyle.Primary)
          .setDisabled(!conf.channel_id),
        new ButtonBuilder().setCustomId(cid('ev', 'view', owner)).setEmoji('🔄').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

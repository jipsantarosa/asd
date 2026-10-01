import { ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { TUNABLES, getTuningValue, type TunableDef } from '../../game/config';
import type { GameContext } from '../../services/context';
import { gameConfig, getSettings } from '../../services/guildSettings';
import { getLogConfig } from '../../services/logConfig';
import { row, type Panel } from '../app';
import { cid } from './ids';
import { COLORS } from './theme';

export const TUNABLE_SECTIONS = [...new Set(TUNABLES.map((t) => t.section))] as TunableDef['section'][];

export function settingsPanel(ctx: GameContext, guildId: string, owner: string, section: TunableDef['section'] = 'Vigor', notice?: string, confirmReset = false): Panel {
  const settings = getSettings(ctx, guildId);
  const cfg = gameConfig(ctx, guildId);
  const logs = getLogConfig(ctx, guildId);
  const defs = TUNABLES.filter((t) => t.section === section);
  const lines = defs.map((t) => {
    const value = getTuningValue(cfg.tuning, t.key);
    const custom = t.key in settings.tunables;
    return `${custom ? '✏️' : '▫️'} **${t.label}**: \`${value}\` *(rango ${t.min}–${t.max})*\n  ${t.hint}`;
  });
  const embed = new EmbedBuilder()
    .setColor(COLORS.settings)
    .setTitle('⚙️ Ajustes del servidor')
    .setDescription(`${notice ? `${notice}\n\n` : ''}**Prefijo:** \`${settings.prefix}\` · **Registrar mensajes enviados:** ${logs.logSentMessages ? 'sí' : 'no'}\n\n__**${section}**__\n${lines.join('\n')}`)
    .setFooter({ text: '✏️ = valor personalizado · ▫️ = valor por defecto. Los cambios se aplican al instante.' });

  const rows = [
    row(new StringSelectMenuBuilder().setCustomId(cid('st', 'sec', owner)).setPlaceholder('Sección…')
      .addOptions(TUNABLE_SECTIONS.map((s) => new StringSelectMenuOptionBuilder().setValue(s).setLabel(s).setDefault(s === section)))),
    row(new StringSelectMenuBuilder().setCustomId(cid('st', 'edit', owner)).setPlaceholder('Cambiar un valor…')
      .addOptions(defs.map((t) => new StringSelectMenuOptionBuilder().setValue(t.key).setLabel(t.label).setDescription(`Actual: ${getTuningValue(cfg.tuning, t.key)}`)))),
  ];
  if (confirmReset) {
    rows.push(row(
      new ButtonBuilder().setCustomId(cid('st', 'resetok', owner)).setLabel('Sí, volver todo a los valores por defecto').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(cid('st', 'sec', owner, section)).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
    ));
  } else {
    rows.push(row(
      new ButtonBuilder().setCustomId(cid('st', 'prefix', owner)).setLabel('Cambiar prefijo').setEmoji('⌨️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(cid('st', 'logmsg', owner, section)).setLabel(logs.logSentMessages ? 'No registrar mensajes enviados' : 'Registrar mensajes enviados')
        .setEmoji('📝').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(cid('st', 'reset', owner, section)).setLabel('Restablecer todo').setEmoji('♻️').setStyle(ButtonStyle.Danger),
    ));
  }
  return { embeds: [embed], components: rows };
}

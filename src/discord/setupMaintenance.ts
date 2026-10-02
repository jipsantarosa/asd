import { ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, type Guild } from 'discord.js';
import { logger } from '../logger';
import { GameError } from '../services/context';
import { getLogConfig } from '../services/logConfig';
import { LAYOUT_VERSIONS, outdatedGuilds, type SetupSystem } from '../services/setupVersions';
import { row, type App, type Panel, type Row } from './app';
import type { Handler } from './handlers/util';
import { deferPanel, update } from './handlers/util';
import { deleteLogDuplicates, duplicateLogChannels, reinstallLogs, runSetup } from './logging/setup';
import { logSystem } from './logging/sender';
import { cid } from './ui/ids';
import { COLORS } from './ui/theme';
import { deleteVoiceDuplicates, duplicateVoiceChannels, reinstallTempVoice, setupTempVoice } from './voice/tempVoice';

/**
 * Mantenimiento de los canales que crea el bot (registros y voz temporal):
 * - botones para borrar sobrantes de instalaciones anteriores y para reinstalar desde cero (con confirmación);
 * - sincronización automática al arrancar una versión nueva (sin borrar nada).
 */

const LABEL: Record<SetupSystem, string> = { logs: 'registros', voice: 'canales de voz temporales' };

/** Fila de mantenimiento debajo del resultado de /setup o /voz. */
export function maintenanceRow(owner: string, system: SetupSystem, duplicates: number): Row {
  return row(
    new ButtonBuilder().setCustomId(cid('sy', 'dups', owner, system)).setLabel(duplicates ? `Borrar sobrantes (${duplicates})` : 'Sin sobrantes')
      .setEmoji('🧹').setStyle(duplicates ? ButtonStyle.Danger : ButtonStyle.Secondary).setDisabled(!duplicates),
    new ButtonBuilder().setCustomId(cid('sy', 'reset', owner, system)).setLabel('Reinstalar desde cero').setEmoji('♻️').setStyle(ButtonStyle.Secondary),
  );
}

function requirePerm(system: SetupSystem, perms: Readonly<{ has(p: bigint): boolean }>): void {
  if (system === 'logs' && !perms.has(PermissionFlagsBits.Administrator)) throw new GameError('Necesitás **Administrador**.');
  if (system === 'voice' && !perms.has(PermissionFlagsBits.ManageGuild)) throw new GameError('Necesitás **Gestionar servidor**.');
}

const panel = (color: number, title: string, text: string, rows: Row[] = []): Panel => ({
  embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(text.slice(0, 4000))], components: rows,
});

function sobrantes(app: App, guild: Guild, system: SetupSystem) {
  return system === 'logs' ? duplicateLogChannels(app.ctx, guild) : duplicateVoiceChannels(app, guild);
}

export const maintenanceHandler: Handler = async (app, i, id) => {
  const system = id.args[0] as SetupSystem;
  if (system !== 'logs' && system !== 'voice') throw new GameError('Opción inválida.');
  requirePerm(system, i.member.permissions);
  const guild = i.guild;
  const owner = i.user.id;
  const tag = i.user.username;
  const lock = <T>(fn: () => Promise<T>) => app.guildLock.run(`${system === 'logs' ? 'setup' : 'voice-setup'}:${guild.id}`, fn);
  switch (id.act) {
    case 'dups': {
      await guild.channels.fetch();
      const list = sobrantes(app, guild, system);
      if (!list.length) return update(i, panel(COLORS.ok, '🧹 Nada para borrar', 'No hay canales sobrantes.'));
      return update(i, panel(COLORS.warn, `🧹 ¿Borrar ${list.length} ${list.length === 1 ? 'canal sobrante' : 'canales sobrantes'}?`,
        `Son de instalaciones anteriores de los ${LABEL[system]} y el bot no los usa:\n${list.slice(0, 40).map((c) => `• <#${c.id}> (\`${c.name}\`)`).join('\n')}\n\n` +
        'Los canales en uso no se tocan, y un canal de voz con gente tampoco.',
        [row(
          new ButtonBuilder().setCustomId(cid('sy', 'dupsok', owner, system)).setLabel('Sí, borrarlos').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(cid('sy', 'cancel', owner, system)).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
        )]));
    }
    case 'dupsok': {
      await deferPanel(i);
      const res = await lock(() => (system === 'logs' ? deleteLogDuplicates(app.ctx, guild, tag) : deleteVoiceDuplicates(app, guild, tag)));
      if (!res.ran) throw new GameError('Hay una configuración en curso. Esperá a que termine.');
      await logSystem(app.ctx, guild, `🧹 <@${owner}> borró ${res.value} ${res.value === 1 ? 'canal sobrante' : 'canales sobrantes'} de los ${LABEL[system]}.`);
      return update(i, panel(COLORS.ok, '🧹 Listo', `Borré **${res.value}** ${res.value === 1 ? 'canal sobrante' : 'canales sobrantes'}.`));
    }
    case 'reset':
      return update(i, panel(COLORS.warn, `♻️ ¿Reinstalar los ${LABEL[system]} desde cero?`,
        system === 'logs'
          ? 'Se **borran** los canales de registro del bot (y los sobrantes) y se vuelven a crear. **Se pierde el historial** de esos canales.\n\nNormalmente no hace falta: `/setup` ya los actualiza sin borrar nada.'
          : 'Se **borran** el canal para crear salas y el de interfaz (y los sobrantes vacíos) y se vuelven a crear. Las salas temporales con gente no se tocan.\n\nNormalmente no hace falta: **Configurar / reparar** ya los actualiza sin borrar nada.',
        [row(
          new ButtonBuilder().setCustomId(cid('sy', 'resetb', owner, system)).setLabel('Sí, reinstalar').setEmoji('♻️').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(cid('sy', 'cancel', owner, system)).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
        )]));
    case 'resetb':
      return update(i, panel(COLORS.error, '⚠️ Última confirmación', `Vas a borrar y recrear los ${LABEL[system]}. Esto no se puede deshacer.`,
        [row(
          new ButtonBuilder().setCustomId(cid('sy', 'resetok', owner, system)).setLabel('Confirmar: borrar y recrear').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(cid('sy', 'cancel', owner, system)).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
        )]));
    case 'resetok': {
      await deferPanel(i);
      if (system === 'logs') {
        const cfg = getLogConfig(app.ctx, guild.id);
        const res = await lock(() => reinstallLogs(app.ctx, guild, { staffRoleId: cfg.staffRoleId, logSentMessages: cfg.logSentMessages, executorTag: tag }));
        if (!res.ran) throw new GameError('Hay una configuración en curso. Esperá a que termine.');
        await update(i, { embeds: [res.value.embed], components: [maintenanceRow(owner, 'logs', res.value.duplicates)] });
      } else {
        const res = await lock(() => reinstallTempVoice(app, guild, tag));
        if (!res.ran) throw new GameError('Hay una configuración en curso. Esperá a que termine.');
        await update(i, { ...panel(COLORS.ok, '♻️ Canales temporales reinstalados', res.value.report.join('\n')), components: [maintenanceRow(owner, 'voice', res.value.duplicates)] });
      }
      await logSystem(app.ctx, guild, `♻️ <@${owner}> reinstaló desde cero los ${LABEL[system]}.`, COLORS.warn);
      return;
    }
    case 'cancel':
      return update(i, panel(COLORS.log, 'Cancelado', 'No se borró nada.'));
    default:
      throw new GameError('Acción desconocida.');
  }
};

/**
 * Al arrancar: los servidores que ya tenían registros o voz temporal configurados con una versión vieja del diseño
 * se sincronizan solos (renombra, mueve y corrige permisos; nunca borra canales). El resumen queda en #sistema.
 */
export async function autoSyncLayouts(app: App): Promise<void> {
  for (const system of ['logs', 'voice'] as SetupSystem[]) {
    for (const guildId of outdatedGuilds(app.ctx, system)) {
      const guild = app.client.guilds.cache.get(guildId);
      if (!guild?.available) continue;
      try {
        if (system === 'logs') {
          const cfg = getLogConfig(app.ctx, guild.id);
          const res = await app.guildLock.run(`setup:${guild.id}`, () => runSetup(app.ctx, guild, { staffRoleId: cfg.staffRoleId, logSentMessages: cfg.logSentMessages, executorTag: 'actualización del bot' }));
          if (res.ran) {
            await logSystem(app.ctx, guild, `🔄 **Registros actualizados a la versión ${LAYOUT_VERSIONS.logs} del bot** (sin borrar nada).${res.value.duplicates ? ` Hay ${res.value.duplicates} canales sobrantes: \`/setup\` → **Borrar sobrantes**.` : ''}`);
          }
        } else {
          const res = await app.guildLock.run(`voice-setup:${guild.id}`, () => setupTempVoice(app, guild, 'actualización del bot', { auto: true }));
          if (res.ran) {
            await logSystem(app.ctx, guild, `🔄 **Canales de voz temporales actualizados a la versión ${LAYOUT_VERSIONS.voice} del bot**:\n${res.value.report.join('\n')}`.slice(0, 3900));
          }
        }
        logger.info(`Diseño de ${system} sincronizado en ${guild.name} (${guild.id}).`);
      } catch (err) {
        // Sin permisos o con algo raro: se reintenta en el próximo arranque, y /setup o /voz lo arreglan a mano.
        logger.warn(`No pude sincronizar ${system} en ${guild.id}:`, err instanceof Error ? err.message : err);
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
}

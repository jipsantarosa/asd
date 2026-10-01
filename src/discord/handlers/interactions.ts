import { MessageFlags, type ChatInputCommandInteraction, type Interaction, type MessageComponentInteraction, type ModalSubmitInteraction } from 'discord.js';
import { logger } from '../../logger';
import { GameError } from '../../services/context';
import { gameConfig, getSettings } from '../../services/guildSettings';
import { viewerOf, type App } from '../app';
import { findCommand } from '../commands';
import { buildContext } from '../commands/types';
import { logSystem } from '../logging/sender';
import { parseId } from '../ui/ids';
import { COLORS } from '../ui/theme';
import { HANDLERS, type Ix } from './components';

type Respondable = Ix | ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction;

/** Responde un error sin romper si la interacción ya fue respondida o expiró. */
export async function respondError(i: Respondable, err: unknown, where: string): Promise<void> {
  const content = err instanceof GameError
    ? `⚠️ ${err.message}`
    : `❌ Ocurrió un error inesperado. Si se repite, pasale este código a un admin: \`${logger.incident(err, where)}\``;
  try {
    if (i.deferred || i.replied) await i.followUp({ content, flags: MessageFlags.Ephemeral });
    else await i.reply({ content, flags: MessageFlags.Ephemeral });
  } catch {
    /* la interacción expiró: no hay nada que hacer */
  }
}

/**
 * Antispam común a botones, menús, modales y comandos.
 * Devuelve false si hay que ignorar la acción (y ya respondió al usuario).
 */
async function passRateLimit(app: App, i: Respondable): Promise<boolean> {
  if (!i.inCachedGuild()) return true;
  const a = gameConfig(app.ctx, i.guildId).tuning.antispam;
  const r = app.limiter.check(`${i.guildId}:${i.user.id}`, a.actionsPerWindow, a.windowSeconds * 1000, a.flagThreshold);
  if (r === 'ok') return true;
  if (r === 'flag') {
    await logSystem(app.ctx, i.guild, `🚨 Actividad sospechosa: <@${i.user.id}> superó el límite de acciones ${a.flagThreshold} veces en la última hora (posible autoclicker o script).`, COLORS.warn);
  }
  await i.reply({ content: '🐢 Vas muy rápido. Esperá unos segundos y probá de nuevo.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
  return false;
}

async function handleSlash(app: App, i: ChatInputCommandInteraction): Promise<void> {
  const cmd = findCommand(i.commandName);
  if (!cmd) return;
  if (!i.inCachedGuild()) {
    await i.reply({ content: 'Este bot solo funciona dentro de servidores.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (cmd.permission && !i.member.permissions.has(cmd.permission)) {
    throw new GameError(`Necesitás el permiso **${cmd.permissionName}** para usar este comando.`);
  }
  if (!(await passRateLimit(app, i))) return;
  const c = buildContext({ app, member: i.member, viewer: viewerOf(i.member), prefix: getSettings(app.ctx, i.guildId).prefix, interaction: i });
  const res = await app.userLock.run(`${i.guildId}:${i.user.id}`, () => cmd.run(c));
  if (!res.ran) throw new GameError('Estoy procesando tu acción anterior, esperá un segundo.');
}

async function handleComponent(app: App, i: MessageComponentInteraction | ModalSubmitInteraction): Promise<void> {
  const id = parseId(i.customId);
  if (!id) return; // no es de este bot
  if (!i.inCachedGuild()) {
    await i.reply({ content: 'Este panel solo funciona dentro de servidores.', flags: MessageFlags.Ephemeral });
    return;
  }
  // Un panel solo lo maneja quien lo abrió ("0" = panel público).
  if (id.owner !== '0' && id.owner !== i.user.id) {
    await i.reply({ content: '🔒 Este panel es de otra persona. Abrí el tuyo con `/granja`, `/pesca` o `/mercado`.', flags: MessageFlags.Ephemeral });
    return;
  }
  const handler = HANDLERS[id.mod];
  if (!handler) {
    await i.reply({ content: 'Este botón ya no es válido. Abrí el panel de nuevo.', flags: MessageFlags.Ephemeral });
    return;
  }
  // La pesca no tiene freno anti spam: se puede tocar sin límite. Cada tiro es una transacción
  // sincrónica de SQLite, así que aunque lleguen muchos clics seguidos el inventario y el saldo quedan exactos.
  if (id.mod === 'fi') {
    await handler(app, i, id);
    return;
  }
  if (!(await passRateLimit(app, i))) return;
  const res = await app.userLock.run(`${i.guildId}:${i.user.id}`, () => handler(app, i, id));
  if (!res.ran) {
    await i.reply({ content: '⏳ Estoy procesando tu acción anterior, esperá un segundo.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}

export function onInteraction(app: App) {
  return async (i: Interaction): Promise<void> => {
    try {
      if (i.isChatInputCommand()) await handleSlash(app, i);
      else if (i.isMessageComponent() || i.isModalSubmit()) await handleComponent(app, i);
    } catch (err) {
      if (i.isChatInputCommand() || i.isMessageComponent() || i.isModalSubmit()) {
        await respondError(i as Respondable, err, i.isChatInputCommand() ? `/${i.commandName}` : i.customId);
      } else {
        logger.error('Interacción no manejada:', err);
      }
    }
  };
}


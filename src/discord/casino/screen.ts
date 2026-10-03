import {
  ButtonBuilder, MessageFlags, type ActionRowBuilder, type ChatInputCommandInteraction, type ContainerBuilder, type EmbedBuilder, type Message,
  type MessageActionRowComponentBuilder, type MessageComponentInteraction,
} from 'discord.js';
import { logger } from '../../logger';
import type { CommandContext } from '../commands/types';

/**
 * Pantalla de un juego. La mayoría usa embeds + filas de botones; Minas usa Components V2 (un tablero de 5 × 5
 * necesita 5 filas de botones y además el botón de cobrar, y los mensajes clásicos admiten solo 5 filas).
 */
export type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;
export type Screen =
  | { v2?: false; embeds: EmbedBuilder[]; components: Row[] }
  | { v2: true; components: (ContainerBuilder | Row)[] };

/** Cuerpo para enviar o editar. En V2 no puede haber `content` ni `embeds`. */
export function payloadOf(s: Screen) {
  return s.v2
    ? { components: s.components, flags: MessageFlags.IsComponentsV2 as const, allowedMentions: { parse: [] as never[] } }
    : { embeds: s.embeds, components: s.components, allowedMentions: { parse: [] as never[] } };
}

/** Mensaje de una partida y cómo editarlo (por la interacción mientras sea válida, o directamente). */
export interface ScreenHandle {
  message: Message | null;
  edit(s: Screen): Promise<boolean>;
}

const INTERACTION_TTL = 14 * 60_000;

function handleFor(message: Message | null, viaInteraction: ChatInputCommandInteraction | MessageComponentInteraction | null, original = true): ScreenHandle {
  const born = Date.now();
  return {
    message,
    async edit(s) {
      let lastErr: unknown = null;
      // Primero por la interacción (mientras sea válida); si falla (venció o ya la respondió otro), directo al mensaje.
      if (viaInteraction && Date.now() - born < INTERACTION_TTL) {
        try {
          if (original) await viaInteraction.editReply(payloadOf(s));
          else if (message) await viaInteraction.webhook.editMessage(message.id, payloadOf(s));
          else throw new Error('sin mensaje');
          return true;
        } catch (err) {
          lastErr = err;
        }
      }
      if (message) {
        try {
          await message.edit(payloadOf(s));
          return true;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) logger.warn('No pude actualizar la pantalla del juego:', lastErr instanceof Error ? lastErr.message : lastErr);
      return false;
    },
  };
}

/** Envía la pantalla como respuesta a un comando (slash o prefijo). */
export async function sendFromCommand(c: CommandContext, s: Screen): Promise<ScreenHandle> {
  const body = payloadOf(s);
  if (c.interaction) {
    const i = c.interaction;
    if (i.deferred || i.replied) {
      const m = await i.editReply(body);
      return handleFor(m, i);
    }
    const res = await i.reply({ ...body, withResponse: true });
    return handleFor(res.resource?.message ?? null, i);
  }
  const m = await c.message!.reply({ ...body, allowedMentions: { parse: [], repliedUser: false } });
  return handleFor(m, null);
}

/** Mensaje nuevo en respuesta a un botón (p. ej. "Repetir apuesta"). */
export async function sendFromButton(i: MessageComponentInteraction, s: Screen): Promise<ScreenHandle> {
  const body = payloadOf(s);
  if (i.deferred || i.replied) {
    const m = await i.followUp(body);
    return handleFor(m, i, false);
  }
  const res = await i.reply({ ...body, withResponse: true });
  return handleFor(res.resource?.message ?? null, i);
}

/** Reemplaza el mensaje del botón tocado (una decisión dentro de la partida). */
export async function updateFromButton(i: MessageComponentInteraction, s: Screen): Promise<ScreenHandle> {
  const body = payloadOf(s);
  try {
    if (i.deferred || i.replied) await i.editReply(body);
    else await i.update(body);
  } catch (err) {
    // La interacción ya no sirve (venció o la respondió otra copia del bot): se edita el mensaje directo,
    // así la pantalla nunca queda con botones viejos.
    const ok = await i.message.edit(body).then(() => true, () => false);
    if (!ok) throw err;
    return handleFor(i.message, null);
  }
  return handleFor(i.message, i);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Muestra cuadros de animación y después la pantalla final (si un cuadro falla, salta directo al final). */
export async function animate(h: ScreenHandle, frames: Screen[], final: Screen, delayMs = 850): Promise<void> {
  for (const f of frames) {
    if (!(await h.edit(f))) break;
    await sleep(delayMs);
  }
  await h.edit(final);
}

/** Copia de una fila con todos sus botones desactivados. */
export function disableRow(row: Row): Row {
  for (const c of row.components) if (c instanceof ButtonBuilder) c.setDisabled(true);
  return row;
}

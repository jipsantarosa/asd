import { MessageFlags, type MessageComponentInteraction, type ModalSubmitInteraction } from 'discord.js';
import type { App, Panel } from '../app';
import type { ParsedId } from '../ui/ids';

/** Interacción de componente (botón, menú) o de ventana (modal), siempre dentro de un servidor. */
export type Ix = MessageComponentInteraction<'cached'> | ModalSubmitInteraction<'cached'>;
export type Handler = (app: App, i: Ix, id: ParsedId) => Promise<void>;

export function values(i: Ix): string[] {
  return i.isAnySelectMenu() ? i.values : [];
}

export function field(i: Ix, name: string): string {
  if (!i.isModalSubmit()) return '';
  return i.fields.getTextInputValue(name).trim();
}

/**
 * Reemplaza el panel en el mismo mensaje. Si el handler ya hizo deferUpdate() (porque iba a tardar
 * más de 3 s hablando con Discord), edita la respuesta diferida en lugar de responder de nuevo.
 */
export async function update(i: Ix, panel: Panel): Promise<void> {
  // attachments: [] quita las imágenes del panel anterior; files agrega las del nuevo (si tiene).
  const body = { embeds: panel.embeds, components: panel.components, files: panel.files ?? [], attachments: [], allowedMentions: { parse: [] } };
  if (i.deferred || i.replied) await i.editReply(body);
  else if (i.isMessageComponent()) await i.update(body);
  else if (i.isFromMessage()) await i.update(body);
  else await i.reply({ embeds: body.embeds, components: body.components, files: body.files, allowedMentions: body.allowedMentions, flags: MessageFlags.Ephemeral });
}

/** Avisa a Discord que la respuesta va a tardar (la edición llega después con update()). */
export async function deferPanel(i: Ix): Promise<void> {
  if (i.deferred || i.replied) return;
  if (i.isMessageComponent() || i.isFromMessage()) await i.deferUpdate();
  else await i.deferReply({ flags: MessageFlags.Ephemeral });
}

/**
 * Para acciones que responden con un mensaje privado aparte (no reemplazan el panel):
 * - botón de un mensaje público o modal → respuesta privada nueva ("pensando…");
 * - menú dentro de un mensaje privado → se edita ese mismo mensaje.
 */
export async function deferPrivate(i: Ix): Promise<void> {
  if (i.deferred || i.replied) return;
  if (i.isMessageComponent() && i.message.flags.has(MessageFlags.Ephemeral)) await i.deferUpdate();
  else await i.deferReply({ flags: MessageFlags.Ephemeral });
}

/** Termina una respuesta privada (ver deferPrivate). */
export async function finishPrivate(i: Ix, content: string, extra: { embeds?: Panel['embeds']; components?: Panel['components'] } = {}): Promise<void> {
  const body = { content, embeds: extra.embeds ?? [], components: extra.components ?? [], allowedMentions: { parse: [] } };
  if (i.deferred || i.replied) await i.editReply(body);
  else if (i.isMessageComponent() && i.message.flags.has(MessageFlags.Ephemeral)) await i.update(body);
  else await i.reply({ ...body, flags: MessageFlags.Ephemeral });
}

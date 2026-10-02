import {
  ApplicationCommandType, ContextMenuCommandBuilder, EmbedBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, type GuildMember, type MessageContextMenuCommandInteraction,
} from 'discord.js';
import { GameError } from '../../services/context';
import type { App, Panel } from '../app';
import { row } from '../app';
import {
  assertCanSteal, expressionsOf, MAX_PER_STEAL, parseCustomEmojis, stealExpressions, stickerRef, type Expression, type StealResult,
} from '../expressions/steal';
import type { Handler } from '../handlers/util';
import { update, values } from '../handlers/util';
import { logSystem } from '../logging/sender';
import { cid } from '../ui/ids';
import { COLORS, clean, truncate } from '../ui/theme';
import type { Command } from './types';

const USAGE = 'Respondé a un mensaje con `!steal` (o poné los emojis: `!steal <:pepe:123…> [nombre]`). También: clic derecho en el mensaje → Apps → **Robar emoji o sticker**.';

function resultEmbed(r: StealResult): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(r.ok.length ? COLORS.ok : COLORS.error)
    .setTitle(r.ok.length ? '😀 Expresiones agregadas' : '⚠️ No se agregó nada')
    .setDescription([...r.ok.map((x) => `✅ ${x}`), ...r.failed.map((x) => `❌ ${clean(x)}`)].join('\n') || 'Nada para copiar.')
    .setFooter({ text: 'Copiá solo emojis y stickers que tengas permiso de usar.' });
}

/** Valor de una opción del menú: e:<id>:<a|s>:<nombre> o s:<id> (el servidor vuelve a validar todo al elegir). */
const optionValue = (e: Expression) => (e.kind === 'emoji' ? `e:${e.id}:${e.animated ? 'a' : 's'}:${e.name}` : `s:${e.id}`);

function pickerPanel(owner: string, items: Expression[]): Panel {
  const e = new EmbedBuilder().setColor(COLORS.casino).setTitle('😀 ¿Qué querés copiar?')
    .setDescription(`Encontré **${items.length}** ${items.length === 1 ? 'expresión' : 'expresiones'}. Elegí hasta ${MAX_PER_STEAL}.`);
  const menu = new StringSelectMenuBuilder().setCustomId(cid('cx', 'pick', owner)).setPlaceholder('Elegí emojis o stickers…')
    .setMinValues(1).setMaxValues(Math.min(MAX_PER_STEAL, items.length))
    .addOptions(items.slice(0, 25).map((x) => {
      const o = new StringSelectMenuOptionBuilder().setValue(optionValue(x)).setLabel(truncate(x.kind === 'emoji' ? `:${x.name}:` : `Sticker: ${x.name}`, 100));
      if (x.kind === 'emoji') o.setEmoji({ id: x.id, name: x.name, animated: x.animated });
      else o.setEmoji('🏷️');
      return o;
    }));
  return { embeds: [e], components: [row(menu)] };
}

async function finish(app: App, member: GuildMember, items: Expression[], rename: string | null): Promise<StealResult> {
  const r = await stealExpressions(member, items, rename);
  if (r.ok.length) await logSystem(app.ctx, member.guild, `😀 <@${member.id}> agregó con !steal: ${r.ok.join(', ')}`);
  return r;
}

export const stealCmd: Command = {
  name: 'steal',
  aliases: ['robar', 'yoink', 'copiaremoji'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('steal').setDescription('😀 Copiá emojis de otro servidor a este (pegalos en la opción).')
    .setDefaultMemberPermissions(PermissionFlagsBits.CreateGuildExpressions)
    .addStringOption((o) => o.setName('emojis').setDescription('Uno o varios emojis personalizados').setRequired(true).setMaxLength(1000))
    .addStringOption((o) => o.setName('nombre').setDescription('Nombre nuevo (si copiás uno solo)').setMaxLength(32)),
  async run(c) {
    assertCanSteal(c.member);
    let items: Expression[];
    let rename: string | null;
    if (c.interaction) {
      items = parseCustomEmojis(c.interaction.options.getString('emojis', true));
      rename = c.interaction.options.getString('nombre');
    } else {
      const ref = c.message!.reference?.messageId ? await c.message!.fetchReference().catch(() => null) : null;
      items = [...(ref ? expressionsOf(ref) : []), ...parseCustomEmojis(c.args.join(' '))];
      const seen = new Set<string>();
      items = items.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
      rename = c.args.filter((a) => !/^<a?:\w+:\d+>$/.test(a)).join('_') || null;
    }
    if (!items.length) throw new GameError(`No encontré emojis personalizados ni stickers. ${USAGE}`);
    if (items.length === 1) {
      await c.defer();
      await c.reply({ embeds: [resultEmbed(await finish(c.app, c.member, items, rename))] });
      return;
    }
    await c.reply(pickerPanel(c.member.id, items));
  },
};

/** Menú contextual: clic derecho en un mensaje → Apps → Robar emoji o sticker. */
export const stealContextMenu = {
  data: new ContextMenuCommandBuilder().setName('Robar emoji o sticker').setType(ApplicationCommandType.Message)
    .setContexts(InteractionContextType.Guild).setDefaultMemberPermissions(PermissionFlagsBits.CreateGuildExpressions),
  async run(app: App, i: MessageContextMenuCommandInteraction<'cached'>): Promise<void> {
    assertCanSteal(i.member);
    const items = expressionsOf(i.targetMessage);
    if (!items.length) throw new GameError('Ese mensaje no tiene emojis personalizados ni stickers.');
    if (items.length === 1) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await i.editReply({ embeds: [resultEmbed(await finish(app, i.member, items, null))] });
      return;
    }
    await i.reply({ ...pickerPanel(i.user.id, items), flags: MessageFlags.Ephemeral });
  },
};

/** Selección del menú: se reconstruye cada expresión desde su valor y se valida de nuevo. */
export const stealHandler: Handler = async (app, i, id) => {
  if (id.act !== 'pick') throw new GameError('Acción desconocida.');
  const items: Expression[] = [];
  for (const v of values(i).slice(0, MAX_PER_STEAL)) {
    const e = v.match(/^e:(\d{17,20}):([as]):(\w{2,32})$/);
    if (e) {
      items.push({ kind: 'emoji', id: e[1], animated: e[2] === 'a', name: e[3] });
      continue;
    }
    const s = v.match(/^s:(\d{17,20})$/);
    if (!s) throw new GameError('Opción inválida.');
    const sticker = await app.client.fetchSticker(s[1]).catch(() => null);
    if (sticker) items.push(stickerRef(sticker));
  }
  if (i.isMessageComponent()) await i.deferUpdate();
  const r = await finish(app, i.member, items, null);
  await update(i, { embeds: [resultEmbed(r)], components: [] });
};

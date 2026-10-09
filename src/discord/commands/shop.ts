import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, Events,
  InteractionContextType, MessageFlags, ModalBuilder, OverwriteType, PermissionFlagsBits, RoleSelectMenuBuilder, SlashCommandBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle,
  type Guild, type GuildMember, type GuildTextBasedChannel, type OverwriteResolvable, type TextChannel,
} from 'discord.js';
import { logger } from '../../logger';
import { GameError } from '../../services/context';
import {
  closeTicket, createProduct, deleteProduct, dropTicket, getProduct, getShopConfig, getTicket, listProducts, markSold, reserveTicket,
  saveShopConfig, setProductMessage, setTicketChannel, shopStats, ticketByChannel, updateProductPrice, updateProductTexts,
  type Product, type Ticket,
} from '../../services/shop';
import { row, type App, type Panel } from '../app';
import { field, update, values, type Handler, type Ix } from '../handlers/util';
import { cid } from '../ui/ids';
import { clean } from '../ui/theme';
import type { Command } from './types';

/**
 * /tienda — productos con embed editable y botón "Comprar" que abre un ticket privado con el staff.
 * El staff arma todo desde un panel: textos, precios, stock, imagen, color, dónde publicar y los tickets.
 */

const F = PermissionFlagsBits;
const ACCENT = 0x2ecc71;

// ───────────────────────── embed del producto ─────────────────────────

export function productEmbed(p: Product): EmbedBuilder {
  const lines = [
    p.description,
    '',
    p.priceArs ? `💸 | Precio: **ARS$${clean(p.priceArs)}**` : '',
    p.priceUsd ? `💰 | Price: **$${clean(p.priceUsd)} USD**` : '',
    `📦 | Stock: **${p.stock === null ? 'Disponible' : p.stock === 0 ? 'Agotado' : p.stock.toLocaleString('es-AR')}**`,
  ].filter((l, i) => l !== '' || i === 1);
  const e = new EmbedBuilder().setColor(p.color).setTitle(p.title).setDescription(lines.join('\n').slice(0, 4096));
  if (p.imageUrl) e.setImage(p.imageUrl);
  return e;
}

function buyRow(p: Product) {
  return row(new ButtonBuilder().setCustomId(cid('sh', 'buy', '0', p.id)).setStyle(p.stock === 0 ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setEmoji(p.stock === 0 ? '⛔' : '🛒').setLabel(p.stock === 0 ? 'Agotado' : p.button).setDisabled(p.stock === 0));
}

export function publicProduct(p: Product) {
  return { embeds: [productEmbed(p)], components: [buyRow(p)], allowedMentions: { parse: [] as never[] } };
}

/** Actualiza el mensaje publicado (si se borró, se olvida). */
async function refreshPublished(app: App, guild: Guild, p: Product): Promise<boolean> {
  if (!p.channelId || !p.messageId) return false;
  const ch = guild.channels.cache.get(p.channelId);
  if (!ch?.isTextBased()) {
    setProductMessage(app.ctx, guild.id, p.id, null, null);
    return false;
  }
  return ch.messages.edit(p.messageId, publicProduct(p)).then(() => true, (err: { code?: number }) => {
    if (err.code === 10008) setProductMessage(app.ctx, guild.id, p.id, null, null);
    return false;
  });
}

// ───────────────────────── panel de administración ─────────────────────────

function homePanel(app: App, guild: Guild, owner: string, notice?: string): Panel {
  const products = listProducts(app.ctx, guild.id);
  const cfg = getShopConfig(app.ctx, guild.id);
  const st = shopStats(app.ctx, guild.id);
  const e = new EmbedBuilder().setColor(ACCENT).setTitle('🛒 Tienda').setDescription([
    notice ?? '',
    products.length
      ? products.map((p) => `**#${p.id} · ${clean(p.title)}** — ${p.messageId ? `publicado en <#${p.channelId}>` : 'sin publicar'}${p.stock !== null ? ` · stock ${p.stock}` : ''}`).join('\n')
      : 'Todavía no hay productos. Tocá **➕ Nuevo producto**.',
    '',
    `🎫 **Tickets:** categoría ${cfg.categoryId ? `<#${cfg.categoryId}>` : '*(ninguna)*'} · staff ${cfg.staffRoleId ? `<@&${cfg.staffRoleId}>` : '*(sin rol)*'} · registro ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : '*(ninguno)*'}`,
    `-# ${st.open} abiertos · ${st.sold} ventas · ${st.total} tickets en total`,
  ].filter((l, i) => l || i > 0).join('\n'));
  const rows = [];
  if (products.length) {
    rows.push(row(new StringSelectMenuBuilder().setCustomId(cid('sh', 'sel', owner)).setPlaceholder('Editar un producto…')
      .addOptions(products.map((p) => new StringSelectMenuOptionBuilder().setValue(String(p.id)).setLabel(`#${p.id} · ${p.title}`.slice(0, 100))
        .setDescription(p.messageId ? 'Publicado' : 'Sin publicar')))));
  }
  rows.push(row(
    new ButtonBuilder().setCustomId(cid('sh', 'new', owner)).setLabel('Nuevo producto').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(cid('sh', 'tk', owner)).setLabel('Tickets').setEmoji('🎫').setStyle(ButtonStyle.Secondary),
  ));
  return { embeds: [e], components: rows };
}

function productPanel(p: Product, owner: string, notice?: string): Panel {
  const info = new EmbedBuilder().setColor(ACCENT).setTitle(`🛒 Producto #${p.id}`).setDescription([
    notice ?? '',
    p.messageId ? `📢 Publicado en <#${p.channelId}> (se actualiza solo al editar).` : '📢 Sin publicar: andá al canal donde lo quieras y tocá **Publicar aquí**.',
    '-# Vista previa abajo.',
  ].filter(Boolean).join('\n'));
  return {
    embeds: [info, productEmbed(p)],
    components: [
      row(
        new ButtonBuilder().setCustomId(cid('sh', 'txt', owner, p.id)).setLabel('Textos e imagen').setEmoji('✏️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(cid('sh', 'prc', owner, p.id)).setLabel('Precio y stock').setEmoji('💲').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(cid('sh', 'pub', owner, p.id)).setLabel(p.messageId ? 'Mover aquí' : 'Publicar aquí').setEmoji('📢').setStyle(ButtonStyle.Success),
      ),
      row(
        new ButtonBuilder().setCustomId(cid('sh', 'del', owner, p.id)).setLabel('Borrar').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(cid('sh', 'home', owner)).setLabel('Volver').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function ticketConfigPanel(app: App, guild: Guild, owner: string, notice?: string): Panel {
  const cfg = getShopConfig(app.ctx, guild.id);
  const e = new EmbedBuilder().setColor(ACCENT).setTitle('🎫 Tickets de compra').setDescription([
    notice ?? '',
    `**Categoría** donde se crean: ${cfg.categoryId ? `<#${cfg.categoryId}>` : '*ninguna (arriba de todo)*'}`,
    `**Rol del staff** que atiende: ${cfg.staffRoleId ? `<@&${cfg.staffRoleId}>` : '*ninguno (solo admins)*'}`,
    `**Canal de registro** (ventas y transcripciones): ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : '*ninguno*'}`,
    '',
    '-# Cada ticket es un canal privado entre quien compra y el staff. Máximo 3 abiertos por persona.',
  ].filter((l, i) => l || i > 0).join('\n'));
  return {
    embeds: [e],
    components: [
      row(new ChannelSelectMenuBuilder().setCustomId(cid('sh', 'tcat', owner)).setPlaceholder('Categoría de los tickets…').setChannelTypes(ChannelType.GuildCategory)),
      row(new RoleSelectMenuBuilder().setCustomId(cid('sh', 'trole', owner)).setPlaceholder('Rol del staff…')),
      row(new ChannelSelectMenuBuilder().setCustomId(cid('sh', 'tlog', owner)).setPlaceholder('Canal de registro…').setChannelTypes(ChannelType.GuildText)),
      row(new ButtonBuilder().setCustomId(cid('sh', 'home', owner)).setLabel('Volver').setEmoji('⬅️').setStyle(ButtonStyle.Secondary)),
    ],
  };
}

function textsModal(p: Product, owner: string): ModalBuilder {
  const input = (id: string, label: string, value: string, style = TextInputStyle.Short, max = 100, required = true) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style)
      .setRequired(required).setMaxLength(max).setValue(value));
  return new ModalBuilder().setCustomId(cid('sh', 'txtsave', owner, p.id)).setTitle(`Producto #${p.id}`).addComponents(
    input('title', 'Título', p.title, TextInputStyle.Short, 120),
    input('desc', 'Descripción (acepta **negrita**, > citas…)', p.description, TextInputStyle.Paragraph, 2000),
    input('image', 'Imagen (enlace https://… o vacío)', p.imageUrl ?? '', TextInputStyle.Short, 500, false),
    input('color', 'Color (#RRGGBB)', `#${p.color.toString(16).padStart(6, '0').toUpperCase()}`, TextInputStyle.Short, 7, false),
    input('button', 'Texto del botón', p.button, TextInputStyle.Short, 40, false),
  );
}

function priceModal(p: Product, owner: string): ModalBuilder {
  const input = (id: string, label: string, value: string, placeholder: string) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short)
      .setRequired(false).setMaxLength(20).setValue(value).setPlaceholder(placeholder));
  return new ModalBuilder().setCustomId(cid('sh', 'prcsave', owner, p.id)).setTitle(`Precio y stock · #${p.id}`).addComponents(
    input('ars', 'Precio en pesos (vacío = no mostrar)', p.priceArs, '399.00'),
    input('usd', 'Precio en dólares (vacío = no mostrar)', p.priceUsd, '1.00'),
    input('stock', 'Stock (vacío = sin límite)', p.stock === null ? '' : String(p.stock), '100'),
  );
}

// ───────────────────────── tickets ─────────────────────────

function isStaff(app: App, member: GuildMember): boolean {
  const cfg = getShopConfig(app.ctx, member.guild.id);
  return member.permissions.has(F.ManageChannels) || (!!cfg.staffRoleId && member.roles.cache.has(cfg.staffRoleId));
}

function ticketMessage(t: Ticket, p: Product | null, staffRoleId: string | null) {
  const e = new EmbedBuilder().setColor(p?.color ?? ACCENT).setTitle(`🎫 Ticket #${String(t.number).padStart(4, '0')}${p ? ` · ${p.title}` : ''}`)
    .setDescription([
      `¡Hola <@${t.userId}>! Gracias por tu interés${p ? ` en **${clean(p.title)}**` : ''}.`,
      'Un miembro del staff te va a atender acá. Contá qué querés y cómo preferís pagar.',
      '',
      p?.priceArs ? `💸 | Precio: **ARS$${clean(p.priceArs)}**` : '',
      p?.priceUsd ? `💰 | Price: **$${clean(p.priceUsd)} USD**` : '',
    ].filter((l, i) => l || i === 2).join('\n'));
  if (p?.imageUrl) e.setThumbnail(p.imageUrl);
  return {
    content: `<@${t.userId}>${staffRoleId ? ` <@&${staffRoleId}>` : ''}`,
    embeds: [e],
    components: [row(
      new ButtonBuilder().setCustomId(cid('sh', 'sold', '0', t.id)).setLabel('Marcar vendido').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cid('sh', 'close', '0', t.id)).setLabel('Cerrar ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    )],
    allowedMentions: { users: [t.userId], roles: staffRoleId ? [staffRoleId] : [] },
  };
}

async function logShop(app: App, guild: Guild, embed: EmbedBuilder, files: AttachmentBuilder[] = []): Promise<void> {
  const id = getShopConfig(app.ctx, guild.id).logChannelId;
  const ch = id ? guild.channels.cache.get(id) : null;
  if (ch?.isTextBased() && 'send' in ch) await (ch as GuildTextBasedChannel).send({ embeds: [embed], files, allowedMentions: { parse: [] } }).catch(() => undefined);
}

async function openTicket(app: App, i: Ix, productId: number): Promise<void> {
  const guild = i.guild;
  const ctx = app.ctx;
  const me = guild.members.me!;
  if (!me.permissions.has([F.ManageChannels, F.ManageRoles])) throw new GameError('El bot necesita **Gestionar canales** y **Gestionar roles** para abrir tickets. Avisale a un admin.');
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  let { ticket, existing } = reserveTicket(ctx, guild.id, i.user.id, productId);
  if (existing) {
    const ch = ticket.channelId ? guild.channels.cache.get(ticket.channelId) : null;
    if (ch) {
      await i.editReply({ content: `🎫 Ya tenés un ticket abierto para este producto: <#${ch.id}>` });
      return;
    }
    // El canal se borró a mano: se cierra ese ticket y se abre uno nuevo.
    closeTicket(ctx, ticket.id, null);
    ({ ticket } = reserveTicket(ctx, guild.id, i.user.id, productId));
  }
  const p = getProduct(ctx, guild.id, productId);
  const cfg = getShopConfig(ctx, guild.id);
  const category = cfg.categoryId ? guild.channels.cache.get(cfg.categoryId) : null;
  const staffRole = cfg.staffRoleId ? guild.roles.cache.get(cfg.staffRoleId) : null;
  const overwrites: OverwriteResolvable[] = [
    { id: guild.id, deny: [F.ViewChannel], type: OverwriteType.Role },
    { id: i.user.id, allow: [F.ViewChannel, F.SendMessages, F.ReadMessageHistory, F.AttachFiles, F.EmbedLinks], type: OverwriteType.Member },
    { id: me.id, allow: [F.ViewChannel, F.SendMessages, F.ReadMessageHistory, F.EmbedLinks, F.AttachFiles, F.ManageChannels], type: OverwriteType.Member },
  ];
  if (staffRole) overwrites.push({ id: staffRole.id, allow: [F.ViewChannel, F.SendMessages, F.ReadMessageHistory, F.AttachFiles, F.EmbedLinks], type: OverwriteType.Role });
  let channel: TextChannel;
  try {
    channel = await guild.channels.create({
      name: `compra-${String(ticket.number).padStart(4, '0')}`,
      type: ChannelType.GuildText,
      parent: category?.type === ChannelType.GuildCategory ? category.id : undefined,
      topic: `Ticket de ${i.user.username} · ${p.title}`.slice(0, 1024),
      permissionOverwrites: overwrites,
      reason: `Ticket de compra #${ticket.number} (${i.user.tag})`,
    });
  } catch (err) {
    dropTicket(ctx, ticket.id);
    logger.warn('Tienda: no pude crear el ticket:', err);
    throw new GameError('No pude crear el ticket (¿la categoría está llena o me faltan permisos?). Avisale a un admin.');
  }
  setTicketChannel(ctx, ticket.id, channel.id);
  await channel.send(ticketMessage(ticket, p, staffRole?.id ?? null)).catch(() => undefined);
  await i.editReply({ content: `🎫 Listo, abrí tu ticket: <#${channel.id}>` });
  await logShop(app, guild, new EmbedBuilder().setColor(ACCENT).setDescription(`🎫 <@${i.user.id}> abrió el ticket **#${ticket.number}** (${clean(p.title)}) → <#${channel.id}>`));
}

async function transcript(channel: GuildTextBasedChannel): Promise<AttachmentBuilder | null> {
  const msgs = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!msgs?.size) return null;
  const lines = [...msgs.values()].reverse().map((m) => {
    const when = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 16);
    const extra = [...m.attachments.values()].map((a) => ` [adjunto: ${a.url}]`).join('');
    return `[${when}] ${m.author.tag}: ${m.content}${extra}`;
  });
  return new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), { name: `${channel.name}.txt` });
}

// ───────────────────────── botones ─────────────────────────

export const shopHandler: Handler = async (app, i, id) => {
  const ctx = app.ctx;
  const g = i.guild;
  const num = (raw: string | undefined) => Number(raw);

  // Botones públicos: comprar, cerrar y marcar vendido.
  if (id.act === 'buy') return openTicket(app, i, num(id.args[0]));
  if (id.act === 'close' || id.act === 'closeok' || id.act === 'sold') {
    if (!i.isButton()) throw new GameError('Acción desconocida.');
    const t = getTicket(ctx, g.id, num(id.args[0]));
    const staff = isStaff(app, i.member);
    if (id.act === 'sold') {
      if (!staff) throw new GameError('Solo el staff puede marcar la venta.');
      const { product } = markSold(ctx, g.id, t.id);
      if (product) await refreshPublished(app, g, product);
      await i.reply({ content: `✅ Venta registrada por <@${i.user.id}>.${product?.stock !== null && product ? ` Stock restante: **${product.stock}**.` : ''}`, allowedMentions: { parse: [] } });
      await logShop(app, g, new EmbedBuilder().setColor(ACCENT).setDescription(`✅ Venta del ticket **#${t.number}** (<@${t.userId}>)${product ? ` · ${clean(product.title)}` : ''} registrada por <@${i.user.id}>.`));
      return;
    }
    if (!staff && i.user.id !== t.userId) throw new GameError('Solo quien abrió el ticket o el staff pueden cerrarlo.');
    if (t.status !== 'open') throw new GameError('Este ticket ya está cerrado.');
    if (id.act === 'close') {
      await i.reply({
        content: '¿Cerrar el ticket? El canal se borra (la transcripción queda en el registro, si hay uno configurado).',
        components: [row(new ButtonBuilder().setCustomId(cid('sh', 'closeok', '0', t.id)).setLabel('Sí, cerrar').setEmoji('🔒').setStyle(ButtonStyle.Danger))],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!closeTicket(ctx, t.id, i.user.id)) throw new GameError('Este ticket ya está cerrado.');
    await i.update({ content: '🔒 Cerrando el ticket en 5 segundos…', components: [] });
    const channel = t.channelId ? g.channels.cache.get(t.channelId) : null;
    if (channel?.isTextBased()) {
      const file = await transcript(channel as GuildTextBasedChannel);
      await logShop(app, g, new EmbedBuilder().setColor(0x95a5a6).setDescription(`🔒 <@${i.user.id}> cerró el ticket **#${t.number}** de <@${t.userId}>${t.sold ? ' · ✅ vendido' : ''}.`), file ? [file] : []);
      setTimeout(() => void channel.delete(`Ticket #${t.number} cerrado`).catch(() => undefined), 5_000);
    }
    return;
  }

  // Panel de administración.
  if (!i.member.permissions.has(F.ManageGuild)) throw new GameError('Necesitás **Gestionar servidor**.');
  const pid = num(id.args[0]);
  switch (id.act) {
    case 'home':
      return update(i, homePanel(app, g, i.user.id));
    case 'new': {
      const p = createProduct(ctx, g.id);
      return update(i, productPanel(p, i.user.id, '✅ Producto creado con textos de ejemplo. Editalo con los botones.'));
    }
    case 'sel':
      return update(i, productPanel(getProduct(ctx, g.id, Number(values(i)[0])), i.user.id));
    case 'txt':
      if (!i.isButton()) return;
      return i.showModal(textsModal(getProduct(ctx, g.id, pid), i.user.id));
    case 'prc':
      if (!i.isButton()) return;
      return i.showModal(priceModal(getProduct(ctx, g.id, pid), i.user.id));
    case 'txtsave':
    case 'prcsave': {
      const p = id.act === 'txtsave'
        ? updateProductTexts(ctx, g.id, pid, { title: field(i, 'title'), description: field(i, 'desc'), imageUrl: field(i, 'image'), color: field(i, 'color'), button: field(i, 'button') })
        : updateProductPrice(ctx, g.id, pid, { ars: field(i, 'ars'), usd: field(i, 'usd'), stock: field(i, 'stock') });
      const live = await refreshPublished(app, g, p);
      return update(i, productPanel(p, i.user.id, `✅ Guardado.${live ? ' La publicación ya está actualizada.' : ''}`));
    }
    case 'pub': {
      const p = getProduct(ctx, g.id, pid);
      const ch = i.channel;
      if (!ch?.isTextBased() || !('send' in ch)) throw new GameError('No puedo publicar en este canal.');
      const msg = await (ch as GuildTextBasedChannel).send(publicProduct(p)).catch(() => null);
      if (!msg) throw new GameError('No pude publicar acá: revisá que el bot pueda ver el canal, enviar mensajes e insertar enlaces.');
      // Si estaba publicado en otro lado, se borra la publicación vieja (queda una sola).
      if (p.channelId && p.messageId && p.messageId !== msg.id) {
        const old = g.channels.cache.get(p.channelId);
        if (old?.isTextBased()) await old.messages.delete(p.messageId).catch(() => undefined);
      }
      setProductMessage(ctx, g.id, p.id, msg.channelId, msg.id);
      return update(i, productPanel(getProduct(ctx, g.id, p.id), i.user.id, `📢 Publicado en <#${msg.channelId}>.`));
    }
    case 'del':
      return update(i, {
        embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription(`¿Borrar el producto **#${pid}**? También se borra su publicación. Los tickets abiertos siguen funcionando.`)],
        components: [row(
          new ButtonBuilder().setCustomId(cid('sh', 'delok', i.user.id, pid)).setLabel('Sí, borrar').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(cid('sh', 'sel2', i.user.id, pid)).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
        )],
      });
    case 'sel2':
      return update(i, productPanel(getProduct(ctx, g.id, pid), i.user.id));
    case 'delok': {
      const p = deleteProduct(ctx, g.id, pid);
      if (p.channelId && p.messageId) {
        const ch = g.channels.cache.get(p.channelId);
        if (ch?.isTextBased()) await ch.messages.delete(p.messageId).catch(() => undefined);
      }
      return update(i, homePanel(app, g, i.user.id, `🗑️ Borré **${clean(p.title)}**.`));
    }
    case 'tk':
      return update(i, ticketConfigPanel(app, g, i.user.id));
    case 'tcat':
    case 'trole':
    case 'tlog': {
      const v = values(i)[0] ?? null;
      const key = id.act === 'tcat' ? 'categoryId' : id.act === 'trole' ? 'staffRoleId' : 'logChannelId';
      if (key === 'staffRoleId' && v && (v === g.id || g.roles.cache.get(v)?.managed)) throw new GameError('Ese rol no sirve como rol del staff.');
      saveShopConfig(ctx, g.id, { [key]: v });
      return update(i, ticketConfigPanel(app, g, i.user.id, '✅ Guardado.'));
    }
    default:
      throw new GameError('Acción desconocida.');
  }
};

/** Si alguien borra a mano el canal de un ticket, el ticket queda cerrado. */
export function startShop(app: App): void {
  app.client.on(Events.ChannelDelete, (ch) => {
    try {
      const t = ticketByChannel(app.ctx, ch.id);
      if (t && t.status === 'open') closeTicket(app.ctx, t.id, null);
    } catch (err) {
      logger.warn('Tienda (canal borrado):', err);
    }
  });
}

// ───────────────────────── comando ─────────────────────────

export const shopCmd: Command = {
  name: 'tienda',
  aliases: ['shop', 'store', 'productos'],
  prefix: true,
  permission: F.ManageGuild,
  permissionName: 'Gestionar servidor',
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('tienda')
    .setDescription('🛒 Productos con botón "Comprar" que abre un ticket privado. Editás todo desde el panel.')
    .setDefaultMemberPermissions(F.ManageGuild),
  async run(c) {
    await c.reply(homePanel(c.app, c.guild, c.member.id), { ephemeral: true });
  },
};

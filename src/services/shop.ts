import { GameError, type GameContext } from './context';

/**
 * Tienda (/tienda): productos con su embed (título, descripción, precios, stock, imagen, color y texto del botón)
 * y tickets de compra. El botón "Comprar" abre un canal privado entre quien compra y el staff; la venta se
 * arregla ahí. Todo lo editable lo configura el staff del servidor.
 */

export interface ShopConfig {
  categoryId: string | null;
  staffRoleId: string | null;
  logChannelId: string | null;
}

export interface Product {
  id: number;
  guildId: string;
  title: string;
  description: string;
  priceArs: string;
  priceUsd: string;
  /** null = sin límite. */
  stock: number | null;
  imageUrl: string | null;
  color: number;
  button: string;
  channelId: string | null;
  messageId: string | null;
}

export interface Ticket {
  id: number;
  guildId: string;
  number: number;
  productId: number | null;
  userId: string;
  channelId: string | null;
  status: 'open' | 'closed';
  sold: boolean;
  createdAt: number;
}

export const SHOP_LIMITS = { products: 25, title: 120, description: 2000, price: 20, button: 40, image: 500, openPerUser: 3 } as const;

export const PRODUCT_DEFAULTS = {
  title: 'Nombre del producto',
  description: '**Descripción del producto.**\n> Editala con el botón ✏️ Textos.',
  color: 0x3498db,
  button: 'Comprar',
} as const;

// ───────────────────────── configuración ─────────────────────────

export function getShopConfig(ctx: GameContext, guildId: string): ShopConfig {
  const r = ctx.db.get<{ category_id: string | null; staff_role_id: string | null; log_channel_id: string | null }>(
    'SELECT category_id, staff_role_id, log_channel_id FROM shop_config WHERE guild_id = ?', guildId,
  );
  return { categoryId: r?.category_id ?? null, staffRoleId: r?.staff_role_id ?? null, logChannelId: r?.log_channel_id ?? null };
}

export function saveShopConfig(ctx: GameContext, guildId: string, patch: Partial<ShopConfig>): ShopConfig {
  const next = { ...getShopConfig(ctx, guildId), ...patch };
  for (const id of [next.categoryId, next.staffRoleId, next.logChannelId]) if (id !== null && !/^\d{17,20}$/.test(id)) throw new GameError('ID inválido.');
  ctx.db.run(
    `INSERT INTO shop_config (guild_id, category_id, staff_role_id, log_channel_id, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET category_id = excluded.category_id, staff_role_id = excluded.staff_role_id,
       log_channel_id = excluded.log_channel_id, updated_at = excluded.updated_at`,
    guildId, next.categoryId, next.staffRoleId, next.logChannelId, ctx.now(),
  );
  return next;
}

// ───────────────────────── productos ─────────────────────────

interface ProductRow {
  id: number; guild_id: string; title: string; description: string; price_ars: string; price_usd: string; stock: number | null;
  image_url: string | null; color: number; button: string; channel_id: string | null; message_id: string | null;
}

const toProduct = (r: ProductRow): Product => ({
  id: r.id, guildId: r.guild_id, title: r.title, description: r.description, priceArs: r.price_ars, priceUsd: r.price_usd, stock: r.stock,
  imageUrl: r.image_url, color: r.color, button: r.button, channelId: r.channel_id, messageId: r.message_id,
});

export function listProducts(ctx: GameContext, guildId: string): Product[] {
  return ctx.db.all<ProductRow>('SELECT * FROM shop_products WHERE guild_id = ? ORDER BY id', guildId).map(toProduct);
}

/** Siempre filtra por servidor: un ID de otro servidor no devuelve nada. */
export function getProduct(ctx: GameContext, guildId: string, id: number): Product {
  const r = Number.isSafeInteger(id) ? ctx.db.get<ProductRow>('SELECT * FROM shop_products WHERE guild_id = ? AND id = ?', guildId, id) : undefined;
  if (!r) throw new GameError('Ese producto ya no existe.');
  return toProduct(r);
}

export function createProduct(ctx: GameContext, guildId: string): Product {
  return ctx.db.transaction(() => {
    const n = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM shop_products WHERE guild_id = ?', guildId)!.n;
    if (n >= SHOP_LIMITS.products) throw new GameError(`Máximo ${SHOP_LIMITS.products} productos por servidor.`);
    const r = ctx.db.run(
      `INSERT INTO shop_products (guild_id, title, description, color, button, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      guildId, PRODUCT_DEFAULTS.title, PRODUCT_DEFAULTS.description, PRODUCT_DEFAULTS.color, PRODUCT_DEFAULTS.button, ctx.now(), ctx.now(),
    );
    return getProduct(ctx, guildId, Number(r.lastInsertRowid));
  });
}

/** "#FF66CC", "ff66cc" o vacío (= color por defecto). */
export function parseHexColor(raw: string): number {
  const v = raw.trim().replace(/^#/, '');
  if (!v) return PRODUCT_DEFAULTS.color;
  if (!/^[0-9a-f]{6}$/i.test(v)) throw new GameError('El color tiene que ser un código como `#3498DB`.');
  return parseInt(v, 16);
}

/** Vacío = sin límite. */
export function parseStock(raw: string): number | null {
  const v = raw.trim().replace(/\./g, '');
  if (!v || /^(ilimitado|infinito|∞|-)$/i.test(v)) return null;
  if (!/^\d{1,9}$/.test(v)) throw new GameError('El stock tiene que ser un número (o vacío para "sin límite").');
  return Number(v);
}

export function updateProductTexts(ctx: GameContext, guildId: string, id: number, t: { title: string; description: string; imageUrl: string; color: string; button: string }): Product {
  getProduct(ctx, guildId, id);
  const title = t.title.trim();
  const description = t.description.trim();
  const button = t.button.trim() || PRODUCT_DEFAULTS.button;
  const image = t.imageUrl.trim();
  if (!title || title.length > SHOP_LIMITS.title) throw new GameError(`El título tiene que tener entre 1 y ${SHOP_LIMITS.title} caracteres.`);
  if (!description || description.length > SHOP_LIMITS.description) throw new GameError(`La descripción tiene que tener entre 1 y ${SHOP_LIMITS.description} caracteres.`);
  if (button.length > SHOP_LIMITS.button) throw new GameError(`El texto del botón puede tener hasta ${SHOP_LIMITS.button} caracteres.`);
  if (image && (!/^https:\/\/\S+$/.test(image) || image.length > SHOP_LIMITS.image)) throw new GameError('La imagen tiene que ser un enlace que empiece con `https://`.');
  ctx.db.run('UPDATE shop_products SET title = ?, description = ?, image_url = ?, color = ?, button = ?, updated_at = ? WHERE guild_id = ? AND id = ?',
    title, description, image || null, parseHexColor(t.color), button, ctx.now(), guildId, id);
  return getProduct(ctx, guildId, id);
}

export function updateProductPrice(ctx: GameContext, guildId: string, id: number, p: { ars: string; usd: string; stock: string }): Product {
  getProduct(ctx, guildId, id);
  const ars = p.ars.trim();
  const usd = p.usd.trim();
  if (ars.length > SHOP_LIMITS.price || usd.length > SHOP_LIMITS.price) throw new GameError(`Cada precio puede tener hasta ${SHOP_LIMITS.price} caracteres.`);
  ctx.db.run('UPDATE shop_products SET price_ars = ?, price_usd = ?, stock = ?, updated_at = ? WHERE guild_id = ? AND id = ?',
    ars, usd, parseStock(p.stock), ctx.now(), guildId, id);
  return getProduct(ctx, guildId, id);
}

export function setProductMessage(ctx: GameContext, guildId: string, id: number, channelId: string | null, messageId: string | null): void {
  ctx.db.run('UPDATE shop_products SET channel_id = ?, message_id = ? WHERE guild_id = ? AND id = ?', channelId, messageId, guildId, id);
}

export function deleteProduct(ctx: GameContext, guildId: string, id: number): Product {
  const p = getProduct(ctx, guildId, id);
  ctx.db.run('DELETE FROM shop_products WHERE guild_id = ? AND id = ?', guildId, id);
  return p;
}

/** Venta confirmada: baja una unidad del stock (si tiene límite). Atómico: nunca queda negativo. */
export function consumeStock(ctx: GameContext, guildId: string, id: number): Product {
  const p = getProduct(ctx, guildId, id);
  if (p.stock === null) return p;
  const upd = ctx.db.run('UPDATE shop_products SET stock = stock - 1, updated_at = ? WHERE guild_id = ? AND id = ? AND stock > 0', ctx.now(), guildId, id);
  if (upd.changes !== 1) throw new GameError('Ese producto ya no tiene stock.');
  return getProduct(ctx, guildId, id);
}

// ───────────────────────── tickets ─────────────────────────

interface TicketRow {
  id: number; guild_id: string; number: number; product_id: number | null; user_id: string; channel_id: string | null;
  status: 'open' | 'closed'; sold: number; created_at: number;
}

const toTicket = (r: TicketRow): Ticket => ({
  id: r.id, guildId: r.guild_id, number: r.number, productId: r.product_id, userId: r.user_id, channelId: r.channel_id,
  status: r.status, sold: r.sold === 1, createdAt: r.created_at,
});

export function openTicketsOf(ctx: GameContext, guildId: string, userId: string): Ticket[] {
  return ctx.db.all<TicketRow>("SELECT * FROM shop_tickets WHERE guild_id = ? AND user_id = ? AND status = 'open' ORDER BY id", guildId, userId).map(toTicket);
}

export function ticketByChannel(ctx: GameContext, channelId: string): Ticket | null {
  const r = ctx.db.get<TicketRow>('SELECT * FROM shop_tickets WHERE channel_id = ?', channelId);
  return r ? toTicket(r) : null;
}

export function getTicket(ctx: GameContext, guildId: string, id: number): Ticket {
  const r = Number.isSafeInteger(id) ? ctx.db.get<TicketRow>('SELECT * FROM shop_tickets WHERE guild_id = ? AND id = ?', guildId, id) : undefined;
  if (!r) throw new GameError('Ese ticket ya no existe.');
  return toTicket(r);
}

/**
 * Reserva un ticket nuevo (antes de crear el canal): controla el stock, el ticket repetido del mismo producto
 * y el máximo de tickets abiertos por persona. Devuelve el ticket con su número.
 */
export function reserveTicket(ctx: GameContext, guildId: string, userId: string, productId: number): { ticket: Ticket; existing: boolean } {
  return ctx.db.transaction(() => {
    const p = getProduct(ctx, guildId, productId);
    const open = openTicketsOf(ctx, guildId, userId);
    const same = open.find((t) => t.productId === productId);
    if (same) return { ticket: same, existing: true };
    if (p.stock === 0) throw new GameError('😕 Este producto no tiene stock en este momento.');
    if (open.length >= SHOP_LIMITS.openPerUser) throw new GameError(`Ya tenés ${open.length} tickets abiertos. Cerrá alguno antes de abrir otro.`);
    ctx.db.run(`INSERT INTO shop_config (guild_id, ticket_counter, updated_at) VALUES (?, 1, ?)
                ON CONFLICT (guild_id) DO UPDATE SET ticket_counter = ticket_counter + 1`, guildId, ctx.now());
    const number = ctx.db.get<{ n: number }>('SELECT ticket_counter AS n FROM shop_config WHERE guild_id = ?', guildId)!.n;
    const r = ctx.db.run(`INSERT INTO shop_tickets (guild_id, number, product_id, user_id, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)`,
      guildId, number, productId, userId, ctx.now());
    return { ticket: getTicket(ctx, guildId, Number(r.lastInsertRowid)), existing: false };
  });
}

export function setTicketChannel(ctx: GameContext, ticketId: number, channelId: string): void {
  ctx.db.run('UPDATE shop_tickets SET channel_id = ? WHERE id = ?', channelId, ticketId);
}

/** No se pudo crear el canal: se descarta la reserva. */
export function dropTicket(ctx: GameContext, ticketId: number): void {
  ctx.db.run("DELETE FROM shop_tickets WHERE id = ? AND channel_id IS NULL AND status = 'open'", ticketId);
}

/** Marca la venta (una sola vez por ticket) y descuenta el stock. */
export function markSold(ctx: GameContext, guildId: string, ticketId: number): { ticket: Ticket; product: Product | null } {
  return ctx.db.transaction(() => {
    const t = getTicket(ctx, guildId, ticketId);
    if (t.sold) throw new GameError('Este ticket ya está marcado como vendido.');
    let product: Product | null = null;
    if (t.productId !== null) {
      try {
        product = consumeStock(ctx, guildId, t.productId);
      } catch (err) {
        // Si el producto se borró, la venta se registra igual; si no hay stock, se avisa.
        if (err instanceof GameError && /stock/.test(err.message)) throw err;
      }
    }
    ctx.db.run('UPDATE shop_tickets SET sold = 1 WHERE id = ?', ticketId);
    return { ticket: getTicket(ctx, guildId, ticketId), product };
  });
}

export function closeTicket(ctx: GameContext, ticketId: number, by: string | null): boolean {
  return ctx.db.run("UPDATE shop_tickets SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ? AND status = 'open'", ctx.now(), by, ticketId).changes === 1;
}

export function shopStats(ctx: GameContext, guildId: string): { open: number; sold: number; total: number } {
  const r = ctx.db.get<{ open: number; sold: number; total: number }>(
    "SELECT SUM(status = 'open') AS open, SUM(sold) AS sold, COUNT(*) AS total FROM shop_tickets WHERE guild_id = ?", guildId,
  );
  return { open: r?.open ?? 0, sold: r?.sold ?? 0, total: r?.total ?? 0 };
}

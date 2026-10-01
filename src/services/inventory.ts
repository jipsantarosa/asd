import { getItem } from '../game/config';
import { GameError, type GameContext } from './context';
import { gameConfig } from './guildSettings';

export interface InventoryRow {
  item_id: string;
  quantity: number;
}

const MAX_QTY = 1_000_000_000;

function assertQty(qty: number): void {
  if (!Number.isSafeInteger(qty) || qty <= 0 || qty > MAX_QTY) throw new GameError('Cantidad inválida.');
}

export function getQty(ctx: GameContext, guildId: string, userId: string, itemId: string): number {
  return ctx.db.get<{ quantity: number }>(
    'SELECT quantity FROM inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?', guildId, userId, itemId,
  )?.quantity ?? 0;
}

export function addItem(ctx: GameContext, guildId: string, userId: string, itemId: string, qty: number): void {
  assertQty(qty);
  if (!getItem(gameConfig(ctx, guildId), itemId)) throw new Error(`addItem: objeto desconocido ${itemId}`);
  ctx.db.run(
    `INSERT INTO inventory (guild_id, user_id, item_id, quantity) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity`,
    guildId, userId, itemId, qty,
  );
}

/** Resta de forma condicional: si no alcanza, no toca nada y lanza GameError. */
export function removeItem(ctx: GameContext, guildId: string, userId: string, itemId: string, qty: number): void {
  assertQty(qty);
  const r = ctx.db.run(
    'UPDATE inventory SET quantity = quantity - ? WHERE guild_id = ? AND user_id = ? AND item_id = ? AND quantity >= ?',
    qty, guildId, userId, itemId, qty,
  );
  if (r.changes !== 1) {
    const item = getItem(gameConfig(ctx, guildId), itemId);
    throw new GameError(`No tenés suficientes ${item ? `${item.emoji} ${item.name}` : itemId}.`);
  }
}

export function listInventory(ctx: GameContext, guildId: string, userId: string): InventoryRow[] {
  const cfg = gameConfig(ctx, guildId);
  // Se ignoran objetos que ya no existan en el catálogo (p. ej. tras editar game.config.json).
  return ctx.db
    .all<InventoryRow>('SELECT item_id, quantity FROM inventory WHERE guild_id = ? AND user_id = ? AND quantity > 0', guildId, userId)
    .filter((r) => getItem(cfg, r.item_id));
}

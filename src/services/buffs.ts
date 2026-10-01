import { getBuff } from '../game/config';
import type { BuffDef, BuffEffect } from '../game/types';
import { GameError, type GameContext } from './context';
import { gameConfig } from './guildSettings';

/** user_id reservado para buffs que afectan a todo el servidor (p. ej. "Marea dorada"). */
export const GUILD_WIDE = '*';

export interface ActiveBuff {
  def: BuffDef;
  expiresAt: number;
  guildWide: boolean;
}

export interface BuffTotals {
  luck: number;
  xpMult: number;
  baitSave: number;
  cooldownMult: number;
  extraLines: number;
  shopDiscount: number;
}

/** Buffs vigentes del jugador más los del servidor. Los vencidos se ignoran (y se limpian aparte). */
export function activeBuffs(ctx: GameContext, guildId: string, userId: string): ActiveBuff[] {
  const cfg = gameConfig(ctx, guildId);
  const now = ctx.now();
  const rows = ctx.db.all<{ user_id: string; buff_id: string; expires_at: number }>(
    'SELECT user_id, buff_id, expires_at FROM buffs WHERE guild_id = ? AND user_id IN (?, ?) AND expires_at > ? ORDER BY expires_at',
    guildId, userId, GUILD_WIDE, now,
  );
  const out: ActiveBuff[] = [];
  for (const r of rows) {
    const def = getBuff(cfg, r.buff_id);
    if (def) out.push({ def, expiresAt: r.expires_at, guildWide: r.user_id === GUILD_WIDE });
  }
  return out;
}

/**
 * Suma los efectos con topes duros: aunque se junten muchos buffs, ninguno rompe el balance.
 * La suerte tiene además su propio tope global en la pesca (tuning.fish.maxLuck).
 */
export function buffTotals(buffs: ActiveBuff[]): BuffTotals {
  const t: BuffTotals = { luck: 0, xpMult: 0, baitSave: 0, cooldownMult: 1, extraLines: 0, shopDiscount: 0 };
  for (const { def } of buffs) {
    const e: BuffEffect = def.effect;
    t.luck += e.luck ?? 0;
    t.xpMult += e.xpMult ?? 0;
    t.baitSave += e.baitSave ?? 0;
    if (e.cooldownMult !== undefined) t.cooldownMult *= e.cooldownMult;
    t.extraLines += e.extraLines ?? 0;
    t.shopDiscount = Math.max(t.shopDiscount, e.shopDiscount ?? 0);
  }
  t.xpMult = Math.min(t.xpMult, 2);
  t.baitSave = Math.min(t.baitSave, 0.5);
  t.cooldownMult = Math.max(t.cooldownMult, 0.4);
  t.extraLines = Math.min(t.extraLines, 2);
  t.shopDiscount = Math.min(t.shopDiscount, 0.5);
  return t;
}

/**
 * Activa (o extiende) un buff. Repetirlo suma duración hasta el tope `maxMinutes` del buff:
 * no se acumula la potencia, así que usar diez de golpe no sirve de nada.
 * Debe llamarse dentro de una transacción. Devuelve el nuevo vencimiento.
 */
export function applyBuff(ctx: GameContext, guildId: string, userId: string, buffId: string, source: string, minutesOverride?: number): number {
  const cfg = gameConfig(ctx, guildId);
  const def = getBuff(cfg, buffId);
  if (!def) throw new GameError('Ese potenciador no existe.');
  const now = ctx.now();
  const current = ctx.db.get<{ expires_at: number }>(
    'SELECT expires_at FROM buffs WHERE guild_id = ? AND user_id = ? AND buff_id = ?', guildId, userId, buffId,
  )?.expires_at ?? 0;
  const minutes = minutesOverride ?? def.minutes;
  const cap = now + Math.max(def.maxMinutes, minutes) * 60_000;
  if (current >= cap - 1000) throw new GameError(`${def.emoji} ${def.name} ya está al máximo de duración.`);
  const next = Math.min(Math.max(now, current) + minutes * 60_000, cap);
  ctx.db.run(
    `INSERT INTO buffs (guild_id, user_id, buff_id, expires_at, source) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id, buff_id) DO UPDATE SET expires_at = excluded.expires_at, source = excluded.source`,
    guildId, userId, buffId, next, source.slice(0, 60),
  );
  return next;
}

/** Descuento vigente del Mercado para este jugador (0..0.5). */
export function shopDiscount(ctx: GameContext, guildId: string, userId: string): { discount: number; until: number } {
  const buffs = activeBuffs(ctx, guildId, userId).filter((b) => (b.def.effect.shopDiscount ?? 0) > 0);
  return { discount: buffTotals(buffs).shopDiscount, until: buffs.reduce((m, b) => Math.max(m, b.expiresAt), 0) };
}

export function pruneBuffs(ctx: GameContext): void {
  ctx.db.run('DELETE FROM buffs WHERE expires_at < ?', ctx.now() - 60_000);
}

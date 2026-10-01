import { getEquipLine, getZone } from '../game/config';
import type { EquipSlot, EquipStats, FarmZone, GameConfig, UpgradeDef } from '../game/types';
import { GameError, type GameContext } from './context';
import { gameConfig } from './guildSettings';
import { addItem } from './inventory';

export interface ProfileRow {
  guild_id: string;
  user_id: string;
  coins: number;
  vigor: number;
  vigor_updated_at: number;
  fatigue: number;
  fatigue_updated_at: number;
  farm_level: number;
  farm_xp: number;
  fish_level: number;
  fish_xp: number;
  farm_zone: string;
  /** Columnas heredadas de la pesca anterior (se conservan, ya no se usan). */
  fish_spot: string;
  bait_id: string;
  rod_id: string;
  /** Tiradas seguidas sin Épico+ (racha de la suerte). */
  fish_pity: number;
  activity_points: number;
  fertilizer: number;
  farms_total: number;
  catches_total: number;
  last_farm_json: string | null;
  created_at: number;
  updated_at: number;
}

export type UpgradeId = UpgradeDef['id'];
export type UpgradeLevels = Record<UpgradeId, number>;
export type EquipTiers = Record<EquipSlot, number>;

export const SLOTS: EquipSlot[] = ['herramienta', 'accesorio'];

export function getProfile(ctx: GameContext, guildId: string, userId: string): ProfileRow | undefined {
  return ctx.db.get<ProfileRow>('SELECT * FROM profiles WHERE guild_id = ? AND user_id = ?', guildId, userId);
}

/** Crea el perfil con el kit inicial si no existe. Idempotente y seguro ante llamadas simultáneas. */
export function ensureProfile(ctx: GameContext, guildId: string, userId: string): ProfileRow {
  return ctx.db.transaction(() => {
    const existing = getProfile(ctx, guildId, userId);
    if (existing) return existing;
    const cfg = gameConfig(ctx, guildId);
    const now = ctx.now();
    const r = ctx.db.run(
      `INSERT OR IGNORE INTO profiles
        (guild_id, user_id, coins, vigor, vigor_updated_at, fatigue, fatigue_updated_at,
         farm_zone, fish_spot, bait_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      guildId, userId, cfg.starter.coins, cfg.tuning.vigor.base, now, now,
      cfg.farming.zones[0].id, 'arroyo', cfg.fishing.baitItemId, now, now,
    );
    if (r.changes === 1) {
      for (const s of cfg.starter.items) addItem(ctx, guildId, userId, s.itemId, s.qty);
      ctx.db.run(
        'INSERT INTO ledger (guild_id, user_id, delta, balance, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        guildId, userId, cfg.starter.coins, cfg.starter.coins, 'kit inicial', now,
      );
    }
    return getProfile(ctx, guildId, userId)!;
  });
}

// ───────────────────────── Mejoras permanentes ─────────────────────────

export function getUpgradeLevels(ctx: GameContext, guildId: string, userId: string): UpgradeLevels {
  const out: UpgradeLevels = { vigor_max: 0, vigor_regen: 0, suerte: 0, negociante: 0 };
  const cfg = gameConfig(ctx, guildId);
  for (const row of ctx.db.all<{ upgrade_id: string; level: number }>(
    'SELECT upgrade_id, level FROM upgrades WHERE guild_id = ? AND user_id = ?', guildId, userId,
  )) {
    const def = cfg.upgrades.find((u) => u.id === row.upgrade_id);
    if (def) out[def.id] = Math.min(row.level, def.maxLevel);
  }
  return out;
}

function upgradeEffect(cfg: GameConfig, levels: UpgradeLevels, id: UpgradeId): number {
  const def = cfg.upgrades.find((u) => u.id === id);
  return def ? def.perLevel * levels[id] : 0;
}

export function luckBonus(cfg: GameConfig, levels: UpgradeLevels): number {
  return upgradeEffect(cfg, levels, 'suerte');
}

export function sellBonus(cfg: GameConfig, levels: UpgradeLevels): number {
  return upgradeEffect(cfg, levels, 'negociante');
}

// ───────────────────────── Vigor ─────────────────────────

export interface VigorState {
  current: number;
  max: number;
  regenMs: number;
  /** Momento en que el vigor estará lleno (ms epoch). */
  fullAt: number;
}

export function vigorState(cfg: GameConfig, p: ProfileRow, levels: UpgradeLevels, now: number): VigorState {
  const max = cfg.tuning.vigor.base + upgradeEffect(cfg, levels, 'vigor_max');
  const regenMs = (cfg.tuning.vigor.regenSeconds * 1000) / (1 + upgradeEffect(cfg, levels, 'vigor_regen'));
  const elapsed = Math.max(0, now - p.vigor_updated_at);
  const current = p.vigor >= max ? max : Math.min(max, p.vigor + elapsed / regenMs);
  return { current, max, regenMs, fullAt: now + Math.max(0, max - current) * regenMs };
}

/** Descuenta vigor. Debe llamarse dentro de una transacción. */
export function spendVigor(ctx: GameContext, p: ProfileRow, amount: number): number {
  const cfg = gameConfig(ctx, p.guild_id);
  const now = ctx.now();
  const st = vigorState(cfg, p, getUpgradeLevels(ctx, p.guild_id, p.user_id), now);
  if (st.current + 1e-9 < amount) {
    const readyAt = now + Math.ceil((amount - st.current) * st.regenMs);
    throw new GameError(`Te falta vigor (${Math.floor(st.current)}/${amount}). Tendrás suficiente <t:${Math.ceil(readyAt / 1000)}:R>.`, readyAt);
  }
  const left = st.current - amount;
  ctx.db.run('UPDATE profiles SET vigor = ?, vigor_updated_at = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
    left, now, now, p.guild_id, p.user_id);
  return left;
}

export function restoreVigor(ctx: GameContext, p: ProfileRow, amount: number): number {
  const cfg = gameConfig(ctx, p.guild_id);
  const now = ctx.now();
  const st = vigorState(cfg, p, getUpgradeLevels(ctx, p.guild_id, p.user_id), now);
  if (st.current >= st.max - 0.5) throw new GameError('Tu vigor ya está al máximo.');
  const next = Math.min(st.max, st.current + amount);
  ctx.db.run('UPDATE profiles SET vigor = ?, vigor_updated_at = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
    next, now, now, p.guild_id, p.user_id);
  return next;
}

// ───────────────────────── Cansancio (anti-farmeo masivo) ─────────────────────────

export function currentFatigue(cfg: GameConfig, p: ProfileRow, now: number): number {
  const minutes = Math.max(0, now - p.fatigue_updated_at) / 60_000;
  return Math.max(0, p.fatigue - cfg.tuning.fatigue.decayPerMinute * minutes);
}

export function fatigueMultiplier(cfg: GameConfig, fatigue: number): number {
  const f = cfg.tuning.fatigue;
  if (fatigue <= f.threshold) return 1;
  return Math.max(f.floor, 1 - (fatigue - f.threshold) * f.step);
}

/** Suma cansancio por una acción y devuelve el multiplicador de rendimiento resultante. */
export function addFatigue(ctx: GameContext, p: ProfileRow): number {
  const cfg = gameConfig(ctx, p.guild_id);
  const now = ctx.now();
  const next = currentFatigue(cfg, p, now) + cfg.tuning.fatigue.perAction;
  ctx.db.run('UPDATE profiles SET fatigue = ?, fatigue_updated_at = ? WHERE guild_id = ? AND user_id = ?',
    next, now, p.guild_id, p.user_id);
  return fatigueMultiplier(cfg, next);
}

// ───────────────────────── Equipamiento ─────────────────────────

export function getEquipTiers(ctx: GameContext, guildId: string, userId: string): EquipTiers {
  const cfg = gameConfig(ctx, guildId);
  const out: EquipTiers = { herramienta: 0, accesorio: 0 };
  for (const row of ctx.db.all<{ slot: EquipSlot; tier: number }>(
    'SELECT slot, tier FROM equipment WHERE guild_id = ? AND user_id = ?', guildId, userId,
  )) {
    if (row.slot in out) out[row.slot] = Math.min(row.tier, getEquipLine(cfg, row.slot).tiers.length - 1);
  }
  return out;
}

const EMPTY_STATS: EquipStats = { yieldMult: 1, extraRolls: 0, vigorDiscount: 0, rareBonus: 0 };

export function equipStats(cfg: GameConfig, tiers: EquipTiers, slots: EquipSlot[]): EquipStats {
  const s = { ...EMPTY_STATS };
  for (const slot of slots) {
    const t = getEquipLine(cfg, slot).tiers[tiers[slot]]?.stats ?? {};
    if (t.yieldMult !== undefined) s.yieldMult *= t.yieldMult;
    s.extraRolls += t.extraRolls ?? 0;
    s.vigorDiscount += t.vigorDiscount ?? 0;
    s.rareBonus += t.rareBonus ?? 0;
  }
  s.vigorDiscount = Math.min(0.6, s.vigorDiscount);
  return s;
}

// ───────────────────────── Desbloqueos (zonas de cultivo) ─────────────────────────

export type UnlockKind = 'zona';

export function unlockTarget(cfg: GameConfig, _kind: UnlockKind, id: string): FarmZone | undefined {
  return getZone(cfg, id);
}

export function isUnlocked(ctx: GameContext, guildId: string, userId: string, kind: UnlockKind, id: string): boolean {
  const cfg = gameConfig(ctx, guildId);
  const target = unlockTarget(cfg, kind, id);
  if (!target) return false;
  if (target.unlockCost === 0 && target.unlockItems.length === 0) return true;
  return !!ctx.db.get('SELECT 1 FROM unlocks WHERE guild_id = ? AND user_id = ? AND unlock_id = ?', guildId, userId, `${kind}:${id}`);
}

export function totalLevel(p: ProfileRow): number {
  return p.farm_level + p.fish_level;
}

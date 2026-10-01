import { applyTunables, normalizeTunable } from '../game/config';
import type { GameConfig } from '../game/types';
import { GameError, type GameContext, type GuildSettingsCache } from './context';

interface SettingsRow {
  prefix: string;
  tunables: string;
}

export const PREFIX_MAX_LENGTH = 5;

function parseTunables(raw: string): Record<string, number> {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      const n = normalizeTunable(k, Number(v));
      if (n !== null) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export function getSettings(ctx: GameContext, guildId: string): GuildSettingsCache {
  const cached = ctx.cache.settings.get(guildId);
  if (cached) return cached;
  const row = ctx.db.get<SettingsRow>('SELECT prefix, tunables FROM guild_settings WHERE guild_id = ?', guildId);
  const value: GuildSettingsCache = row
    ? { prefix: row.prefix, tunables: parseTunables(row.tunables) }
    : { prefix: ctx.defaultPrefix, tunables: {} };
  ctx.cache.settings.set(guildId, value);
  return value;
}

export function ensureSettings(ctx: GameContext, guildId: string): void {
  const now = ctx.now();
  ctx.db.run(
    `INSERT OR IGNORE INTO guild_settings (guild_id, prefix, tunables, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)`,
    guildId, ctx.defaultPrefix, now, now,
  );
}

function invalidate(ctx: GameContext, guildId: string): void {
  ctx.cache.settings.delete(guildId);
  ctx.cache.configs.delete(guildId);
}

/** Valida un prefijo: 1-5 caracteres visibles, sin espacios, sin menciones ni formato de Discord. */
export function validatePrefix(raw: string): string {
  const prefix = raw.trim();
  if (prefix.length < 1 || prefix.length > PREFIX_MAX_LENGTH) {
    throw new GameError(`El prefijo debe tener entre 1 y ${PREFIX_MAX_LENGTH} caracteres.`);
  }
  if (/\s/.test(prefix)) throw new GameError('El prefijo no puede contener espacios.');
  if (/[`*_~|<>@#]/.test(prefix)) throw new GameError('El prefijo no puede usar ` * _ ~ | < > @ #.');
  return prefix;
}

export function setPrefix(ctx: GameContext, guildId: string, raw: string): string {
  const prefix = validatePrefix(raw);
  ctx.db.transaction(() => {
    ensureSettings(ctx, guildId);
    ctx.db.run('UPDATE guild_settings SET prefix = ?, updated_at = ? WHERE guild_id = ?', prefix, ctx.now(), guildId);
  });
  invalidate(ctx, guildId);
  return prefix;
}

export function setTunable(ctx: GameContext, guildId: string, key: string, value: number): number {
  const normalized = normalizeTunable(key, value);
  if (normalized === null) throw new GameError('Valor inválido o fuera de rango para ese ajuste.');
  ctx.db.transaction(() => {
    ensureSettings(ctx, guildId);
    const row = ctx.db.get<SettingsRow>('SELECT prefix, tunables FROM guild_settings WHERE guild_id = ?', guildId);
    const current = parseTunables(row?.tunables ?? '{}');
    current[key] = normalized;
    ctx.db.run('UPDATE guild_settings SET tunables = ?, updated_at = ? WHERE guild_id = ?', JSON.stringify(current), ctx.now(), guildId);
  });
  invalidate(ctx, guildId);
  return normalized;
}

export function resetTunable(ctx: GameContext, guildId: string, key: string | 'all'): void {
  ctx.db.transaction(() => {
    ensureSettings(ctx, guildId);
    const row = ctx.db.get<SettingsRow>('SELECT prefix, tunables FROM guild_settings WHERE guild_id = ?', guildId);
    const current = key === 'all' ? {} : parseTunables(row?.tunables ?? '{}');
    if (key !== 'all') delete current[key];
    ctx.db.run('UPDATE guild_settings SET tunables = ?, updated_at = ? WHERE guild_id = ?', JSON.stringify(current), ctx.now(), guildId);
  });
  invalidate(ctx, guildId);
}

/** Configuración efectiva del juego para un servidor (base + ajustes del servidor). */
export function gameConfig(ctx: GameContext, guildId: string): GameConfig {
  const cached = ctx.cache.configs.get(guildId);
  if (cached) return cached;
  const cfg = applyTunables(ctx.baseConfig, getSettings(ctx, guildId).tunables);
  ctx.cache.configs.set(guildId, cfg);
  return cfg;
}

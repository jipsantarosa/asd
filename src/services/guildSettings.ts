import { GameError, type GameContext, type GuildSettingsCache } from './context';

/** Ajustes por servidor que no son del casino: el prefijo de los comandos de texto. */

export const PREFIX_MAX_LENGTH = 5;

export function getSettings(ctx: GameContext, guildId: string): GuildSettingsCache {
  const cached = ctx.cache.settings.get(guildId);
  if (cached) return cached;
  const row = ctx.db.get<{ prefix: string }>('SELECT prefix FROM guild_settings WHERE guild_id = ?', guildId);
  const value: GuildSettingsCache = { prefix: row?.prefix ?? ctx.defaultPrefix };
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
  ctx.cache.settings.delete(guildId);
  return prefix;
}

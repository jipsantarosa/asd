import { GameError, type GameContext } from '../services/context';

/**
 * Ajustes del casino propios de cada servidor (los maneja el staff con /ajustes, no el dueño del bot):
 * - canal de anuncios (grandes premios, torneos, lluvias de monedas);
 * - canales de juego: si hay alguno, los juegos solo se pueden usar ahí (vacío = en cualquier canal);
 * - recompensas por actividad en este servidor (on/off).
 */

export const MAX_GAME_CHANNELS = 10;
const SNOWFLAKE = /^\d{17,20}$/;

export interface CasinoGuild {
  guildId: string;
  announceChannelId: string | null;
  gameChannels: string[];
  activityEnabled: boolean;
}

interface Raw {
  guild_id: string;
  announce_channel_id: string | null;
  game_channels: string;
  activity_enabled: number;
}

function parseChannels(raw: string): string[] {
  try {
    const a = JSON.parse(raw) as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && SNOWFLAKE.test(x)).slice(0, MAX_GAME_CHANNELS) : [];
  } catch {
    return [];
  }
}

export function getCasinoGuild(ctx: GameContext, guildId: string): CasinoGuild {
  const r = ctx.db.get<Raw>('SELECT * FROM casino_guild_settings WHERE guild_id = ?', guildId);
  return {
    guildId,
    announceChannelId: r?.announce_channel_id ?? null,
    gameChannels: r ? parseChannels(r.game_channels) : [],
    activityEnabled: r ? r.activity_enabled === 1 : true,
  };
}

function save(ctx: GameContext, g: CasinoGuild): CasinoGuild {
  ctx.db.run(
    `INSERT INTO casino_guild_settings (guild_id, announce_channel_id, game_channels, activity_enabled, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET announce_channel_id = excluded.announce_channel_id, game_channels = excluded.game_channels,
       activity_enabled = excluded.activity_enabled, updated_at = excluded.updated_at`,
    g.guildId, g.announceChannelId, JSON.stringify(g.gameChannels), g.activityEnabled ? 1 : 0, ctx.now(),
  );
  return getCasinoGuild(ctx, g.guildId);
}

export function setAnnounceChannel(ctx: GameContext, guildId: string, channelId: string | null): CasinoGuild {
  if (channelId !== null && !SNOWFLAKE.test(channelId)) throw new GameError('Canal inválido.');
  return save(ctx, { ...getCasinoGuild(ctx, guildId), announceChannelId: channelId });
}

export function setGameChannels(ctx: GameContext, guildId: string, channelIds: string[]): CasinoGuild {
  const ids = [...new Set(channelIds)].filter((id) => SNOWFLAKE.test(id));
  if (ids.length > MAX_GAME_CHANNELS) throw new GameError(`Podés elegir hasta ${MAX_GAME_CHANNELS} canales de juego.`);
  return save(ctx, { ...getCasinoGuild(ctx, guildId), gameChannels: ids });
}

export function setActivityEnabled(ctx: GameContext, guildId: string, on: boolean): CasinoGuild {
  return save(ctx, { ...getCasinoGuild(ctx, guildId), activityEnabled: on });
}

/** Quita un canal borrado de los ajustes. */
export function forgetChannel(ctx: GameContext, guildId: string, channelId: string): void {
  const g = getCasinoGuild(ctx, guildId);
  if (g.announceChannelId !== channelId && !g.gameChannels.includes(channelId)) return;
  save(ctx, { ...g, announceChannelId: g.announceChannelId === channelId ? null : g.announceChannelId, gameChannels: g.gameChannels.filter((c) => c !== channelId) });
}

/** ¿Se puede jugar en este canal? (Sin canales configurados, en cualquiera.) Los hilos heredan del canal padre. */
export function canPlayIn(g: CasinoGuild, channelId: string, parentId: string | null): boolean {
  return !g.gameChannels.length || g.gameChannels.includes(channelId) || (!!parentId && g.gameChannels.includes(parentId));
}

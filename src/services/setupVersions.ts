import type { GameContext } from './context';

/**
 * Versión del diseño de los canales que crea el bot. Subila cuando cambie algo de lo que crea /setup o /voz
 * (nombres, descripciones, permisos, canales nuevos): al arrancar, cada servidor con una versión anterior
 * se sincroniza solo (sin borrar nada) y queda un resumen en el canal de sistema.
 */
export const LAYOUT_VERSIONS = { logs: 3, voice: 4 } as const;
export type SetupSystem = keyof typeof LAYOUT_VERSIONS;

export function getSetupVersion(ctx: GameContext, guildId: string, system: SetupSystem): number {
  return ctx.db.get<{ version: number }>('SELECT version FROM setup_versions WHERE guild_id = ? AND system = ?', guildId, system)?.version ?? 0;
}

export function markSetupVersion(ctx: GameContext, guildId: string, system: SetupSystem, version: number = LAYOUT_VERSIONS[system]): void {
  ctx.db.run(`INSERT INTO setup_versions (guild_id, system, version, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT (guild_id, system) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`, guildId, system, version, ctx.now());
}

/** Servidores que ya tenían el sistema configurado y quedaron con una versión vieja del diseño. */
export function outdatedGuilds(ctx: GameContext, system: SetupSystem): string[] {
  const sql = system === 'logs'
    ? 'SELECT guild_id FROM log_config WHERE category_id IS NOT NULL'
    : 'SELECT guild_id FROM voice_config WHERE hub_channel_id IS NOT NULL';
  return ctx.db.all<{ guild_id: string }>(sql).map((r) => r.guild_id).filter((g) => getSetupVersion(ctx, g, system) < LAYOUT_VERSIONS[system]);
}

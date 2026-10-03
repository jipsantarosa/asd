import { GameError, type GameContext } from './context';

/** Roles automáticos (/autorol): uno para las personas que entran y otro para los bots. */

export type AutoRoleKind = 'members' | 'bots';

export interface AutoRoles {
  members: string | null;
  bots: string | null;
}

const COLUMN: Record<AutoRoleKind, string> = { members: 'member_role', bots: 'bot_role' };

export function getAutoRoles(ctx: GameContext, guildId: string): AutoRoles {
  const r = ctx.db.get<{ member_role: string | null; bot_role: string | null }>('SELECT member_role, bot_role FROM auto_roles WHERE guild_id = ?', guildId);
  return { members: r?.member_role ?? null, bots: r?.bot_role ?? null };
}

/** roleId null = desactivar ese autorol. */
export function setAutoRole(ctx: GameContext, guildId: string, kind: AutoRoleKind, roleId: string | null): AutoRoles {
  if (roleId !== null && !/^\d{17,20}$/.test(roleId)) throw new GameError('Rol inválido.');
  const col = COLUMN[kind];
  ctx.db.run(
    `INSERT INTO auto_roles (guild_id, ${col}, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET ${col} = excluded.${col}, updated_at = excluded.updated_at`,
    guildId, roleId, ctx.now(),
  );
  return getAutoRoles(ctx, guildId);
}

/** El rol que le toca a quien entra: el de bots si es un bot, el de miembros si es una persona. */
export function autoRoleFor(ctx: GameContext, guildId: string, isBot: boolean): string | null {
  const a = getAutoRoles(ctx, guildId);
  return isBot ? a.bots : a.members;
}

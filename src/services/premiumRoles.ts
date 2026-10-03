import { GameError, type GameContext } from './context';
import { TIERS, type PremiumTier } from './premium';

/** Roles premium (/rolespremium): un rol por nivel en cada servidor. Quien tiene premium recibe el de su nivel. */

export type PremiumRoles = Partial<Record<PremiumTier, string>>;

export const PREMIUM_ROLE_DEFAULTS: Record<PremiumTier, { name: string; color: number }> = {
  1: { name: `Premium ${TIERS[1].name}`, color: 0x5dade2 },
  2: { name: `Premium ${TIERS[2].name}`, color: 0xf1c40f },
  3: { name: `Premium ${TIERS[3].name}`, color: 0xe67e22 },
  4: { name: `Premium ${TIERS[4].name}`, color: 0x9b59b6 },
};

export function getPremiumRoles(ctx: GameContext, guildId: string): PremiumRoles {
  const out: PremiumRoles = {};
  for (const r of ctx.db.all<{ tier: PremiumTier; role_id: string }>('SELECT tier, role_id FROM premium_roles WHERE guild_id = ?', guildId)) out[r.tier] = r.role_id;
  return out;
}

export function setPremiumRole(ctx: GameContext, guildId: string, tier: number, roleId: string | null): PremiumRoles {
  if (![1, 2, 3, 4].includes(tier)) throw new GameError('El nivel tiene que ser 1, 2, 3 o 4.');
  if (roleId === null) {
    ctx.db.run('DELETE FROM premium_roles WHERE guild_id = ? AND tier = ?', guildId, tier);
    return getPremiumRoles(ctx, guildId);
  }
  if (!/^\d{17,20}$/.test(roleId)) throw new GameError('Rol inválido.');
  const other = Object.entries(getPremiumRoles(ctx, guildId)).find(([t, id]) => id === roleId && Number(t) !== tier);
  if (other) throw new GameError(`Ese rol ya es el del nivel ${other[0]}. Usá un rol distinto para cada nivel.`);
  ctx.db.run(
    `INSERT INTO premium_roles (guild_id, tier, role_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, tier) DO UPDATE SET role_id = excluded.role_id, updated_at = excluded.updated_at`,
    guildId, tier, roleId, ctx.now(),
  );
  return getPremiumRoles(ctx, guildId);
}

export function clearPremiumRoles(ctx: GameContext, guildId: string): void {
  ctx.db.run('DELETE FROM premium_roles WHERE guild_id = ?', guildId);
}

/** Qué roles premium tiene que tener alguien: solo el de su nivel (0 = ninguno). Devuelve qué agregar y qué quitar. */
export function premiumRoleChanges(roles: PremiumRoles, tier: PremiumTier | 0, has: (roleId: string) => boolean): { add: string[]; remove: string[] } {
  const want = tier ? roles[tier] : undefined;
  const add = want && !has(want) ? [want] : [];
  const remove = Object.values(roles).filter((id): id is string => !!id && id !== want && has(id));
  return { add, remove };
}

/** Servidores con roles premium configurados (para sincronizar). */
export function guildsWithPremiumRoles(ctx: GameContext): string[] {
  return ctx.db.all<{ guild_id: string }>('SELECT DISTINCT guild_id FROM premium_roles').map((r) => r.guild_id);
}

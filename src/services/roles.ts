import { GameError, type GameContext } from './context';

export type RoleMode = 'libre' | 'unico';
export type RewardSkill = 'granja' | 'pesca' | 'total' | 'actividad';
export const REWARD_SKILLS: RewardSkill[] = ['granja', 'pesca', 'total', 'actividad'];

export interface RoleGroup {
  id: number;
  guild_id: string;
  name: string;
  description: string;
  mode: RoleMode;
  min_total_level: number;
  channel_id: string | null;
  message_id: string | null;
  roles: string[];
}

export interface RoleReward {
  role_id: string;
  skill: RewardSkill;
  level: number;
}

export const MAX_GROUPS = 15;
export const MAX_ROLES_PER_GROUP = 25;
export const MAX_REWARDS = 25;

type GroupRow = Omit<RoleGroup, 'roles'>;

function withRoles(ctx: GameContext, row: GroupRow): RoleGroup {
  const roles = ctx.db.all<{ role_id: string }>('SELECT role_id FROM role_group_entries WHERE group_id = ? ORDER BY position, role_id', row.id)
    .map((r) => r.role_id);
  return { ...row, roles };
}

export function listGroups(ctx: GameContext, guildId: string): RoleGroup[] {
  return ctx.db.all<GroupRow>('SELECT * FROM role_groups WHERE guild_id = ? ORDER BY id', guildId).map((r) => withRoles(ctx, r));
}

/** Siempre filtra por servidor: un ID manipulado de otro servidor no devuelve nada. */
export function getGroup(ctx: GameContext, guildId: string, id: number): RoleGroup {
  const row = ctx.db.get<GroupRow>('SELECT * FROM role_groups WHERE guild_id = ? AND id = ?', guildId, id);
  if (!row) throw new GameError('Ese grupo de roles ya no existe.');
  return withRoles(ctx, row);
}

function cleanText(raw: string, max: number): string {
  return raw.replace(/@(everyone|here)/g, '@\u200b$1').trim().slice(0, max);
}

export function createGroup(ctx: GameContext, guildId: string, name: string, description: string, minTotalLevel: number): RoleGroup {
  return ctx.db.transaction(() => {
    const count = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM role_groups WHERE guild_id = ?', guildId)!.n;
    if (count >= MAX_GROUPS) throw new GameError(`Máximo ${MAX_GROUPS} grupos por servidor.`);
    const n = cleanText(name, 60);
    if (!n) throw new GameError('El grupo necesita un nombre.');
    const r = ctx.db.run(
      `INSERT INTO role_groups (guild_id, name, description, mode, min_total_level, created_at) VALUES (?, ?, ?, 'libre', ?, ?)`,
      guildId, n, cleanText(description, 300), Math.max(0, Math.min(500, Math.floor(minTotalLevel) || 0)), ctx.now(),
    );
    return getGroup(ctx, guildId, Number(r.lastInsertRowid));
  });
}

export function updateGroupText(ctx: GameContext, guildId: string, id: number, name: string, description: string, minTotalLevel: number): RoleGroup {
  getGroup(ctx, guildId, id);
  const n = cleanText(name, 60);
  if (!n) throw new GameError('El grupo necesita un nombre.');
  ctx.db.run('UPDATE role_groups SET name = ?, description = ?, min_total_level = ? WHERE guild_id = ? AND id = ?',
    n, cleanText(description, 300), Math.max(0, Math.min(500, Math.floor(minTotalLevel) || 0)), guildId, id);
  return getGroup(ctx, guildId, id);
}

export function toggleMode(ctx: GameContext, guildId: string, id: number): RoleGroup {
  const g = getGroup(ctx, guildId, id);
  ctx.db.run('UPDATE role_groups SET mode = ? WHERE guild_id = ? AND id = ?', g.mode === 'libre' ? 'unico' : 'libre', guildId, id);
  return getGroup(ctx, guildId, id);
}

export function addRolesToGroup(ctx: GameContext, guildId: string, id: number, roleIds: string[]): RoleGroup {
  return ctx.db.transaction(() => {
    const g = getGroup(ctx, guildId, id);
    const merged = [...new Set([...g.roles, ...roleIds])];
    if (merged.length > MAX_ROLES_PER_GROUP) throw new GameError(`Un grupo admite como máximo ${MAX_ROLES_PER_GROUP} roles.`);
    let pos = g.roles.length;
    for (const roleId of roleIds) {
      if (!/^\d{17,20}$/.test(roleId)) continue;
      ctx.db.run('INSERT OR IGNORE INTO role_group_entries (group_id, role_id, position) VALUES (?, ?, ?)', id, roleId, pos++);
    }
    return getGroup(ctx, guildId, id);
  });
}

export function removeRoleFromGroup(ctx: GameContext, guildId: string, id: number, roleId: string): RoleGroup {
  getGroup(ctx, guildId, id);
  ctx.db.run('DELETE FROM role_group_entries WHERE group_id = ? AND role_id = ?', id, roleId);
  return getGroup(ctx, guildId, id);
}

export function setPublished(ctx: GameContext, guildId: string, id: number, channelId: string | null, messageId: string | null): void {
  ctx.db.run('UPDATE role_groups SET channel_id = ?, message_id = ? WHERE guild_id = ? AND id = ?', channelId, messageId, guildId, id);
}

export function deleteGroup(ctx: GameContext, guildId: string, id: number): RoleGroup {
  const g = getGroup(ctx, guildId, id);
  ctx.db.transaction(() => {
    ctx.db.run('DELETE FROM role_group_entries WHERE group_id = ?', id);
    ctx.db.run('DELETE FROM role_groups WHERE guild_id = ? AND id = ?', guildId, id);
  });
  return g;
}

/** Quita un rol eliminado del servidor de todos los grupos y recompensas. */
export function forgetRole(ctx: GameContext, guildId: string, roleId: string): void {
  ctx.db.transaction(() => {
    ctx.db.run(`DELETE FROM role_group_entries WHERE role_id = ? AND group_id IN (SELECT id FROM role_groups WHERE guild_id = ?)`, roleId, guildId);
    ctx.db.run('DELETE FROM role_rewards WHERE guild_id = ? AND role_id = ?', guildId, roleId);
  });
}

// ───────────────────────── Distinciones (roles por progreso) ─────────────────────────

export function listRewards(ctx: GameContext, guildId: string): RoleReward[] {
  return ctx.db.all<RoleReward>('SELECT role_id, skill, level FROM role_rewards WHERE guild_id = ? ORDER BY skill, level', guildId);
}

export function setReward(ctx: GameContext, guildId: string, roleId: string, skill: RewardSkill, level: number): void {
  if (!REWARD_SKILLS.includes(skill)) throw new GameError('Habilidad inválida: usá granja, pesca, total o actividad.');
  const max = skill === 'actividad' ? 10_000_000 : 500;
  if (!Number.isSafeInteger(level) || level < 1 || level > max) {
    throw new GameError(skill === 'actividad' ? 'Los puntos de actividad deben estar entre 1 y 10.000.000.' : 'El nivel debe estar entre 1 y 500.');
  }
  ctx.db.transaction(() => {
    const exists = ctx.db.get('SELECT 1 FROM role_rewards WHERE guild_id = ? AND role_id = ?', guildId, roleId);
    const n = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM role_rewards WHERE guild_id = ?', guildId)!.n;
    if (!exists && n >= MAX_REWARDS) throw new GameError(`Máximo ${MAX_REWARDS} distinciones.`);
    ctx.db.run(`INSERT INTO role_rewards (guild_id, role_id, skill, level) VALUES (?, ?, ?, ?)
                ON CONFLICT (guild_id, role_id) DO UPDATE SET skill = excluded.skill, level = excluded.level`,
      guildId, roleId, skill, level);
  });
}

export function removeReward(ctx: GameContext, guildId: string, roleId: string): void {
  ctx.db.run('DELETE FROM role_rewards WHERE guild_id = ? AND role_id = ?', guildId, roleId);
}

export interface RewardProgress {
  farm_level: number;
  fish_level: number;
  activity_points: number;
}

export function rewardValue(skill: RewardSkill, p: RewardProgress): number {
  switch (skill) {
    case 'granja': return p.farm_level;
    case 'pesca': return p.fish_level;
    case 'total': return p.farm_level + p.fish_level;
    case 'actividad': return p.activity_points;
    default: return 0;
  }
}

/** Distinciones que corresponden a un jugador (por nivel o por puntos de actividad). */
export function eligibleRewards(rewards: RoleReward[], p: RewardProgress): RoleReward[] {
  return rewards.filter((r) => rewardValue(r.skill, p) >= r.level);
}

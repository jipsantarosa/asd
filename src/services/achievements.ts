import { getItem } from '../game/config';
import type { AchievementDef, AchievementTier, GameConfig } from '../game/types';
import { awardActivity } from './activity';
import type { GameContext } from './context';
import { gameConfig } from './guildSettings';
import { getProfile, totalLevel, type ProfileRow } from './player';
import { grantReward } from './rewards';
import { getStats } from './stats';

export const TIER_META: Record<AchievementTier, { label: string; color: number; emoji: string }> = {
  bronce: { label: 'Bronce', color: 0xcd7f32, emoji: '🥉' },
  plata: { label: 'Plata', color: 0xc0c7d0, emoji: '🥈' },
  oro: { label: 'Oro', color: 0xf1c40f, emoji: '🥇' },
  platino: { label: 'Platino', color: 0x7fdbda, emoji: '💠' },
  diamante: { label: 'Diamante', color: 0xb388ff, emoji: '💎' },
};

export const CATEGORY_META: Record<AchievementDef['category'], { label: string; emoji: string }> = {
  pesca: { label: 'Pesca', emoji: '🎣' },
  granja: { label: 'Granja', emoji: '🌾' },
  economia: { label: 'Economía', emoji: '💰' },
  progresion: { label: 'Progresión', emoji: '⭐' },
  canas: { label: 'Cañas', emoji: '🎋' },
  eventos: { label: 'Eventos', emoji: '🎁' },
};

export interface AchievementUnlock {
  def: AchievementDef;
  rewardLines: string[];
  activity: number;
}

export interface AchievementProgress {
  def: AchievementDef;
  value: number;
  unlocked: boolean;
  unlockedAt: number | null;
  dmStatus: string | null;
}

/** Calcula todas las métricas de un jugador de una sola vez (pocas consultas). */
export function metricValues(ctx: GameContext, cfg: GameConfig, p: ProfileRow): Record<string, number> {
  const g = p.guild_id;
  const u = p.user_id;
  const species = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM fish_log WHERE guild_id = ? AND user_id = ?', g, u)!.n;
  const freeRods = cfg.fishing.rods.filter((r) => r.price === 0 && r.requires.length === 0).map((r) => r.id);
  const known = new Set(cfg.fishing.rods.map((r) => r.id));
  const ownedRows = ctx.db.all<{ rod_id: string }>('SELECT rod_id FROM rods_owned WHERE guild_id = ? AND user_id = ?', g, u).map((r) => r.rod_id);
  const rods = new Set([...freeRods, ...ownedRows.filter((r) => known.has(r))]).size;
  const collections = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM milestones WHERE guild_id = ? AND user_id = ? AND milestone_id LIKE 'coleccion:%'", g, u)!.n;
  const out: Record<string, number> = {
    catches: p.catches_total, harvests: p.farms_total, fish_level: p.fish_level, farm_level: p.farm_level,
    total_level: totalLevel(p), species, rods_owned: rods, collections,
  };
  for (const [k, v] of getStats(ctx, g, u)) out[k] = v;
  return out;
}

/**
 * Revisa los logros pendientes y desbloquea los cumplidos. Idempotente: la clave primaria
 * impide desbloquear (y cobrar) dos veces. Debe llamarse dentro de la transacción de la acción.
 * El aviso por DM queda en cola ('pendiente') y lo envía la capa de Discord.
 */
export function checkAchievements(ctx: GameContext, guildId: string, userId: string): AchievementUnlock[] {
  const cfg = gameConfig(ctx, guildId);
  const p = getProfile(ctx, guildId, userId);
  if (!p) return [];
  const done = new Set(ctx.db.all<{ achievement_id: string }>(
    'SELECT achievement_id FROM achievements_unlocked WHERE guild_id = ? AND user_id = ?', guildId, userId,
  ).map((r) => r.achievement_id));
  const pending = cfg.achievements.filter((a) => !done.has(a.id));
  if (!pending.length) return [];
  const values = metricValues(ctx, cfg, p);
  const out: AchievementUnlock[] = [];
  for (const def of pending) {
    if ((values[def.metric] ?? 0) < def.goal) continue;
    const r = ctx.db.run(
      'INSERT OR IGNORE INTO achievements_unlocked (guild_id, user_id, achievement_id, unlocked_at) VALUES (?, ?, ?, ?)',
      guildId, userId, def.id, ctx.now(),
    );
    if (r.changes !== 1) continue;
    const granted = grantReward(ctx, guildId, userId, def.reward, `logro: ${def.id}`);
    const activity = awardActivity(ctx, guildId, userId, 'achievement', { points: def.activity });
    out.push({ def, rewardLines: granted.lines, activity });
  }
  return out;
}

export function achievementProgress(ctx: GameContext, guildId: string, userId: string): AchievementProgress[] {
  const cfg = gameConfig(ctx, guildId);
  const p = getProfile(ctx, guildId, userId);
  const rows = new Map(ctx.db.all<{ achievement_id: string; unlocked_at: number; dm_status: string }>(
    'SELECT achievement_id, unlocked_at, dm_status FROM achievements_unlocked WHERE guild_id = ? AND user_id = ?', guildId, userId,
  ).map((r) => [r.achievement_id, r]));
  const values = p ? metricValues(ctx, cfg, p) : {};
  return cfg.achievements.map((def) => {
    const row = rows.get(def.id);
    return { def, value: Math.min(values[def.metric] ?? 0, def.goal), unlocked: !!row, unlockedAt: row?.unlocked_at ?? null, dmStatus: row?.dm_status ?? null };
  });
}

/** El próximo logro de la misma categoría (para mostrar progreso relevante en el DM). */
export function nextInCategory(progress: AchievementProgress[], def: AchievementDef): AchievementProgress | undefined {
  return progress.filter((x) => !x.unlocked && x.def.category === def.category)
    .sort((a, b) => b.value / b.def.goal - a.value / a.def.goal)[0];
}

// ───────────────────────── Cola de avisos por DM ─────────────────────────

export interface PendingNotice {
  guildId: string;
  userId: string;
  achievementId: string;
}

export function pendingNotices(ctx: GameContext, filter?: { guildId: string; userId: string }, limit = 50): PendingNotice[] {
  const rows = filter
    ? ctx.db.all<{ guild_id: string; user_id: string; achievement_id: string }>(
      "SELECT guild_id, user_id, achievement_id FROM achievements_unlocked WHERE dm_status = 'pendiente' AND guild_id = ? AND user_id = ? ORDER BY unlocked_at LIMIT ?",
      filter.guildId, filter.userId, limit)
    : ctx.db.all<{ guild_id: string; user_id: string; achievement_id: string }>(
      "SELECT guild_id, user_id, achievement_id FROM achievements_unlocked WHERE dm_status = 'pendiente' ORDER BY unlocked_at LIMIT ?", limit);
  return rows.map((r) => ({ guildId: r.guild_id, userId: r.user_id, achievementId: r.achievement_id }));
}

/**
 * Reserva avisos para enviar (pendiente → enviando). Solo quien logra el UPDATE los envía:
 * dos entregas simultáneas (el hook de la acción y el barrido periódico) nunca mandan el mismo DM dos veces.
 */
export function claimNotices(ctx: GameContext, notices: PendingNotice[]): PendingNotice[] {
  return ctx.db.transaction(() => notices.filter((n) => ctx.db.run(
    "UPDATE achievements_unlocked SET dm_status = 'enviando', dm_attempts = dm_attempts + 1 WHERE guild_id = ? AND user_id = ? AND achievement_id = ? AND dm_status = 'pendiente'",
    n.guildId, n.userId, n.achievementId,
  ).changes === 1));
}

/** Resultado del envío. 'reintentar' vuelve a la cola hasta 3 intentos (luego queda 'fallido'). */
export function finishNotices(ctx: GameContext, notices: PendingNotice[], result: 'enviado' | 'bloqueado' | 'reintentar'): void {
  ctx.db.transaction(() => {
    for (const n of notices) {
      if (result === 'reintentar') {
        ctx.db.run(
          "UPDATE achievements_unlocked SET dm_status = CASE WHEN dm_attempts >= 3 THEN 'fallido' ELSE 'pendiente' END WHERE guild_id = ? AND user_id = ? AND achievement_id = ?",
          n.guildId, n.userId, n.achievementId);
      } else {
        ctx.db.run('UPDATE achievements_unlocked SET dm_status = ?, notified_at = ? WHERE guild_id = ? AND user_id = ? AND achievement_id = ?',
          result, ctx.now(), n.guildId, n.userId, n.achievementId);
      }
    }
  });
}

/** Tras un reinicio, lo que quedó "enviando" vuelve a la cola (el envío se cortó a mitad). */
export function recoverStuckNotices(ctx: GameContext): void {
  ctx.db.run("UPDATE achievements_unlocked SET dm_status = 'pendiente' WHERE dm_status = 'enviando'");
}

export function itemName(cfg: GameConfig, id: string): string {
  const it = getItem(cfg, id);
  return it ? `${it.emoji} ${it.name}` : id;
}

import type { GameConfig, Skill } from '../game/types';
import type { GameContext } from './context';
import { addCoins } from './economy';
import { gameConfig } from './guildSettings';
import type { ProfileRow } from './player';

export interface LevelUp {
  skill: Skill;
  from: number;
  to: number;
  coins: number;
  reachedMax: boolean;
}

export interface XpGain {
  skill: Skill;
  amount: number;
  level: number;
  xp: number;
  need: number;
  levelUp: LevelUp | null;
}

/** XP necesaria para pasar de `level` a `level + 1`. Crece de forma polinómica (exponente configurable). */
export function xpToNext(cfg: GameConfig, level: number): number {
  const p = cfg.tuning.progression;
  return Math.max(1, Math.round((p.curveBase * Math.pow(level, p.curveExponent) + p.curveLinear * level) * p.curveMultiplier));
}

/** XP total acumulada necesaria para alcanzar `level` desde el nivel 1. */
export function totalXpForLevel(cfg: GameConfig, level: number): number {
  let sum = 0;
  for (let l = 1; l < level; l++) sum += xpToNext(cfg, l);
  return sum;
}

/**
 * Penaliza la XP obtenida en contenido muy por debajo del nivel del jugador.
 * Obliga a avanzar de zona para seguir progresando de verdad.
 */
export function levelGapMultiplier(cfg: GameConfig, playerLevel: number, contentLevel: number): number {
  const p = cfg.tuning.progression;
  const gap = playerLevel - contentLevel - p.levelGapTolerance;
  if (gap <= 0) return 1;
  return Math.max(p.levelGapFloor, 1 - gap * p.levelGapPenalty);
}

function columns(skill: Skill): { level: 'farm_level' | 'fish_level'; xp: 'farm_xp' | 'fish_xp' } {
  return skill === 'granja' ? { level: 'farm_level', xp: 'farm_xp' } : { level: 'fish_level', xp: 'fish_xp' };
}

/** Suma XP y resuelve subidas de nivel. Debe llamarse dentro de una transacción. */
export function addXp(ctx: GameContext, p: ProfileRow, skill: Skill, rawAmount: number): XpGain {
  const cfg = gameConfig(ctx, p.guild_id);
  const col = columns(skill);
  const row = ctx.db.get<{ level: number; xp: number }>(
    `SELECT ${col.level} AS level, ${col.xp} AS xp FROM profiles WHERE guild_id = ? AND user_id = ?`, p.guild_id, p.user_id,
  )!;
  const max = cfg.tuning.progression.maxLevel;
  const amount = Math.max(0, Math.round(rawAmount));
  if (row.level >= max) {
    return { skill, amount: 0, level: row.level, xp: 0, need: 0, levelUp: null };
  }
  let level = row.level;
  let xp = row.xp + amount;
  let coins = 0;
  while (level < max && xp >= xpToNext(cfg, level)) {
    xp -= xpToNext(cfg, level);
    level += 1;
    coins += level * cfg.tuning.progression.levelUpCoinsPerLevel;
  }
  if (level >= max) xp = 0;
  ctx.db.run(`UPDATE profiles SET ${col.level} = ?, ${col.xp} = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?`,
    level, xp, ctx.now(), p.guild_id, p.user_id);
  if (coins > 0) addCoins(ctx, p.guild_id, p.user_id, coins, `subida de nivel (${skill} ${level})`);
  return {
    skill,
    amount,
    level,
    xp,
    need: level >= max ? 0 : xpToNext(cfg, level),
    levelUp: level > row.level ? { skill, from: row.level, to: level, coins, reachedMax: level >= max } : null,
  };
}

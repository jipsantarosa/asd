import crypto from 'node:crypto';
import type { GameContext } from '../services/context';
import { casinoDay, getCasinoConfig } from './config';
import { applyTx, ensureCasinoUser } from './economy';
import { getCasinoGuild } from './guilds';
import { FLAG_BLOCKED, getCasinoUser, touchUser } from './users';

/**
 * Coins por actividad, con filtros anti-farming. Un mensaje paga solo si:
 * - el servidor y el casino tienen la actividad activada, y la cuenta no está suspendida;
 * - la cuenta de Discord y la membresía tienen la antigüedad mínima (frena cuentas recién creadas);
 * - tiene suficientes letras y palabras reales (sin contar menciones, enlaces ni emojis);
 * - no repite (ni casi repite) uno de los últimos mensajes de esa persona;
 * - la persona no está mandando ráfagas (spam);
 * - pasó la espera desde la última recompensa (global: varios servidores no suman más rápido);
 * - no llegó al tope diario.
 * El monto baja con la cantidad de mensajes recompensados en el día (rendimiento decreciente) y sube
 * un poco con la racha de días seguidos (bonus de constancia). El mismo mensaje nunca paga dos veces.
 */

export interface ActivityInput {
  userId: string;
  guildId: string;
  messageId: string;
  content: string;
  accountCreatedAt: number;
  memberJoinedAt: number | null;
}

export type ActivityOutcome =
  | { awarded: number; balance?: number; streak: number; day: string }
  | { awarded: 0; reason: ActivitySkip };

export type ActivitySkip = 'disabled' | 'blocked' | 'young_account' | 'new_member' | 'short' | 'duplicate' | 'burst' | 'cooldown' | 'cap';

/** Texto "real" de un mensaje: sin menciones, enlaces, emojis personalizados ni código, en minúsculas y sin repeticiones de letras. */
export function normalizeMessage(content: string): string {
  return content
    .toLowerCase()
    .replace(/<a?:\w+:\d+>/g, ' ')
    .replace(/<[@#][!&]?\d+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`{1,3}[^`]*`{1,3}/g, ' ')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/(\p{L})\1{2,}/gu, '$1$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

/** Palabras de al menos 2 letras, sin contar repetidas ("jaja jaja jaja" es una sola). */
export function wordCount(text: string): number {
  return new Set(text.split(' ').filter((w) => (w.match(/\p{L}/gu) ?? []).length >= 2)).size;
}

/** Similitud de Jaccard entre conjuntos de palabras (para detectar mensajes casi iguales). */
export function similarity(a: string, b: string): number {
  const A = new Set(a.split(' '));
  const B = new Set(b.split(' '));
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

/** Memoria corta por persona (en RAM: tras un reinicio simplemente empieza de cero). */
export class ActivityGuard {
  private readonly recent = new Map<string, { texts: string[]; times: number[]; mutedUntil: number }>();

  constructor(
    private readonly opts = { keep: 6, burstCount: 5, burstWindowMs: 8_000, muteMs: 120_000, maxUsers: 20_000 },
  ) {}

  /** Registra el mensaje y devuelve por qué no debería pagar (o null si pasa los filtros de memoria). */
  inspect(userId: string, normalized: string, now: number): 'duplicate' | 'burst' | null {
    let r = this.recent.get(userId);
    if (!r) {
      if (this.recent.size >= this.opts.maxUsers) this.recent.delete(this.recent.keys().next().value!);
      r = { texts: [], times: [], mutedUntil: 0 };
      this.recent.set(userId, r);
    }
    r.times = [...r.times.filter((t) => now - t < this.opts.burstWindowMs), now];
    const duplicate = r.texts.some((t) => t === normalized || similarity(t, normalized) >= 0.8);
    r.texts = [...r.texts, normalized].slice(-this.opts.keep);
    if (r.times.length >= this.opts.burstCount) r.mutedUntil = now + this.opts.muteMs;
    if (r.mutedUntil > now) return 'burst';
    return duplicate ? 'duplicate' : null;
  }

  sweep(now: number): void {
    for (const [k, v] of this.recent) if (v.times.every((t) => now - t > 3_600_000) && v.mutedUntil < now) this.recent.delete(k);
  }
}

/** Factor de rendimiento decreciente según los mensajes ya recompensados hoy. */
export function decayFactor(rewardedToday: number, decayAfter: number): number {
  if (rewardedToday >= decayAfter * 2) return 0.25;
  if (rewardedToday >= decayAfter) return 0.5;
  return 1;
}

/** Entero uniforme en [min, max] con crypto (no Math.random). */
export function rollAmount(min: number, max: number): number {
  return min >= max ? min : crypto.randomInt(min, max + 1);
}

export function rewardMessage(ctx: GameContext, guard: ActivityGuard, input: ActivityInput, roll: (min: number, max: number) => number = rollAmount): ActivityOutcome {
  const cfg = getCasinoConfig(ctx);
  const a = cfg.activity;
  const now = ctx.now();
  if (!a.enabled || !getCasinoGuild(ctx, input.guildId).activityEnabled) return { awarded: 0, reason: 'disabled' };
  if (now - input.accountCreatedAt < a.minAccountDays * 86_400_000) return { awarded: 0, reason: 'young_account' };
  if (input.memberJoinedAt === null || now - input.memberJoinedAt < a.minMemberHours * 3_600_000) return { awarded: 0, reason: 'new_member' };
  const text = normalizeMessage(input.content);
  if (letterCount(text) < a.minLetters || wordCount(text) < a.minWords) return { awarded: 0, reason: 'short' };
  const seen = guard.inspect(input.userId, text, now);
  if (seen) return { awarded: 0, reason: seen };

  return ctx.db.transaction((): ActivityOutcome => {
    const existing = getCasinoUser(ctx, input.userId);
    if (existing && (existing.flags & FLAG_BLOCKED) !== 0) return { awarded: 0, reason: 'blocked' };
    if (existing?.lastActivityRewardAt && now - existing.lastActivityRewardAt < a.cooldownSeconds * 1000) return { awarded: 0, reason: 'cooldown' };
    const day = casinoDay(cfg, now);
    const today = ctx.db.get<{ messages: number; coins: number }>('SELECT messages, coins FROM casino_activity WHERE user_id = ? AND day = ?', input.userId, day);
    const earned = today?.coins ?? 0;
    if (earned >= a.dailyCap) return { awarded: 0, reason: 'cap' };

    ensureCasinoUser(ctx, input.userId);
    const u = getCasinoUser(ctx, input.userId)!;
    const yesterday = casinoDay(cfg, now - 86_400_000);
    const streak = u.lastActivityDay === day ? u.activityStreak : u.lastActivityDay === yesterday ? u.activityStreak + 1 : 1;
    const streakBonus = 1 + (Math.min(streak - 1, a.streakMaxDays) * a.streakPct) / 100;
    const boost = cfg.boost.until > now ? cfg.boost.activity : 1;
    const base = roll(a.min, a.max);
    const amount = Math.min(a.dailyCap - earned, Math.floor(base * decayFactor(today?.messages ?? 0, a.decayAfter) * streakBonus * boost));

    ctx.db.run('UPDATE casino_users SET last_activity_reward_at = ?, last_activity_day = ?, activity_streak = ?, last_active_at = ? WHERE user_id = ?',
      now, day, streak, now, input.userId);
    ctx.db.run(`INSERT INTO casino_activity (user_id, day, messages, coins) VALUES (?, ?, 1, ?)
                ON CONFLICT (user_id, day) DO UPDATE SET messages = messages + 1, coins = coins + excluded.coins`, input.userId, day, Math.max(0, amount));
    touchUser(ctx, input.userId, input.guildId);
    if (amount <= 0) return { awarded: 0, reason: 'cap' };
    const tx = applyTx(ctx, { userId: input.userId, amount, type: 'ACTIVITY', guildId: input.guildId, key: `act:${input.messageId}`, meta: { streak } });
    return { awarded: tx.replayed ? 0 : amount, balance: tx.after, streak, day } as ActivityOutcome;
  });
}

/** Lo ganado hoy por actividad (para el perfil). */
export function activityToday(ctx: GameContext, userId: string): { messages: number; coins: number; cap: number } {
  const cfg = getCasinoConfig(ctx);
  const r = ctx.db.get<{ messages: number; coins: number }>('SELECT messages, coins FROM casino_activity WHERE user_id = ? AND day = ?', userId, casinoDay(cfg, ctx.now()));
  return { messages: r?.messages ?? 0, coins: r?.coins ?? 0, cap: cfg.activity.dailyCap };
}

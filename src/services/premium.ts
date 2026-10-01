import { GameError, type GameContext } from './context';

/**
 * Premium del bot: 4 niveles acumulativos (cada nivel incluye todo lo del anterior).
 * Solo el dueño del bot puede darlo o quitarlo (eso lo verifica la capa de Discord).
 */
export type PremiumTier = 1 | 2 | 3 | 4;

export const TIERS: Record<PremiumTier, { name: string; emoji: string; perks: string[] }> = {
  1: { name: 'Booster', emoji: '💎', perks: ['!clearavatars', '!clearnames', '!tags'] },
  2: { name: 'Tier 2', emoji: '🌟', perks: ['!cleartags', '!mstats (parcial)', '!autoplay'] },
  3: { name: 'Tier 3', emoji: '👑', perks: ['!mstats completo (últimas 10 personas)'] },
  4: { name: 'Tier 4', emoji: '🔮', perks: ['!ghostmode', '!botperfil (perfil del bot en 3 servidores)'] },
};

export const FEATURE_TIER = {
  clearavatars: 1, clearnames: 1, tags: 1, cleartags: 2, mstats: 2, autoplay: 2, mstatsFull: 3, ghostmode: 4, botprofile: 4,
} as const satisfies Record<string, PremiumTier>;

export interface PremiumRow {
  user_id: string;
  tier: PremiumTier;
  granted_by: string;
  granted_at: number;
  expires_at: number | null;
  ghost_mode: number;
  /** Tier 4: servidores que puede personalizar con !botperfil. */
  bot_slots: number;
}

/** Premium vigente (null si no tiene o si venció). */
export function getPremium(ctx: GameContext, userId: string): PremiumRow | null {
  const row = ctx.db.get<PremiumRow>('SELECT * FROM premium WHERE user_id = ?', userId);
  if (!row || (row.expires_at !== null && row.expires_at <= ctx.now())) return null;
  return row;
}

export function tierOf(ctx: GameContext, userId: string): PremiumTier | 0 {
  return getPremium(ctx, userId)?.tier ?? 0;
}

/** Corta con un mensaje claro si el usuario no tiene el nivel necesario. */
export function requireTier(ctx: GameContext, userId: string, needed: PremiumTier, feature: string): PremiumRow {
  const p = getPremium(ctx, userId);
  if (!p || p.tier < needed) {
    throw new GameError(`🔒 **${feature}** es Premium ${TIERS[needed].emoji} **${TIERS[needed].name}**${needed > 1 ? ' o superior' : ''}. ${p ? `Tenés ${TIERS[p.tier].name}.` : 'Pedíselo al dueño del bot.'}`);
  }
  return p;
}

export function grantPremium(ctx: GameContext, userId: string, tier: number, grantedBy: string, days: number | null): PremiumRow {
  if (![1, 2, 3, 4].includes(tier)) throw new GameError('El nivel tiene que ser 1, 2, 3 o 4.');
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new GameError('Los días tienen que ser entre 1 y 3650 (o nada para que no venza).');
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO premium (user_id, tier, granted_by, granted_at, expires_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET tier = excluded.tier, granted_by = excluded.granted_by, granted_at = excluded.granted_at, expires_at = excluded.expires_at`,
    userId, tier, grantedBy, now, days ? now + days * 86_400_000 : null,
  );
  return getPremium(ctx, userId)!;
}

export function revokePremium(ctx: GameContext, userId: string): boolean {
  return ctx.db.run('DELETE FROM premium WHERE user_id = ?', userId).changes === 1;
}

export function listPremium(ctx: GameContext): PremiumRow[] {
  return ctx.db.all<PremiumRow>('SELECT * FROM premium WHERE expires_at IS NULL OR expires_at > ? ORDER BY tier DESC, granted_at', ctx.now());
}

/** Modo fantasma (Tier 4): tus vistas a historiales ajenos no se registran. Solo cuenta si el premium sigue vigente. */
export function isGhost(ctx: GameContext, userId: string): boolean {
  const p = getPremium(ctx, userId);
  return !!p && p.tier >= 4 && p.ghost_mode === 1;
}

export function setGhost(ctx: GameContext, userId: string, on: boolean): boolean {
  requireTier(ctx, userId, 4, '!ghostmode');
  ctx.db.run('UPDATE premium SET ghost_mode = ? WHERE user_id = ?', on ? 1 : 0, userId);
  return on;
}

/** El dueño elige cuántos servidores puede personalizar una persona con !botperfil (por defecto 3). */
export function setBotSlots(ctx: GameContext, userId: string, slots: number): void {
  if (!Number.isInteger(slots) || slots < 1 || slots > 100) throw new GameError('La cantidad de servidores tiene que ser entre 1 y 100.');
  if (!getPremium(ctx, userId)) throw new GameError('Esa persona no tiene premium.');
  ctx.db.run('UPDATE premium SET bot_slots = ? WHERE user_id = ?', slots, userId);
}

import { GameError, type GameContext } from './context';

/** Mensajes de agradecimiento cuando alguien boostea el servidor (/boosttracker). */

export interface BoostConfig {
  enabled: boolean;
  channelId: string | null;
  title: string;
  description: string;
  color: number;
  imageUrl: string | null;
  footer: string;
}

export const BOOST_DEFAULTS: Omit<BoostConfig, 'channelId' | 'enabled'> = {
  title: '🚀 ¡Nuevo boost!',
  description: '¡Gracias {user} por boostear **{server}**! 💖\nYa tenemos **{boosts}** boosts (nivel {tier}).',
  color: 0xf47fff,
  imageUrl: null,
  footer: 'Gracias por apoyar al servidor',
};

export const BOOST_LIMITS = { title: 256, description: 2000, footer: 200, image: 500 } as const;

/** Colores con nombre (español e inglés) o #RRGGBB. */
export const COLOR_NAMES: Record<string, number> = {
  oro: 0xf1c40f, dorado: 0xf1c40f, gold: 0xf1c40f,
  rosa: 0xf47fff, nitro: 0xf47fff, pink: 0xf47fff,
  morado: 0x9b59b6, violeta: 0x9b59b6, purple: 0x9b59b6,
  azul: 0x3498db, blue: 0x3498db,
  celeste: 0x5dade2, cyan: 0x5dade2,
  verde: 0x2ecc71, green: 0x2ecc71,
  rojo: 0xe74c3c, red: 0xe74c3c,
  naranja: 0xe67e22, orange: 0xe67e22,
  blanco: 0xffffff, white: 0xffffff,
  negro: 0x23272a, black: 0x23272a,
};

export function parseColor(raw: string): number {
  const v = raw.trim().toLowerCase();
  if (COLOR_NAMES[v] !== undefined) return COLOR_NAMES[v];
  const m = v.match(/^#?([0-9a-f]{6})$/);
  if (m) return parseInt(m[1], 16);
  throw new GameError(`Color inválido. Usá un nombre (${['oro', 'rosa', 'morado', 'azul', 'verde', 'rojo', 'naranja'].join(', ')}) o un código como #FF66CC.`);
}

interface Row {
  enabled: number; channel_id: string | null; title: string; description: string; color: number; image_url: string | null; footer: string;
}

export function getBoostConfig(ctx: GameContext, guildId: string): BoostConfig {
  const r = ctx.db.get<Row>('SELECT * FROM boost_config WHERE guild_id = ?', guildId);
  if (!r) return { enabled: false, channelId: null, ...BOOST_DEFAULTS };
  return { enabled: r.enabled === 1, channelId: r.channel_id, title: r.title, description: r.description, color: r.color, imageUrl: r.image_url, footer: r.footer };
}

export function saveBoostConfig(ctx: GameContext, guildId: string, patch: Partial<BoostConfig>): BoostConfig {
  const next = { ...getBoostConfig(ctx, guildId), ...patch };
  if (!next.title.trim() || next.title.length > BOOST_LIMITS.title) throw new GameError(`El título tiene que tener entre 1 y ${BOOST_LIMITS.title} caracteres.`);
  if (!next.description.trim() || next.description.length > BOOST_LIMITS.description) throw new GameError(`La descripción tiene que tener entre 1 y ${BOOST_LIMITS.description} caracteres.`);
  if (next.footer.length > BOOST_LIMITS.footer) throw new GameError(`El pie puede tener hasta ${BOOST_LIMITS.footer} caracteres.`);
  if (next.imageUrl && (!/^https:\/\/\S+$/i.test(next.imageUrl) || next.imageUrl.length > BOOST_LIMITS.image)) throw new GameError('La imagen tiene que ser un enlace https (por ejemplo un .gif o .png).');
  if (!Number.isInteger(next.color) || next.color < 0 || next.color > 0xffffff) throw new GameError('Color inválido.');
  ctx.db.run(
    `INSERT INTO boost_config (guild_id, enabled, channel_id, title, description, color, image_url, footer, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET enabled = excluded.enabled, channel_id = excluded.channel_id, title = excluded.title,
       description = excluded.description, color = excluded.color, image_url = excluded.image_url, footer = excluded.footer, updated_at = excluded.updated_at`,
    guildId, next.enabled ? 1 : 0, next.channelId, next.title, next.description, next.color, next.imageUrl, next.footer, ctx.now(),
  );
  return getBoostConfig(ctx, guildId);
}

/** Reemplaza {user} (mención), {username}, {server}, {boosts} y {tier}. Sin @everyone ni @here. */
export function fillBoostText(text: string, v: { userId: string; username: string; server: string; boosts: number; tier: number }): string {
  return text
    .replace(/\{user\}/g, `<@${v.userId}>`)
    .replace(/\{username\}/g, v.username)
    .replace(/\{server\}/g, v.server)
    .replace(/\{boosts\}/g, String(v.boosts))
    .replace(/\{tier\}/g, String(v.tier))
    .replace(/@(everyone|here)/g, '@​$1');
}

/** Evita anunciar dos veces el mismo boost (mensaje de sistema + cambio de miembro llegan casi juntos). */
export class BoostDedupe {
  private readonly seen = new Map<string, number>();
  constructor(private readonly windowMs = 60_000) {}
  first(key: string, now: number): boolean {
    for (const [k, t] of this.seen) if (now - t > this.windowMs) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }
}

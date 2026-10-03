import type { GameContext } from './context';

/**
 * Canales de registro que crea /setup. El orden es el orden en la categoría.
 * `legacy`: nombres que tuvo el canal en versiones anteriores, para reconocerlo y renombrarlo al sincronizar.
 */
export const LOG_CHANNELS: readonly { key: LogKey; name: string; topic: string; legacy?: readonly string[] }[] = [
  { key: 'mensajes', name: 'mensajes', topic: 'Mensajes enviados y editados.' },
  { key: 'eliminados', name: 'eliminados', topic: 'Mensajes eliminados (individuales y en masa).' },
  { key: 'adjuntos', name: 'adjuntos', topic: 'Imágenes y archivos enviados (copia de respaldo).' },
  { key: 'baneos', name: 'baneos', topic: 'Baneos y desbaneos.' },
  { key: 'expulsiones', name: 'expulsiones', topic: 'Expulsiones de miembros.' },
  { key: 'entradas', name: 'entradas-salidas', topic: 'Miembros que entran y salen.', legacy: ['entradas', 'entradas-y-salidas', 'miembros'] },
  { key: 'apodos', name: 'apodos', topic: 'Cambios de apodo.' },
  { key: 'roles', name: 'roles', topic: 'Roles asignados/quitados y cambios en roles del servidor.' },
  { key: 'moderacion', name: 'moderacion', topic: 'Aislamientos, purgas y otras acciones de moderación.' },
  { key: 'voz', name: 'voz', topic: 'Entradas, salidas y movimientos en canales de voz.' },
  { key: 'servidor', name: 'servidor', topic: 'Canales, invitaciones y ajustes del servidor.' },
  { key: 'sistema', name: 'sistema-bot', topic: 'Configuración del bot y alertas antiabuso.', legacy: ['sistema', 'bot', 'logs-bot'] },
];

export type LogKey = 'mensajes' | 'eliminados' | 'adjuntos' | 'baneos' | 'expulsiones' | 'entradas' | 'apodos' | 'roles' | 'moderacion' | 'voz' | 'servidor' | 'sistema';
export const CATEGORY_NAME = 'Registros';

export interface LogConfig {
  categoryId: string | null;
  staffRoleId: string | null;
  logSentMessages: boolean;
  channels: Partial<Record<LogKey, string>>;
}

const cache = new Map<string, LogConfig>();

export function getLogConfig(ctx: GameContext, guildId: string): LogConfig {
  const hit = cache.get(guildId);
  if (hit) return hit;
  const row = ctx.db.get<{ category_id: string | null; staff_role_id: string | null; log_sent_messages: number }>(
    'SELECT category_id, staff_role_id, log_sent_messages FROM log_config WHERE guild_id = ?', guildId,
  );
  const channels: Partial<Record<LogKey, string>> = {};
  for (const r of ctx.db.all<{ log_key: LogKey; channel_id: string }>('SELECT log_key, channel_id FROM log_channels WHERE guild_id = ?', guildId)) {
    channels[r.log_key] = r.channel_id;
  }
  const cfg: LogConfig = {
    categoryId: row?.category_id ?? null,
    staffRoleId: row?.staff_role_id ?? null,
    logSentMessages: row ? row.log_sent_messages === 1 : true,
    channels,
  };
  cache.set(guildId, cfg);
  return cfg;
}

export function saveLogConfig(ctx: GameContext, guildId: string, cfg: LogConfig): void {
  ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO log_config (guild_id, category_id, staff_role_id, log_sent_messages, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET category_id = excluded.category_id, staff_role_id = excluded.staff_role_id,
         log_sent_messages = excluded.log_sent_messages, updated_at = excluded.updated_at`,
      guildId, cfg.categoryId, cfg.staffRoleId, cfg.logSentMessages ? 1 : 0, ctx.now(),
    );
    ctx.db.run('DELETE FROM log_channels WHERE guild_id = ?', guildId);
    for (const [key, id] of Object.entries(cfg.channels)) {
      if (id) ctx.db.run('INSERT INTO log_channels (guild_id, log_key, channel_id) VALUES (?, ?, ?)', guildId, key, id);
    }
  });
  cache.set(guildId, { ...cfg, channels: { ...cfg.channels } });
}

/** Olvida un canal borrado (el próximo /setup lo recrea). */
export function forgetLogChannel(ctx: GameContext, guildId: string, channelId: string): LogKey | null {
  const cfg = getLogConfig(ctx, guildId);
  const entry = Object.entries(cfg.channels).find(([, id]) => id === channelId);
  if (entry) {
    ctx.db.run('DELETE FROM log_channels WHERE guild_id = ? AND channel_id = ?', guildId, channelId);
    delete cfg.channels[entry[0] as LogKey];
    return entry[0] as LogKey;
  }
  if (cfg.categoryId === channelId) {
    ctx.db.run('UPDATE log_config SET category_id = NULL WHERE guild_id = ?', guildId);
    cfg.categoryId = null;
  }
  return null;
}

export function isLogChannel(ctx: GameContext, guildId: string, channelId: string | null | undefined, parentId?: string | null): boolean {
  if (!channelId) return false;
  const cfg = getLogConfig(ctx, guildId);
  return Object.values(cfg.channels).includes(channelId) || (!!cfg.categoryId && parentId === cfg.categoryId);
}

// ───────────────────────── Planificador de /setup (puro, testeable) ─────────────────────────

export interface ExistingChannel {
  id: string;
  name: string;
  type: 'category' | 'text' | 'other';
  parentId: string | null;
}

export type SetupStep =
  | { kind: 'keep'; key: LogKey; channelId: string }
  | { kind: 'reparent'; key: LogKey; channelId: string }
  | { kind: 'adopt'; key: LogKey; channelId: string }
  | { kind: 'create'; key: LogKey };

export interface SetupPlan {
  category: { kind: 'keep' | 'adopt'; id: string } | { kind: 'create' };
  steps: SetupStep[];
  /** Canales de registro sobrantes (de instalaciones anteriores): se ofrecen para borrar, nunca se borran solos. */
  duplicates: string[];
  /** Otras categorías de registros: se borran solo si quedan vacías después de quitar los duplicados. */
  duplicateCategories: string[];
}

/** Nombres que tuvo la categoría en versiones anteriores (se reconocen sin importar emojis ni mayúsculas). */
export const CATEGORY_LEGACY = ['📋 Registros', 'Logs', 'Registro'];

/** Nombre comparable: sin emojis ni separadores, en minúsculas y sin acentos ("📝・Mensajes" → "mensajes"). */
export function normalizeChannelName(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

const categoryNames = new Set([CATEGORY_NAME, ...CATEGORY_LEGACY].map(normalizeChannelName));
const namesOf = (key: LogKey) => {
  const def = LOG_CHANNELS.find((c) => c.key === key)!;
  return new Set([def.name, ...(def.legacy ?? [])].map(normalizeChannelName));
};

/**
 * Decide qué hacer con cada canal sin tocar Discord:
 * 1) Si el ID guardado existe y es de texto → se conserva (y se reubica si salió de la categoría).
 * 2) Si no, se adopta un canal de texto con ese nombre (o uno anterior) dentro de alguna categoría de registros.
 * 3) Si no hay nada, se crea.
 * Lo que sobra (canales con nombre de registro que no se usan, categorías repetidas) queda marcado como duplicado.
 */
export function planSetup(stored: LogConfig, existing: ExistingChannel[]): SetupPlan {
  const byId = new Map(existing.map((c) => [c.id, c]));
  const logCategories = existing.filter((c) => c.type === 'category' && categoryNames.has(normalizeChannelName(c.name)));
  let category: SetupPlan['category'];
  const storedCat = stored.categoryId ? byId.get(stored.categoryId) : undefined;
  if (storedCat?.type === 'category') category = { kind: 'keep', id: storedCat.id };
  else {
    // Entre varias categorías de registros, la que más canales tiene (la "real" de la instalación anterior).
    const children = (id: string) => existing.filter((c) => c.parentId === id).length;
    const best = [...logCategories].sort((a, b) => children(b.id) - children(a.id))[0];
    category = best ? { kind: 'adopt', id: best.id } : { kind: 'create' };
  }
  const catId = category.kind === 'create' ? null : category.id;
  const searchIn = new Set([...(catId ? [catId] : []), ...logCategories.map((c) => c.id)]);
  const claimed = new Set<string>();
  const steps: SetupStep[] = LOG_CHANNELS.map(({ key }) => {
    const storedId = stored.channels[key];
    const current = storedId ? byId.get(storedId) : undefined;
    if (current?.type === 'text' && !claimed.has(current.id)) {
      claimed.add(current.id);
      return current.parentId === catId && catId ? { kind: 'keep', key, channelId: current.id } : { kind: 'reparent', key, channelId: current.id };
    }
    const names = namesOf(key);
    // Primero en la categoría elegida, después en las otras categorías de registros.
    const candidates = existing.filter((c) => c.type === 'text' && c.parentId !== null && searchIn.has(c.parentId) && names.has(normalizeChannelName(c.name)) && !claimed.has(c.id))
      .sort((a, b) => Number(b.parentId === catId) - Number(a.parentId === catId));
    if (candidates[0]) {
      claimed.add(candidates[0].id);
      return { kind: 'adopt', key, channelId: candidates[0].id };
    }
    return { kind: 'create', key };
  });
  const allNames = new Set(LOG_CHANNELS.flatMap(({ key }) => [...namesOf(key)]));
  const duplicates = existing
    .filter((c) => c.type === 'text' && c.parentId !== null && searchIn.has(c.parentId) && !claimed.has(c.id) && allNames.has(normalizeChannelName(c.name)))
    .map((c) => c.id);
  const duplicateCategories = logCategories.filter((c) => c.id !== catId).map((c) => c.id);
  return { category, steps, duplicates, duplicateCategories };
}

export function resetLogCache(): void {
  cache.clear();
}

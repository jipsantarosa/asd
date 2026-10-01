import type { GameContext } from './context';

/** Canales de registro que crea /setup. El orden es el orden en la categoría. */
export const LOG_CHANNELS = [
  { key: 'mensajes', name: '📝・mensajes', topic: 'Mensajes enviados y editados.' },
  { key: 'eliminados', name: '🗑️・eliminados', topic: 'Mensajes eliminados (individuales y en masa).' },
  { key: 'adjuntos', name: '🖼️・adjuntos', topic: 'Imágenes y archivos enviados (copia de respaldo).' },
  { key: 'baneos', name: '🔨・baneos', topic: 'Baneos y desbaneos.' },
  { key: 'expulsiones', name: '👢・expulsiones', topic: 'Expulsiones de miembros.' },
  { key: 'entradas', name: '🚪・entradas-salidas', topic: 'Miembros que entran y salen.' },
  { key: 'apodos', name: '🏷️・apodos', topic: 'Cambios de apodo.' },
  { key: 'roles', name: '🎭・roles', topic: 'Roles asignados/quitados y cambios en roles del servidor.' },
  { key: 'moderacion', name: '🛡️・moderacion', topic: 'Aislamientos, purgas y otras acciones de moderación.' },
  { key: 'voz', name: '🔊・voz', topic: 'Entradas, salidas y movimientos en canales de voz.' },
  { key: 'servidor', name: '⚙️・servidor', topic: 'Canales, invitaciones y ajustes del servidor.' },
  { key: 'sistema', name: '🤖・sistema-bot', topic: 'Configuración del bot y alertas antiabuso.' },
] as const;

export type LogKey = (typeof LOG_CHANNELS)[number]['key'];
export const CATEGORY_NAME = '📋 Registros';

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
}

/**
 * Decide qué hacer con cada canal sin tocar Discord:
 * 1) Si el ID guardado existe y es de texto → se conserva (y se reubica si salió de la categoría).
 * 2) Si no, se adopta un canal de texto con el nombre esperado dentro de la categoría (evita duplicados).
 * 3) Si no hay nada, se crea.
 */
export function planSetup(stored: LogConfig, existing: ExistingChannel[]): SetupPlan {
  const byId = new Map(existing.map((c) => [c.id, c]));
  let category: SetupPlan['category'];
  const storedCat = stored.categoryId ? byId.get(stored.categoryId) : undefined;
  if (storedCat?.type === 'category') category = { kind: 'keep', id: storedCat.id };
  else {
    const named = existing.find((c) => c.type === 'category' && c.name.toLowerCase() === CATEGORY_NAME.toLowerCase());
    category = named ? { kind: 'adopt', id: named.id } : { kind: 'create' };
  }
  const catId = category.kind === 'create' ? null : category.id;
  const claimed = new Set<string>();
  const steps: SetupStep[] = LOG_CHANNELS.map(({ key, name }) => {
    const storedId = stored.channels[key];
    const current = storedId ? byId.get(storedId) : undefined;
    if (current?.type === 'text' && !claimed.has(current.id)) {
      claimed.add(current.id);
      return current.parentId === catId && catId ? { kind: 'keep', key, channelId: current.id } : { kind: 'reparent', key, channelId: current.id };
    }
    const adoptable = catId
      ? existing.find((c) => c.type === 'text' && c.parentId === catId && c.name === name && !claimed.has(c.id))
      : undefined;
    if (adoptable) {
      claimed.add(adoptable.id);
      return { kind: 'adopt', key, channelId: adoptable.id };
    }
    return { kind: 'create', key };
  });
  return { category, steps };
}

export function resetLogCache(): void {
  cache.clear();
}

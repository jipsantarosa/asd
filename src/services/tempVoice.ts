import { GameError, type GameContext } from './context';

/**
 * Canales de voz temporales ("unirse para crear"): datos y reglas, sin discord.js.
 * La capa de Discord (src/discord/voice) aplica estas decisiones a los canales reales.
 */

export const DEFAULT_NAME_TEMPLATE = 'Canal de {usuario}';
/** Tope de canales temporales vivos por servidor (anti abuso: nadie puede llenar el servidor de canales). */
export const MAX_TEMP_CHANNELS_PER_GUILD = 50;
/** Personas permitidas o bloqueadas por dueño (cada una es un permiso en el canal). */
export const MAX_ACCESS_ENTRIES = 25;
/** Discord solo deja cambiar el nombre de un canal 2 veces cada 10 minutos. */
export const RENAME_LIMIT = 2;
export const RENAME_WINDOW_MS = 10 * 60_000;
/** Espera entre canales creados por la misma persona (entrar y salir del hub muy rápido). */
export const CREATE_COOLDOWN_MS = 10_000;

const SNOWFLAKE = /^\d{17,20}$/;

// ───────────────────────── Configuración por servidor ─────────────────────────

export interface VoiceConfig {
  enabled: boolean;
  categoryId: string | null;
  hubChannelId: string | null;
  interfaceChannelId: string | null;
  interfaceMessageId: string | null;
  nameTemplate: string;
  defaultLimit: number;
}

interface VoiceConfigRow {
  enabled: number;
  category_id: string | null;
  hub_channel_id: string | null;
  interface_channel_id: string | null;
  interface_message_id: string | null;
  name_template: string;
  default_limit: number;
}

export function getVoiceConfig(ctx: GameContext, guildId: string): VoiceConfig {
  const r = ctx.db.get<VoiceConfigRow>('SELECT * FROM voice_config WHERE guild_id = ?', guildId);
  return {
    enabled: r ? r.enabled === 1 : false,
    categoryId: r?.category_id ?? null,
    hubChannelId: r?.hub_channel_id ?? null,
    interfaceChannelId: r?.interface_channel_id ?? null,
    interfaceMessageId: r?.interface_message_id ?? null,
    nameTemplate: r?.name_template ?? DEFAULT_NAME_TEMPLATE,
    defaultLimit: r?.default_limit ?? 0,
  };
}

export function saveVoiceConfig(ctx: GameContext, guildId: string, patch: Partial<VoiceConfig>): VoiceConfig {
  const next = { ...getVoiceConfig(ctx, guildId), ...patch };
  if (patch.nameTemplate !== undefined) next.nameTemplate = validateTemplate(patch.nameTemplate);
  if (patch.defaultLimit !== undefined) next.defaultLimit = validateLimit(patch.defaultLimit);
  ctx.db.run(
    `INSERT INTO voice_config (guild_id, enabled, category_id, hub_channel_id, interface_channel_id, interface_message_id, name_template, default_limit, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET enabled = excluded.enabled, category_id = excluded.category_id, hub_channel_id = excluded.hub_channel_id,
       interface_channel_id = excluded.interface_channel_id, interface_message_id = excluded.interface_message_id,
       name_template = excluded.name_template, default_limit = excluded.default_limit, updated_at = excluded.updated_at`,
    guildId, next.enabled ? 1 : 0, next.categoryId, next.hubChannelId, next.interfaceChannelId, next.interfaceMessageId,
    next.nameTemplate, next.defaultLimit, ctx.now(),
  );
  return next;
}

// ───────────────────────── Canales vivos ─────────────────────────

export interface TempChannel {
  channelId: string;
  guildId: string;
  ownerId: string;
  createdAt: number;
}

interface TempRow {
  channel_id: string;
  guild_id: string;
  owner_id: string;
  created_at: number;
}

const toTemp = (r: TempRow): TempChannel => ({ channelId: r.channel_id, guildId: r.guild_id, ownerId: r.owner_id, createdAt: r.created_at });

export function getTempChannel(ctx: GameContext, channelId: string): TempChannel | null {
  const r = ctx.db.get<TempRow>('SELECT * FROM temp_voice_channels WHERE channel_id = ?', channelId);
  return r ? toTemp(r) : null;
}

export function tempChannelOf(ctx: GameContext, guildId: string, ownerId: string): TempChannel | null {
  const r = ctx.db.get<TempRow>('SELECT * FROM temp_voice_channels WHERE guild_id = ? AND owner_id = ?', guildId, ownerId);
  return r ? toTemp(r) : null;
}

export function listTempChannels(ctx: GameContext, guildId?: string): TempChannel[] {
  const rows = guildId
    ? ctx.db.all<TempRow>('SELECT * FROM temp_voice_channels WHERE guild_id = ? ORDER BY created_at', guildId)
    : ctx.db.all<TempRow>('SELECT * FROM temp_voice_channels ORDER BY created_at');
  return rows.map(toTemp);
}

/**
 * ¿Puede esta persona crear un canal ahora? Devuelve el motivo si no.
 * (El índice único de la tabla es la garantía final: un dueño, un canal.)
 */
export function creationProblem(ctx: GameContext, guildId: string, ownerId: string): string | null {
  if (tempChannelOf(ctx, guildId, ownerId)) return 'ya tenés un canal temporal';
  const n = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM temp_voice_channels WHERE guild_id = ?', guildId)!.n;
  if (n >= MAX_TEMP_CHANNELS_PER_GUILD) return `el servidor llegó al máximo de ${MAX_TEMP_CHANNELS_PER_GUILD} canales temporales`;
  return null;
}

/** Registra un canal recién creado. Si el dueño ya tenía uno (carrera), lanza y el llamador borra el nuevo. */
export function registerTempChannel(ctx: GameContext, guildId: string, channelId: string, ownerId: string): TempChannel {
  return ctx.db.transaction(() => {
    const problem = creationProblem(ctx, guildId, ownerId);
    if (problem) throw new GameError(`No se puede crear el canal: ${problem}.`);
    ctx.db.run('INSERT INTO temp_voice_channels (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, ?)', channelId, guildId, ownerId, ctx.now());
    return getTempChannel(ctx, channelId)!;
  });
}

export function forgetTempChannel(ctx: GameContext, channelId: string): boolean {
  return ctx.db.run('DELETE FROM temp_voice_channels WHERE channel_id = ?', channelId).changes === 1;
}

/**
 * Cambia el dueño (transferir o reclamar). Condicional sobre el dueño anterior: si dos personas
 * reclaman a la vez, solo una gana. La persona nueva no puede tener otro canal temporal.
 */
export function setTempOwner(ctx: GameContext, channelId: string, expectedOwnerId: string, newOwnerId: string): TempChannel {
  return ctx.db.transaction(() => {
    const t = getTempChannel(ctx, channelId);
    if (!t) throw new GameError('Ese canal ya no es un canal temporal.');
    if (newOwnerId === t.ownerId) throw new GameError('Esa persona ya es la dueña del canal.');
    if (tempChannelOf(ctx, t.guildId, newOwnerId)) throw new GameError('Esa persona ya tiene su propio canal temporal.');
    const r = ctx.db.run('UPDATE temp_voice_channels SET owner_id = ? WHERE channel_id = ? AND owner_id = ?', newOwnerId, channelId, expectedOwnerId);
    if (r.changes !== 1) throw new GameError('El canal cambió de dueño mientras tanto. Probá de nuevo.');
    return { ...t, ownerId: newOwnerId };
  });
}

// ───────────────────────── Preferencias del dueño ─────────────────────────

export interface VoiceProfile {
  name: string | null;
  limit: number | null;
  locked: boolean;
  hidden: boolean;
  region: string | null;
}

export function getVoiceProfile(ctx: GameContext, guildId: string, userId: string): VoiceProfile {
  const r = ctx.db.get<{ name: string | null; user_limit: number | null; locked: number; hidden: number; region: string | null }>(
    'SELECT name, user_limit, locked, hidden, region FROM voice_profiles WHERE guild_id = ? AND user_id = ?', guildId, userId,
  );
  return { name: r?.name ?? null, limit: r?.user_limit ?? null, locked: r?.locked === 1, hidden: r?.hidden === 1, region: r?.region ?? null };
}

export function saveVoiceProfile(ctx: GameContext, guildId: string, userId: string, patch: Partial<VoiceProfile>): VoiceProfile {
  const next = { ...getVoiceProfile(ctx, guildId, userId), ...patch };
  ctx.db.run(
    `INSERT INTO voice_profiles (guild_id, user_id, name, user_limit, locked, hidden, region, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET name = excluded.name, user_limit = excluded.user_limit, locked = excluded.locked,
       hidden = excluded.hidden, region = excluded.region, updated_at = excluded.updated_at`,
    guildId, userId, next.name, next.limit, next.locked ? 1 : 0, next.hidden ? 1 : 0, next.region, ctx.now(),
  );
  return next;
}

// ───────────────────────── Permitidos y bloqueados ─────────────────────────

export type AccessKind = 'trust' | 'block';

export function listAccess(ctx: GameContext, guildId: string, ownerId: string, kind: AccessKind): string[] {
  return ctx.db.all<{ target_id: string }>(
    'SELECT target_id FROM voice_access WHERE guild_id = ? AND owner_id = ? AND kind = ? ORDER BY created_at', guildId, ownerId, kind,
  ).map((r) => r.target_id);
}

export interface AccessChange {
  changed: string[];
  skipped: { id: string; reason: string }[];
}

/**
 * Agrega personas a la lista (permitir o bloquear). Pasar de una lista a la otra reemplaza la entrada:
 * nadie queda permitido y bloqueado a la vez. Respeta el tope por dueño.
 */
export function setAccess(ctx: GameContext, guildId: string, ownerId: string, targetIds: string[], kind: AccessKind): AccessChange {
  return ctx.db.transaction(() => {
    const out: AccessChange = { changed: [], skipped: [] };
    for (const id of [...new Set(targetIds)]) {
      if (!SNOWFLAKE.test(id)) { out.skipped.push({ id, reason: 'usuario inválido' }); continue; }
      if (id === ownerId) { out.skipped.push({ id, reason: 'sos vos' }); continue; }
      const current = ctx.db.get<{ kind: AccessKind }>('SELECT kind FROM voice_access WHERE guild_id = ? AND owner_id = ? AND target_id = ?', guildId, ownerId, id)?.kind;
      if (current === kind) { out.changed.push(id); continue; }
      const n = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM voice_access WHERE guild_id = ? AND owner_id = ? AND kind = ?', guildId, ownerId, kind)!.n;
      if (n >= MAX_ACCESS_ENTRIES) { out.skipped.push({ id, reason: `máximo ${MAX_ACCESS_ENTRIES} en la lista` }); continue; }
      ctx.db.run(
        `INSERT INTO voice_access (guild_id, owner_id, target_id, kind, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, owner_id, target_id) DO UPDATE SET kind = excluded.kind, created_at = excluded.created_at`,
        guildId, ownerId, id, kind, ctx.now(),
      );
      out.changed.push(id);
    }
    return out;
  });
}

export function removeAccess(ctx: GameContext, guildId: string, ownerId: string, targetIds: string[], kind: AccessKind): string[] {
  return ctx.db.transaction(() => targetIds.filter((id) =>
    ctx.db.run('DELETE FROM voice_access WHERE guild_id = ? AND owner_id = ? AND target_id = ? AND kind = ?', guildId, ownerId, id, kind).changes === 1));
}

// ───────────────────────── Validaciones ─────────────────────────

const INVITE = /(discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg)\/\S+/i;
const LINK = /https?:\/\/\S+/i;

/** Nombre de canal: 1–100 caracteres, sin saltos de línea, sin menciones masivas, invitaciones ni enlaces. */
export function validateChannelName(raw: string): string {
  const name = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!name) throw new GameError('El nombre no puede estar vacío.');
  if (name.length > 100) throw new GameError('El nombre puede tener hasta 100 caracteres.');
  if (/@(everyone|here)/i.test(name)) throw new GameError('El nombre no puede incluir @everyone ni @here.');
  if (INVITE.test(name) || LINK.test(name)) throw new GameError('El nombre no puede incluir enlaces ni invitaciones.');
  return name;
}

export function validateTemplate(raw: string): string {
  const t = validateChannelName(raw);
  if (t.length > 80) throw new GameError('La plantilla puede tener hasta 80 caracteres (el nombre de la persona ocupa lugar).');
  return t;
}

/** Nombre inicial a partir de la plantilla ({usuario} = nombre visible). Nunca lanza: si algo falla, usa la de fábrica. */
export function renderChannelName(template: string, displayName: string): string {
  const who = displayName.replace(/[\r\n\t]+/g, ' ').replace(/@(everyone|here)/gi, '$1').trim() || 'alguien';
  const name = template.split('{usuario}').join(who).trim();
  try {
    return validateChannelName(name.slice(0, 100));
  } catch {
    return DEFAULT_NAME_TEMPLATE.replace('{usuario}', who).slice(0, 100);
  }
}

/** Límite de usuarios: 0 (sin límite) a 99, como en Discord. */
export function validateLimit(raw: string | number): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim() || 'x');
  if (!Number.isInteger(n) || n < 0 || n > 99) throw new GameError('El límite tiene que ser un número entero entre 0 (sin límite) y 99.');
  return n;
}

// ───────────────────────── Límite de renombres (en memoria) ─────────────────────────

/**
 * Discord deja renombrar un canal 2 veces cada 10 minutos; pasado eso, la API demora la respuesta
 * hasta 10 minutos y el botón quedaría "pensando". Se lleva la cuenta acá para avisar antes.
 */
export class RenameLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit = RENAME_LIMIT, private readonly windowMs = RENAME_WINDOW_MS) {}

  /** null si se puede renombrar; si no, cuándo se libera el próximo cambio (ms epoch). */
  readyAt(channelId: string, now: number): number | null {
    const list = (this.hits.get(channelId) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(channelId, list);
    return list.length < this.limit ? null : list[0] + this.windowMs;
  }

  record(channelId: string, now: number): void {
    const list = (this.hits.get(channelId) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.hits.set(channelId, list);
  }

  forget(channelId: string): void {
    this.hits.delete(channelId);
  }

  sweep(now: number): void {
    for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
  }
}

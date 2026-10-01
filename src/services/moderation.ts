import { GameError, type GameContext } from './context';

/**
 * Moderación: casos numerados por servidor, roles de moderación, configuración del automod y
 * reglas de escalado. Sin discord.js: la capa de Discord (src/discord/moderation) ejecuta las acciones.
 */

export type CaseAction = 'warn' | 'timeout' | 'untimeout' | 'kick' | 'ban' | 'unban';
export const CASE_ACTIONS: CaseAction[] = ['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban'];

export const CASE_META: Record<CaseAction, { label: string; emoji: string; color: number; past: string }> = {
  warn: { label: 'Advertencia', emoji: '⚠️', color: 0xf1c40f, past: 'advertido' },
  timeout: { label: 'Aislamiento', emoji: '⏱️', color: 0xe67e22, past: 'aislado' },
  untimeout: { label: 'Fin de aislamiento', emoji: '✅', color: 0x2ecc71, past: 'liberado del aislamiento' },
  kick: { label: 'Expulsión', emoji: '👢', color: 0xe67e22, past: 'expulsado' },
  ban: { label: 'Baneo', emoji: '🔨', color: 0xe74c3c, past: 'baneado' },
  unban: { label: 'Desbaneo', emoji: '🕊️', color: 0x2ecc71, past: 'desbaneado' },
};

export interface ModCase {
  id: number;
  guildId: string;
  number: number;
  action: CaseAction;
  targetId: string;
  moderatorId: string;
  reason: string;
  durationMs: number | null;
  auto: boolean;
  active: boolean;
  createdAt: number;
  expiresAt: number | null;
  revokedBy: string | null;
  revokedAt: number | null;
  logChannelId: string | null;
  logMessageId: string | null;
}

interface CaseRow {
  id: number; guild_id: string; case_number: number; action: CaseAction; target_id: string; moderator_id: string; reason: string;
  duration_ms: number | null; auto: number; active: number; created_at: number; expires_at: number | null; revoked_by: string | null;
  revoked_at: number | null; log_channel_id: string | null; log_message_id: string | null;
}

const toCase = (r: CaseRow): ModCase => ({
  id: r.id, guildId: r.guild_id, number: r.case_number, action: r.action, targetId: r.target_id, moderatorId: r.moderator_id, reason: r.reason,
  durationMs: r.duration_ms, auto: r.auto === 1, active: r.active === 1, createdAt: r.created_at, expiresAt: r.expires_at,
  revokedBy: r.revoked_by, revokedAt: r.revoked_at, logChannelId: r.log_channel_id, logMessageId: r.log_message_id,
});

export const REASON_MAX = 500;
const SNOWFLAKE = /^\d{17,20}$/;

/** Motivo limpio: sin menciones masivas, una línea larga como máximo 500 caracteres. */
export function cleanReason(raw: string | null | undefined): string {
  const r = (raw ?? '').replace(/@(everyone|here)/gi, '@​$1').replace(/\s+/g, ' ').trim();
  return r ? r.slice(0, REASON_MAX) : 'Sin motivo';
}

/**
 * Crea un caso con el siguiente número del servidor. El número sale de MAX()+1 dentro de la misma
 * transacción (y hay un índice único): dos sanciones simultáneas nunca comparten número.
 */
export function createCase(ctx: GameContext, input: {
  guildId: string; action: CaseAction; targetId: string; moderatorId: string; reason?: string | null; durationMs?: number | null; auto?: boolean;
}): ModCase {
  if (!SNOWFLAKE.test(input.targetId)) throw new GameError('Usuario inválido.');
  return ctx.db.transaction(() => {
    const now = ctx.now();
    const next = (ctx.db.get<{ n: number | null }>('SELECT MAX(case_number) AS n FROM mod_cases WHERE guild_id = ?', input.guildId)?.n ?? 0) + 1;
    let expiresAt: number | null = null;
    if (input.action === 'timeout' && input.durationMs) expiresAt = now + input.durationMs;
    if (input.action === 'warn') {
      const days = getAutomod(ctx, input.guildId).warns.expireDays;
      expiresAt = days > 0 ? now + days * 86_400_000 : null;
    }
    const r = ctx.db.run(
      `INSERT INTO mod_cases (guild_id, case_number, action, target_id, moderator_id, reason, duration_ms, auto, active, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      input.guildId, next, input.action, input.targetId, input.moderatorId, cleanReason(input.reason), input.durationMs ?? null,
      input.auto ? 1 : 0, now, expiresAt,
    );
    return toCase(ctx.db.get<CaseRow>('SELECT * FROM mod_cases WHERE id = ?', Number(r.lastInsertRowid))!);
  });
}

export function getCase(ctx: GameContext, guildId: string, number: number): ModCase | null {
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const r = ctx.db.get<CaseRow>('SELECT * FROM mod_cases WHERE guild_id = ? AND case_number = ?', guildId, number);
  return r ? toCase(r) : null;
}

export function listCases(ctx: GameContext, guildId: string, targetId: string, limit = 10, offset = 0): ModCase[] {
  return ctx.db.all<CaseRow>(
    'SELECT * FROM mod_cases WHERE guild_id = ? AND target_id = ? ORDER BY case_number DESC LIMIT ? OFFSET ?',
    guildId, targetId, Math.max(1, Math.min(50, limit)), Math.max(0, offset),
  ).map(toCase);
}

export function countCases(ctx: GameContext, guildId: string, targetId: string): number {
  return ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mod_cases WHERE guild_id = ? AND target_id = ?', guildId, targetId)!.n;
}

/** Advertencias que cuentan para el escalado: no anuladas y no vencidas. */
export function activeWarnCount(ctx: GameContext, guildId: string, targetId: string): number {
  return ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM mod_cases WHERE guild_id = ? AND target_id = ? AND action = 'warn' AND active = 1 AND (expires_at IS NULL OR expires_at > ?)",
    guildId, targetId, ctx.now(),
  )!.n;
}

export interface CaseSummary {
  total: number;
  activeWarns: number;
  byAction: Record<CaseAction, number>;
}

export function caseSummary(ctx: GameContext, guildId: string, targetId: string): CaseSummary {
  const byAction = Object.fromEntries(CASE_ACTIONS.map((a) => [a, 0])) as Record<CaseAction, number>;
  let total = 0;
  for (const r of ctx.db.all<{ action: CaseAction; n: number }>(
    'SELECT action, COUNT(*) AS n FROM mod_cases WHERE guild_id = ? AND target_id = ? AND active = 1 GROUP BY action', guildId, targetId,
  )) {
    byAction[r.action] = r.n;
    total += r.n;
  }
  return { total, activeWarns: activeWarnCount(ctx, guildId, targetId), byAction };
}

export function setCaseReason(ctx: GameContext, guildId: string, number: number, reason: string): ModCase {
  const c = getCase(ctx, guildId, number);
  if (!c) throw new GameError(`No existe el caso #${number}.`);
  ctx.db.run('UPDATE mod_cases SET reason = ? WHERE id = ?', cleanReason(reason), c.id);
  return getCase(ctx, guildId, number)!;
}

/** Anula un caso (queda en el historial tachado). Una advertencia anulada deja de contar para el escalado. */
export function revokeCase(ctx: GameContext, guildId: string, number: number, by: string): ModCase {
  return ctx.db.transaction(() => {
    const c = getCase(ctx, guildId, number);
    if (!c) throw new GameError(`No existe el caso #${number}.`);
    const r = ctx.db.run('UPDATE mod_cases SET active = 0, revoked_by = ?, revoked_at = ? WHERE id = ? AND active = 1', by, ctx.now(), c.id);
    if (r.changes !== 1) throw new GameError(`El caso #${number} ya estaba anulado.`);
    return getCase(ctx, guildId, number)!;
  });
}

export function setCaseLog(ctx: GameContext, caseId: number, channelId: string, messageId: string): void {
  ctx.db.run('UPDATE mod_cases SET log_channel_id = ?, log_message_id = ? WHERE id = ?', channelId, messageId, caseId);
}

// ───────────────────────── Duraciones ─────────────────────────

/** Discord no deja aislar por más de 28 días. */
export const MAX_TIMEOUT_MS = 28 * 86_400_000;
const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** "10m", "1h30m", "2d", "1w", "45s" (también "10 min", "2 horas"). Devuelve milisegundos. */
export function parseDuration(raw: string | null | undefined): number {
  const t = (raw ?? '').toLowerCase().replace(/\s+/g, '')
    .replace(/(semanas?|sem)/g, 'w').replace(/(d[ií]as?)/g, 'd').replace(/(horas?|hs|hrs?)/g, 'h').replace(/(minutos?|mins?)/g, 'm').replace(/(segundos?|segs?)/g, 's');
  if (!t || !/^(\d{1,5}[smhdw])+$/.test(t)) throw new GameError('Duración inválida. Ejemplos: `10m`, `1h`, `1h30m`, `2d`, `1w`.');
  let ms = 0;
  for (const m of t.matchAll(/(\d{1,5})([smhdw])/g)) ms += Number(m[1]) * UNITS[m[2]];
  if (ms < 5000) throw new GameError('La duración mínima es de 5 segundos.');
  if (ms > MAX_TIMEOUT_MS) throw new GameError('Discord no permite aislar por más de 28 días.');
  return ms;
}

export function formatDuration(ms: number): string {
  const parts: string[] = [];
  let rest = Math.round(ms / 1000);
  for (const [secs, label] of [[604_800, 'sem'], [86_400, 'd'], [3_600, 'h'], [60, 'min'], [1, 's']] as const) {
    const n = Math.floor(rest / secs);
    if (n) parts.push(`${n} ${label}`);
    rest -= n * secs;
  }
  return parts.slice(0, 2).join(' ') || '0 s';
}

// ───────────────────────── Roles de moderación ─────────────────────────

export type ModLevel = 'mod' | 'admin';
export type ModAction = 'warn' | 'timeout' | 'history' | 'kick' | 'ban' | 'editcase';

/** Qué nivel hace falta para cada acción cuando el permiso viene de un rol configurado en /automod. */
export const ACTION_LEVEL: Record<ModAction, ModLevel> = { warn: 'mod', timeout: 'mod', history: 'mod', kick: 'admin', ban: 'admin', editcase: 'admin' };
export const MAX_MOD_ROLES = 10;

export function listModRoles(ctx: GameContext, guildId: string): { roleId: string; level: ModLevel }[] {
  return ctx.db.all<{ role_id: string; level: ModLevel }>('SELECT role_id, level FROM mod_roles WHERE guild_id = ? ORDER BY level, role_id', guildId)
    .map((r) => ({ roleId: r.role_id, level: r.level }));
}

/** Reemplaza los roles de un nivel. Un rol está en un solo nivel (el último que se eligió). */
export function setModRoles(ctx: GameContext, guildId: string, level: ModLevel, roleIds: string[]): string[] {
  const ids = [...new Set(roleIds.filter((r) => SNOWFLAKE.test(r) && r !== guildId))];
  if (ids.length > MAX_MOD_ROLES) throw new GameError(`Como máximo ${MAX_MOD_ROLES} roles por nivel.`);
  ctx.db.transaction(() => {
    ctx.db.run('DELETE FROM mod_roles WHERE guild_id = ? AND level = ?', guildId, level);
    for (const id of ids) {
      ctx.db.run(`INSERT INTO mod_roles (guild_id, role_id, level) VALUES (?, ?, ?)
                  ON CONFLICT (guild_id, role_id) DO UPDATE SET level = excluded.level`, guildId, id, level);
    }
  });
  return ids;
}

/** Nivel más alto que dan los roles de una persona (o null). */
export function levelFromRoles(ctx: GameContext, guildId: string, roleIds: Iterable<string>): ModLevel | null {
  const have = new Set(roleIds);
  let best: ModLevel | null = null;
  for (const r of listModRoles(ctx, guildId)) {
    if (!have.has(r.roleId)) continue;
    if (r.level === 'admin') return 'admin';
    best = 'mod';
  }
  return best;
}

// ───────────────────────── Automod ─────────────────────────

export type LinkMode = 'off' | 'invites' | 'all';
export type RaidAction = 'alert' | 'timeout' | 'kick';

export interface AutomodConfig {
  spam: { enabled: boolean; maxMessages: number; perSeconds: number; timeoutMinutes: number };
  flood: { enabled: boolean; maxDuplicates: number; maxMentions: number; maxLines: number };
  links: { mode: LinkMode; allow: string[] };
  raid: { enabled: boolean; joins: number; perSeconds: number; action: RaidAction; accountDays: number; minutes: number };
  warns: { expireDays: number; timeoutAt: number; timeoutMinutes: number; kickAt: number; banAt: number };
  /** Infracciones del automod (enlace, flood) en 10 minutos que generan una advertencia. 0 = nunca. */
  strikesToWarn: number;
  exemptRoles: string[];
  exemptChannels: string[];
  /** Avisar por MD a quien recibe una sanción. */
  dmOnAction: boolean;
}

export const DEFAULT_AUTOMOD: AutomodConfig = {
  spam: { enabled: true, maxMessages: 6, perSeconds: 5, timeoutMinutes: 5 },
  flood: { enabled: true, maxDuplicates: 4, maxMentions: 6, maxLines: 30 },
  links: { mode: 'invites', allow: ['tenor.com', 'giphy.com', 'youtube.com', 'youtu.be', 'twitch.tv', 'spotify.com'] },
  raid: { enabled: true, joins: 10, perSeconds: 30, action: 'alert', accountDays: 7, minutes: 15 },
  warns: { expireDays: 30, timeoutAt: 3, timeoutMinutes: 60, kickAt: 0, banAt: 0 },
  strikesToWarn: 3,
  exemptRoles: [],
  exemptChannels: [],
  dmOnAction: true,
};

/** Campos numéricos editables desde /automod, con su rango seguro. */
export const AUTOMOD_NUMBERS = {
  'spam.maxMessages': { label: 'Mensajes máximos', min: 3, max: 30 },
  'spam.perSeconds': { label: 'En cuántos segundos', min: 2, max: 60 },
  'spam.timeoutMinutes': { label: 'Aislamiento por spam (min)', min: 1, max: 1440 },
  'flood.maxDuplicates': { label: 'Mensajes repetidos máximos (30 s)', min: 2, max: 20 },
  'flood.maxMentions': { label: 'Menciones máximas por mensaje', min: 2, max: 50 },
  'flood.maxLines': { label: 'Líneas máximas por mensaje', min: 5, max: 200 },
  strikesToWarn: { label: 'Infracciones para advertir (0 = nunca)', min: 0, max: 20 },
  'raid.joins': { label: 'Entradas para detectar raid', min: 3, max: 100 },
  'raid.perSeconds': { label: 'En cuántos segundos', min: 5, max: 600 },
  'raid.accountDays': { label: 'Cuenta "nueva" si tiene menos de (días)', min: 0, max: 365 },
  'raid.minutes': { label: 'Duración del modo raid (min)', min: 1, max: 1440 },
  'warns.expireDays': { label: 'Advertencias vencen a los (días; 0 = nunca)', min: 0, max: 365 },
  'warns.timeoutAt': { label: 'Aislar al llegar a N advertencias (0 = no)', min: 0, max: 20 },
  'warns.timeoutMinutes': { label: 'Minutos de ese aislamiento', min: 1, max: 40_320 },
  'warns.kickAt': { label: 'Expulsar al llegar a N advertencias (0 = no)', min: 0, max: 20 },
  'warns.banAt': { label: 'Banear al llegar a N advertencias (0 = no)', min: 0, max: 30 },
} as const;
export type AutomodNumberKey = keyof typeof AUTOMOD_NUMBERS;

const MAX_LIST = 25;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;

function int(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
}
function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}
function ids(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && SNOWFLAKE.test(x)))].slice(0, MAX_LIST) : [];
}

export function normalizeDomains(raw: string | string[]): string[] {
  const list = (Array.isArray(raw) ? raw : raw.split(/[\s,;]+/))
    .map((d) => String(d).toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
    .filter((d) => DOMAIN.test(d));
  return [...new Set(list)].slice(0, 40);
}

/** Normaliza cualquier JSON guardado (o editado a mano) a una configuración válida: nunca rompe el bot. */
export function normalizeAutomod(raw: unknown): AutomodConfig {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const d = DEFAULT_AUTOMOD;
  const n = (path: AutomodNumberKey, v: unknown, def: number) => int(v, def, AUTOMOD_NUMBERS[path].min, AUTOMOD_NUMBERS[path].max);
  return {
    spam: {
      enabled: bool(o.spam?.enabled, d.spam.enabled),
      maxMessages: n('spam.maxMessages', o.spam?.maxMessages, d.spam.maxMessages),
      perSeconds: n('spam.perSeconds', o.spam?.perSeconds, d.spam.perSeconds),
      timeoutMinutes: n('spam.timeoutMinutes', o.spam?.timeoutMinutes, d.spam.timeoutMinutes),
    },
    flood: {
      enabled: bool(o.flood?.enabled, d.flood.enabled),
      maxDuplicates: n('flood.maxDuplicates', o.flood?.maxDuplicates, d.flood.maxDuplicates),
      maxMentions: n('flood.maxMentions', o.flood?.maxMentions, d.flood.maxMentions),
      maxLines: n('flood.maxLines', o.flood?.maxLines, d.flood.maxLines),
    },
    links: {
      mode: (['off', 'invites', 'all'] as LinkMode[]).includes(o.links?.mode) ? o.links.mode : d.links.mode,
      allow: Array.isArray(o.links?.allow) ? normalizeDomains(o.links.allow) : [...d.links.allow],
    },
    raid: {
      enabled: bool(o.raid?.enabled, d.raid.enabled),
      joins: n('raid.joins', o.raid?.joins, d.raid.joins),
      perSeconds: n('raid.perSeconds', o.raid?.perSeconds, d.raid.perSeconds),
      action: (['alert', 'timeout', 'kick'] as RaidAction[]).includes(o.raid?.action) ? o.raid.action : d.raid.action,
      accountDays: n('raid.accountDays', o.raid?.accountDays, d.raid.accountDays),
      minutes: n('raid.minutes', o.raid?.minutes, d.raid.minutes),
    },
    warns: {
      expireDays: n('warns.expireDays', o.warns?.expireDays, d.warns.expireDays),
      timeoutAt: n('warns.timeoutAt', o.warns?.timeoutAt, d.warns.timeoutAt),
      timeoutMinutes: n('warns.timeoutMinutes', o.warns?.timeoutMinutes, d.warns.timeoutMinutes),
      kickAt: n('warns.kickAt', o.warns?.kickAt, d.warns.kickAt),
      banAt: n('warns.banAt', o.warns?.banAt, d.warns.banAt),
    },
    strikesToWarn: n('strikesToWarn', o.strikesToWarn, d.strikesToWarn),
    exemptRoles: ids(o.exemptRoles),
    exemptChannels: ids(o.exemptChannels),
    dmOnAction: bool(o.dmOnAction, d.dmOnAction),
  };
}

/** Caché en memoria (el automod se consulta en cada mensaje); se invalida al guardar. */
const automodCache = new Map<string, AutomodConfig>();

export function getAutomod(ctx: GameContext, guildId: string): AutomodConfig {
  const hit = automodCache.get(guildId);
  if (hit) return hit;
  const row = ctx.db.get<{ config: string }>('SELECT config FROM automod_config WHERE guild_id = ?', guildId);
  let parsed: unknown = {};
  try {
    parsed = row ? JSON.parse(row.config) : {};
  } catch {
    parsed = {};
  }
  const cfg = normalizeAutomod(parsed);
  automodCache.set(guildId, cfg);
  return cfg;
}

export function saveAutomod(ctx: GameContext, guildId: string, cfg: AutomodConfig): AutomodConfig {
  const clean = normalizeAutomod(cfg);
  ctx.db.run(
    `INSERT INTO automod_config (guild_id, config, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    guildId, JSON.stringify(clean), ctx.now(),
  );
  automodCache.set(guildId, clean);
  return clean;
}

/** Cambia un campo numérico por su ruta ("spam.maxMessages"), validando el rango. */
export function setAutomodNumber(ctx: GameContext, guildId: string, key: AutomodNumberKey, value: number): AutomodConfig {
  const def = AUTOMOD_NUMBERS[key];
  if (!Number.isInteger(value) || value < def.min || value > def.max) throw new GameError(`**${def.label}**: tiene que ser un número entero entre ${def.min} y ${def.max}.`);
  const cfg = structuredClone(getAutomod(ctx, guildId)) as unknown as Record<string, Record<string, number> | number>;
  const [a, b] = key.split('.');
  if (b) (cfg[a] as Record<string, number>)[b] = value;
  else cfg[a] = value;
  return saveAutomod(ctx, guildId, cfg as unknown as AutomodConfig);
}

export function resetAutomodCache(): void {
  automodCache.clear();
}

export function getRaidUntil(ctx: GameContext, guildId: string): number {
  return ctx.db.get<{ raid_until: number | null }>('SELECT raid_until FROM automod_config WHERE guild_id = ?', guildId)?.raid_until ?? 0;
}

export function setRaidUntil(ctx: GameContext, guildId: string, until: number | null): void {
  ctx.db.run(
    `INSERT INTO automod_config (guild_id, config, raid_until, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET raid_until = excluded.raid_until, updated_at = excluded.updated_at`,
    guildId, JSON.stringify(getAutomod(ctx, guildId)), until, ctx.now(),
  );
}

// ───────────────────────── Escalado por advertencias ─────────────────────────

export type Escalation = { action: 'timeout'; ms: number } | { action: 'kick' } | { action: 'ban' };

/**
 * Qué hacer al llegar a N advertencias activas. Aislar y expulsar se disparan al llegar justo al umbral
 * (no se repiten en cada advertencia siguiente); banear, desde el umbral en adelante.
 */
export function escalationFor(cfg: AutomodConfig, activeWarns: number): Escalation | null {
  const w = cfg.warns;
  if (w.banAt && activeWarns >= w.banAt) return { action: 'ban' };
  if (w.kickAt && activeWarns === w.kickAt) return { action: 'kick' };
  if (w.timeoutAt && activeWarns === w.timeoutAt) return { action: 'timeout', ms: Math.min(MAX_TIMEOUT_MS, w.timeoutMinutes * 60_000) };
  return null;
}

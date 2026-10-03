import type { GameContext } from './context';

/**
 * Anti-webhooks: quién puede crear webhooks y qué hacer con los mensajes de webhooks maliciosos.
 * Las decisiones son funciones puras (testeables); la capa de Discord solo las ejecuta.
 */

export interface WebhookGuardConfig {
  enabled: boolean;
  /** Los administradores pueden crear webhooks. */
  allowAdmins: boolean;
  /** Si un bot (que no sea este) crea un webhook sin permiso, se lo expulsa. */
  kickBots: boolean;
  allowRoles: string[];
}

const SNOWFLAKE = /^\d{17,20}$/;

export function getWebhookGuard(ctx: GameContext, guildId: string): WebhookGuardConfig {
  const r = ctx.db.get<{ enabled: number; allow_admins: number; kick_bots: number; allow_roles: string }>('SELECT * FROM webhook_guard WHERE guild_id = ?', guildId);
  if (!r) return { enabled: false, allowAdmins: true, kickBots: true, allowRoles: [] };
  let roles: string[] = [];
  try {
    const a = JSON.parse(r.allow_roles) as unknown;
    roles = Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && SNOWFLAKE.test(x)).slice(0, 25) : [];
  } catch {
    roles = [];
  }
  return { enabled: r.enabled === 1, allowAdmins: r.allow_admins === 1, kickBots: r.kick_bots === 1, allowRoles: roles };
}

export function saveWebhookGuard(ctx: GameContext, guildId: string, patch: Partial<WebhookGuardConfig>): WebhookGuardConfig {
  const next = { ...getWebhookGuard(ctx, guildId), ...patch };
  next.allowRoles = [...new Set(next.allowRoles.filter((r) => SNOWFLAKE.test(r)))].slice(0, 25);
  ctx.db.run(
    `INSERT INTO webhook_guard (guild_id, enabled, allow_admins, kick_bots, allow_roles, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET enabled = excluded.enabled, allow_admins = excluded.allow_admins, kick_bots = excluded.kick_bots,
       allow_roles = excluded.allow_roles, updated_at = excluded.updated_at`,
    guildId, next.enabled ? 1 : 0, next.allowAdmins ? 1 : 0, next.kickBots ? 1 : 0, JSON.stringify(next.allowRoles), ctx.now(),
  );
  return getWebhookGuard(ctx, guildId);
}

export interface WebhookCreator {
  id: string;
  isSelf: boolean;
  isOwner: boolean;
  isBot: boolean;
  isAdmin: boolean;
  roleIds: string[];
}

export type WebhookVerdict = 'allow' | 'delete' | 'delete_kick';

/** ¿Se permite que esta persona (o bot) cree un webhook? */
export function judgeWebhookCreator(cfg: WebhookGuardConfig, c: WebhookCreator): WebhookVerdict {
  if (!cfg.enabled || c.isSelf || c.isOwner) return 'allow';
  if (cfg.allowAdmins && c.isAdmin) return 'allow';
  if (c.roleIds.some((r) => cfg.allowRoles.includes(r))) return 'allow';
  return c.isBot && cfg.kickBots ? 'delete_kick' : 'delete';
}

/** Mensajes de webhook peligrosos: menciones masivas o invitaciones a otros servidores. */
export function webhookMessageProblem(content: string, mentionsEveryone: boolean): string | null {
  if (mentionsEveryone || /@(everyone|here)/.test(content)) return 'mención masiva (@everyone/@here)';
  if (/(discord\.gg|discord(?:app)?\.com\/invite)\/\w+/i.test(content)) return 'invitación a otro servidor';
  return null;
}

/** Ráfaga: más de `max` mensajes del mismo webhook en `windowMs`. */
export class WebhookFlood {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max = 5, private readonly windowMs = 5_000) {}
  hit(webhookId: string, now: number): boolean {
    const list = [...(this.hits.get(webhookId) ?? []).filter((t) => now - t < this.windowMs), now];
    this.hits.set(webhookId, list);
    if (this.hits.size > 5_000) this.hits.delete(this.hits.keys().next().value!);
    return list.length > this.max;
  }
}

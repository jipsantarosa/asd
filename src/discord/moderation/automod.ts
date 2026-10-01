import { EmbedBuilder, PermissionFlagsBits, type GuildMember, type Message, type PartialMessage } from 'discord.js';
import { logger } from '../../logger';
import { JoinTracker, MessageTracker, StrikeTracker, isNewAccount, lineCount, linkViolation, normalizeContent } from '../../services/automod';
import { MAX_TIMEOUT_MS, formatDuration, getAutomod, getRaidUntil, levelFromRoles, setRaidUntil, type AutomodConfig } from '../../services/moderation';
import type { App } from '../app';
import { logSystem, sendLog } from '../logging/sender';
import { COLORS, truncate } from '../ui/theme';
import { kickMember, timeoutMember, warnMember, type Actor } from './actions';

const F = PermissionFlagsBits;

export interface Automod {
  /** true si el mensaje rompió una regla y ya se actuó (no hay que procesarlo como comando). */
  onMessage(msg: Message): Promise<boolean>;
  /** Ediciones: alguien podría mandar un texto inocente y después editarlo con una invitación. */
  onEdit(msg: Message | PartialMessage): Promise<void>;
  onMemberAdd(member: GuildMember): Promise<void>;
  sweep(): void;
}

/**
 * Automod: antispam (ráfagas → aislamiento), antiflood (repetidos, menciones, paredes de texto), filtro de enlaces
 * y detección de raids. Nunca toca al staff, a los roles de moderación ni a lo que esté exento.
 */
export function createAutomod(app: App): Automod {
  const { ctx } = app;
  const messages = new MessageTracker();
  const strikes = new StrikeTracker();
  const joins = new JoinTracker();
  /** Tras actuar por spam, los mensajes que sigan llegando en 15 s se borran sin volver a sancionar. */
  const spamCooldown = new Map<string, number>();
  const lastNotice = new Map<string, number>();
  const lastPermWarning = new Map<string, number>();
  const raidReport = new Map<string, { done: string[]; failed: number; timer: NodeJS.Timeout }>();

  const botActor = (member: GuildMember): Actor => ({ app, guild: member.guild, moderator: null });

  function exempt(member: GuildMember, channelId: string, parentId: string | null, cfg: AutomodConfig): boolean {
    if (member.user.bot || member.id === member.guild.ownerId) return true;
    if (member.permissions.any([F.Administrator, F.ManageGuild, F.ManageMessages])) return true;
    if (cfg.exemptRoles.some((r) => member.roles.cache.has(r))) return true;
    if (cfg.exemptChannels.includes(channelId) || (parentId && cfg.exemptChannels.includes(parentId))) return true;
    return levelFromRoles(ctx, member.guild.id, member.roles.cache.keys()) !== null;
  }

  function parentOf(msg: Message<true>): string | null {
    // En un hilo, el "padre" es el canal; en un canal, la categoría. Se miran los dos para las exenciones.
    const ch = msg.channel;
    return 'parentId' in ch ? ch.parentId ?? null : null;
  }

  async function warnMissingPerms(msg: Message<true>, what: string): Promise<void> {
    if (Date.now() - (lastPermWarning.get(msg.guildId) ?? 0) < 30 * 60_000) return;
    lastPermWarning.set(msg.guildId, Date.now());
    await logSystem(ctx, msg.guild, `⚠️ El automod no pudo ${what} en <#${msg.channelId}>: dame **Gestionar mensajes** y **Moderar miembros**.`, COLORS.warn);
  }

  /** Aviso corto en el canal (como mucho uno cada 8 s por persona), que se borra solo. */
  async function notice(msg: Message<true>, text: string): Promise<void> {
    const key = `${msg.guildId}:${msg.author.id}`;
    if (Date.now() - (lastNotice.get(key) ?? 0) < 8000 || !msg.channel.isSendable()) return;
    lastNotice.set(key, Date.now());
    const sent = await msg.channel.send({ content: `<@${msg.author.id}> ${text}`, allowedMentions: { users: [msg.author.id] } }).catch(() => null);
    if (sent) setTimeout(() => void sent.delete().catch(() => undefined), 7000).unref();
  }

  /** Infracción leve: se borra el mensaje, se avisa y suma una infracción (varias = una advertencia). */
  async function violation(msg: Message<true>, member: GuildMember, cfg: AutomodConfig, reason: string): Promise<boolean> {
    const deleted = await msg.delete().then(() => true).catch(() => false);
    if (!deleted) await warnMissingPerms(msg, 'borrar un mensaje');
    await notice(msg, `⚠️ ${reason}.`);
    if (cfg.strikesToWarn > 0) {
      const key = `${msg.guildId}:${member.id}`;
      const n = strikes.add(key, Date.now());
      if (n >= cfg.strikesToWarn) {
        strikes.reset(key);
        await warnMember(botActor(member), member, `Automod: ${reason} (${n} infracciones en 10 minutos)`)
          .catch((err) => logger.warn('Automod (advertencia):', (err as Error).message));
      }
    }
    return true;
  }

  /** Ráfaga de mensajes: se borran los de la ráfaga y se aísla a la persona. */
  async function punishSpam(msg: Message<true>, member: GuildMember, cfg: AutomodConfig, recent: { id: string; channelId: string }[]): Promise<void> {
    const byChannel = new Map<string, string[]>();
    for (const m of recent) byChannel.set(m.channelId, [...(byChannel.get(m.channelId) ?? []), m.id]);
    for (const [channelId, ids] of byChannel) {
      const ch = msg.guild.channels.cache.get(channelId);
      if (!ch?.isTextBased() || !('bulkDelete' in ch)) continue;
      const ok = ids.length === 1
        ? await ch.messages.delete(ids[0]).then(() => true).catch(() => false)
        : await ch.bulkDelete(ids, true).then(() => true).catch(() => false);
      if (!ok) await warnMissingPerms(msg, 'borrar mensajes de spam');
    }
    const ms = cfg.spam.timeoutMinutes * 60_000;
    const r = await timeoutMember(botActor(member), member, ms, `Automod: spam (${recent.length} mensajes en ${cfg.spam.perSeconds} s)`).catch((err) => {
      logger.warn('Automod (spam):', (err as Error).message);
      return null;
    });
    await notice(msg, r ? `🚫 aislado ${formatDuration(ms)} por spam (caso #${r.c.number}).` : '🚫 bajá el ritmo: estás mandando mensajes demasiado rápido.');
  }

  async function check(msg: Message<true>, member: GuildMember, cfg: AutomodConfig, fresh: boolean): Promise<boolean> {
    const now = Date.now();
    const key = `${msg.guildId}:${member.id}`;
    const content = msg.content ?? '';

    if (fresh && cfg.spam.enabled) {
      messages.record(key, { id: msg.id, channelId: msg.channelId, hash: normalizeContent(content), at: now });
      if ((spamCooldown.get(key) ?? 0) > now) {
        await msg.delete().catch(() => undefined);
        return true;
      }
      const recent = messages.recent(key, now, cfg.spam.perSeconds * 1000);
      if (recent.length > cfg.spam.maxMessages) {
        spamCooldown.set(key, now + 15_000);
        messages.clear(key);
        await punishSpam(msg, member, cfg, recent);
        return true;
      }
    } else if (fresh) {
      messages.record(key, { id: msg.id, channelId: msg.channelId, hash: normalizeContent(content), at: now });
    }

    const link = linkViolation(content, cfg.links.mode, cfg.links.allow);
    if (link) return violation(msg, member, cfg, link);

    if (cfg.flood.enabled) {
      const mentions = msg.mentions.users.filter((u) => u.id !== member.id).size + msg.mentions.roles.size;
      if (mentions > cfg.flood.maxMentions) return violation(msg, member, cfg, `demasiadas menciones en un mensaje (${mentions})`);
      if (lineCount(content) > cfg.flood.maxLines) return violation(msg, member, cfg, 'el mensaje tiene demasiadas líneas');
      const hash = normalizeContent(content);
      if (fresh && hash && messages.duplicates(key, hash, now) > cfg.flood.maxDuplicates) return violation(msg, member, cfg, 'no repitas el mismo mensaje');
    }
    return false;
  }

  async function memberOf(msg: Message<true>): Promise<GuildMember | null> {
    return msg.member ?? (await msg.guild.members.fetch(msg.author.id).catch(() => null));
  }

  // ───────────── Raid ─────────────

  /** Resumen de lo que hizo el modo raid, agrupado cada 10 s (no un log por persona). */
  function report(member: GuildMember, failed: boolean): void {
    const g = member.guild;
    let r = raidReport.get(g.id);
    if (!r) {
      r = {
        done: [], failed: 0,
        timer: setTimeout(() => {
          const cur = raidReport.get(g.id);
          raidReport.delete(g.id);
          if (!cur) return;
          const cfg = getAutomod(ctx, g.id);
          const verb = cfg.raid.action === 'kick' ? 'expulsé' : cfg.raid.action === 'timeout' ? 'aislé' : 'detecté';
          void sendLog(ctx, g, 'moderacion', { embeds: [new EmbedBuilder().setColor(COLORS.error).setTimestamp().setTitle('🚨 Modo raid')
            .setDescription(`${cur.done.length ? `Durante el modo raid ${verb} ${cur.done.length} cuenta(s) nueva(s): ${truncate(cur.done.map((id) => `<@${id}>`).join(' '), 3500)}` : ''}${cur.failed ? `\n⚠️ ${cur.failed} no se pudieron sancionar (revisá mis permisos).` : ''}`)] });
        }, 10_000),
      };
      r.timer.unref();
      raidReport.set(g.id, r);
    }
    if (failed) r.failed += 1;
    else r.done.push(member.id);
  }

  async function raidAct(member: GuildMember, cfg: AutomodConfig, until: number): Promise<void> {
    if (member.user.bot || !isNewAccount(member.user.createdTimestamp, Date.now(), cfg.raid.accountDays)) return;
    if (cfg.raid.action === 'alert') {
      report(member, false);
      return;
    }
    const actor: Actor = { app, guild: member.guild, moderator: null, silent: true };
    const why = 'Modo raid: cuenta nueva durante un raid';
    const ok = cfg.raid.action === 'kick'
      ? await kickMember(actor, member, why).then(() => true).catch(() => false)
      : await timeoutMember(actor, member, Math.min(MAX_TIMEOUT_MS, Math.max(60_000, until - Date.now())), why).then(() => true).catch(() => false);
    report(member, !ok);
  }

  return {
    async onMessage(msg) {
      if (!msg.inGuild() || msg.author.bot || msg.webhookId || msg.system) return false;
      const cfg = getAutomod(ctx, msg.guildId);
      if (!cfg.spam.enabled && !cfg.flood.enabled && cfg.links.mode === 'off') return false;
      const member = await memberOf(msg);
      if (!member || exempt(member, msg.channelId, parentOf(msg), cfg)) return false;
      return check(msg, member, cfg, true);
    },

    async onEdit(partial) {
      const msg = partial.partial ? await partial.fetch().catch(() => null) : partial;
      if (!msg || !msg.inGuild() || msg.author.bot || msg.webhookId) return;
      const cfg = getAutomod(ctx, msg.guildId);
      if (cfg.links.mode === 'off' && !cfg.flood.enabled) return;
      const member = await memberOf(msg);
      if (!member || exempt(member, msg.channelId, parentOf(msg), cfg)) return;
      await check(msg, member, cfg, false);
    },

    async onMemberAdd(member) {
      const cfg = getAutomod(ctx, member.guild.id);
      if (!cfg.raid.enabled || member.user.bot) return;
      const now = Date.now();
      const windowMs = cfg.raid.perSeconds * 1000;
      const count = joins.record(member.guild.id, member.id, now, windowMs);
      const until = getRaidUntil(ctx, member.guild.id);
      if (until > now) {
        await raidAct(member, cfg, until);
        return;
      }
      if (count < cfg.raid.joins) return;
      // ¡Raid! Se activa el modo raid y se aplica la acción a quienes entraron en la ventana.
      const end = now + cfg.raid.minutes * 60_000;
      setRaidUntil(ctx, member.guild.id, end);
      const text = `🚨 **Posible raid:** ${count} entradas en ${cfg.raid.perSeconds} s. Modo raid activo hasta <t:${Math.floor(end / 1000)}:R>. ` +
        `Acción: **${cfg.raid.action === 'kick' ? 'expulsar' : cfg.raid.action === 'timeout' ? 'aislar' : 'solo avisar'}** cuentas de menos de ${cfg.raid.accountDays} días. Se termina antes desde \`/automod\`.`;
      await logSystem(ctx, member.guild, text, COLORS.error);
      await sendLog(ctx, member.guild, 'moderacion', { embeds: [new EmbedBuilder().setColor(COLORS.error).setTitle('🚨 Raid detectado').setDescription(text).setTimestamp()] });
      for (const id of joins.recent(member.guild.id, now, windowMs)) {
        const m = member.guild.members.cache.get(id);
        if (m) await raidAct(m, cfg, end);
      }
    },

    sweep() {
      const now = Date.now();
      messages.sweep(now);
      strikes.sweep(now);
      joins.sweep(now);
      for (const [k, t] of spamCooldown) if (t < now) spamCooldown.delete(k);
      for (const [k, t] of lastNotice) if (now - t > 60_000) lastNotice.delete(k);
    },
  };
}

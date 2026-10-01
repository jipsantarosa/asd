import { EmbedBuilder, type AttachmentBuilder, type GuildMember } from 'discord.js';
import {
  CATEGORY_META, TIER_META, achievementProgress, claimNotices, finishNotices, nextInCategory, pendingNotices, recoverStuckNotices,
  type PendingNotice,
} from '../services/achievements';
import { describeReward } from '../services/rewards';
import { gameConfig } from '../services/guildSettings';
import { logger } from '../logger';
import type { App } from './app';
import { badgeImage } from './assets';
import { syncRewardRoles } from './roleSafety';
import { bar, num } from './ui/theme';

/** Discord: "Cannot send messages to this user" (MD cerrados, bloqueado o sin servidor en común). */
const DM_CLOSED = 50007;

/**
 * Envía por DM los logros pendientes de un jugador (hasta 5 por mensaje, cada uno con su insignia; el resto sale en el siguiente envío).
 * Con los MD cerrados no se reintenta: queda marcado como "bloqueado" y el logro igual se ve en /perfil.
 */
export async function deliverAchievements(app: App, guildId: string, userId: string): Promise<number> {
  const { ctx } = app;
  const claimed = claimNotices(ctx, pendingNotices(ctx, { guildId, userId }, 5));
  if (!claimed.length) return 0;
  const guild = app.client.guilds.cache.get(guildId);
  const cfg = gameConfig(ctx, guildId);
  const progress = achievementProgress(ctx, guildId, userId);
  const unlocked = progress.filter((x) => x.unlocked).length;
  const embeds: EmbedBuilder[] = [];
  const files: AttachmentBuilder[] = [];
  for (const n of claimed) {
    const def = cfg.achievements.find((a) => a.id === n.achievementId);
    if (!def) continue;
    const tier = TIER_META[def.tier];
    const next = nextInCategory(progress, def);
    const e = new EmbedBuilder()
      .setColor(tier.color)
      .setAuthor({ name: guild ? `${guild.name} · El Valle` : 'El Valle', iconURL: guild?.iconURL() ?? undefined })
      .setTitle(`🏅 ¡Logro desbloqueado! ${def.emoji} ${def.name}`)
      .setDescription(`*${def.description}*`)
      .addFields(
        { name: 'Recompensa', value: `${describeReward(ctx, guildId, def.reward)}${def.activity ? ` · 🔥 ${def.activity} de actividad` : ''}`, inline: true },
        { name: 'Nivel', value: `${tier.emoji} ${tier.label} · ${CATEGORY_META[def.category].emoji} ${CATEGORY_META[def.category].label}`, inline: true },
        { name: 'Tu colección', value: `\`${bar(unlocked, progress.length, 10)}\` ${unlocked}/${progress.length} logros` },
      )
      .setFooter({ text: 'Todos tus logros: /perfil → Logros' })
      .setTimestamp();
    if (next) e.addFields({ name: `Siguiente en ${CATEGORY_META[def.category].label}`, value: `${next.def.emoji} **${next.def.name}** — ${num(next.value)}/${num(next.def.goal)} \`${bar(next.value, next.def.goal, 8)}\`` });
    const badge = badgeImage(def);
    if (badge) {
      e.setThumbnail(badge.url);
      files.push(badge.file);
    }
    embeds.push(e);
  }
  if (!embeds.length) {
    finishNotices(ctx, claimed, 'enviado');
    return 0;
  }
  try {
    const user = await app.client.users.fetch(userId);
    await user.send({ embeds, files });
    finishNotices(ctx, claimed, 'enviado');
    return embeds.length;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === DM_CLOSED) {
      finishNotices(ctx, claimed, 'bloqueado');
    } else {
      logger.warn(`No pude enviar logros a ${userId}:`, (err as Error).message);
      finishNotices(ctx, claimed, 'reintentar');
    }
    return 0;
  }
}

/** Después de cualquier acción: distinciones (por nivel o actividad) y avisos de logros. Nunca lanza. */
export async function afterAction(app: App, member: GuildMember): Promise<void> {
  try {
    await syncRewardRoles(app.ctx, member);
    await deliverAchievements(app, member.guild.id, member.id);
  } catch (err) {
    logger.warn('afterAction:', err);
  }
}

/** Barrido periódico: entrega lo que quedó pendiente (acciones desde la Actividad, reinicios, reintentos). */
export function startNoticeSweeper(app: App, everyMs = 60_000): NodeJS.Timeout {
  recoverStuckNotices(app.ctx);
  let running = false;
  const timer = setInterval(async () => {
    if (running || !app.client.isReady()) return;
    running = true;
    try {
      const seen = new Set<string>();
      for (const n of pendingNotices(app.ctx, undefined, 100) as PendingNotice[]) {
        const key = `${n.guildId}:${n.userId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const guild = app.client.guilds.cache.get(n.guildId);
        const member = guild ? await guild.members.fetch(n.userId).catch(() => null) : null;
        if (member) await afterAction(app, member);
        else await deliverAchievements(app, n.guildId, n.userId);
      }
    } finally {
      running = false;
    }
  }, everyMs);
  timer.unref();
  return timer;
}

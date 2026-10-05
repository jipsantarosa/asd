import { Events, type GuildMember, type User } from 'discord.js';
import { logger } from '../../logger';
import { recordMedia } from '../../services/userMedia';
import { recordName } from '../../services/userNames';
import type { App } from '../app';
import { ensureArchived, MediaArchiver, setArchiver } from '../media/archive';

/**
 * Detecta cambios de avatar, banner, nombres y tags mientras el bot está presente:
 *  - Mensajes: compara con lo último visto (caché en memoria → casi sin costo).
 *  - Actualizaciones de usuario y de miembro (intent GuildMembers): avatar, nombres, apodo, tag.
 *  - Ingresos al servidor.
 * El banner solo viene cuando se pide el usuario completo; por eso los comandos también lo registran.
 */
const MAX_CACHE = 50_000;

/** Tag de servidor (el "clan" que se ve al lado del nombre). discord.js lo expone en versiones recientes. */
export function serverTag(user: User): { tag: string; guildId: string } | null {
  const pg = (user as unknown as { primaryGuild?: { tag?: string | null; identityGuildId?: string | null; identityEnabled?: boolean | null } | null }).primaryGuild;
  if (!pg?.tag || pg.identityEnabled === false) return null;
  return { tag: pg.tag, guildId: pg.identityGuildId ?? '' };
}

export function startMediaTracking(app: App): NodeJS.Timeout {
  // Archivo de imágenes: guarda cada avatar/banner nuevo y, cada 10 minutos, reintenta los que faltan.
  const archiver = new MediaArchiver(app.ctx);
  setArchiver(archiver);
  const backfill = () => {
    try {
      archiver.backfill(200);
    } catch (err) {
      logger.warn('Archivo de avatares:', err);
    }
  };
  setTimeout(backfill, 30_000).unref();
  const timer = setInterval(backfill, 10 * 60_000);
  timer.unref();
  const lastUser = new Map<string, string>();
  const lastNick = new Map<string, string>();

  const cap = (m: Map<string, string>) => {
    if (m.size >= MAX_CACHE) m.clear();
  };

  const seenUser = (user: User, guildId: string | null) => {
    if (user.bot) return;
    const tag = serverTag(user);
    const key = [user.avatar ?? '', user.username, user.globalName ?? '', tag?.tag ?? '', tag?.guildId ?? ''].join('|');
    if (lastUser.get(user.id) === key) return;
    cap(lastUser);
    lastUser.set(user.id, key);
    try {
      recordMedia(app.ctx, user.id, 'avatar', user.avatar, guildId);
      // Se guarda la imagen ya (Discord la borra de su CDN cuando la persona la cambia).
      ensureArchived(user.id, 'avatar', user.avatar);
      // `banner` es undefined si Discord no lo mandó (no es lo mismo que "sin banner").
      if (user.banner) {
        recordMedia(app.ctx, user.id, 'banner', user.banner, guildId);
        ensureArchived(user.id, 'banner', user.banner);
      }
      recordName(app.ctx, user.id, 'username', user.username);
      recordName(app.ctx, user.id, 'display', user.globalName);
      if (tag) recordName(app.ctx, user.id, 'tag', tag.tag, tag.guildId);
    } catch (err) {
      logger.warn('Historial de perfiles:', err);
    }
  };

  const seenMember = (member: GuildMember) => {
    seenUser(member.user, member.guild.id);
    if (member.user.bot || !member.nickname) return;
    const k = `${member.guild.id}:${member.id}`;
    if (lastNick.get(k) === member.nickname) return;
    cap(lastNick);
    lastNick.set(k, member.nickname);
    try {
      recordName(app.ctx, member.id, 'nick', member.nickname, member.guild.id);
    } catch (err) {
      logger.warn('Historial de apodos:', err);
    }
  };

  app.client.on(Events.MessageCreate, (msg) => {
    if (!msg.inGuild() || msg.webhookId) return;
    if (msg.member) seenMember(msg.member);
    else seenUser(msg.author, msg.guildId);
  });
  app.client.on(Events.UserUpdate, (_old, user) => {
    lastUser.delete(user.id);
    seenUser(user, null);
  });
  app.client.on(Events.GuildMemberUpdate, (_old, member) => {
    lastNick.delete(`${member.guild.id}:${member.id}`);
    seenMember(member);
  });
  app.client.on(Events.GuildMemberAdd, (member) => seenMember(member));
  return timer;
}

/** Pide el usuario completo (con banner) y registra lo que vea. Para los comandos. */
export async function fetchAndRecord(app: App, userId: string, guildId: string | null): Promise<User | null> {
  const user = await app.client.users.fetch(userId, { force: true }).catch(() => null);
  if (!user) return null;
  recordMedia(app.ctx, user.id, 'avatar', user.avatar, guildId);
  recordMedia(app.ctx, user.id, 'banner', user.banner, guildId);
  ensureArchived(user.id, 'avatar', user.avatar);
  ensureArchived(user.id, 'banner', user.banner);
  recordName(app.ctx, user.id, 'username', user.username);
  recordName(app.ctx, user.id, 'display', user.globalName);
  const tag = serverTag(user);
  if (tag) recordName(app.ctx, user.id, 'tag', tag.tag, tag.guildId);
  return user;
}

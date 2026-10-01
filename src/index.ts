import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { openDatabase } from './db/sqlite';
import { runMigrations } from './db/migrations';
import { startBackups } from './db/backup';
import { loadBaseConfig } from './game/config';
import { env } from './env';
import { logger } from './logger';
import { KeyedLock, RateLimiter } from './services/antispam';
import { createContext } from './services/context';
import { pruneBuffs } from './services/buffs';
import { startEventScheduler } from './discord/events/scheduler';
import { afterAction, startNoticeSweeper } from './discord/notifier';
import { startMediaTracking } from './discord/tracking/userMedia';
import { autoRegisterCommands } from './discord/registerCommands';
import { loadOwners } from './discord/owner';
import { startAutoplayScheduler } from './discord/autoplay';
import { startTempVoice } from './discord/voice/tempVoice';
import { createAutomod } from './discord/moderation/automod';
import { pruneEphemeral } from './services/limits';
import type { App } from './discord/app';
import { onInteraction } from './discord/handlers/interactions';
import { onMessage } from './discord/handlers/prefix';
import { registerLogEvents } from './discord/logging/events';
import { logSystem } from './discord/logging/sender';
import { syncRewardRoles } from './discord/roleSafety';
import { COLORS } from './discord/ui/theme';
import { createActivityServer, discordOAuth } from './activity/server';
import path from 'node:path';
import type http from 'node:http';

async function main(): Promise<void> {
  const baseConfig = loadBaseConfig(env.gameConfigPath);
  const db = openDatabase(env.databasePath);
  const applied = runMigrations(db);
  if (applied.length) logger.info(`Migraciones aplicadas: ${applied.join(', ')}`);
  const ctx = createContext({ db, baseConfig, defaultPrefix: env.defaultPrefix });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildVoiceStates,
    ],
    // Necesario para recibir ediciones/borrados de mensajes que no están en memoria.
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User],
  });

  const app: App = { client, ctx, limiter: new RateLimiter(), userLock: new KeyedLock(), guildLock: new KeyedLock() };
  app.afterAction = (member) => afterAction(app, member);

  client.once(Events.ClientReady, (c) => {
    logger.info(`Conectado como ${c.user.tag} en ${c.guilds.cache.size} servidores.`);
    void loadOwners(app);
    // Registra los comandos de barra si cambiaron (comandos nuevos aparecen sin pasos manuales).
    void autoRegisterCommands(env.token(), c.application?.id ?? env.clientId(), env.devGuildId, path.dirname(path.resolve(env.databasePath)));
  });
  client.on(Events.InteractionCreate, onInteraction(app));
  // Automod primero: un mensaje que rompe una regla (spam, enlaces, flood) se borra y no se procesa como comando.
  const automod = createAutomod(app);
  const commands = onMessage(app);
  client.on(Events.MessageCreate, async (msg) => {
    try {
      if (await automod.onMessage(msg)) return;
    } catch (err) {
      logger.warn('Automod:', err);
    }
    await commands(msg);
  });
  client.on(Events.MessageUpdate, (_old, msg) => void automod.onEdit(msg).catch((err) => logger.warn('Automod (edición):', err)));
  client.on(Events.GuildMemberAdd, (member) => void automod.onMemberAdd(member).catch((err) => logger.warn('Automod (raid):', err)));
  // Historial de avatares y banners (!avs, !banners): solo lo que el bot ve desde ahora.
  startMediaTracking(app);
  registerLogEvents(client, ctx);
  client.on(Events.Error, (e) => logger.error('Error del cliente:', e));

  // Actividad de granja (app web dentro de Discord). Comparte BD, reglas, antispam y candados con el bot.
  let activity: http.Server | null = null;
  if (env.clientSecret) {
    const oauth = discordOAuth(env.clientId(), env.clientSecret);
    const memberOf = async (guildId: string, userId: string) => {
      const guild = client.guilds.cache.get(guildId);
      return guild ? guild.members.fetch(userId).catch(() => null) : null;
    };
    activity = createActivityServer({
      ctx,
      limiter: app.limiter,
      userLock: app.userLock,
      clientId: env.clientId(),
      staticDir: path.resolve(__dirname, '..', 'activity', 'dist'),
      exchangeCode: oauth.exchangeCode,
      fetchUser: oauth.fetchUser,
      isMember: async (g, u) => !!(await memberOf(g, u)),
      onAction: async (g, u) => {
        const m = await memberOf(g, u);
        if (m) await afterAction(app, m);
      },
      memberNames: async (g, ids) => {
        const guild = client.guilds.cache.get(g);
        if (!guild || !ids.length) return {};
        const found = await guild.members.fetch({ user: ids }).catch(() => null);
        const out: Record<string, string> = {};
        for (const id of ids) {
          const m = found?.get(id) ?? guild.members.cache.get(id);
          if (m) out[id] = m.displayName;
        }
        return out;
      },
      roleInfo: async (g, ids) => {
        const guild = client.guilds.cache.get(g);
        const out: Record<string, { name: string; color: string }> = {};
        for (const id of ids) {
          const r = guild?.roles.cache.get(id);
          if (r) out[id] = { name: r.name, color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : '#99aab5' };
        }
        return out;
      },
      onAbuse: async (g, u) => {
        const guild = client.guilds.cache.get(g);
        if (guild) await logSystem(ctx, guild, `🚨 Actividad sospechosa en la Actividad de granja: <@${u}> superó el límite de acciones repetidamente.`, COLORS.warn);
      },
    });
    activity.on('error', (err: NodeJS.ErrnoException) => {
      // Si el puerto está ocupado, el bot sigue funcionando; solo el juego queda apagado.
      if (err.code === 'EADDRINUSE') {
        logger.error(`El puerto ${env.activityPort} está ocupado (¿otra copia del bot abierta?). El juego como Actividad queda apagado; el bot sigue funcionando. Cerrá la otra copia o cambiá ACTIVITY_PORT en .env.`);
      } else {
        logger.error('Error en el servidor de la Actividad:', err);
      }
    });
    activity.listen(env.activityPort, () => logger.info(`Actividad de granja escuchando en http://localhost:${env.activityPort}`));
  } else {
    logger.info('Actividad de granja desactivada (falta CLIENT_SECRET en .env).');
  }

  // Eventos automáticos (sorteos y mareas doradas) en los canales configurados con /eventos.
  const events = startEventScheduler(app);
  // Avisos de logros por DM que quedaron pendientes (Actividad, reinicios, reintentos).
  const notices = startNoticeSweeper(app);
  // !autoplay (premium): turnos automáticos de pesca y granja.
  const autoplay = startAutoplayScheduler(app);
  // Canales de voz temporales: crear al entrar al hub, borrar vacíos y reconciliar tras reinicios.
  const tempVoice = startTempVoice(app);

  // Copia de seguridad diaria de la base (data/backups, se guardan 7).
  const backups = startBackups(db, env.databasePath);

  // Mantenimiento periódico: sesiones de pesca abandonadas, cooldowns viejos, memoria del antispam.
  const sweep = setInterval(() => {
    try {
      pruneBuffs(ctx);
      pruneEphemeral(ctx);
      app.limiter.sweep();
      automod.sweep();
    } catch (err) {
      logger.error('Fallo en el mantenimiento:', err);
    }
  }, 10 * 60_000);
  sweep.unref();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info(`${signal} recibido: cerrando ordenadamente…`);
    clearInterval(sweep);
    clearInterval(events);
    clearInterval(notices);
    clearInterval(autoplay);
    clearInterval(tempVoice);
    clearInterval(backups);
    activity?.close();
    await client.destroy().catch(() => undefined);
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => logger.error('Promesa rechazada sin manejar:', e));
  // Un error inesperado en un evento no debe tirar el bot entero: se registra y se sigue
  // (todo el estado importante está en SQLite, con transacciones atómicas).
  process.on('uncaughtException', (e) => logger.error('Excepción no capturada (el bot sigue funcionando):', e));

  await client.login(env.token());
}

main().catch((err) => {
  logger.error('No se pudo iniciar el bot:', err);
  process.exit(1);
});

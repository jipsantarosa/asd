import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { openDatabase } from './db/sqlite';
import { runMigrations } from './db/migrations';
import { startBackups } from './db/backup';
import { env } from './env';
import { logger } from './logger';
import { KeyedLock, RateLimiter } from './services/antispam';
import { createContext } from './services/context';
import { startMediaTracking } from './discord/tracking/userMedia';
import { autoRegisterCommands } from './discord/registerCommands';
import { loadOwners } from './discord/owner';
import { startTempVoice } from './discord/voice/tempVoice';
import { createAutomod } from './discord/moderation/automod';
import { pruneEphemeral } from './services/limits';
import type { App } from './discord/app';
import { onInteraction } from './discord/handlers/interactions';
import { onMessage } from './discord/handlers/prefix';
import { registerLogEvents } from './discord/logging/events';
import { startCasino } from './discord/casino/scheduler';
import { createActivityListener } from './discord/casino/activity';
import { forgetChannel } from './casino/guilds';
import { autoSyncLayouts } from './discord/setupMaintenance';
import { startServerTools } from './discord/commands/serverTools';
import { startAutoRole } from './discord/commands/autoRole';
import { startPremiumRoles } from './discord/commands/premiumRoles';
import { startShop } from './discord/commands/shop';
import path from 'node:path';
import { acquireInstanceLock } from './instanceLock';

async function main(): Promise<void> {
  // Una sola copia del bot por carpeta de datos: dos copias responderían dos veces a cada comando.
  const lock = acquireInstanceLock(path.dirname(path.resolve(env.databasePath)));
  if (!lock.ok) {
    logger.error(`Ya hay otra copia del bot corriendo (proceso ${lock.pid}). Cerrá esa ventana o ese proceso; esta copia no se conecta para no duplicar respuestas ni canales.`);
    process.exit(1);
  }
  const db = openDatabase(env.databasePath);
  const applied = runMigrations(db);
  if (applied.length) logger.info(`Migraciones aplicadas: ${applied.join(', ')}`);
  const ctx = createContext({ db, defaultPrefix: env.defaultPrefix });

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

  client.once(Events.ClientReady, (c) => {
    logger.info(`Conectado como ${c.user.tag} en ${c.guilds.cache.size} servidores.`);
    void loadOwners(app);
    // Registros y voz temporal: si esta versión cambió el diseño de los canales, se actualizan solos (sin borrar nada).
    void autoSyncLayouts(app).catch((err) => logger.warn('Sincronización de canales:', err));
    // Registra los comandos de barra si cambiaron (comandos nuevos aparecen sin pasos manuales).
    void autoRegisterCommands(env.token(), c.application?.id ?? env.clientId(), env.devGuildId, path.dirname(path.resolve(env.databasePath)));
  });
  client.on(Events.InteractionCreate, onInteraction(app));
  // Automod primero: un mensaje que rompe una regla (spam, enlaces, flood) se borra y no se procesa como comando.
  const automod = createAutomod(app);
  const commands = onMessage(app);
  // Coins por actividad: solo mensajes que pasaron el automod y que no son comandos.
  const activity = createActivityListener(app);
  client.on(Events.MessageCreate, async (msg) => {
    try {
      if (await automod.onMessage(msg)) return;
    } catch (err) {
      logger.warn('Automod:', err);
    }
    if (await commands(msg)) return;
    activity(msg);
  });
  client.on(Events.MessageUpdate, (_old, msg) => void automod.onEdit(msg).catch((err) => logger.warn('Automod (edición):', err)));
  client.on(Events.GuildMemberAdd, (member) => void automod.onMemberAdd(member).catch((err) => logger.warn('Automod (raid):', err)));
  // Historial de avatares y banners (!avs, !banners): solo lo que el bot ve desde ahora.
  startMediaTracking(app);
  registerLogEvents(client, ctx);
  // Mensajes de boost (/boosttracker) y protección de webhooks (/anti-webhooks).
  startServerTools(app);
  // Rol automático para quienes entran (/autorol).
  startAutoRole(app);
  // Roles premium (/rolespremium): se dan y se quitan solos según el nivel de cada persona.
  const premiumRoles = startPremiumRoles(app);
  // Tienda: si borran a mano el canal de un ticket, queda cerrado.
  startShop(app);
  client.on(Events.Error, (e) => logger.error('Error del cliente:', e));

  // Un canal borrado deja de figurar en los ajustes del casino.
  client.on(Events.ChannelDelete, (ch) => {
    if ('guildId' in ch && ch.guildId) forgetChannel(ctx, ch.guildId, ch.id);
  });

  // Casino: recuperación de partidas tras un reinicio, partidas abandonadas, torneos, latido y anuncios.
  const casino = startCasino(app);
  // Canales de voz temporales: crear al entrar al hub, borrar vacíos y reconciliar tras reinicios.
  const tempVoice = startTempVoice(app);

  // Copia de seguridad diaria de la base (data/backups, se guardan 7).
  const backups = startBackups(db, env.databasePath);

  // Mantenimiento periódico: esperas vencidas y memoria del antispam.
  const sweep = setInterval(() => {
    try {
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
    casino.stop();
    clearInterval(tempVoice);
    clearInterval(backups);
    clearInterval(premiumRoles);
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

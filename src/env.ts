import 'dotenv/config';
import { clientIdFromToken } from './tokenId';

export { clientIdFromToken };

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Falta la variable de entorno ${name}. Revisá tu archivo .env (ver .env.example).`);
  return v;
}

export const env = {
  token: () => required('DISCORD_TOKEN'),
  clientId: (): string => {
    const explicit = process.env.CLIENT_ID?.trim();
    if (explicit) return explicit;
    const derived = clientIdFromToken(required('DISCORD_TOKEN'));
    if (!derived) throw new Error('No pude deducir el ID de la aplicación del token. Agregá CLIENT_ID=... (Application ID) en tu archivo .env.');
    return derived;
  },
  devGuildId: process.env.DEV_GUILD_ID?.trim() || null,
  databasePath: process.env.DATABASE_PATH?.trim() || './data/valle.db',
  gameConfigPath: process.env.GAME_CONFIG_PATH?.trim() || './game.config.json',
  /** Si está definido, se inicia el servidor de la Actividad de granja. */
  clientSecret: process.env.CLIENT_SECRET?.trim() || null,
  activityPort: Number(process.env.ACTIVITY_PORT?.trim() || 3000),
  defaultPrefix: process.env.DEFAULT_PREFIX?.trim() || '!',
};

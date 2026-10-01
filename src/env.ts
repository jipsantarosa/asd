import 'dotenv/config';
import { clientIdFromToken } from './tokenId';

export { clientIdFromToken };

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Falta la variable de entorno ${name}. Revisá tu archivo .env (ver .env.example).`);
  return v;
}

/** Puerto válido (1–65535); si el .env tiene algo raro, se usa 3000 en lugar de fallar al escuchar. */
function port(raw: string | undefined): number {
  const n = Number(raw?.trim() || 3000);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000;
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
  activityPort: port(process.env.ACTIVITY_PORT),
  defaultPrefix: process.env.DEFAULT_PREFIX?.trim() || '!',
};

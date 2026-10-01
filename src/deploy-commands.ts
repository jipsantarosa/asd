import fs from 'node:fs';
import path from 'node:path';
import { commandsHash, registerCommands } from './discord/registerCommands';
import { env } from './env';

/**
 * Registro manual de los comandos de barra (`npm run deploy`).
 * Normalmente no hace falta: el bot los registra solo al arrancar si cambiaron.
 */
async function main(): Promise<void> {
  const n = await registerCommands(env.token(), env.clientId(), env.devGuildId);
  const dataDir = path.dirname(path.resolve(env.databasePath));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.comandos-hash'), `${commandsHash()}:${env.devGuildId ?? 'global'}`);
  console.log(`✅ ${n} comandos registrados ${env.devGuildId ? `en el servidor ${env.devGuildId}` : 'globalmente'}.`);
}

main().catch((err) => {
  console.error('❌ No se pudieron registrar los comandos:', err);
  process.exit(1);
});

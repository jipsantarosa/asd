import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REST, Routes } from 'discord.js';
import { logger } from '../logger';
import { COMMANDS, CONTEXT_MENUS } from './commands';

/** JSON de los comandos de barra tal como se mandan a Discord. */
export function commandsBody(): unknown[] {
  return [...COMMANDS.filter((c) => c.data).map((c) => c.data!.toJSON()), ...CONTEXT_MENUS.map((m) => m.data.toJSON())];
}

/** Huella de los comandos: si cambia (comando nuevo, opción nueva…), hay que volver a registrarlos. */
export function commandsHash(): string {
  return crypto.createHash('sha256').update(JSON.stringify(commandsBody())).digest('hex').slice(0, 16);
}

/**
 * Registra los comandos de barra.
 * - Con devGuildId: solo en ese servidor (aparecen al instante).
 * - Sin devGuildId: globales, en todos los servidores donde esté el bot.
 * Conserva el comando "Entry Point" de la Actividad (tipo 4): una sobrescritura sin él falla.
 */
export async function registerCommands(token: string, clientId: string, devGuildId: string | null): Promise<number> {
  const rest = new REST().setToken(token);
  const body = commandsBody();
  const route = devGuildId ? Routes.applicationGuildCommands(clientId, devGuildId) : Routes.applicationCommands(clientId);
  if (!devGuildId) {
    const existing = (await rest.get(route)) as { id: string; type: number; name: string; description: string; handler?: number; contexts?: number[]; integration_types?: number[] }[];
    for (const cmd of existing.filter((c) => c.type === 4)) {
      body.push({ id: cmd.id, type: 4, name: cmd.name, description: cmd.description, handler: cmd.handler, contexts: cmd.contexts, integration_types: cmd.integration_types });
    }
  }
  const result = (await rest.put(route, { body })) as unknown[];
  return result.length;
}

/**
 * Al arrancar: si los comandos cambiaron desde el último registro, los registra solo.
 * Así los comandos nuevos (/kiss, /avatares, /purgar…) aparecen sin pasos manuales.
 */
export async function autoRegisterCommands(token: string, clientId: string, devGuildId: string | null, dataDir: string): Promise<void> {
  const file = path.join(dataDir, '.comandos-hash');
  const hash = `${commandsHash()}:${devGuildId ?? 'global'}`;
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  if (previous === hash) return;
  try {
    const n = await registerCommands(token, clientId, devGuildId);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, hash);
    logger.info(`Comandos de barra actualizados: ${n} registrados ${devGuildId ? `en el servidor ${devGuildId}` : 'globalmente'}.`);
  } catch (err) {
    logger.error('No pude registrar los comandos de barra (los de prefijo funcionan igual):', err);
  }
}

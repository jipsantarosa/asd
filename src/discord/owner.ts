import { logger } from '../logger';
import type { App } from './app';

/**
 * Dueños del bot (los únicos que pueden dar o quitar premium):
 * el dueño de la aplicación en el portal de Discord (o los miembros de su equipo),
 * más los IDs que se pongan en OWNER_IDS del .env (separados por coma).
 */
const owners = new Set<string>(
  (process.env.OWNER_IDS ?? '').split(',').map((x) => x.trim()).filter((x) => /^\d{17,20}$/.test(x)),
);

export async function loadOwners(app: App): Promise<void> {
  try {
    const application = await app.client.application?.fetch();
    const owner = application?.owner as { id?: string; members?: Map<string, { id: string }> } | null | undefined;
    if (owner?.members) for (const m of owner.members.values()) owners.add(m.id);
    else if (owner?.id) owners.add(owner.id);
    logger.info(`Dueños del bot: ${owners.size ? [...owners].join(', ') : 'ninguno detectado (agregá OWNER_IDS en .env)'}.`);
  } catch (err) {
    logger.warn('No pude detectar al dueño del bot (usá OWNER_IDS en .env):', err);
  }
}

export function isOwner(userId: string): boolean {
  return owners.has(userId);
}

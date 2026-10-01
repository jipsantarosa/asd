// Solo tipos: este módulo no carga discord.js en ejecución, así el algoritmo se prueba con un canal simulado.
import type { Collection, GuildTextBasedChannel, Message } from 'discord.js';

/** Discord solo permite borrar en bloque mensajes de menos de 14 días (dejamos 1 minuto de margen). */
const BULK_MAX_AGE = 14 * 24 * 60 * 60 * 1000 - 60_000;
export const PURGE_MAX = 1000;
/** Tope de mensajes a revisar por comando (100 por pedido a la API). */
export const PURGE_SCAN_LIMIT = 10_000;

export interface PurgeResult {
  deleted: number;
  scanned: number;
  /** Mensajes del usuario que no se pudieron borrar por tener más de 14 días. */
  tooOld: number;
  stoppedByAge: boolean;
}

/**
 * Borra hasta `max` mensajes de `userId` en el canal, del más nuevo al más viejo.
 * Recorre el historial de a 100 mensajes; borra en bloques de hasta 100 (bulkDelete) y, si queda
 * uno solo, lo borra individualmente. Se detiene al llegar a mensajes de más de 14 días, porque
 * Discord no permite borrarlos en bloque (y de a uno sería lentísimo por los límites de la API).
 * discord.js respeta solo los límites de velocidad de la API (cola de REST).
 */
export async function purgeUserMessages(channel: GuildTextBasedChannel, userId: string, max: number, skipIds: Set<string> = new Set()): Promise<PurgeResult> {
  const limit = Math.max(1, Math.min(PURGE_MAX, Math.floor(max)));
  const res: PurgeResult = { deleted: 0, scanned: 0, tooOld: 0, stoppedByAge: false };
  const cutoff = Date.now() - BULK_MAX_AGE;
  let before: string | undefined;
  let batch: Message[] = [];

  const flush = async () => {
    while (batch.length) {
      const chunk = batch.splice(0, 100);
      if (chunk.length === 1) {
        await chunk[0].delete().then(() => { res.deleted += 1; }).catch(() => undefined);
      } else {
        const done = await channel.bulkDelete(chunk.map((m) => m.id), true).catch(() => null);
        res.deleted += done?.size ?? 0;
      }
    }
  };

  while (res.deleted + batch.length < limit && res.scanned < PURGE_SCAN_LIMIT) {
    const page: Collection<string, Message> = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}), cache: false });
    if (page.size === 0) break;
    for (const m of page.values()) {
      res.scanned += 1;
      if (m.createdTimestamp < cutoff) {
        res.stoppedByAge = true;
        if (m.author.id === userId) res.tooOld += 1;
        continue;
      }
      if (m.author.id !== userId || skipIds.has(m.id) || m.pinned) continue;
      if (res.deleted + batch.length >= limit) break;
      batch.push(m);
      if (batch.length >= 100) await flush();
    }
    if (res.stoppedByAge) break;
    // La API devuelve del más nuevo al más viejo: el último es el cursor para la próxima página.
    before = page.lastKey();
    if (!before || page.size < 100) break;
  }
  await flush();
  return res;
}

import { GameError, type GameContext } from './context';
import { consumeCooldown } from './limits';

/** Clave canónica de una pareja: el orden no depende de quién ejecute el comando. */
export function kissPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export interface KissResult {
  /** Besos entre los dos (sumando los de ambos lados). */
  pair: number;
  /** Besos dados por el autor en este servidor. */
  given: number;
  /** Besos recibidos por el objetivo en este servidor. */
  received: number;
}

export const KISS_COOLDOWN_MS = 5000;

/**
 * Registra un beso. Todo en una transacción y con UPSERT ... RETURNING: el contador sube de a uno
 * aunque lleguen dos comandos a la vez, y el número que se muestra es exactamente el guardado.
 */
export function kiss(ctx: GameContext, guildId: string, authorId: string, targetId: string): KissResult {
  if (authorId === targetId) throw new GameError('No te podés besar a vos mismo… ¡probá con alguien más! 💋');
  return ctx.db.transaction(() => {
    // Anti spam: un beso cada 5 s por persona (también evita inflar el contador a clics).
    consumeCooldown(ctx, guildId, authorId, 'kiss', KISS_COOLDOWN_MS, 'Tu próximo beso');
    const [a, b] = kissPair(authorId, targetId);
    const now = ctx.now();
    const pair = ctx.db.get<{ count: number }>(
      `INSERT INTO kiss_pairs (guild_id, user_a, user_b, count, last_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (guild_id, user_a, user_b) DO UPDATE SET count = count + 1, last_at = excluded.last_at
       RETURNING count`,
      guildId, a, b, now,
    )!.count;
    const given = ctx.db.get<{ given: number }>(
      `INSERT INTO kiss_stats (guild_id, user_id, given, received) VALUES (?, ?, 1, 0)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET given = given + 1
       RETURNING given`,
      guildId, authorId,
    )!.given;
    const received = ctx.db.get<{ received: number }>(
      `INSERT INTO kiss_stats (guild_id, user_id, given, received) VALUES (?, ?, 0, 1)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET received = received + 1
       RETURNING received`,
      guildId, targetId,
    )!.received;
    return { pair, given, received };
  });
}

export function kissCount(ctx: GameContext, guildId: string, x: string, y: string): number {
  const [a, b] = kissPair(x, y);
  return ctx.db.get<{ count: number }>('SELECT count FROM kiss_pairs WHERE guild_id = ? AND user_a = ? AND user_b = ?', guildId, a, b)?.count ?? 0;
}

export type KissResponse = 'correspondido' | 'rechazado';

/**
 * Marca que un beso ya fue respondido. Clave primaria = id del mensaje: dos clics (o dos procesos)
 * no pueden responder dos veces. Debe llamarse dentro de la misma transacción que el beso de vuelta.
 */
export function claimKissReply(ctx: GameContext, messageId: string, guildId: string, userId: string, response: KissResponse): void {
  const r = ctx.db.run('INSERT OR IGNORE INTO kiss_replies (message_id, guild_id, user_id, response, created_at) VALUES (?, ?, ?, ?, ?)',
    messageId, guildId, userId, response, ctx.now());
  if (r.changes !== 1) throw new GameError('Este beso ya fue respondido. 💌');
}

/** Corresponder: marca la respuesta y suma el beso de vuelta, todo o nada. */
export function kissBack(ctx: GameContext, messageId: string, guildId: string, responderId: string, originalAuthorId: string): KissResult {
  return ctx.db.transaction(() => {
    claimKissReply(ctx, messageId, guildId, responderId, 'correspondido');
    return kiss(ctx, guildId, responderId, originalAuthorId);
  });
}

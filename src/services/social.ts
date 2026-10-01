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

/** Espera entre besos de una misma persona (a cualquiera). */
export const KISS_COOLDOWN_MS = 5000;
/** Espera entre besos nuevos de una misma pareja (en cualquier sentido). Corresponder no la usa. */
export const KISS_PAIR_COOLDOWN_MS = 15_000;

/** "1 vez" / "9 veces" (con separador de miles). */
export function kissTimes(n: number): string {
  return `${n.toLocaleString('es-AR')} ${n === 1 ? 'vez' : 'veces'}`;
}

/**
 * Suma un beso a los contadores (pareja, dados y recibidos). Sin esperas: la llama quien ya validó.
 * UPSERT ... RETURNING dentro de la transacción del llamador: el número que se muestra es exactamente el guardado.
 */
function countKiss(ctx: GameContext, guildId: string, authorId: string, targetId: string): KissResult {
  if (authorId === targetId) throw new GameError('No te podés besar a vos mismo… ¡probá con alguien más! 💋');
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
}

/**
 * Registra un beso nuevo con sus esperas anti spam (5 s por persona y 15 s por pareja).
 * Todo en una transacción: si una espera corta, no queda nada a medias.
 */
export function kiss(ctx: GameContext, guildId: string, authorId: string, targetId: string): KissResult {
  if (authorId === targetId) throw new GameError('No te podés besar a vos mismo… ¡probá con alguien más! 💋');
  return ctx.db.transaction(() => {
    consumeCooldown(ctx, guildId, authorId, 'kiss', KISS_COOLDOWN_MS, 'Tu próximo beso');
    const [a, b] = kissPair(authorId, targetId);
    consumeCooldown(ctx, guildId, `${a}|${b}`, 'kisspair', KISS_PAIR_COOLDOWN_MS, 'El próximo beso entre ustedes');
    return countKiss(ctx, guildId, authorId, targetId);
  });
}

export function kissCount(ctx: GameContext, guildId: string, x: string, y: string): number {
  const [a, b] = kissPair(x, y);
  return ctx.db.get<{ count: number }>('SELECT count FROM kiss_pairs WHERE guild_id = ? AND user_a = ? AND user_b = ?', guildId, a, b)?.count ?? 0;
}

// ───────────────────────── Besos con botones (Corresponder / Rechazar) ─────────────────────────

export type KissState = 'open' | 'returned' | 'rejected';

export interface KissRow {
  id: number;
  guild_id: string;
  author_id: string;
  target_id: string;
  author_name: string;
  target_name: string;
  channel_id: string | null;
  message_id: string | null;
  gif_url: string | null;
  state: KissState;
  created_at: number;
  answered_at: number | null;
  reply_message_id: string | null;
}

export interface Person {
  id: string;
  name: string;
}

/**
 * Beso nuevo: cuenta (con esperas) y crea la fila que van a usar los botones, en una sola transacción.
 * Los botones llevan solo el id de esta fila: el autor y el destinatario salen de la base, no del botón.
 */
export function createKiss(ctx: GameContext, guildId: string, author: Person, target: Person): { kissId: number; result: KissResult } {
  return ctx.db.transaction(() => {
    const result = kiss(ctx, guildId, author.id, target.id);
    const r = ctx.db.run(
      `INSERT INTO kisses (guild_id, author_id, target_id, author_name, target_name, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      guildId, author.id, target.id, author.name.slice(0, 100), target.name.slice(0, 100), ctx.now(),
    );
    return { kissId: Number(r.lastInsertRowid), result };
  });
}

/** Guarda dónde quedó publicado el beso y su GIF (para que la respuesta use uno distinto). */
export function attachKissMessage(ctx: GameContext, kissId: number, channelId: string | null, messageId: string | null, gifUrl: string | null): void {
  ctx.db.run('UPDATE kisses SET channel_id = COALESCE(?, channel_id), message_id = COALESCE(?, message_id), gif_url = COALESCE(?, gif_url) WHERE id = ?',
    channelId, messageId, gifUrl, kissId);
}

/** Siempre filtra por servidor: un id de otro servidor no devuelve nada. */
export function getKiss(ctx: GameContext, guildId: string, kissId: number): KissRow | null {
  if (!Number.isSafeInteger(kissId) || kissId < 1) return null;
  return ctx.db.get<KissRow>('SELECT * FROM kisses WHERE id = ? AND guild_id = ?', kissId, guildId) ?? null;
}

export function answeredText(state: KissState): string {
  return state === 'returned' ? 'Este beso ya fue correspondido. 💞' : state === 'rejected' ? 'Este beso ya fue rechazado. 💔' : 'Este beso sigue esperando respuesta.';
}

/**
 * Pasa el beso de "abierto" a respondido con un UPDATE condicional. Si dos clics llegan a la vez,
 * solo uno cambia la fila (changes = 1); el otro recibe un aviso y no suma nada.
 */
function claimKiss(ctx: GameContext, k: KissRow, responderId: string, state: Exclude<KissState, 'open'>): void {
  if (k.target_id !== responderId) throw new GameError(`Solo ${k.target_name} puede responder este beso. 💌`);
  const r = ctx.db.run("UPDATE kisses SET state = ?, answered_at = ? WHERE id = ? AND state = 'open'", state, ctx.now(), k.id);
  if (r.changes !== 1) {
    const now = ctx.db.get<{ state: KissState }>('SELECT state FROM kisses WHERE id = ?', k.id)?.state ?? 'returned';
    throw new GameError(answeredText(now));
  }
}

/** Corresponder: marca el beso y suma el beso de vuelta, todo o nada. */
export function returnKiss(ctx: GameContext, guildId: string, kissId: number, responderId: string): { kiss: KissRow; result: KissResult } {
  return ctx.db.transaction(() => {
    const k = getKiss(ctx, guildId, kissId);
    if (!k) throw new GameError('Ese beso ya no existe.');
    claimKiss(ctx, k, responderId, 'returned');
    return { kiss: { ...k, state: 'returned' }, result: countKiss(ctx, guildId, responderId, k.author_id) };
  });
}

/** Rechazar: solo cambia el estado (el beso original ya contó). */
export function rejectKiss(ctx: GameContext, guildId: string, kissId: number, responderId: string): KissRow {
  return ctx.db.transaction(() => {
    const k = getKiss(ctx, guildId, kissId);
    if (!k) throw new GameError('Ese beso ya no existe.');
    claimKiss(ctx, k, responderId, 'rejected');
    return { ...k, state: 'rejected' };
  });
}

export function setKissReply(ctx: GameContext, kissId: number, replyMessageId: string): void {
  ctx.db.run('UPDATE kisses SET reply_message_id = ? WHERE id = ?', replyMessageId, kissId);
}

// ───────────────────────── Botones de versiones anteriores ─────────────────────────

export type KissResponse = 'correspondido' | 'rechazado';

/**
 * Mensajes de beso viejos (antes de la tabla kisses): el botón traía autor y destinatario y la
 * respuesta se marcaba por id de mensaje. Clave primaria = id del mensaje → una sola respuesta.
 */
export function claimKissReply(ctx: GameContext, messageId: string, guildId: string, userId: string, response: KissResponse): void {
  const r = ctx.db.run('INSERT OR IGNORE INTO kiss_replies (message_id, guild_id, user_id, response, created_at) VALUES (?, ?, ?, ?, ?)',
    messageId, guildId, userId, response, ctx.now());
  if (r.changes !== 1) throw new GameError('Este beso ya fue respondido. 💌');
}

/** Corresponder un beso viejo: marca la respuesta y suma el beso de vuelta, todo o nada. */
export function kissBack(ctx: GameContext, messageId: string, guildId: string, responderId: string, originalAuthorId: string): KissResult {
  return ctx.db.transaction(() => {
    claimKissReply(ctx, messageId, guildId, responderId, 'correspondido');
    return countKiss(ctx, guildId, responderId, originalAuthorId);
  });
}

// ───────────────────────── Estadísticas ─────────────────────────

export interface KissStats {
  given: number;
  received: number;
  /** Con quién más se besó (hasta 5). */
  partners: { userId: string; count: number }[];
  /** Besos que todavía nadie respondió. */
  pending: number;
}

export function kissStats(ctx: GameContext, guildId: string, userId: string): KissStats {
  const s = ctx.db.get<{ given: number; received: number }>('SELECT given, received FROM kiss_stats WHERE guild_id = ? AND user_id = ?', guildId, userId);
  const partners = ctx.db.all<{ other: string; count: number }>(
    `SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS other, count FROM kiss_pairs
     WHERE guild_id = ? AND (user_a = ? OR user_b = ?) ORDER BY count DESC, last_at DESC LIMIT 5`,
    userId, guildId, userId, userId,
  ).map((r) => ({ userId: r.other, count: r.count }));
  const pending = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kisses WHERE guild_id = ? AND target_id = ? AND state = 'open'", guildId, userId)!.n;
  return { given: s?.given ?? 0, received: s?.received ?? 0, partners, pending };
}

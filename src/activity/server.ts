import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { logger } from '../logger';
import type { KeyedLock, RateLimiter } from '../services/antispam';
import { useConsumable } from '../services/consumables';
import { GameError, type GameContext } from '../services/context';
import { farm, setFarmZone } from '../services/farming';
import { gameConfig } from '../services/guildSettings';
import { equipRod, fish } from '../services/fishing';
import { TOP_CATEGORIES, TOP_META, leaderboard, playerCount, rankOf } from '../services/leaderboard';
import { getProfile } from '../services/player';
import { listRewards, rewardValue } from '../services/roles';
import { buildFarmState, harvestEvent } from './farmState';
import { buildFishState, castView } from './fishState';
import type { TopCategory, TopView } from './types';

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export interface ActivityDeps {
  ctx: GameContext;
  limiter: RateLimiter;
  /** El mismo candado que usan los botones del bot: no se puede actuar desde los dos lados a la vez. */
  userLock: KeyedLock;
  clientId: string;
  staticDir: string;
  /** Intercambia el código OAuth2 por un access_token (en producción: API de Discord). */
  exchangeCode(code: string): Promise<string>;
  /** Devuelve el usuario dueño del access_token. */
  fetchUser(accessToken: string): Promise<DiscordUser>;
  /** ¿El usuario pertenece al servidor y el bot está en él? */
  isMember(guildId: string, userId: string): Promise<boolean>;
  /** Tras una acción (cosechar, pescar…): distinciones y avisos de logros. */
  onAction?(guildId: string, userId: string): Promise<void>;
  /** Nombres visibles de miembros (para el ranking). Los que falten se muestran como "Jugador". */
  memberNames?(guildId: string, userIds: string[]): Promise<Record<string, string>>;
  /** Nombre y color de roles (para las distinciones). */
  roleInfo?(guildId: string, roleIds: string[]): Promise<Record<string, { name: string; color: string }>>;
  onAbuse?(guildId: string, userId: string): Promise<void>;
  sessionTtlMs?: number;
}

interface Session {
  user: DiscordUser;
  expiresAt: number;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const SNOWFLAKE = /^\d{17,20}$/;
const MAX_BODY = 4096;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Se esperaba JSON.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Solicitud demasiado grande.');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('no es un objeto');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

function str(body: Record<string, unknown>, key: string, max = 64): string {
  const v = body[key];
  if (typeof v !== 'string' || !v || v.length > max) throw new HttpError(400, `Falta el campo "${key}".`);
  return v;
}

export function createActivityServer(deps: ActivityDeps): http.Server {
  const { ctx } = deps;
  const ttl = deps.sessionTtlMs ?? 12 * 3_600_000;
  const sessions = new Map<string, Session>();
  const memberCache = new Map<string, number>(); // "guild:user" -> válido hasta
  const staticRoot = path.resolve(deps.staticDir);

  function sweep(): void {
    const now = Date.now();
    for (const [k, s] of sessions) if (s.expiresAt < now) sessions.delete(k);
    for (const [k, t] of memberCache) if (t < now) memberCache.delete(k);
  }
  const sweeper = setInterval(sweep, 10 * 60_000);
  sweeper.unref();

  function session(req: http.IncomingMessage): Session {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const s = token ? sessions.get(token) : undefined;
    if (!s || s.expiresAt < Date.now()) throw new HttpError(401, 'Sesión vencida. Volvé a abrir la actividad.');
    return s;
  }

  async function authorizeGuild(guildId: string, userId: string): Promise<void> {
    if (!SNOWFLAKE.test(guildId)) throw new HttpError(400, 'Servidor inválido.');
    const key = `${guildId}:${userId}`;
    if ((memberCache.get(key) ?? 0) > Date.now()) return;
    if (!(await deps.isMember(guildId, userId))) throw new HttpError(403, 'No sos miembro de este servidor o el bot no está en él.');
    memberCache.set(key, Date.now() + 5 * 60_000);
  }

  /** Acción de juego: sesión + pertenencia + antispam + candado compartido con el bot. */
  async function gameAction<T>(req: http.IncomingMessage, guildId: string, fn: (userId: string) => T): Promise<T> {
    const s = session(req);
    await authorizeGuild(guildId, s.user.id);
    const a = gameConfig(ctx, guildId).tuning.antispam;
    const rl = deps.limiter.check(`${guildId}:${s.user.id}`, a.actionsPerWindow, a.windowSeconds * 1000, a.flagThreshold);
    if (rl === 'flag') void deps.onAbuse?.(guildId, s.user.id).catch(() => undefined);
    if (rl !== 'ok') throw new HttpError(429, 'Vas muy rápido. Esperá unos segundos.');
    const res = await deps.userLock.run(`${guildId}:${s.user.id}`, async () => fn(s.user.id));
    if (!res.ran) throw new HttpError(409, 'Tu acción anterior todavía se está procesando.');
    return res.value;
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, route: string, url: URL): Promise<void> {
    if (req.method === 'GET' && route === '/api/config') return send(res, 200, { clientId: deps.clientId });

    if (req.method === 'POST' && route === '/api/token') {
      const code = str(await readJson(req), 'code', 256);
      let accessToken: string;
      let user: DiscordUser;
      try {
        accessToken = await deps.exchangeCode(code);
        user = await deps.fetchUser(accessToken);
      } catch (err) {
        logger.warn('Actividad: fallo el intercambio OAuth:', (err as Error).message);
        throw new HttpError(401, 'No se pudo verificar tu cuenta de Discord.');
      }
      if (!user?.id || !SNOWFLAKE.test(user.id)) throw new HttpError(401, 'Cuenta inválida.');
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { user, expiresAt: Date.now() + ttl });
      return send(res, 200, { access_token: accessToken, session: token, user: { id: user.id, name: user.global_name || user.username, avatar: user.avatar ?? null } });
    }

    if (req.method === 'GET' && route === '/api/farm') {
      const guildId = url.searchParams.get('guild') ?? '';
      const s = session(req);
      await authorizeGuild(guildId, s.user.id);
      return send(res, 200, { state: buildFarmState(ctx, guildId, s.user.id) });
    }

    if (req.method === 'POST' && route.startsWith('/api/farm/')) {
      const body = await readJson(req);
      const guildId = str(body, 'guild', 20);
      const action = route.slice('/api/farm/'.length);

      if (action === 'harvest') {
        const out = await gameAction(req, guildId, (userId) => {
          const r = farm(ctx, guildId, userId);
          return { userId, event: harvestEvent(gameConfig(ctx, guildId), r), state: buildFarmState(ctx, guildId, userId) };
        });
        void deps.onAction?.(guildId, out.userId).catch(() => undefined);
        return send(res, 200, { event: out.event, state: out.state });
      }
      if (action === 'zone') {
        const zoneId = str(body, 'zone');
        const out = await gameAction(req, guildId, (userId) => {
          const z = setFarmZone(ctx, guildId, userId, zoneId);
          return { notice: `Ahora trabajás en ${z.emoji} ${z.name}.`, state: buildFarmState(ctx, guildId, userId) };
        });
        return send(res, 200, out);
      }
      if (action === 'use') {
        const itemId = str(body, 'item');
        const out = await gameAction(req, guildId, (userId) => {
          const r = useConsumable(ctx, guildId, userId, itemId);
          return { notice: r.message, state: buildFarmState(ctx, guildId, userId) };
        });
        return send(res, 200, out);
      }
    }
    if (req.method === 'GET' && route === '/api/fish') {
      const guildId = url.searchParams.get('guild') ?? '';
      const s = session(req);
      await authorizeGuild(guildId, s.user.id);
      return send(res, 200, { state: buildFishState(ctx, guildId, s.user.id) });
    }

    if (req.method === 'POST' && route.startsWith('/api/fish/')) {
      const body = await readJson(req);
      const guildId = str(body, 'guild', 20);
      const action = route.slice('/api/fish/'.length);
      const cfg = () => gameConfig(ctx, guildId);

      if (action === 'cast') {
        const out = await gameAction(req, guildId, (userId) => {
          const r = fish(ctx, guildId, userId);
          return { userId, cast: castView(cfg(), r), state: buildFishState(ctx, guildId, userId) };
        });
        void deps.onAction?.(guildId, out.userId).catch(() => undefined);
        return send(res, 200, { cast: out.cast, state: out.state });
      }
      if (action === 'rod') {
        const rodId = str(body, 'rod', 32);
        const out = await gameAction(req, guildId, (userId) => {
          const rod = equipRod(ctx, guildId, userId, rodId);
          return { notice: `Equipaste ${rod.emoji} ${rod.name}.`, state: buildFishState(ctx, guildId, userId) };
        });
        return send(res, 200, out);
      }
    }

    if (req.method === 'GET' && route === '/api/top') {
      const guildId = url.searchParams.get('guild') ?? '';
      const cat = (url.searchParams.get('cat') ?? 'total') as TopCategory;
      if (!TOP_CATEGORIES.includes(cat)) throw new HttpError(400, 'Categoría inválida.');
      const s = session(req);
      await authorizeGuild(guildId, s.user.id);
      const top = leaderboard(ctx, guildId, cat, 10);
      const names = (await deps.memberNames?.(guildId, top.map((e) => e.userId)).catch(() => ({}))) ?? {};
      const mine = rankOf(ctx, guildId, s.user.id, cat);
      const p = getProfile(ctx, guildId, s.user.id);
      const rewards = listRewards(ctx, guildId);
      const roles = (await deps.roleInfo?.(guildId, rewards.map((r) => r.role_id)).catch(() => ({}))) ?? {};
      const view: TopView = {
        category: cat,
        categories: TOP_CATEGORIES.map((id) => ({ id, label: TOP_META[id].label, emoji: TOP_META[id].emoji })),
        unit: cat === 'monedas' ? gameConfig(ctx, guildId).currency.emoji : TOP_META[cat].unit,
        players: playerCount(ctx, guildId),
        entries: top.map((e) => ({ rank: e.rank, userId: e.userId, name: (names as Record<string, string>)[e.userId] ?? 'Jugador', value: e.value, me: e.userId === s.user.id })),
        me: mine ? { rank: mine.rank, value: mine.value } : null,
        rewards: rewards
          .filter((r) => (roles as Record<string, unknown>)[r.role_id] || !deps.roleInfo)
          .map((r) => {
            const current = !p ? 0 : rewardValue(r.skill, p);
            const info = (roles as Record<string, { name: string; color: string }>)[r.role_id];
            return { roleId: r.role_id, roleName: info?.name ?? 'Rol', color: info?.color ?? '#99aab5', skill: r.skill, level: r.level, current, earned: current >= r.level };
          }),
      };
      return send(res, 200, { top: view });
    }
    throw new HttpError(404, 'Ruta desconocida.');
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, route: string): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const rel = route === '/' ? 'index.html' : decodeURIComponent(route).replace(/^\/+/, '');
    let file = path.resolve(staticRoot, rel);
    if (!file.startsWith(staticRoot + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(staticRoot, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('La actividad no está compilada. Ejecutá "npm run build".');
      return;
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      // Sin caché: así Discord siempre carga la última versión compilada del juego.
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Discord puede reenviar las solicitudes con el prefijo "/.proxy".
    const route = url.pathname.replace(/^\/\.proxy(?=\/)/, '');
    if (!route.startsWith('/api/')) return serveStatic(req, res, route);
    api(req, res, route, url).catch((err: unknown) => {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof GameError) return send(res, 400, { error: err.message, readyAt: err.readyAt ?? null });
      const code = logger.incident(err, `actividad ${req.method} ${route}`);
      send(res, 500, { error: `Error interno (código ${code}).` });
    });
  });
  server.on('close', () => clearInterval(sweeper));
  return server;
}

/** Implementaciones reales contra la API de Discord. */
export function discordOAuth(clientId: string, clientSecret: string) {
  return {
    async exchangeCode(code: string): Promise<string> {
      const r = await fetch('https://discord.com/api/v10/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        const hint = detail.includes('invalid_client')
          ? ' → el CLIENT_SECRET del .env es incorrecto (usá el de OAuth2, no el token del bot)'
          : detail.includes('invalid_grant') ? ' → código vencido o usado; volvé a abrir la actividad' : '';
        throw new Error(`oauth2/token respondió ${r.status} ${detail.slice(0, 200)}${hint}`);
      }
      const data = (await r.json()) as { access_token?: string };
      if (!data.access_token) throw new Error('respuesta sin access_token');
      return data.access_token;
    },
    async fetchUser(accessToken: string): Promise<DiscordUser> {
      const r = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) throw new Error(`users/@me respondió ${r.status}`);
      return (await r.json()) as DiscordUser;
    },
  };
}

const API = '/.proxy/api';

export const auth = { session: '', guildId: '' };
let reauth: (() => Promise<void>) | null = null;

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function onReauth(fn: () => Promise<void>): void {
  reauth = fn;
}

export async function api<T>(route: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(auth.session ? { Authorization: `Bearer ${auth.session}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Error ${res.status}`);
  return data;
}

/** Igual que api(), pero si la sesión venció vuelve a iniciar sesión y reintenta una vez. */
export async function call<T>(route: string, body?: Record<string, unknown>): Promise<T> {
  try {
    return await api<T>(route, body);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && reauth) {
      await reauth();
      return api<T>(route, body);
    }
    throw err;
  }
}

/** Acción de juego sobre el servidor actual. */
export function action<T>(route: string, body: Record<string, unknown> = {}): Promise<T> {
  return call<T>(route, { guild: auth.guildId, ...body });
}

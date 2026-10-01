/**
 * El ID de la aplicación se puede sacar del token: su primera parte es el ID del bot en base64,
 * y en las aplicaciones de bot el ID del bot y el de la aplicación son el mismo.
 * Así CLIENT_ID es opcional (si está en .env, se usa ese).
 */
export function clientIdFromToken(token: string): string | null {
  const first = token.split('.')[0] ?? '';
  try {
    const id = Buffer.from(first.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^\d{17,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

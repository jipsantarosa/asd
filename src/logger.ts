import crypto from 'node:crypto';

function stamp(): string {
  return new Date().toISOString();
}

export const logger = {
  info: (...a: unknown[]) => console.log(stamp(), 'INFO ', ...a),
  warn: (...a: unknown[]) => console.warn(stamp(), 'WARN ', ...a),
  error: (...a: unknown[]) => console.error(stamp(), 'ERROR', ...a),
  /** Registra un error inesperado y devuelve un código corto para mostrar al usuario. */
  incident(err: unknown, where: string): string {
    const code = crypto.randomBytes(3).toString('hex');
    console.error(stamp(), 'ERROR', `[${code}] ${where}:`, err);
    return code;
  },
};

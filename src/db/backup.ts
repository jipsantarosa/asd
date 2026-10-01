import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
import type { Db } from './types';

/**
 * Copia de seguridad diaria de la base: `VACUUM INTO` genera un archivo consistente aunque el bot esté
 * escribiendo (funciona igual con better-sqlite3 y con node:sqlite). Se guardan las últimas `keep` copias.
 */
export function backupNow(db: Db, databasePath: string, keep = 7, now = new Date()): string | null {
  if (databasePath === ':memory:') return null;
  const dir = path.join(path.dirname(path.resolve(databasePath)), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(databasePath, path.extname(databasePath));
  const file = path.join(dir, `${base}-${now.toISOString().slice(0, 10)}.db`);
  if (fs.existsSync(file)) return file; // ya hay una copia de hoy
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}-`) && f.endsWith('.db')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

export function startBackups(db: Db, databasePath: string, everyMs = 6 * 3_600_000): NodeJS.Timeout {
  const run = () => {
    try {
      const file = backupNow(db, databasePath);
      if (file) logger.info(`Copia de seguridad al día: ${file}`);
    } catch (err) {
      logger.warn('No pude hacer la copia de seguridad de la base:', err);
    }
  };
  setTimeout(run, 60_000).unref(); // la primera, un minuto después de arrancar
  const timer = setInterval(run, everyMs);
  timer.unref();
  return timer;
}

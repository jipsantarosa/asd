import fs from 'node:fs';
import path from 'node:path';

/**
 * Evita que corran dos copias del bot con la misma carpeta de datos: las dos responderían a cada comando
 * (por ejemplo, !setup armaría los canales dos veces). La copia que corre deja un archivo con su PID y lo
 * "late" cada 30 s; otra copia que arranca y lo ve fresco no se conecta. Si el archivo quedó viejo (el bot
 * se cerró de golpe), se toma sin problema.
 */

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 90_000;

interface LockData {
  pid: number;
  heartbeat: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: existe pero es de otro usuario.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(file: string): LockData | null {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8')) as LockData;
    return Number.isInteger(d.pid) && Number.isFinite(d.heartbeat) ? d : null;
  } catch {
    return null;
  }
}

/** PID de otra copia viva del bot, o null si esta copia puede arrancar. */
export function otherInstance(file: string, now = Date.now(), pid = process.pid, isAlive = alive): number | null {
  const d = readLock(file);
  if (!d || d.pid === pid) return null;
  if (now - d.heartbeat > STALE_MS) return null;
  return isAlive(d.pid) ? d.pid : null;
}

export function writeLock(file: string, now = Date.now(), pid = process.pid): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid, heartbeat: now }));
}

/** Toma el lock (o devuelve el PID de la otra copia). Mientras corre, lo renueva; al salir, lo suelta. */
export function acquireInstanceLock(dataDir: string): { ok: true; release: () => void } | { ok: false; pid: number } {
  const file = path.join(dataDir, '.bot.lock');
  const other = otherInstance(file);
  if (other !== null) return { ok: false, pid: other };
  writeLock(file);
  const timer = setInterval(() => {
    try {
      writeLock(file);
    } catch {
      /* disco lleno o sin permisos: no frena al bot */
    }
  }, HEARTBEAT_MS);
  timer.unref();
  const release = () => {
    clearInterval(timer);
    try {
      if (readLock(file)?.pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      /* nada */
    }
  };
  process.once('exit', release);
  return { ok: true, release };
}

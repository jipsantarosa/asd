export const COLORS = {
  casino: 0xf1c40f,
  win: 0x2ecc71,
  loss: 0xe74c3c,
  push: 0x95a5a6,
  profile: 0x5865f2,
  tournament: 0xe67e22,
  roles: 0x8e44ad,
  settings: 0x607d8b,
  help: 0x16a085,
  ok: 0x2ecc71,
  warn: 0xe67e22,
  error: 0xe74c3c,
  log: 0x4f545c,
} as const;

/** Barra de progreso compacta: ▰▰▰▱▱▱ */
export function bar(value: number, max: number, size = 10): string {
  const ratio = max <= 0 ? 1 : Math.min(1, Math.max(0, value / max));
  const filled = Math.round(ratio * size);
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

export function num(n: number): string {
  return Math.trunc(n).toLocaleString('es-AR');
}

/** Monto en Coins: 🪙 12.500 */
export function coins(n: number): string {
  return `🪙 ${num(n)}`;
}

/** Monto con signo: +🪙 1.200 / −🪙 300 */
export function signedCoins(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}🪙 ${num(Math.abs(n))}`;
}

/** Multiplicador con dos decimales: 2,50x */
export function mult(m: number): string {
  return `${m.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}x`;
}

export function rel(ms: number): string {
  return `<t:${Math.ceil(ms / 1000)}:R>`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Escapa texto de usuario para que no rompa el formato ni mencione a nadie. */
export function clean(s: string): string {
  return s.replace(/([*_`~|>\\])/g, '\\$1').replace(/@/g, '@\u200b');
}

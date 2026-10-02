import { GameError } from '../../services/context';

/** Redondea hacia abajo a centésimos (los multiplicadores siempre se muestran y pagan así). */
export function floor2(x: number): number {
  return Math.floor(x * 100 + 1e-7) / 100;
}

/** Elige una opción por alias ("alto", "high", "h" → 'high'). */
export function pickOption<T extends string>(raw: string | undefined, options: Record<T, string[]>, def: T, what: string): T {
  if (raw === undefined || raw === '') return def;
  const v = raw.toLowerCase().trim();
  for (const [key, aliases] of Object.entries(options) as [T, string[]][]) {
    if (key === v || aliases.includes(v)) return key;
  }
  const all = Object.values<string[]>(options).map((a) => a[0]).join(', ');
  throw new GameError(`${what} inválido. Opciones: ${all}.`);
}

/** Entero dentro de un rango, o el valor por defecto si no se pasó. */
export function intOption(raw: string | undefined, min: number, max: number, def: number, what: string): number {
  if (raw === undefined || raw === '') return def;
  const n = Number(raw.replace(/[^\d-]/g, ''));
  if (!Number.isInteger(n) || n < min || n > max || !/\d/.test(raw)) throw new GameError(`${what} tiene que ser un número entre ${min} y ${max}.`);
  return n;
}

/** Barra de progreso compacta: ▰▰▰▱▱ */
export function bar(value: number, max: number, size = 10): string {
  const ratio = max <= 0 ? 1 : Math.min(1, Math.max(0, value / max));
  const filled = Math.round(ratio * size);
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

export const pct = (p: number) => `${(p * 100).toLocaleString('es-AR', { maximumFractionDigits: 1 })} %`;
export const mx = (m: number) => `${m.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}x`;

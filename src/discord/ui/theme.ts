import type { GameConfig, Rarity } from '../../game/types';

export const COLORS = {
  farm: 0x6aab3e,
  golden: 0xf1c40f,
  fish: 0x2e86c1,
  fight: 0x1b4f72,
  market: 0xe0a526,
  inventory: 0x8e6e53,
  profile: 0x5865f2,
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
  return Math.floor(n).toLocaleString('es-AR');
}

export function money(cfg: GameConfig, n: number): string {
  return `${cfg.currency.emoji} ${num(n)}`;
}

export function rel(ms: number): string {
  return `<t:${Math.ceil(ms / 1000)}:R>`;
}

export function rarityTag(cfg: GameConfig, r: Rarity): string {
  return `${cfg.rarities[r].emoji} ${cfg.rarities[r].label}`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function kg(v: number): string {
  return `${v.toLocaleString('es-AR', { maximumFractionDigits: 2 })} kg`;
}

/** Escapa texto de usuario para que no rompa el formato ni mencione a nadie. */
export function clean(s: string): string {
  return s.replace(/([*_`~|>\\])/g, '\\$1').replace(/@/g, '@\u200b');
}

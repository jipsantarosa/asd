// Tipos compartidos entre el servidor de la Actividad y la interfaz web (sin dependencias).

/**
 * Estado de la granja tal como lo ve la Actividad. Es de solo lectura: toda acción pasa
 * por los mismos servicios que usan los botones del bot, con las mismas validaciones.
 */
export interface DropView {
  id: string;
  name: string;
  emoji: string;
  qty: number;
  rarity: string;
  rarityLabel: string;
  color: string;
  special: boolean;
}

export interface ZoneView {
  id: string;
  name: string;
  emoji: string;
  description: string;
  level: number;
  vigorCost: number;
  baseXp: number;
  unlocked: boolean;
  current: boolean;
  requirements: { label: string; ok: boolean }[];
  crops: { name: string; emoji: string }[];
}

export interface FarmState {
  serverNow: number;
  currency: { name: string; emoji: string };
  player: {
    coins: number;
    level: number;
    xp: number;
    need: number;
    maxLevel: number;
    atMax: boolean;
    totalLevel: number;
    farmsTotal: number;
  };
  vigor: { current: number; max: number; regenMs: number; cost: number };
  readyAt: number;
  cooldownMs: number;
  fatigue: { multiplier: number; label: string };
  fertilizer: number;
  zone: ZoneView;
  zones: ZoneView[];
  equipment: { slot: string; name: string; emoji: string }[];
  bonuses: { yield: number; vigorDiscount: number };
  toolOk: boolean;
  barn: { id: string; name: string; emoji: string; qty: number; color: string }[];
  consumables: { id: string; name: string; emoji: string; qty: number; effect: string; limit: number | null }[];
  last: { at: number; drops: DropView[]; golden: boolean; fertilized: boolean; xp: number } | null;
}

export interface HarvestEvent {
  drops: DropView[];
  golden: boolean;
  fertilized: boolean;
  xp: number;
  fatigueMult: number;
  levelUp: { to: number; coins: number; reachedMax: boolean } | null;
  /** Logros desbloqueados en este lance (nombre + insignia). */
  achievements: { name: string; emoji: string; badge: string }[];
  activity: number;
}


// ───────────────────────── Pesca ─────────────────────────

export interface RodView {
  id: string;
  name: string;
  emoji: string;
  description: string;
  lines: number;
  luck: number;
  baitSave: number;
  cooldownSeconds: number;
  special: string | null;
  price: number;
  fishLevel: number;
  owned: boolean;
  equipped: boolean;
  /** Ruta relativa de la imagen (rods/<sprite>.png) o null. */
  image: string | null;
}

export interface BuffView {
  name: string;
  emoji: string;
  description: string;
  expiresAt: number;
  guildWide: boolean;
}

export interface FishState {
  serverNow: number;
  currency: { name: string; emoji: string };
  player: { level: number; xp: number; need: number; atMax: boolean; catches: number; coins: number };
  vigor: { current: number; max: number; regenMs: number };
  bait: { qty: number; emoji: string; price: number };
  /** Lo que usará el próximo "Pescar". */
  next: { lines: number; vigorCost: number };
  loadout: { lines: number; luck: number; baitSave: number; cooldownMs: number };
  readyAt: number;
  pity: { current: number; threshold: number };
  odds: { rarity: string; label: string; emoji: string; color: string; chance: number }[];
  rods: RodView[];
  buffs: BuffView[];
  collections: { label: string; emoji: string; color: string; found: number; total: number; reward: number; claimed: boolean }[];
  species: { name: string; emoji: string; color: string; found: boolean; caught: number; best: number; minLevel: number }[];
}

export interface CatchView {
  name: string;
  emoji: string;
  rarityLabel: string;
  color: string;
  weight: number;
  newSpecies: boolean;
  newRecord: boolean;
  echo: boolean;
  pity: boolean;
}

export interface CastView {
  lines: number;
  wantedLines: number;
  baitUsed: number;
  baitSaved: number;
  vigorSpent: number;
  xp: number;
  catches: CatchView[];
  extras: { name: string; emoji: string }[];
  collections: { label: string; coins: number }[];
  levelUp: { to: number; coins: number; reachedMax: boolean } | null;
  achievements: { name: string; emoji: string; badge: string }[];
  activity: number;
}

// ───────────────────────── Ranking ─────────────────────────

export type TopCategory = 'total' | 'actividad' | 'granja' | 'pesca' | 'monedas' | 'coleccion';

export interface TopView {
  category: TopCategory;
  categories: { id: TopCategory; label: string; emoji: string }[];
  unit: string;
  players: number;
  entries: { rank: number; userId: string; name: string; value: number; me: boolean }[];
  me: { rank: number; value: number } | null;
  rewards: { roleId: string; roleName: string; color: string; skill: string; level: number; current: number; earned: boolean }[];
}

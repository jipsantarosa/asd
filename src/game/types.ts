/**
 * Tipos del catálogo del juego. Todo lo que define el contenido (objetos, zonas,
 * equipamiento, precios, curvas) vive en datos tipados, no en la lógica.
 */

export type Rarity = 'comun' | 'poco_comun' | 'raro' | 'epico' | 'legendario' | 'mitico';
export type Skill = 'granja' | 'pesca';
export type ItemCategory = 'cultivo' | 'pez' | 'cebo' | 'consumible' | 'reliquia' | 'chatarra';
export type EquipSlot = 'herramienta' | 'accesorio';

export interface RarityMeta {
  label: string;
  emoji: string;
  color: number;
  /** 0 (común) .. 5 (mítico). Se usa para sesgos de probabilidad. */
  rank: number;
  /** Escala de saturación del mercado (unidades vendidas en el servidor antes de que el precio caiga a la mitad). */
  marketScale: number;
}

export interface ItemDef {
  id: string;
  name: string;
  emoji: string;
  category: ItemCategory;
  rarity: Rarity;
  /** 0 = no se puede vender. */
  sellPrice: number;
  description: string;
}

export interface ItemCost {
  itemId: string;
  qty: number;
}

export type ConsumableEffect =
  | { type: 'vigor'; amount: number }
  | { type: 'abono'; charges: number }
  | { type: 'buff'; buffId: string };

export interface ConsumableDef {
  itemId: string;
  /** null = no se vende en el mercado (solo se obtiene jugando). */
  buyPrice: number | null;
  /** Usos máximos por día (null = sin límite). */
  dailyUseLimit: number | null;
  minTotalLevel: number;
  /** Encarece el precio con el nivel total: precio × (1 + levelScaling × nivel total). */
  levelScaling?: number;
  effect: ConsumableEffect;
}

export interface EquipStats {
  yieldMult: number;
  extraRolls: number;
  vigorDiscount: number;
  rareBonus: number;
}

export interface EquipTier {
  tier: number;
  name: string;
  emoji: string;
  price: number;
  skill: Skill;
  level: number;
  stats: Partial<EquipStats>;
}

export interface EquipLine {
  slot: EquipSlot;
  label: string;
  emoji: string;
  skill: Skill;
  /** tiers[0] es el equipo inicial (gratis). */
  tiers: EquipTier[];
}

export interface WeightedDrop {
  itemId: string;
  weight: number;
  min: number;
  max: number;
}

export interface ChanceDrop {
  itemId: string;
  chance: number;
}

export interface FarmZone {
  id: string;
  name: string;
  emoji: string;
  description: string;
  level: number;
  unlockCost: number;
  unlockItems: ItemCost[];
  minToolTier: number;
  vigorCost: number;
  baseXp: number;
  rolls: number;
  crops: WeightedDrop[];
  rareDrops: ChanceDrop[];
}

/** Un pez del catálogo de pesca. Aparece desde `minLevel` de pesca. */
export interface FishDef {
  itemId: string;
  minLevel: number;
  /** Peso relativo dentro de su rareza (entre los peces ya desbloqueados). */
  weight: number;
  minKg: number;
  maxKg: number;
  xp: number;
}

export type RodSpecial =
  | { kind: 'eco'; chance: number }
  | { kind: 'abismo'; ultraMult: number };

/** Caña de pescar comprable en el Mercado. */
export interface RodDef {
  id: string;
  name: string;
  emoji: string;
  description: string;
  price: number;
  fishLevel: number;
  /** Objetos que se entregan al comprarla (además de las monedas). */
  requires: ItemCost[];
  /** Líneas simultáneas máximas (cada línea usa 1 carnada y hace 1 tirada). */
  lines: number;
  /** Suerte: sube la probabilidad de rarezas altas. */
  luck: number;
  /** Probabilidad de que una línea no gaste carnada. */
  baitSave: number;
  cooldownSeconds: number;
  special?: RodSpecial;
  /** Imagen en assets/rods/<sprite>.png (si falta, se usa solo el emoji). */
  sprite?: string;
}

export interface BuffEffect {
  luck?: number;
  /** +0.5 = +50% de XP de pesca. */
  xpMult?: number;
  baitSave?: number;
  /** Multiplica la espera entre pescas (0.6 = −40%). */
  cooldownMult?: number;
  extraLines?: number;
  /** Descuento en el Mercado (0.15 = −15%). */
  shopDiscount?: number;
}

export interface BuffDef {
  id: string;
  name: string;
  emoji: string;
  description: string;
  minutes: number;
  /** Tope de duración acumulada si se activa varias veces. */
  maxMinutes: number;
  effect: BuffEffect;
}

export type EventRewardKind = 'coins' | 'bait' | 'item' | 'buff' | 'xp';

export interface EventRewardDef {
  id: string;
  label: string;
  emoji: string;
  weight: number;
  kind: EventRewardKind;
  /** coins/bait/item: cantidad. xp: fracción de la XP que falta para el siguiente nivel (0.2 = 20%). */
  min: number;
  max: number;
  itemId?: string;
  buffId?: string;
  /** Solo monedas: escala por nivel total (1 + escala × nivel, con tope ×6). */
  scalePerLevel?: number;
}

/** Casilla del lago: cada tipo de agua cambia la pesca en ese lugar. */
export interface LakeTileDef {
  id: string;
  name: string;
  emoji: string;
  description: string;
  /** Frecuencia con la que aparece en el lago. */
  weight: number;
  /** Máximo de casillas de este tipo por lago (p. ej. un solo remolino). */
  maxPerLake?: number;
  /** Suerte extra (puede ser negativa). Se suma después del tope de suerte normal. */
  luck: number;
  /** Multiplica la probabilidad de Ultralegendario. */
  ultraMult?: number;
  /** Multiplica la XP de ese tiro. */
  xpMult?: number;
  /** Probabilidad de que cada línea se corte (se pierde esa captura). */
  snapChance?: number;
  /** Hallazgos extra propios de esa casilla. */
  extraDrops?: ChanceDrop[];
}

export interface FishingConfig {
  /** Objeto que funciona como carnada. */
  baitItemId: string;
  /** Probabilidad base de cada rareza (se normaliza). */
  rarityWeights: Record<Rarity, number>;
  /** Cuánto aprovecha cada rareza la suerte: peso × (1 + suerte × factor). */
  luckScaling: Record<Rarity, number>;
  fish: FishDef[];
  /** Hallazgos extra por pesca (no por línea). Los de rareza Raro+ escalan con la suerte. */
  extraDrops: ChanceDrop[];
  /** Premio único al registrar todas las especies de una rareza. */
  collectionRewards: Record<Rarity, number>;
  rods: RodDef[];
  /** Tipos de casilla del lago (el juego de pesca). */
  tiles: LakeTileDef[];
  /** Cantidad de casillas del lago (máx. 12: 3 filas de 4 botones). */
  lakeSize: number;
}

export type AchievementTier = 'bronce' | 'plata' | 'oro' | 'platino' | 'diamante';
export type AchievementCategory = 'pesca' | 'granja' | 'economia' | 'progresion' | 'canas' | 'eventos';

/**
 * Métricas que pueden medir los logros. Las "stat:*" son contadores acumulados en la tabla player_stats;
 * el resto se calcula a partir del perfil.
 */
export type AchievementMetric =
  | 'catches' | 'harvests' | 'fish_level' | 'farm_level' | 'total_level' | 'species' | 'rods_owned' | 'collections'
  | 'stat:rare_caught' | 'stat:epic_caught' | 'stat:legend_caught' | 'stat:ultra_caught' | 'stat:golden_harvests'
  | 'stat:items_sold' | 'stat:coins_from_sales' | 'stat:purchases' | 'stat:coins_spent' | 'stat:events_won';

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  emoji: string;
  /** Ícono de la insignia (assets/badges/<id>.png se genera en pixel art con scripts/pixel-art.py). */
  icon: string;
  tier: AchievementTier;
  category: AchievementCategory;
  metric: AchievementMetric;
  goal: number;
  reward: { coins?: number; items?: ItemCost[] };
  /** Puntos de actividad que otorga (cuentan para las distinciones por actividad). */
  activity: number;
}

export interface EventsConfig {
  rewards: EventRewardDef[];
  /** Buff de servidor para el evento "marea" (todos los que pescan lo reciben). */
  guildBoostBuffId: string;
}

export interface UpgradeDef {
  id: 'vigor_max' | 'vigor_regen' | 'suerte' | 'negociante';
  name: string;
  emoji: string;
  description: string;
  maxLevel: number;
  baseCost: number;
  costGrowth: number;
  /** Nivel total (granja + pesca) requerido para el nivel 1 de la mejora. */
  baseTotalLevel: number;
  totalLevelPerStep: number;
  /** Efecto por nivel (su significado depende de la mejora). */
  perLevel: number;
}

/** Valores numéricos que cada servidor puede ajustar con /ajustes. */
export interface Tuning {
  vigor: { base: number; regenSeconds: number };
  farm: { cooldownSeconds: number; xpMultiplier: number; yieldMultiplier: number; rareMultiplier: number; goldenChance: number; fertilizerBonus: number };
  fatigue: { threshold: number; perAction: number; decayPerMinute: number; step: number; floor: number };
  fish: {
    xpMultiplier: number;
    /** Multiplica toda la suerte de pesca. */
    luckMultiplier: number;
    maxLuck: number;
    vigorPerCast: number;
    vigorPerLine: number;
    /** Multiplica la espera de todas las cañas. */
    cooldownMultiplier: number;
    minCooldownSeconds: number;
    maxLines: number;
    /** Tiradas seguidas sin Épico+ que garantizan un Épico (0 = desactivado). */
    pityThreshold: number;
    baitPriceBase: number;
    baitPricePerLevel: number;
  };
  /** Puntos de actividad: premian jugar de verdad, con topes diarios contra el spam. */
  activity: {
    fishPoints: number;
    farmPoints: number;
    sellPoints: number;
    buyPoints: number;
    eventPoints: number;
    /** Ventas y compras solo suman si mueven al menos este valor. */
    minTradeValue: number;
    dailyCapFish: number;
    dailyCapFarm: number;
    dailyCapTrade: number;
    dailyCapTotal: number;
  };
  events: {
    minMinutes: number;
    maxMinutes: number;
    joinSeconds: number;
    maxWinners: number;
    /** Probabilidad de que el evento sea una "marea dorada" para todo el servidor. */
    boostChance: number;
    boostMinutes: number;
    minAccountDays: number;
    minMemberHours: number;
    minTotalLevel: number;
    dailyWinCap: number;
  };
  market: { buyMultiplier: number; sellMultiplier: number; saturationHalfLifeHours: number; minPriceMultiplier: number };
  progression: {
    maxLevel: number;
    curveBase: number;
    curveExponent: number;
    curveLinear: number;
    curveMultiplier: number;
    levelGapTolerance: number;
    levelGapPenalty: number;
    levelGapFloor: number;
    levelUpCoinsPerLevel: number;
  };
  antispam: { actionsPerWindow: number; windowSeconds: number; flagThreshold: number };
}

export interface GameConfig {
  /** Desfase horario (minutos) para el reinicio de los límites diarios. -180 = Argentina. */
  timezoneOffsetMinutes: number;
  currency: { name: string; emoji: string };
  starter: { coins: number; items: ItemCost[] };
  maxFertilizerCharges: number;
  rarities: Record<Rarity, RarityMeta>;
  items: ItemDef[];
  consumables: ConsumableDef[];
  equipment: EquipLine[];
  farming: { zones: FarmZone[] };
  fishing: FishingConfig;
  buffs: BuffDef[];
  events: EventsConfig;
  achievements: AchievementDef[];
  upgrades: UpgradeDef[];
  tuning: Tuning;
}

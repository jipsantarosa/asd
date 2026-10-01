import fs from 'node:fs';
import { DEFAULT_CONFIG } from './defaults';
import type { BuffDef, EquipLine, EquipSlot, FarmZone, FishDef, GameConfig, ItemDef, Rarity, RodDef, Tuning } from './types';

// ───────────────────────── Overrides globales (game.config.json) ─────────────────────────

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge profundo: objetos se combinan, arrays y primitivos se reemplazan. Rechaza cambios de tipo. */
export function deepMerge<T>(base: T, override: unknown, path = ''): T {
  if (override === undefined) return base;
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Json = { ...base };
    for (const [k, v] of Object.entries(override)) {
      if (!(k in base)) throw new Error(`Clave desconocida en game.config.json: ${path}${k}`);
      out[k] = deepMerge((base as Json)[k], v, `${path}${k}.`);
    }
    return out as T;
  }
  if (Array.isArray(base) !== Array.isArray(override) || (!Array.isArray(base) && typeof base !== typeof override)) {
    throw new Error(`Tipo inválido en game.config.json para "${path.slice(0, -1)}"`);
  }
  return override as T;
}

/** Comprueba la coherencia del catálogo para fallar al arrancar y no en mitad de una partida. */
export function validateConfig(cfg: GameConfig): void {
  const ids = new Set<string>();
  for (const item of cfg.items) {
    if (ids.has(item.id)) throw new Error(`Objeto duplicado: ${item.id}`);
    if (!/^[a-z0-9_]{1,40}$/.test(item.id)) throw new Error(`ID de objeto inválido: ${item.id}`);
    if (!(item.rarity in cfg.rarities)) throw new Error(`Rareza inválida en ${item.id}`);
    ids.add(item.id);
  }
  const need = (id: string, where: string) => {
    if (!ids.has(id)) throw new Error(`${where} referencia un objeto inexistente: ${id}`);
  };
  const buffIds = new Set(cfg.buffs.map((b) => b.id));
  for (const c of cfg.consumables) {
    need(c.itemId, 'consumables');
    if (c.effect.type === 'buff' && !buffIds.has(c.effect.buffId)) throw new Error(`consumables: buff inexistente ${c.effect.buffId}`);
  }
  for (const b of cfg.buffs) {
    if (!/^[a-z0-9_]{1,32}$/.test(b.id)) throw new Error(`ID de buff inválido: ${b.id}`);
    if (b.minutes <= 0 || b.maxMinutes < b.minutes) throw new Error(`Duración inválida en el buff ${b.id}`);
  }
  cfg.starter.items.forEach((s) => need(s.itemId, 'starter'));
  for (const z of cfg.farming.zones) {
    z.crops.forEach((c) => need(c.itemId, `zona ${z.id}`));
    z.rareDrops.forEach((c) => need(c.itemId, `zona ${z.id}`));
    z.unlockItems.forEach((c) => need(c.itemId, `zona ${z.id}`));
    if (z.crops.length === 0) throw new Error(`La zona ${z.id} no tiene cultivos`);
  }
  const f = cfg.fishing;
  need(f.baitItemId, 'fishing.baitItemId');
  f.fish.forEach((x) => need(x.itemId, 'fishing.fish'));
  f.extraDrops.forEach((x) => need(x.itemId, 'fishing.extraDrops'));
  for (const x of f.fish) if (x.minKg <= 0 || x.maxKg < x.minKg || x.weight <= 0) throw new Error(`Pez inválido: ${x.itemId}`);
  for (const r of Object.keys(cfg.rarities) as Rarity[]) {
    if (!(f.rarityWeights[r] >= 0) || !(f.luckScaling[r] >= 0)) throw new Error(`fishing: falta la probabilidad de ${r}`);
    // Cada rareza necesita al menos un pez disponible desde nivel 1: así ninguna tirada queda "vacía".
    if (!f.fish.some((x) => x.minLevel <= 1 && cfg.items.find((i) => i.id === x.itemId)?.rarity === r)) {
      throw new Error(`fishing: la rareza ${r} necesita al menos un pez de nivel 1`);
    }
  }
  if (!f.tiles.length || f.lakeSize < 1 || f.lakeSize > 12) throw new Error('fishing: el lago necesita casillas (lakeSize 1–12)');
  const tileIds = new Set<string>();
  for (const t of f.tiles) {
    if (tileIds.has(t.id) || !/^[a-z0-9_]{1,24}$/.test(t.id) || t.weight <= 0) throw new Error(`Casilla inválida: ${t.id}`);
    if ((t.snapChance ?? 0) < 0 || (t.snapChance ?? 0) >= 1) throw new Error(`Casilla ${t.id}: snapChance debe estar entre 0 y 1`);
    tileIds.add(t.id);
    (t.extraDrops ?? []).forEach((d) => need(d.itemId, `casilla ${t.id}`));
  }
  if (!f.tiles.some((t) => !t.maxPerLake)) throw new Error('fishing: al menos una casilla debe no tener límite por lago');
  const rodIds = new Set<string>();
  for (const rod of f.rods) {
    if (rodIds.has(rod.id) || !/^[a-z0-9_]{1,32}$/.test(rod.id)) throw new Error(`Caña inválida o duplicada: ${rod.id}`);
    rodIds.add(rod.id);
    rod.requires.forEach((c) => need(c.itemId, `caña ${rod.id}`));
    if (rod.lines < 1 || rod.cooldownSeconds < 1 || rod.baitSave < 0 || rod.baitSave > 0.9 || rod.luck < 0) throw new Error(`Valores inválidos en la caña ${rod.id}`);
  }
  if (!f.rods.length || f.rods[0].price !== 0 || f.rods[0].requires.length) throw new Error('La primera caña debe ser gratuita');
  for (const r of cfg.events.rewards) {
    if (r.weight <= 0 || r.max < r.min) throw new Error(`Premio de evento inválido: ${r.id}`);
    if (r.kind === 'item') need(r.itemId ?? '', `evento ${r.id}`);
    if (r.kind === 'buff' && !buffIds.has(r.buffId ?? '')) throw new Error(`evento ${r.id}: buff inexistente`);
  }
  if (!buffIds.has(cfg.events.guildBoostBuffId)) throw new Error('events.guildBoostBuffId no existe');
  const METRICS = new Set(['catches', 'harvests', 'fish_level', 'farm_level', 'total_level', 'species', 'rods_owned', 'collections',
    'stat:rare_caught', 'stat:epic_caught', 'stat:legend_caught', 'stat:ultra_caught', 'stat:golden_harvests', 'stat:items_sold',
    'stat:coins_from_sales', 'stat:purchases', 'stat:coins_spent', 'stat:events_won']);
  const achIds = new Set<string>();
  for (const a of cfg.achievements) {
    if (achIds.has(a.id) || !/^[a-z0-9_]{1,40}$/.test(a.id)) throw new Error(`Logro inválido o duplicado: ${a.id}`);
    achIds.add(a.id);
    if (!METRICS.has(a.metric)) throw new Error(`Logro ${a.id}: métrica desconocida ${a.metric}`);
    if (!(a.goal >= 1) || !(a.activity >= 0) || (a.reward.coins ?? 0) < 0) throw new Error(`Logro ${a.id}: valores inválidos`);
    (a.reward.items ?? []).forEach((c) => need(c.itemId, `logro ${a.id}`));
  }
  const slots: EquipSlot[] = ['herramienta', 'accesorio'];
  for (const slot of slots) {
    const line = cfg.equipment.find((l) => l.slot === slot);
    if (!line) throw new Error(`Falta la línea de equipo ${slot}`);
    line.tiers.forEach((t, i) => {
      if (t.tier !== i) throw new Error(`Los tiers de ${slot} deben ser consecutivos desde 0`);
    });
    if (line.tiers[0].price !== 0) throw new Error(`El tier 0 de ${slot} debe ser gratuito`);
  }
  if (cfg.farming.zones[0].unlockCost !== 0) throw new Error('La primera zona debe ser gratuita');
  for (const t of TUNABLES) {
    const v = getTuningValue(cfg.tuning, t.key);
    if (typeof v !== 'number' || v < t.min || v > t.max) throw new Error(`Valor fuera de rango para ${t.key}: ${v}`);
  }
}

export function loadBaseConfig(filePath?: string): GameConfig {
  let cfg: GameConfig = structuredClone(DEFAULT_CONFIG);
  if (filePath && fs.existsSync(filePath)) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    cfg = deepMerge(cfg, raw);
  }
  validateConfig(cfg);
  return cfg;
}

// ───────────────────────── Ajustes por servidor (tunables) ─────────────────────────

export interface TunableDef {
  key: string;
  label: string;
  section: 'Vigor' | 'Granja' | 'Cansancio' | 'Pesca' | 'Eventos' | 'Actividad' | 'Mercado' | 'Progresión' | 'Antispam';
  min: number;
  max: number;
  integer?: boolean;
  hint: string;
}

/** Lista blanca de valores ajustables por servidor, con rangos seguros. */
export const TUNABLES: TunableDef[] = [
  { key: 'vigor.base', label: 'Vigor base', section: 'Vigor', min: 20, max: 1000, integer: true, hint: 'Vigor máximo inicial.' },
  { key: 'vigor.regenSeconds', label: 'Segundos por punto de vigor', section: 'Vigor', min: 5, max: 3600, integer: true, hint: 'Cuánto tarda en regenerarse 1 punto.' },
  { key: 'farm.cooldownSeconds', label: 'Espera entre cosechas (s)', section: 'Granja', min: 1, max: 600, integer: true, hint: 'Tiempo mínimo entre dos "Farmear".' },
  { key: 'farm.xpMultiplier', label: 'Multiplicador de XP', section: 'Granja', min: 0.1, max: 10, hint: 'XP de granja.' },
  { key: 'farm.yieldMultiplier', label: 'Multiplicador de cosecha', section: 'Granja', min: 0.1, max: 10, hint: 'Cantidad de cultivos.' },
  { key: 'farm.rareMultiplier', label: 'Multiplicador de hallazgos raros', section: 'Granja', min: 0, max: 20, hint: 'Probabilidad de reliquias.' },
  { key: 'farm.goldenChance', label: 'Probabilidad de cosecha dorada', section: 'Granja', min: 0, max: 0.5, hint: '0.04 = 4%.' },
  { key: 'farm.fertilizerBonus', label: 'Bonus del abono', section: 'Granja', min: 0, max: 3, hint: '0.4 = +40% de cosecha.' },
  { key: 'fatigue.threshold', label: 'Umbral de cansancio', section: 'Cansancio', min: 5, max: 500, integer: true, hint: 'Acciones seguidas antes de rendir menos.' },
  { key: 'fatigue.decayPerMinute', label: 'Recuperación por minuto', section: 'Cansancio', min: 0.05, max: 20, hint: 'Cansancio que se pierde por minuto.' },
  { key: 'fatigue.step', label: 'Penalización por acción extra', section: 'Cansancio', min: 0, max: 0.5, hint: '0.03 = -3% por acción sobre el umbral.' },
  { key: 'fatigue.floor', label: 'Rendimiento mínimo', section: 'Cansancio', min: 0.05, max: 1, hint: 'Piso del multiplicador de cansancio.' },
  { key: 'fish.xpMultiplier', label: 'Multiplicador de XP', section: 'Pesca', min: 0.1, max: 10, hint: 'XP de pesca.' },
  { key: 'fish.luckMultiplier', label: 'Multiplicador de suerte', section: 'Pesca', min: 0, max: 5, hint: 'Escala toda la suerte (cañas, mejoras y buffs).' },
  { key: 'fish.maxLuck', label: 'Suerte máxima', section: 'Pesca', min: 0, max: 3, hint: 'Tope de suerte total. 0.8 = +80%.' },
  { key: 'fish.vigorPerCast', label: 'Vigor fijo por pesca', section: 'Pesca', min: 0, max: 50, integer: true, hint: 'Costo base de cada "Pescar".' },
  { key: 'fish.vigorPerLine', label: 'Vigor por línea', section: 'Pesca', min: 0, max: 50, integer: true, hint: 'Costo extra por cada línea simultánea.' },
  { key: 'fish.cooldownMultiplier', label: 'Multiplicador de espera', section: 'Pesca', min: 0, max: 10, hint: 'Escala la espera de todas las cañas (0 = sin espera).' },
  { key: 'fish.minCooldownSeconds', label: 'Espera mínima (s)', section: 'Pesca', min: 0, max: 600, integer: true, hint: 'Piso de la espera (0 = sin espera).' },
  { key: 'fish.maxLines', label: 'Líneas máximas', section: 'Pesca', min: 1, max: 10, integer: true, hint: 'Tope de líneas simultáneas (caña + buffs).' },
  { key: 'fish.pityThreshold', label: 'Racha que garantiza un Épico', section: 'Pesca', min: 0, max: 2000, integer: true, hint: 'Tiradas sin Épico+ antes de garantizar uno (0 = desactivado).' },
  { key: 'fish.baitPriceBase', label: 'Precio base de la carnada', section: 'Pesca', min: 1, max: 10000, integer: true, hint: 'Precio por unidad en el Mercado.' },
  { key: 'fish.baitPricePerLevel', label: 'Carnada: precio extra por nivel', section: 'Pesca', min: 0, max: 1000, hint: 'Se suma por cada nivel de pesca.' },
  { key: 'events.minMinutes', label: 'Intervalo mínimo (min)', section: 'Eventos', min: 10, max: 1440, integer: true, hint: 'Tiempo mínimo entre eventos automáticos.' },
  { key: 'events.maxMinutes', label: 'Intervalo máximo (min)', section: 'Eventos', min: 10, max: 2880, integer: true, hint: 'Tiempo máximo entre eventos automáticos.' },
  { key: 'events.joinSeconds', label: 'Tiempo para participar (s)', section: 'Eventos', min: 30, max: 3600, integer: true, hint: 'Cuánto dura abierto cada sorteo.' },
  { key: 'events.maxWinners', label: 'Ganadores máximos', section: 'Eventos', min: 1, max: 10, integer: true, hint: 'Cada sorteo tiene entre 1 y este número de ganadores.' },
  { key: 'events.boostChance', label: 'Probabilidad de marea dorada', section: 'Eventos', min: 0, max: 1, hint: 'Chance de que el evento sea un bonus para todo el servidor.' },
  { key: 'events.boostMinutes', label: 'Duración de la marea dorada (min)', section: 'Eventos', min: 1, max: 240, integer: true, hint: 'Duración del bonus de servidor.' },
  { key: 'events.minAccountDays', label: 'Antigüedad mínima de la cuenta (días)', section: 'Eventos', min: 0, max: 365, integer: true, hint: 'Anti cuentas alternativas.' },
  { key: 'events.minMemberHours', label: 'Tiempo mínimo en el servidor (h)', section: 'Eventos', min: 0, max: 2160, integer: true, hint: 'Anti cuentas alternativas.' },
  { key: 'events.minTotalLevel', label: 'Nivel total mínimo', section: 'Eventos', min: 0, max: 500, integer: true, hint: 'Hay que haber jugado un poco para participar.' },
  { key: 'events.dailyWinCap', label: 'Victorias máximas por día', section: 'Eventos', min: 1, max: 50, integer: true, hint: 'Reparte los premios entre más gente.' },
  { key: 'activity.fishPoints', label: 'Puntos por pesca', section: 'Actividad', min: 0, max: 100, integer: true, hint: 'Puntos de actividad por cada "Pescar".' },
  { key: 'activity.farmPoints', label: 'Puntos por cosecha', section: 'Actividad', min: 0, max: 100, integer: true, hint: 'Puntos de actividad por cada cosecha.' },
  { key: 'activity.sellPoints', label: 'Puntos por venta', section: 'Actividad', min: 0, max: 100, integer: true, hint: 'Por venta que supere el valor mínimo.' },
  { key: 'activity.buyPoints', label: 'Puntos por compra', section: 'Actividad', min: 0, max: 100, integer: true, hint: 'Por compra que supere el valor mínimo.' },
  { key: 'activity.eventPoints', label: 'Puntos por ganar un sorteo', section: 'Actividad', min: 0, max: 1000, integer: true, hint: 'Se suman al ganador.' },
  { key: 'activity.minTradeValue', label: 'Valor mínimo de compra/venta', section: 'Actividad', min: 0, max: 1000000, integer: true, hint: 'Compras o ventas más chicas no suman puntos (anti spam).' },
  { key: 'activity.dailyCapFish', label: 'Tope diario por pesca', section: 'Actividad', min: 0, max: 10000, integer: true, hint: 'Máximo de puntos por día pescando.' },
  { key: 'activity.dailyCapFarm', label: 'Tope diario por granja', section: 'Actividad', min: 0, max: 10000, integer: true, hint: 'Máximo de puntos por día farmeando.' },
  { key: 'activity.dailyCapTrade', label: 'Tope diario por comercio', section: 'Actividad', min: 0, max: 10000, integer: true, hint: 'Máximo de puntos por día comprando y vendiendo.' },
  { key: 'activity.dailyCapTotal', label: 'Tope diario total', section: 'Actividad', min: 0, max: 50000, integer: true, hint: 'Máximo de puntos por día (sin contar logros).' },
  { key: 'market.buyMultiplier', label: 'Multiplicador de compra', section: 'Mercado', min: 0.1, max: 10, hint: 'Precios de la tienda.' },
  { key: 'market.sellMultiplier', label: 'Multiplicador de venta', section: 'Mercado', min: 0.1, max: 10, hint: 'Lo que paga el mercado.' },
  { key: 'market.saturationHalfLifeHours', label: 'Recuperación de demanda (h)', section: 'Mercado', min: 0.25, max: 168, hint: 'Vida media de la saturación.' },
  { key: 'market.minPriceMultiplier', label: 'Precio mínimo por saturación', section: 'Mercado', min: 0.05, max: 1, hint: 'Piso del precio cuando el mercado está saturado.' },
  { key: 'progression.maxLevel', label: 'Nivel máximo', section: 'Progresión', min: 10, max: 250, integer: true, hint: 'Tope de nivel por habilidad.' },
  { key: 'progression.curveMultiplier', label: 'Dificultad de la curva', section: 'Progresión', min: 0.1, max: 20, hint: '2 = el doble de XP por nivel.' },
  { key: 'progression.curveExponent', label: 'Exponente de la curva', section: 'Progresión', min: 1, max: 3.5, hint: 'Mayor = niveles altos mucho más difíciles.' },
  { key: 'progression.levelGapTolerance', label: 'Tolerancia de zona', section: 'Progresión', min: 0, max: 100, integer: true, hint: 'Niveles de ventaja antes de penalizar XP en zonas bajas.' },
  { key: 'progression.levelGapPenalty', label: 'Penalización por nivel de ventaja', section: 'Progresión', min: 0, max: 1, hint: 'Reducción de XP por nivel sobre la tolerancia.' },
  { key: 'progression.levelUpCoinsPerLevel', label: 'Monedas por subir de nivel', section: 'Progresión', min: 0, max: 100000, integer: true, hint: 'Premio = nivel × este valor.' },
  { key: 'antispam.actionsPerWindow', label: 'Acciones permitidas por ventana', section: 'Antispam', min: 2, max: 60, integer: true, hint: 'Límite de clics por usuario.' },
  { key: 'antispam.windowSeconds', label: 'Ventana antispam (s)', section: 'Antispam', min: 2, max: 120, integer: true, hint: 'Duración de la ventana.' },
];

const TUNABLE_KEYS = new Map(TUNABLES.map((t) => [t.key, t]));

export function getTunable(key: string): TunableDef | undefined {
  return TUNABLE_KEYS.get(key);
}

export function getTuningValue(tuning: Tuning, key: string): number | undefined {
  const [section, field] = key.split('.');
  const sec = (tuning as unknown as Record<string, Record<string, unknown>>)[section];
  const v = sec?.[field];
  return typeof v === 'number' ? v : undefined;
}

/** Valida y normaliza un valor de ajuste. Devuelve null si es inválido. */
export function normalizeTunable(key: string, value: number): number | null {
  const def = TUNABLE_KEYS.get(key);
  if (!def || !Number.isFinite(value)) return null;
  const v = def.integer ? Math.round(value) : Math.round(value * 10000) / 10000;
  if (v < def.min || v > def.max) return null;
  return v;
}

/** Aplica los ajustes de un servidor sobre la config base. Ignora claves fuera de la lista blanca. */
export function applyTunables(base: GameConfig, overrides: Record<string, number>): GameConfig {
  const tuning = structuredClone(base.tuning) as unknown as Record<string, Record<string, number>>;
  for (const [key, raw] of Object.entries(overrides)) {
    const v = normalizeTunable(key, Number(raw));
    if (v === null) continue;
    const [section, field] = key.split('.');
    if (tuning[section] && field in tuning[section]) tuning[section][field] = v;
  }
  return { ...base, tuning: tuning as unknown as Tuning };
}

// ───────────────────────── Búsquedas en el catálogo ─────────────────────────

const itemIndex = new WeakMap<GameConfig, Map<string, ItemDef>>();

export function getItem(cfg: GameConfig, id: string): ItemDef | undefined {
  let idx = itemIndex.get(cfg);
  if (!idx) {
    idx = new Map(cfg.items.map((i) => [i.id, i]));
    itemIndex.set(cfg, idx);
  }
  return idx.get(id);
}

export function requireItem(cfg: GameConfig, id: string): ItemDef {
  const item = getItem(cfg, id);
  if (!item) throw new Error(`Objeto desconocido: ${id}`);
  return item;
}

export function getZone(cfg: GameConfig, id: string): FarmZone | undefined {
  return cfg.farming.zones.find((z) => z.id === id);
}

export function getRod(cfg: GameConfig, id: string): RodDef | undefined {
  return cfg.fishing.rods.find((r) => r.id === id);
}

export function getBuff(cfg: GameConfig, id: string): BuffDef | undefined {
  return cfg.buffs.find((b) => b.id === id);
}

export function fishRarity(cfg: GameConfig, fish: FishDef): Rarity {
  return getItem(cfg, fish.itemId)!.rarity;
}

export function getEquipLine(cfg: GameConfig, slot: EquipSlot): EquipLine {
  const line = cfg.equipment.find((l) => l.slot === slot);
  if (!line) throw new Error(`Línea de equipo inexistente: ${slot}`);
  return line;
}

export function itemLabel(cfg: GameConfig, id: string): string {
  const item = getItem(cfg, id);
  return item ? `${item.emoji} ${item.name}` : id;
}

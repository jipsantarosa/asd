/**
 * Informe matemático de balance: valores esperados EXACTOS (no simulados) a partir del catálogo.
 * Uso:  npx tsx scripts/balance-report.ts
 */
import { getEquipLine, getItem, loadBaseConfig } from '../src/game/config';
import type { GameConfig, Rarity } from '../src/game/types';
import { RARITY_ORDER, baitPrice, castVigorCost, expectedRoll, rarityOdds } from '../src/services/fishing';
import { xpToNext } from '../src/services/progression';

const cfg: GameConfig = loadBaseConfig();
const noVigor = cfg.tuning.fish.vigorPerCast + cfg.tuning.fish.vigorPerLine === 0;
if (noVigor) {
  // Configuración por defecto: la pesca no gasta vigor ni tiene espera. Para comparar con la granja
  // por punto de vigor se usa el costo clásico (4 + 2 por línea), como si un admin lo reactivara.
  console.log('ℹ️  La pesca no gasta vigor ni tiene espera: la carnada es su único costo.');
  console.log('   Las comparaciones "por vigor" usan 4 + 2 por línea (lo que se puede reactivar en /ajustes → Pesca).\n');
  cfg.tuning.fish.vigorPerCast = 4;
  cfg.tuning.fish.vigorPerLine = 2;
}
const pct = (x: number, d = 3) => `${(x * 100).toFixed(d)}%`;
const n = (x: number) => Math.round(x).toLocaleString('es-AR');

/** Monedas esperadas por punto de vigor al farmear una zona con cierto equipo de granja. */
export function farmPerVigor(cfg: GameConfig, zoneIdx: number, toolTier: number, accTier: number): { perVigor: number; baitPerFarm: number } {
  const z = cfg.farming.zones[zoneIdx];
  const tool = getEquipLine(cfg, 'herramienta').tiers[toolTier].stats;
  const acc = getEquipLine(cfg, 'accesorio').tiers[accTier].stats;
  const yieldMult = (tool.yieldMult ?? 1) * (1 + cfg.tuning.farm.goldenChance);
  const rolls = z.rolls + (tool.extraRolls ?? 0);
  const tw = z.crops.reduce((s, c) => s + c.weight, 0);
  const perRoll = z.crops.reduce((s, c) => s + (c.weight / tw) * ((c.min + c.max) / 2) * yieldMult * (getItem(cfg, c.itemId)!.sellPrice), 0);
  const rare = z.rareDrops.reduce((s, r) => s + (r.itemId === cfg.fishing.baitItemId ? 0 : r.chance * (1 + (acc.rareBonus ?? 0)) * getItem(cfg, r.itemId)!.sellPrice), 0);
  const bait = z.rareDrops.find((r) => r.itemId === cfg.fishing.baitItemId)?.chance ?? 0;
  const vigor = Math.max(1, Math.ceil(z.vigorCost * (1 - Math.min(0.6, acc.vigorDiscount ?? 0))));
  return { perVigor: (rolls * perRoll + rare) / vigor, baitPerFarm: bait };
}

console.log('═══ 1. Probabilidad por tirada según la suerte ═══');
const header = ['suerte', ...RARITY_ORDER.map((r) => cfg.rarities[r].label), '1 Ultra cada…'];
console.log(header.join(' | '));
for (const [label, luck, ultra] of [['0 (inicio)', 0, 1], ['0,30', 0.3, 1], ['0,80 (tope)', 0.8, 1], ['0,80 + abismo', 0.8, 1.6]] as const) {
  const o = rarityOdds(cfg, luck, ultra);
  console.log([label, ...RARITY_ORDER.map((r) => pct(o[r], 3)), `${n(1 / o.mitico)} tiradas`].join(' | '));
}

console.log('\n═══ 2. Economía por etapa (valores base de venta, sin saturación del mercado) ═══');
const stages = [
  { lvl: 1, rod: 'junco', upg: 0, zone: 0, tool: 0, acc: 0 },
  { lvl: 10, rod: 'tejedora', upg: 1, zone: 1, tool: 1, acc: 1 },
  { lvl: 20, rod: 'coral', upg: 2, zone: 2, tool: 2, acc: 2 },
  { lvl: 36, rod: 'relampago', upg: 4, zone: 3, tool: 3, acc: 3 },
  { lvl: 45, rod: 'brujula', upg: 5, zone: 3, tool: 3, acc: 3 },
  { lvl: 58, rod: 'abismo', upg: 7, zone: 4, tool: 4, acc: 4 },
  { lvl: 80, rod: 'astro', upg: 10, zone: 4, tool: 5, acc: 4 },
];
const vigorPerHour = (3600 / cfg.tuning.vigor.regenSeconds);
console.log('nivel | caña | suerte | EV/tirada | XP/tirada | carnada | pesca neta/vigor | granja/vigor | pesca/granja | pesca neta/h');
const rows: { lvl: number; fishNet: number; farm: number; perHour: number }[] = [];
for (const s of stages) {
  const rod = cfg.fishing.rods.find((r) => r.id === s.rod)!;
  const luck = Math.min(cfg.tuning.fish.maxLuck, rod.luck + 0.04 * s.upg);
  const ultra = rod.special?.kind === 'abismo' ? rod.special.ultraMult : 1;
  const echo = rod.special?.kind === 'eco' ? rod.special.chance : 0;
  const ev = expectedRoll(cfg, s.lvl, luck, ultra);
  const lines = rod.lines;
  const vig = castVigorCost(cfg, lines);
  const bp = baitPrice(cfg, s.lvl);
  const baitCostPerRoll = bp * (1 - rod.baitSave);
  const netPerRoll = ev.coins * (1 + echo) - baitCostPerRoll;
  const fishNet = (netPerRoll * lines) / vig;
  const farm = farmPerVigor(cfg, s.zone, s.tool, s.acc).perVigor;
  const perHour = fishNet * vigorPerHour * (1 + 0.08 * Math.min(8, s.upg));
  rows.push({ lvl: s.lvl, fishNet, farm, perHour });
  console.log([s.lvl, rod.name, luck.toFixed(2), n(ev.coins), n(ev.xp), `${bp}/u`, fishNet.toFixed(1), farm.toFixed(1), (fishNet / farm).toFixed(2), n(perHour)].join(' | '));
}

console.log('\n═══ 3. Horas de juego (solo pescando, vigor natural) para pagar cada caña ═══');
let acc = 0;
for (const rod of cfg.fishing.rods.slice(1)) {
  const stage = [...rows].reverse().find((r) => r.lvl <= rod.fishLevel) ?? rows[0];
  acc += rod.price;
  console.log(`${rod.name.padEnd(26)} ${n(rod.price).padStart(10)}  → ~${(rod.price / stage.perHour).toFixed(1)} h al ritmo de nivel ${stage.lvl} (acumulado ${n(acc)})`);
}

console.log('\n═══ 4. XP necesaria (curva) ═══');
let total = 0;
const marks = new Set([10, 20, 36, 58, 80, 100]);
for (let l = 1; l < cfg.tuning.progression.maxLevel; l++) {
  total += xpToNext(cfg, l);
  if (marks.has(l + 1)) {
    const st = [...stages].reverse().find((s) => s.lvl <= l) ?? stages[0];
    const rod = cfg.fishing.rods.find((r) => r.id === st.rod)!;
    const ev = expectedRoll(cfg, st.lvl, Math.min(cfg.tuning.fish.maxLuck, rod.luck + 0.04 * st.upg));
    const xpPerHour = ev.xp * rod.lines / castVigorCost(cfg, rod.lines) * vigorPerHour;
    console.log(`nivel ${l + 1}: ${n(total)} XP acumulada · el tramo actual rinde ~${n(xpPerHour)} XP/h`);
  }
}

console.log('\n═══ 5. Carnada ═══');
const f0 = farmPerVigor(cfg, 0, 0, 0);
console.log(`Farmear la Huerta da ${f0.baitPerFarm} carnada por cosecha (${(f0.baitPerFarm / cfg.farming.zones[0].vigorCost).toFixed(3)} por vigor).`);
console.log(`Pescar con 1 línea gasta 1 carnada cada ${castVigorCost(cfg, 1)} de vigor (${(1 / castVigorCost(cfg, 1)).toFixed(3)} por vigor).`);
console.log('→ la granja sola no alcanza para pescar sin parar: la carnada hay que comprarla o ganarla (recurso con valor real).');

const rarityLabel = (r: Rarity) => cfg.rarities[r].label;
void rarityLabel;

console.log('\n═══ 6. Sin límite de clics: ¿cuánto rinde cada carnada? ═══');
for (const s of stages) {
  const rod = cfg.fishing.rods.find((r) => r.id === s.rod)!;
  const ev = expectedRoll(cfg, s.lvl, Math.min(cfg.tuning.fish.maxLuck, rod.luck + 0.04 * s.upg));
  const bp = baitPrice(cfg, s.lvl);
  console.log(`nivel ${s.lvl}: pez esperado ${n(ev.coins)} vs carnada ${bp} → ganancia ${n(ev.coins - bp * (1 - rod.baitSave))} por tiro (antes de que baje el precio por saturación del mercado)`);
}
console.log('Sin espera ni vigor, el ingreso por hora depende de cuánto clickee cada uno: lo que lo frena es la demanda');
console.log('del mercado (vender mucho del mismo pez baja su precio) y los topes diarios de actividad.');

console.log('\n═══ 7. Logros y actividad ═══');
const achCoins = cfg.achievements.reduce((s, a) => s + (a.reward.coins ?? 0), 0);
const achAct = cfg.achievements.reduce((s, a) => s + a.activity, 0);
console.log(`${cfg.achievements.length} logros · ${n(achCoins)} monedas en total (pago único) · ${n(achAct)} puntos de actividad.`);
const late = rows[rows.length - 1];
console.log(`Todos los logros juntos equivalen a ~${(achCoins / late.perHour).toFixed(1)} h de pesca de nivel ${late.lvl}: premian, no reemplazan el juego.`);
const t = cfg.tuning.activity;
console.log(`Actividad diaria máxima (sin logros): ${t.dailyCapTotal} pts. Pesca ${t.dailyCapFish} · granja ${t.dailyCapFarm} · comercio ${t.dailyCapTrade}.`);
console.log(`Para llegar al tope de pesca hacen falta ${Math.ceil(t.dailyCapFish / t.fishPoints)} pescas reales (cada una con espera, vigor y carnada).`);

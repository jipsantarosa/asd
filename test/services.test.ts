import { leaderboard, playerCount, rankOf } from '../src/services/leaderboard';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runMigrations } from '../src/db/migrations';
import { createContext, GameError } from '../src/services/context';
import { getCoins, addCoins } from '../src/services/economy';
import { farm, setFarmZone } from '../src/services/farming';
import { gameConfig, getSettings, resetTunable, setPrefix, setTunable } from '../src/services/guildSettings';
import { addItem, getQty } from '../src/services/inventory';
import { planSetup, LOG_CHANNELS, type ExistingChannel, type LogConfig } from '../src/services/logConfig';
import { buyEquipment, buyUnlock, buyUpgrade, quoteSell, sellBulk, sellItem } from '../src/services/market';
import { ensureProfile, getEquipTiers, getProfile, isUnlocked, vigorState, getUpgradeLevels } from '../src/services/player';
import { addXp, levelGapMultiplier, xpToNext } from '../src/services/progression';
import { useConsumable } from '../src/services/consumables';
import { addRolesToGroup, createGroup, getGroup, listGroups } from '../src/services/roles';
import { RateLimiter } from '../src/services/antispam';
import { getItem } from '../src/game/config';
import { G, U, U2, makeWorld, seeded } from './helpers';

function expectGameError(fn: () => unknown, re?: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));
}

function setLevel(w: ReturnType<typeof makeWorld>, farm: number, fish: number): void {
  w.ctx.db.run('UPDATE profiles SET farm_level = ?, fish_level = ? WHERE guild_id = ? AND user_id = ?', farm, fish, G, U);
}

describe('base de datos y configuración', () => {
  it('las migraciones son idempotentes', () => {
    const w = makeWorld();
    assert.deepEqual(runMigrations(w.ctx.db), []);
  });

  it('el prefijo persiste tras un "reinicio" (contexto nuevo sobre la misma BD)', () => {
    const w = makeWorld();
    assert.equal(getSettings(w.ctx, G).prefix, '!');
    setPrefix(w.ctx, G, '?v');
    const restarted = createContext({ db: w.ctx.db, baseConfig: w.ctx.baseConfig });
    assert.equal(getSettings(restarted, G).prefix, '?v');
    expectGameError(() => setPrefix(w.ctx, G, 'con espacio'));
    expectGameError(() => setPrefix(w.ctx, G, '@@'));
    expectGameError(() => setPrefix(w.ctx, G, 'demasiado'));
  });

  it('los ajustes por servidor se validan y aplican', () => {
    const w = makeWorld();
    setTunable(w.ctx, G, 'farm.cooldownSeconds', 20);
    assert.equal(gameConfig(w.ctx, G).tuning.farm.cooldownSeconds, 20);
    assert.equal(gameConfig(w.ctx, 'otro').tuning.farm.cooldownSeconds, 6);
    expectGameError(() => setTunable(w.ctx, G, 'farm.cooldownSeconds', -5));
    expectGameError(() => setTunable(w.ctx, G, 'clave.inventada', 1));
    resetTunable(w.ctx, G, 'all');
    assert.equal(gameConfig(w.ctx, G).tuning.farm.cooldownSeconds, 6);
  });
});

describe('perfil y economía', () => {
  it('crea el perfil con kit inicial una sola vez', () => {
    const w = makeWorld();
    ensureProfile(w.ctx, G, U);
    ensureProfile(w.ctx, G, U);
    assert.equal(getCoins(w.ctx, G, U), 150);
    assert.equal(getQty(w.ctx, G, U, 'lombriz'), 25);
  });

  it('el saldo nunca queda negativo', () => {
    const w = makeWorld();
    ensureProfile(w.ctx, G, U);
    expectGameError(() => addCoins(w.ctx, G, U, -151, 'test'), /No te alcanza/);
    assert.equal(getCoins(w.ctx, G, U), 150);
  });

  it('los perfiles están aislados por servidor', () => {
    const w = makeWorld();
    ensureProfile(w.ctx, G, U);
    addCoins(w.ctx, G, U, 1000, 'test');
    ensureProfile(w.ctx, 'otro-servidor', U);
    assert.equal(getCoins(w.ctx, 'otro-servidor', U), 150);
  });
});

describe('granja', () => {
  it('farmear da cultivos, XP y consume vigor', () => {
    const w = makeWorld();
    const r = farm(w.ctx, G, U);
    assert.ok(r.drops.length > 0);
    assert.ok(r.gain.amount > 0);
    const p = getProfile(w.ctx, G, U)!;
    assert.equal(Math.round(p.vigor), 100 - r.vigorCost);
  });

  it('un doble clic no cosecha dos veces (cooldown atómico) y no cobra vigor extra', () => {
    const w = makeWorld();
    farm(w.ctx, G, U);
    const before = getProfile(w.ctx, G, U)!;
    expectGameError(() => farm(w.ctx, G, U), /disponible/);
    const after = getProfile(w.ctx, G, U)!;
    assert.equal(after.vigor, before.vigor);
    assert.equal(after.farms_total, 1);
  });

  it('sin vigor no se puede farmear y el error indica cuándo', () => {
    const w = makeWorld();
    ensureProfile(w.ctx, G, U);
    w.ctx.db.run('UPDATE profiles SET vigor = 3, vigor_updated_at = ? WHERE guild_id = ? AND user_id = ?', w.clock.t, G, U);
    assert.throws(() => farm(w.ctx, G, U), (e: unknown) => e instanceof GameError && !!e.readyAt && e.readyAt > w.clock.t);
  });

  it('el vigor se regenera con el tiempo hasta el máximo', () => {
    const w = makeWorld();
    const p = ensureProfile(w.ctx, G, U);
    w.ctx.db.run('UPDATE profiles SET vigor = 0, vigor_updated_at = ? WHERE guild_id = ? AND user_id = ?', w.clock.t, G, U);
    const cfg = gameConfig(w.ctx, G);
    w.clock.advance(cfg.tuning.vigor.regenSeconds * 1000 * 10);
    const st = vigorState(cfg, getProfile(w.ctx, G, U)!, getUpgradeLevels(w.ctx, G, U), w.clock.t);
    assert.equal(Math.round(st.current), 10);
    w.clock.advance(1e9);
    assert.equal(vigorState(cfg, getProfile(w.ctx, G, U)!, getUpgradeLevels(w.ctx, G, U), w.clock.t).current, 100);
    void p;
  });

  it('no se puede elegir una zona bloqueada', () => {
    const w = makeWorld();
    ensureProfile(w.ctx, G, U);
    expectGameError(() => setFarmZone(w.ctx, G, U, 'invernadero'), /bloqueada/);
    expectGameError(() => setFarmZone(w.ctx, G, U, 'zona_falsa'), /no existe/);
  });

  it('el cansancio reduce el rendimiento al farmear en exceso', () => {
    const w = makeWorld();
    setTunable(w.ctx, G, 'fatigue.threshold', 5);
    setTunable(w.ctx, G, 'vigor.base', 1000);
    ensureProfile(w.ctx, G, U);
    w.ctx.db.run('UPDATE profiles SET vigor = 1000 WHERE guild_id = ? AND user_id = ?', G, U);
    let last = 1;
    for (let i = 0; i < 15; i++) {
      last = farm(w.ctx, G, U).fatigueMult;
      w.clock.advance(6000);
    }
    assert.ok(last < 1, `esperaba penalización, obtuve ${last}`);
  });
});

describe('progresión', () => {
  it('la curva de XP es estrictamente creciente', () => {
    const w = makeWorld();
    const cfg = gameConfig(w.ctx, G);
    for (let l = 1; l < 100; l++) assert.ok(xpToNext(cfg, l + 1) > xpToNext(cfg, l));
  });

  it('respeta el nivel máximo y no acumula XP después', () => {
    const w = makeWorld();
    const p = ensureProfile(w.ctx, G, U);
    const g1 = addXp(w.ctx, p, 'granja', 1e12);
    assert.equal(g1.level, 100);
    assert.equal(g1.xp, 0);
    assert.ok(g1.levelUp?.reachedMax);
    const g2 = addXp(w.ctx, p, 'granja', 5000);
    assert.equal(g2.amount, 0);
    assert.equal(getProfile(w.ctx, G, U)!.farm_level, 100);
  });

  it('subir de nivel otorga monedas', () => {
    const w = makeWorld();
    const p = ensureProfile(w.ctx, G, U);
    const cfg = gameConfig(w.ctx, G);
    const g = addXp(w.ctx, p, 'pesca', xpToNext(cfg, 1));
    assert.equal(g.level, 2);
    assert.equal(getCoins(w.ctx, G, U), 150 + 2 * cfg.tuning.progression.levelUpCoinsPerLevel);
  });

  it('las zonas muy inferiores dan menos XP', () => {
    const w = makeWorld();
    const cfg = gameConfig(w.ctx, G);
    assert.equal(levelGapMultiplier(cfg, 5, 1), 1);
    assert.ok(levelGapMultiplier(cfg, 40, 1) < 0.5);
    assert.ok(levelGapMultiplier(cfg, 99, 1) >= cfg.tuning.progression.levelGapFloor);
  });
});

describe('mercado', () => {
  it('comprar equipo exige nivel y dinero, y un doble clic no compra dos tiers', () => {
    const w = makeWorld();
    ensureProfile(w.ctx, G, U);
    expectGameError(() => buyEquipment(w.ctx, G, U, 'herramienta'), /requiere nivel/);
    setLevel(w, 20, 1);
    addCoins(w.ctx, G, U, 100_000, 'test');
    buyEquipment(w.ctx, G, U, 'herramienta');
    expectGameError(() => buyEquipment(w.ctx, G, U, 'herramienta'), /disponible/);
    assert.equal(getEquipTiers(w.ctx, G, U).herramienta, 1);
    assert.equal(getCoins(w.ctx, G, U), 100_150 - 1500);
  });

  it('desbloquear una zona exige nivel, herramienta, monedas y reliquias', () => {
    const w = makeWorld();
    ensureProfile(w.ctx, G, U);
    setLevel(w, 25, 1);
    addCoins(w.ctx, G, U, 1_000_000, 'test');
    expectGameError(() => buyUnlock(w.ctx, G, U, 'zona', 'terrazas'), /necesitás/i);
    buyEquipment(w.ctx, G, U, 'herramienta');
    w.clock.advance(2000);
    buyEquipment(w.ctx, G, U, 'herramienta');
    w.clock.advance(2000);
    expectGameError(() => buyUnlock(w.ctx, G, U, 'zona', 'terrazas'), /Semilla de ámbar/);
    addItem(w.ctx, G, U, 'semilla_ambar', 1);
    buyUnlock(w.ctx, G, U, 'zona', 'terrazas');
    assert.ok(isUnlocked(w.ctx, G, U, 'zona', 'terrazas'));
    assert.equal(getQty(w.ctx, G, U, 'semilla_ambar'), 0);
    assert.equal(getProfile(w.ctx, G, U)!.farm_zone, 'terrazas');
    w.clock.advance(2000);
    expectGameError(() => buyUnlock(w.ctx, G, U, 'zona', 'terrazas'), /Ya tenés/);
  });

  it('las mejoras escalan en costo y requisito', () => {
    const w = makeWorld();
    ensureProfile(w.ctx, G, U);
    expectGameError(() => buyUpgrade(w.ctx, G, U, 'vigor_max'), /nivel total/);
    setLevel(w, 10, 10);
    addCoins(w.ctx, G, U, 1_000_000, 'test');
    buyUpgrade(w.ctx, G, U, 'vigor_max');
    assert.equal(getUpgradeLevels(w.ctx, G, U).vigor_max, 1);
    const cfg = gameConfig(w.ctx, G);
    assert.equal(vigorState(cfg, getProfile(w.ctx, G, U)!, getUpgradeLevels(w.ctx, G, U), w.clock.t).max, 110);
  });

  it('vender mucho del mismo objeto baja el precio y la demanda se recupera', () => {
    const w = makeWorld();
    ensureProfile(w.ctx, G, U);
    addItem(w.ctx, G, U, 'zanahoria', 20_000);
    const item = getItem(gameConfig(w.ctx, G), 'zanahoria')!;
    const fresh = quoteSell(w.ctx, G, U, item, 100).total;
    sellItem(w.ctx, G, U, 'zanahoria', 5000);
    const saturated = quoteSell(w.ctx, G, U, item, 100).total;
    assert.ok(saturated < fresh * 0.8, `${saturated} vs ${fresh}`);
    w.clock.advance(48 * 3_600_000);
    assert.ok(quoteSell(w.ctx, G, U, item, 100).total >= fresh * 0.97);
  });

  it('la venta en lote nunca vende reliquias ni cebos', () => {
    const w = makeWorld();
    ensureProfile(w.ctx, G, U);
    addItem(w.ctx, G, U, 'papa', 10);
    addItem(w.ctx, G, U, 'semilla_lunar', 1);
    sellBulk(w.ctx, G, U, 'comunes');
    assert.equal(getQty(w.ctx, G, U, 'papa'), 0);
    assert.equal(getQty(w.ctx, G, U, 'semilla_lunar'), 1);
    assert.equal(getQty(w.ctx, G, U, 'lombriz'), 25);
  });

  it('no se puede vender más de lo que se tiene', () => {
    const w = makeWorld();
    ensureProfile(w.ctx, G, U);
    addItem(w.ctx, G, U, 'papa', 3);
    expectGameError(() => sellItem(w.ctx, G, U, 'papa', 4), /Solo tenés/);
    expectGameError(() => sellItem(w.ctx, G, U, 'mate', 1), /no se puede vender/);
    assert.equal(getQty(w.ctx, G, U, 'papa'), 3);
  });
});

describe('consumibles', () => {
  it('respeta el límite diario y se reinicia al día siguiente', () => {
    const w = makeWorld();
    ensureProfile(w.ctx, G, U);
    setLevel(w, 5, 5);
    addItem(w.ctx, G, U, 'mate', 10);
    for (let i = 0; i < 4; i++) {
      w.ctx.db.run('UPDATE profiles SET vigor = 0, vigor_updated_at = ? WHERE guild_id = ? AND user_id = ?', w.clock.t, G, U);
      useConsumable(w.ctx, G, U, 'mate');
    }
    w.ctx.db.run('UPDATE profiles SET vigor = 0 WHERE guild_id = ? AND user_id = ?', G, U);
    expectGameError(() => useConsumable(w.ctx, G, U, 'mate'), /Límite diario/);
    assert.equal(getQty(w.ctx, G, U, 'mate'), 8); // 2 del kit + 10 - 4 usados
    w.clock.advance(86_400_000);
    w.ctx.db.run('UPDATE profiles SET vigor = 0, vigor_updated_at = ? WHERE guild_id = ? AND user_id = ?', w.clock.t, G, U);
    useConsumable(w.ctx, G, U, 'mate');
  });

  it('no gasta el objeto si el vigor ya está lleno', () => {
    const w = makeWorld();
    ensureProfile(w.ctx, G, U);
    setLevel(w, 5, 5);
    expectGameError(() => useConsumable(w.ctx, G, U, 'mate'), /máximo/);
    assert.equal(getQty(w.ctx, G, U, 'mate'), 2);
  });
});

describe('roles', () => {
  it('los grupos están aislados por servidor (IDs manipulados no cruzan servidores)', () => {
    const w = makeWorld();
    const g = createGroup(w.ctx, G, 'Colores', 'Elegí tu color', 0);
    addRolesToGroup(w.ctx, G, g.id, ['300000000000000001', 'no-es-un-id']);
    assert.deepEqual(getGroup(w.ctx, G, g.id).roles, ['300000000000000001']);
    expectGameError(() => getGroup(w.ctx, 'otro', g.id), /no existe/);
    assert.equal(listGroups(w.ctx, 'otro').length, 0);
  });
});

describe('planificador de /setup', () => {
  const empty: LogConfig = { categoryId: null, staffRoleId: null, logSentMessages: true, channels: {} };

  it('servidor limpio: crea categoría y todos los canales', () => {
    const plan = planSetup(empty, []);
    assert.equal(plan.category.kind, 'create');
    assert.ok(plan.steps.every((s) => s.kind === 'create'));
    assert.equal(plan.steps.length, LOG_CHANNELS.length);
  });

  it('configuración intacta: no crea nada (sin duplicados al repetir /setup)', () => {
    const existing: ExistingChannel[] = [{ id: 'cat', name: '📋 Registros', type: 'category', parentId: null }];
    const channels: LogConfig['channels'] = {};
    LOG_CHANNELS.forEach((c, i) => {
      existing.push({ id: `c${i}`, name: c.name, type: 'text', parentId: 'cat' });
      channels[c.key] = `c${i}`;
    });
    const plan = planSetup({ ...empty, categoryId: 'cat', channels }, existing);
    assert.equal(plan.category.kind, 'keep');
    assert.ok(plan.steps.every((s) => s.kind === 'keep'));
  });

  it('canal borrado se recrea, canal movido se reubica, canal renombrado se conserva por ID', () => {
    const existing: ExistingChannel[] = [
      { id: 'cat', name: '📋 Registros', type: 'category', parentId: null },
      { id: 'c1', name: 'renombrado-por-alguien', type: 'text', parentId: 'cat' },
      { id: 'c2', name: '🗑️・eliminados', type: 'text', parentId: 'otra-categoria' },
    ];
    const plan = planSetup({ ...empty, categoryId: 'cat', channels: { mensajes: 'c1', eliminados: 'c2', adjuntos: 'borrado' } }, existing);
    const byKey = Object.fromEntries(plan.steps.map((s) => [s.key, s.kind]));
    assert.equal(byKey.mensajes, 'keep');
    assert.equal(byKey.eliminados, 'reparent');
    assert.equal(byKey.adjuntos, 'create');
  });

  it('si se perdió la BD, adopta canales existentes por nombre dentro de la categoría', () => {
    const existing: ExistingChannel[] = [
      { id: 'cat', name: '📋 Registros', type: 'category', parentId: null },
      { id: 'x', name: '🔨・baneos', type: 'text', parentId: 'cat' },
      { id: 'y', name: '🔨・baneos', type: 'text', parentId: null },
    ];
    const plan = planSetup(empty, existing);
    assert.deepEqual(plan.category, { kind: 'adopt', id: 'cat' });
    assert.deepEqual(plan.steps.find((s) => s.key === 'baneos'), { kind: 'adopt', key: 'baneos', channelId: 'x' });
  });

  it('dos claves apuntando al mismo canal no comparten canal', () => {
    const existing: ExistingChannel[] = [
      { id: 'cat', name: '📋 Registros', type: 'category', parentId: null },
      { id: 'dup', name: 'x', type: 'text', parentId: 'cat' },
    ];
    const plan = planSetup({ ...empty, categoryId: 'cat', channels: { mensajes: 'dup', eliminados: 'dup' } }, existing);
    const kinds = plan.steps.filter((s) => s.key === 'mensajes' || s.key === 'eliminados').map((s) => s.kind);
    assert.deepEqual(kinds, ['keep', 'create']);
  });
});

describe('antispam', () => {
  it('limita ráfagas y marca abuso reiterado una sola vez', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    const results: string[] = [];
    for (let i = 0; i < 20; i++) results.push(rl.check('u', 5, 10_000, 3));
    assert.equal(results.filter((r) => r === 'ok').length, 5);
    assert.equal(results.filter((r) => r === 'flag').length, 1);
    t += 11_000;
    assert.equal(rl.check('u', 5, 10_000, 3), 'ok');
  });
});

describe('ranking', () => {
  it('ordena por categoría, desempata por XP, ignora a quien no jugó y aísla servidores', () => {
    const w = makeWorld();
    const set = (u: string, farm: number, fish: number, xp: number, coins: number) => {
      ensureProfile(w.ctx, G, u);
      w.ctx.db.run('UPDATE profiles SET farm_level = ?, fish_level = ?, farm_xp = ?, coins = ?, farms_total = 1 WHERE guild_id = ? AND user_id = ?', farm, fish, xp, coins, G, u);
    };
    const U3 = '200000000000000004';
    set(U, 10, 5, 0, 100);
    set(U2, 7, 8, 50, 900);
    set(U3, 1, 1, 0, 5000);
    ensureProfile(w.ctx, G, '200000000000000005'); // nunca jugó
    ensureProfile(w.ctx, '100000000000000009', '200000000000000006');
    w.ctx.db.run('UPDATE profiles SET farms_total = 1, farm_level = 99 WHERE user_id = ?', '200000000000000006');

    const total = leaderboard(w.ctx, G, 'total');
    assert.deepEqual(total.map((e) => e.userId), [U2, U, U3]); // U y U2 empatan en 15: gana más XP
    assert.equal(total[0].rank, 1);
    assert.deepEqual(leaderboard(w.ctx, G, 'monedas').map((e) => e.userId), [U3, U2, U]);
    assert.equal(rankOf(w.ctx, G, U3, 'granja')!.rank, 3);
    assert.equal(rankOf(w.ctx, G, '200000000000000005', 'total'), null);
    assert.equal(playerCount(w.ctx, G), 3);
    assert.throws(() => leaderboard(w.ctx, G, 'coins; DROP TABLE profiles'));
  });
});

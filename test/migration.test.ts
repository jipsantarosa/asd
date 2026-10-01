import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MIGRATIONS, runMigrations } from '../src/db/migrations';
import { DEFAULT_CONFIG } from '../src/game/defaults';
import { createContext } from '../src/services/context';
import { fishingLoadout, ownedRodIds } from '../src/services/fishing';
import { getQty } from '../src/services/inventory';
import { memoryDb, seeded } from './helpers';

const G = '100000000000000001';
const A = '200000000000000010';
const B = '200000000000000011';

describe('migración 2: datos de la pesca anterior', () => {
  it('convierte cañas viejas, reintegra carretes y permisos, y no toca lo demás', () => {
    const db = memoryDb();
    // Base "vieja": solo la migración 1, con datos de jugadores.
    db.transaction(() => {
      db.exec(MIGRATIONS[0].sql);
      db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
      db.run('INSERT INTO schema_migrations VALUES (1, ?, 0)', MIGRATIONS[0].name);
    });
    const insertProfile = (u: string, coins: number) => db.run(
      `INSERT INTO profiles (guild_id, user_id, coins, vigor, vigor_updated_at, fatigue_updated_at, farm_zone, fish_spot, bait_id, created_at, updated_at)
       VALUES (?, ?, ?, 100, 0, 0, 'huerta', 'lago', 'cebo_maiz', 0, 0)`, G, u, coins);
    insertProfile(A, 1000);
    insertProfile(B, 50);
    db.run("INSERT INTO equipment VALUES (?, ?, 'cana', 3), (?, ?, 'carrete', 2), (?, ?, 'herramienta', 2)", G, A, G, A, G, A);
    db.run("INSERT INTO unlocks VALUES (?, ?, 'lugar:lago', 0), (?, ?, 'lugar:fosa_abisal', 0), (?, ?, 'zona:invernadero', 0)", G, A, G, A, G, A);
    db.run("INSERT INTO inventory VALUES (?, ?, 'trucha_arcoiris', 4)", G, A);
    db.run("INSERT INTO fish_log VALUES (?, ?, 'trucha_arcoiris', 4, 2, 0), (?, ?, 'celacanto', 1, 40, 0)", G, A, G, A);
    db.run("INSERT INTO ledger (guild_id, user_id, delta, balance, reason, created_at) VALUES (?, ?, 300, 300, 'venta 10x papa', 0), (?, ?, -2500, 0, 'equipo herramienta t1', 0)", G, A, G, A);
    db.run("INSERT INTO role_rewards VALUES (?, '900000000000000001', 'pesca', 10)", G);

    assert.deepEqual(runMigrations(db, 0), [2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(runMigrations(db, 0), [], 'idempotente');

    const ctx = createContext({ db, baseConfig: structuredClone(DEFAULT_CONFIG), now: () => 1_750_000_000_000, rng: seeded(1) });
    // Caña tier 3 → coral (y las anteriores); la migración 3 suma las cañas nuevas que quedaron por debajo.
    assert.deepEqual([...ownedRodIds(ctx, G, A)].sort(), ['boya_roja', 'coral', 'corcho', 'junco', 'sauce', 'tejedora']);
    assert.equal(fishingLoadout(ctx, G, A).rod.id, 'coral');
    // Reintegros: carrete t2 (22.500) + lago (3.000) + fosa (480.000)
    const coins = db.get<{ coins: number }>('SELECT coins FROM profiles WHERE user_id = ?', A)!.coins;
    assert.equal(coins, 1000 + 22_500 + 3_000 + 480_000);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ledger WHERE user_id = ? AND reason LIKE 'reintegro%'", A)!.n, 3, 'cada reintegro queda en el libro contable');
    assert.equal(getQty(ctx, G, A, 'mapa_corrientes'), 1, 'se devuelve el mapa usado para la fosa');
    // Lo que no es de pesca queda intacto
    assert.equal(getQty(ctx, G, A, 'trucha_arcoiris'), 4);
    assert.ok(db.get("SELECT 1 FROM unlocks WHERE user_id = ? AND unlock_id = 'zona:invernadero'", A));
    assert.equal(db.get<{ tier: number }>("SELECT tier FROM equipment WHERE user_id = ? AND slot = 'herramienta'", A)!.tier, 2);
    // Migración 3: estadísticas reconstruidas para los logros de los veteranos
    const stat = (k: string) => db.get<{ value: number }>('SELECT value FROM player_stats WHERE user_id = ? AND stat = ?', A, k)?.value ?? 0;
    assert.equal(stat('stat:rare_caught'), 5, '4 truchas + 1 celacanto');
    assert.equal(stat('stat:legend_caught'), 1);
    assert.equal(stat('stat:coins_from_sales'), 300);
    assert.equal(stat('stat:coins_spent'), 2500);
    // Las distinciones existentes se conservan y ahora aceptan "actividad"
    assert.equal(db.get<{ skill: string }>("SELECT skill FROM role_rewards WHERE role_id = '900000000000000001'")!.skill, 'pesca');
    db.run("INSERT INTO role_rewards VALUES (?, '900000000000000002', 'actividad', 5000)", G);
    assert.equal(db.get<{ activity_points: number }>('SELECT activity_points FROM profiles WHERE user_id = ?', A)!.activity_points, 0);
    // Un jugador sin nada de pesca queda con la caña inicial y el mismo saldo
    assert.equal(fishingLoadout(ctx, G, B).rod.id, 'junco');
    assert.equal(db.get<{ coins: number }>('SELECT coins FROM profiles WHERE user_id = ?', B)!.coins, 50);
  });
});

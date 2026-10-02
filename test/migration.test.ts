import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MIGRATIONS, runMigrations } from '../src/db/migrations';
import { ensureCasinoUser, getBalance, ledgerAudit } from '../src/casino/economy';
import { DEFAULT_CASINO } from '../src/casino/config';
import { createContext } from '../src/services/context';
import { memoryDb } from './helpers';

const G = '100000000000000001';
const G2 = '100000000000000002';
const A = '200000000000000010';
const B = '200000000000000011';
const C = '200000000000000012';

describe('migraciones', () => {
  it('una base vieja (con granja) sube hasta el casino sin perder datos y es idempotente', () => {
    const db = memoryDb();
    // Base "vieja": solo la migración 1, con jugadores de la granja en dos servidores.
    db.transaction(() => {
      db.exec(MIGRATIONS[0].sql);
      db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
      db.run('INSERT INTO schema_migrations VALUES (1, ?, 0)', MIGRATIONS[0].name);
    });
    const insertProfile = (g: string, u: string, coins: number) => db.run(
      `INSERT INTO profiles (guild_id, user_id, coins, vigor, vigor_updated_at, fatigue_updated_at, farm_zone, fish_spot, bait_id, created_at, updated_at)
       VALUES (?, ?, ?, 100, 0, 0, 'huerta', 'lago', 'cebo_maiz', 0, 0)`, g, u, coins);
    insertProfile(G, A, 1_000_000);
    insertProfile(G2, A, 500_000);
    insertProfile(G, B, 5_000_000);
    insertProfile(G, C, 50);
    db.run("INSERT INTO inventory VALUES (?, ?, 'trucha_arcoiris', 4)", G, A);

    const all = MIGRATIONS.map((m) => m.id).sort((a, b) => a - b).slice(1);
    assert.deepEqual(runMigrations(db, 0), all);
    assert.deepEqual(runMigrations(db, 0), [], 'idempotente');

    // Nada de la granja se borra: los datos quedan, aunque ya no se usen.
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM profiles')!.n, 4);
    assert.equal(db.get<{ quantity: number }>('SELECT quantity FROM inventory WHERE user_id = ?', A)!.quantity, 4);

    // Bono de bienvenida a los veteranos: 1 Coin cada 100 monedas (sumando servidores), con tope de 25.000, una sola vez.
    const ctx = createContext({ db, now: () => 1_750_000_000_000 });
    ensureCasinoUser(ctx, A);
    ensureCasinoUser(ctx, A);
    ensureCasinoUser(ctx, B);
    ensureCasinoUser(ctx, C);
    const start = DEFAULT_CASINO.startingBalance;
    assert.equal(getBalance(ctx, A), start + 15_000);
    assert.equal(getBalance(ctx, B), start + 25_000, 'tope de 25.000');
    assert.equal(getBalance(ctx, C), start, 'menos de 100 monedas no da bono');
    assert.ok(ledgerAudit(ctx).ok);
  });

  it('una base nueva aplica todas las migraciones', () => {
    const db = memoryDb();
    assert.deepEqual(runMigrations(db, 0), MIGRATIONS.map((m) => m.id).sort((a, b) => a - b));
    for (const t of ['casino_users', 'casino_wallets', 'casino_transactions', 'casino_rounds', 'casino_seeds', 'casino_tournaments', 'casino_achievements']) {
      assert.ok(db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t), `falta la tabla ${t}`);
    }
  });
});

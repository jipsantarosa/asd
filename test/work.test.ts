import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CASINO, getCasinoConfig, saveCasinoConfig } from '../src/casino/config';
import { applyTx, ensureCasinoUser, getBalance, ledgerAudit } from '../src/casino/economy';
import { setFlag, FLAG_BLOCKED } from '../src/casino/users';
import { doWork, expectedPay, jobOf, JOBS, workStatus } from '../src/casino/work';
import { GameError } from '../src/services/context';
import { G, U, makeWorld, type TestWorld } from './helpers';

const OLD = 1_600_000_000_000;
const expectGameError = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));
const HOUR = DEFAULT_CASINO.work.cooldownMinutes * 60_000;
/** Azar fijo: roll(100) = 0 → siempre sale bien; el sueldo es el mínimo. */
const lucky = (n: number) => 0 * n;
/** roll(100) = 99 → siempre sale mal (salvo los trabajos de 100 %). */
const unlucky = (n: number) => (n === 100 ? 99 : 0);

describe('!work', () => {
  it('conserva los 5 trabajos de siempre y suma trabajos nuevos', () => {
    for (const n of ['Pedidos Ya', 'pedidosya', 'cirujeando', 'Vender informes', 'verdulero', 'hacker']) assert.ok(jobOf(n), n);
    for (const n of ['plomero', 'DJ de fiestas', 'cazatesoros', 'revendedor', 'paseador', 'lavacoches']) assert.ok(jobOf(n), n);
    assert.ok(JOBS.length >= 10);
    assert.equal(jobOf('astronauta'), null);
  });

  it('del más barato al más caro: más sueldo, menos probabilidad y más fianza', () => {
    for (let i = 1; i < JOBS.length; i++) {
      const a = JOBS[i - 1];
      const b = JOBS[i];
      assert.ok(b.max >= a.max, `${b.name} paga al menos lo que ${a.name}`);
      assert.ok(b.chance <= a.chance, `${b.name} es más arriesgado que ${a.name}`);
      assert.ok(b.bail >= a.bail, `${b.name} pide más fianza que ${a.name}`);
      assert.ok(expectedPay(b) > expectedPay(a), `${b.name} rinde más en promedio que ${a.name}`);
    }
    // Los seguros no piden fianza; los caros sí.
    assert.ok(JOBS.filter((j) => j.risk === 'Seguro').every((j) => j.chance === 100 && j.bail === 0));
    assert.ok(JOBS.filter((j) => j.risk === 'Arriesgado').every((j) => j.bail > 0));
  });

  it('cada trabajo tiene su propia espera de 1 hora; mientras, se pueden hacer otros', () => {
    const w = makeWorld();
    doWork(w.ctx, U, G, 'pedidosya', OLD, lucky);
    expectGameError(() => doWork(w.ctx, U, G, 'pedidosya', OLD, lucky), /vuelve a estar listo/);
    // Otros trabajos siguen disponibles.
    doWork(w.ctx, U, G, 'cirujeo', OLD, lucky);
    doWork(w.ctx, U, G, 'plomero', OLD, lucky);
    const st = workStatus(w.ctx, U);
    assert.ok(st.jobs.pedidosya > 0 && st.jobs.cirujeo > 0 && st.jobs.plomero > 0);
    assert.equal(st.jobs.hacker, 0);
    assert.equal(st.readyCount, JOBS.length - 3);
    w.clock.advance(HOUR);
    assert.ok(doWork(w.ctx, U, G, 'pedidosya', OLD, lucky).success);
  });

  it('si sale bien cobra; si sale mal pierde la fianza (nunca deja saldo negativo)', () => {
    const w = makeWorld();
    ensureCasinoUser(w.ctx, U);
    const hacker = jobOf('hacker')!;
    const before = getBalance(w.ctx, U);
    const ok = doWork(w.ctx, U, G, 'hacker', OLD, lucky);
    assert.ok(ok.success);
    assert.equal(ok.amount, hacker.min);
    assert.equal(getBalance(w.ctx, U), before + hacker.min);
    w.clock.advance(HOUR);
    const bad = doWork(w.ctx, U, G, 'hacker', OLD, unlucky);
    assert.equal(bad.success, false);
    assert.equal(bad.amount, -hacker.bail);
    // Sin la fianza no se puede tomar el trabajo.
    w.clock.advance(HOUR);
    applyTx(w.ctx, { userId: U, amount: -(getBalance(w.ctx, U) - 10), type: 'BET' });
    expectGameError(() => doWork(w.ctx, U, G, 'hacker', OLD, lucky), /fianza/);
    // Los trabajos sin fianza siempre se pueden hacer, y un fallo sin fianza no cobra ni descuenta.
    const free = doWork(w.ctx, U, G, 'paseador', OLD, unlucky);
    assert.equal(free.success, false);
    assert.equal(free.amount, 0);
    assert.equal(getBalance(w.ctx, U), 10);
    assert.ok(ledgerAudit(w.ctx).ok);
  });

  it('cupo diario de ganancias: lo que pasa del cupo no se cobra', () => {
    const w = makeWorld();
    const cfg = structuredClone(getCasinoConfig(w.ctx));
    cfg.work.dailyCap = 1_200;
    saveCasinoConfig(w.ctx, cfg, null);
    const r1 = doWork(w.ctx, U, G, 'cazatesoros', OLD, lucky);
    assert.equal(r1.amount, 1_100);
    const r2 = doWork(w.ctx, U, G, 'hacker', OLD, lucky);
    assert.equal(r2.amount, 100);
    assert.ok(r2.capped);
    assert.equal(workStatus(w.ctx, U).remaining, 0);
    expectGameError(() => doWork(w.ctx, U, G, 'cirujeo', OLD, lucky), /cupo/);
    // Al día siguiente se renueva.
    w.clock.advance(86_400_000);
    assert.ok(doWork(w.ctx, U, G, 'cirujeo', OLD, lucky).amount > 0);
  });

  it('racha de días seguidos trabajando: suma % al sueldo y se corta si salteás un día', () => {
    const w = makeWorld();
    const pct = DEFAULT_CASINO.work.streakPct;
    const day = 86_400_000;
    assert.equal(doWork(w.ctx, U, G, 'informes', OLD, lucky).status.streak, 1);
    w.clock.advance(day);
    const d2 = doWork(w.ctx, U, G, 'informes', OLD, lucky);
    assert.equal(d2.status.streak, 2);
    assert.equal(d2.amount, Math.trunc((jobOf('informes')!.min * (100 + pct)) / 100));
    w.clock.advance(2 * day);
    assert.equal(workStatus(w.ctx, U).streak, 0, 'salteó un día');
    assert.equal(doWork(w.ctx, U, G, 'informes', OLD, lucky).status.streak, 1);
  });

  it('cuentas nuevas, suspendidas o trabajos cerrados no cobran; cada turno queda registrado', () => {
    const w = makeWorld();
    expectGameError(() => doWork(w.ctx, U, G, 'pedidosya', w.clock.t - 86_400_000, lucky), /días/);
    setFlag(w.ctx, U, FLAG_BLOCKED, true);
    expectGameError(() => doWork(w.ctx, U, G, 'pedidosya', OLD, lucky), /suspendida/);
    setFlag(w.ctx, U, FLAG_BLOCKED, false);
    const cfg = structuredClone(getCasinoConfig(w.ctx));
    cfg.work.enabled = false;
    saveCasinoConfig(w.ctx, cfg, null);
    expectGameError(() => doWork(w.ctx, U, G, 'pedidosya', OLD, lucky), /cerrados/);
    cfg.work.enabled = true;
    saveCasinoConfig(w.ctx, cfg, null);
    const r = doWork(w.ctx, U, G, 'pedidosya', OLD, lucky);
    assert.equal(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM casino_transactions WHERE type = 'WORK' AND user_id = ?", U)!.n, 1);
    assert.equal(r.balance, DEFAULT_CASINO.startingBalance + r.amount);
    assert.equal(workStatus(w.ctx, U).shifts, 1);
    assert.ok(ledgerAudit(w.ctx).ok);
  });
});

describe('bonos', () => {
  it('diario de 50 con racha y semanal de 500', () => {
    assert.equal(DEFAULT_CASINO.daily.amount, 50);
    assert.equal(DEFAULT_CASINO.weekly.amount, 500);
  });
});

describe('migración 11', () => {
  it('baja los ingresos gratis de una configuración guardada y conserva el resto', async () => {
    const { memoryDb } = await import('./helpers');
    const { MIGRATIONS, runMigrations } = await import('../src/db/migrations');
    const { createContext } = await import('../src/services/context');
    const db = memoryDb();
    db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.id <= 10)) db.transaction(() => { db.exec(m.sql); db.run('INSERT INTO schema_migrations VALUES (?, ?, 0)', m.id, m.name); });
    const old = { ...structuredClone(DEFAULT_CASINO), startingBalance: 5000, daily: { amount: 1000, streakPct: 10, streakMaxDays: 10 }, weekly: { amount: 7500 } };
    old.games.slots.maxBet = 1234;
    db.run("INSERT INTO casino_config (key, value, updated_at) VALUES ('main', ?, 0)", JSON.stringify(old));
    db.run("INSERT INTO casino_users (user_id, created_at, last_active_at, updated_at) VALUES (?, 0, 0, 0)", U);
    db.run("INSERT INTO casino_wallets (user_id, currency, balance, updated_at) VALUES (?, 'coins', 50, 0)", U);
    db.run("INSERT INTO casino_transactions (tx_id, user_id, amount, balance_before, balance_after, type, created_at) VALUES ('t1', ?, 50, 0, 50, 'BONUS', 0)", U);
    assert.deepEqual(runMigrations(db, 0), [11, 12, 13, 14, 15, 16, 17, 18]);
    const ctx = createContext({ db });
    const c = getCasinoConfig(ctx);
    // La 11 bajó los bonos y la 17 los dejó en los valores pedidos (diario 50 con racha, semanal 500).
    assert.equal(c.daily.amount, 50);
    assert.equal(c.daily.streakPct, 10);
    assert.equal(c.weekly.amount, 500);
    assert.equal(c.work.cooldownMinutes, 60);
    assert.equal(c.work.dailyCap, 3000);
    assert.equal(c.startingBalance, 1000);
    assert.equal(c.games.slots.maxBet, 1234, 'lo demás se conserva');
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM casino_transactions')!.n, 1, 'los movimientos se copiaron');
    assert.ok(ledgerAudit(ctx).ok);
  });
});

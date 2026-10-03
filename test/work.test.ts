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
const COOLDOWN = DEFAULT_CASINO.work.cooldownMinutes * 60_000;
/** Azar fijo: siempre elige el primer resultado de cada trabajo (el "normal"). */
const first = (n: number) => 0 * n;

function shift(w: TestWorld, job: Parameters<typeof jobOf>[0], roll = first) {
  const r = doWork(w.ctx, U, G, jobOf(job)!.id, OLD, roll);
  w.clock.advance(COOLDOWN);
  return r;
}

describe('!work', () => {
  it('existen los 5 trabajos pedidos y se reconocen por nombre', () => {
    for (const n of ['Pedidos Ya', 'pedidosya', 'cirujeando', 'Vender informes', 'verdulero', 'hacker']) assert.ok(jobOf(n), n);
    assert.equal(JOBS.length, 5);
    assert.equal(jobOf('astronauta'), null);
  });

  it('ordenados del que menos paga al que más, y el desbloqueo sigue ese orden', () => {
    for (let i = 1; i < JOBS.length; i++) {
      assert.ok(expectedPay(JOBS[i]) > expectedPay(JOBS[i - 1]), `${JOBS[i].name} debería pagar más que ${JOBS[i - 1].name}`);
      assert.ok(JOBS[i].requires >= JOBS[i - 1].requires);
    }
    assert.equal(JOBS[JOBS.length - 1].id, 'hacker');
  });

  it('paga poco: el máximo diario esperado es chico y menor que un día de juego mínimo', () => {
    for (const j of JOBS) assert.ok(expectedPay(j) <= 80, `${j.name}: ${expectedPay(j)}`);
    const best = Math.max(...JOBS.map((j) => expectedPay(j)));
    assert.ok(best * DEFAULT_CASINO.work.maxShiftsPerDay < 400, 'un día entero trabajando da menos de 400 Coins');
  });

  it('espera compartida entre trabajos y tope de turnos por día', () => {
    const w = makeWorld();
    doWork(w.ctx, U, G, 'pedidosya', OLD, first);
    expectGameError(() => doWork(w.ctx, U, G, 'cirujeo', OLD, first), /cansado/);
    w.clock.advance(COOLDOWN);
    for (let i = 1; i < DEFAULT_CASINO.work.maxShiftsPerDay; i++) {
      // Evita cruzar al día siguiente del casino durante la prueba.
      doWork(w.ctx, U, G, 'cirujeo', OLD, first);
      w.clock.advance(COOLDOWN);
    }
    const st = workStatus(w.ctx, U);
    if (st.todayShifts >= st.maxPerDay) expectGameError(() => doWork(w.ctx, U, G, 'pedidosya', OLD, first), /turnos de hoy/);
    assert.equal(st.shifts, DEFAULT_CASINO.work.maxShiftsPerDay);
  });

  it('los mejores trabajos se desbloquean con experiencia', () => {
    const w = makeWorld();
    expectGameError(() => doWork(w.ctx, U, G, 'verdulero', OLD, first), /requiere 5 turnos/);
    expectGameError(() => doWork(w.ctx, U, G, 'hacker', OLD, first), /requiere 40/);
    let unlocked: string[] = [];
    for (let i = 0; i < 5; i++) {
      unlocked = shift(w, 'pedidosya').unlocked.map((j) => j.id);
      w.clock.advance(86_400_000);
    }
    assert.deepEqual(unlocked, ['verdulero']);
    assert.ok(shift(w, 'verdulero').amount > 0);
  });

  it('el hacker puede pagar multa, pero nunca deja saldo negativo', () => {
    const w = makeWorld();
    ensureCasinoUser(w.ctx, U);
    w.ctx.db.run('UPDATE casino_users SET work_shifts = 40 WHERE user_id = ?', U);
    const fine = (n: number) => (n === 100 ? 99 : 0); // cae en el último resultado (multa) con la multa más alta
    applyTx(w.ctx, { userId: U, amount: -(getBalance(w.ctx, U) - 30), type: 'BET' });
    const r = doWork(w.ctx, U, G, 'hacker', OLD, fine);
    assert.equal(r.kind, 'fine');
    assert.equal(r.amount, -30);
    assert.equal(getBalance(w.ctx, U), 0);
    assert.ok(ledgerAudit(w.ctx).ok);
  });

  it('cuentas nuevas, suspendidas o trabajos cerrados no cobran; cada turno queda registrado', () => {
    const w = makeWorld();
    expectGameError(() => doWork(w.ctx, U, G, 'pedidosya', w.clock.t - 86_400_000, first), /días/);
    setFlag(w.ctx, U, FLAG_BLOCKED, true);
    expectGameError(() => doWork(w.ctx, U, G, 'pedidosya', OLD, first), /suspendida/);
    setFlag(w.ctx, U, FLAG_BLOCKED, false);
    const cfg = structuredClone(getCasinoConfig(w.ctx));
    cfg.work.enabled = false;
    saveCasinoConfig(w.ctx, cfg, null);
    expectGameError(() => doWork(w.ctx, U, G, 'pedidosya', OLD, first), /cerrados/);
    cfg.work.enabled = true;
    saveCasinoConfig(w.ctx, cfg, null);
    const r = doWork(w.ctx, U, G, 'pedidosya', OLD, first);
    assert.equal(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM casino_transactions WHERE type = 'WORK' AND user_id = ?", U)!.n, 1);
    assert.equal(r.balance, DEFAULT_CASINO.startingBalance + r.amount);
    assert.ok(ledgerAudit(w.ctx).ok);
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
    assert.deepEqual(runMigrations(db, 0), [11, 12, 13]);
    const ctx = createContext({ db });
    const c = getCasinoConfig(ctx);
    assert.equal(c.daily.amount, 100);
    assert.equal(c.weekly.amount, 400);
    assert.equal(c.startingBalance, 1000);
    assert.equal(c.games.slots.maxBet, 1234, 'lo demás se conserva');
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM casino_transactions')!.n, 1, 'los movimientos se copiaron');
    assert.ok(ledgerAudit(ctx).ok);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adjustBalance, adminLog } from '../src/casino/admin';
import { ActivityGuard, decayFactor, normalizeMessage, rewardMessage, wordCount } from '../src/casino/activity';
import { claimDaily, claimRescue, claimWeekly, dailyAmount } from '../src/casino/bonus';
import { DEFAULT_CASINO, getCasinoConfig, normalizeCasino, saveCasinoConfig, setConfigNumber } from '../src/casino/config';
import { applyTx, assertCoins, ensureCasinoUser, getBalance, InsufficientFundsError, ledgerAudit, MAX_BALANCE } from '../src/casino/economy';
import { claimDrop, closeExpiredDrops, createDrop } from '../src/casino/events';
import { setActivityEnabled } from '../src/casino/guilds';
import { rankOf, topPage } from '../src/casino/leaderboard';
import { activeSeed, FairRng, reserveNonce, rngFor, rotateSeed, sha256 } from '../src/casino/rng';
import { FLAG_BLOCKED, FLAG_HIDDEN, getCasinoUser, levelFromWagered, setFlag, touchUser, wageredForLevel } from '../src/casino/users';
import { GameError } from '../src/services/context';
import { G, U, U2, makeWorld, type TestWorld } from './helpers';

const U3 = '200000000000000004';
const START = DEFAULT_CASINO.startingBalance;
const DAY = 86_400_000;
const expectGameError = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));

function audit(w: TestWorld): void {
  const a = ledgerAudit(w.ctx);
  assert.ok(a.ok, `descuadre: saldos ${a.wallets} vs transacciones ${a.ledger}`);
  assert.equal(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM casino_wallets WHERE balance < 0')!.n, 0);
}

describe('billetera y transacciones', () => {
  it('la cuenta se crea una sola vez con el saldo inicial', () => {
    const w = makeWorld();
    ensureCasinoUser(w.ctx, U);
    ensureCasinoUser(w.ctx, U);
    assert.equal(getBalance(w.ctx, U), START);
    assert.equal(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM casino_transactions WHERE type = 'STARTER'")!.n, 1);
    expectGameError(() => ensureCasinoUser(w.ctx, 'no-es-un-id'));
    audit(w);
  });

  it('valida cantidades: enteros seguros, signo correcto según el tipo', () => {
    const w = makeWorld();
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_BALANCE + 1, 2 ** 60]) {
      assert.throws(() => applyTx(w.ctx, { userId: U, amount: bad, type: 'BONUS' }));
    }
    assert.throws(() => applyTx(w.ctx, { userId: U, amount: 10, type: 'BET' }), /debe restar/);
    assert.throws(() => applyTx(w.ctx, { userId: U, amount: -10, type: 'WIN' }), /debe sumar/);
    assert.throws(() => applyTx(w.ctx, { userId: U, amount: 0, type: 'BONUS' }));
    assert.throws(() => applyTx(w.ctx, { userId: U, amount: 5, type: 'INVENTADO' as never }));
    expectGameError(() => assertCoins(-1));
    expectGameError(() => assertCoins('100' as never));
    audit(w);
  });

  it('nunca deja saldo negativo: sin fondos no cambia nada', () => {
    const w = makeWorld();
    ensureCasinoUser(w.ctx, U);
    assert.throws(() => applyTx(w.ctx, { userId: U, amount: -(START + 1), type: 'BET' }), InsufficientFundsError);
    assert.equal(getBalance(w.ctx, U), START);
    applyTx(w.ctx, { userId: U, amount: -START, type: 'BET' });
    assert.equal(getBalance(w.ctx, U), 0);
    audit(w);
  });

  it('idempotencia: la misma clave no paga dos veces y no se puede reutilizar con otros datos', () => {
    const w = makeWorld();
    const a = applyTx(w.ctx, { userId: U, amount: 500, type: 'BONUS', key: 'test:1' });
    const b = applyTx(w.ctx, { userId: U, amount: 500, type: 'BONUS', key: 'test:1' });
    assert.equal(b.replayed, true);
    assert.equal(b.txId, a.txId);
    assert.equal(getBalance(w.ctx, U), START + 500);
    assert.throws(() => applyTx(w.ctx, { userId: U2, amount: 500, type: 'BONUS', key: 'test:1' }), /reutilizada/);
    audit(w);
  });

  it('la base rechaza un movimiento que no cuadra (CHECK) aunque alguien lo intente a mano', () => {
    const w = makeWorld();
    ensureCasinoUser(w.ctx, U);
    assert.throws(() => w.ctx.db.run(
      `INSERT INTO casino_transactions (tx_id, user_id, amount, balance_before, balance_after, type, created_at) VALUES ('x', ?, 10, 0, 999, 'BONUS', 0)`, U,
    ));
    assert.throws(() => w.ctx.db.run('UPDATE casino_wallets SET balance = -1 WHERE user_id = ?', U));
  });

  it('ajustes del dueño: sumar, quitar, fijar; nunca negativo; quedan registrados', () => {
    const w = makeWorld();
    adjustBalance(w.ctx, { actorId: U2, targetId: U, mode: 'add', amount: 1_000, reason: 'premio de evento', guildId: G });
    assert.equal(getBalance(w.ctx, U), START + 1_000);
    adjustBalance(w.ctx, { actorId: U2, targetId: U, mode: 'remove', amount: 500, reason: '', guildId: G });
    adjustBalance(w.ctx, { actorId: U2, targetId: U, mode: 'set', amount: 42, reason: 'reset', guildId: G });
    assert.equal(getBalance(w.ctx, U), 42);
    expectGameError(() => adjustBalance(w.ctx, { actorId: U2, targetId: U, mode: 'remove', amount: 43, reason: '', guildId: G }), /negativo/);
    assert.equal(adminLog(w.ctx, 10, U).length, 3);
    audit(w);
  });
});

describe('configuración', () => {
  it('normaliza valores fuera de rango o de tipo incorrecto sin romperse', () => {
    const c = normalizeCasino({ startingBalance: -5, maxPayout: 'mucho', games: { slots: { minBet: 500, maxBet: 10, edgePct: 99 } }, tournaments: { daily: { metric: 'trampa', prizes: [-1, 1.5] } } });
    assert.equal(c.startingBalance, 0);
    assert.equal(c.maxPayout, DEFAULT_CASINO.maxPayout);
    assert.equal(c.games.slots.edgePct, 10);
    assert.ok(c.games.slots.maxBet >= c.games.slots.minBet);
    assert.equal(c.tournaments.daily.metric, DEFAULT_CASINO.tournaments.daily.metric);
    assert.deepEqual(c.tournaments.daily.prizes, DEFAULT_CASINO.tournaments.daily.prizes);
  });

  it('setConfigNumber valida rutas, rangos y que la mínima no supere a la máxima', () => {
    const w = makeWorld();
    setConfigNumber(w.ctx, 'games.plinko.maxBet', 5_000, U);
    assert.equal(getCasinoConfig(w.ctx).games.plinko.maxBet, 5_000);
    expectGameError(() => setConfigNumber(w.ctx, 'games.plinko.minBet', 6_000, U), /mínima/);
    expectGameError(() => setConfigNumber(w.ctx, 'games.plinko.edgePct', 50, U));
    expectGameError(() => setConfigNumber(w.ctx, 'no.existe', 1, U));
    expectGameError(() => setConfigNumber(w.ctx, 'daily.amount', 1.5, U));
  });
});

describe('azar verificable', () => {
  it('mismas semillas y nonce → mismos números; floats en [0, 1); mezcla = permutación', () => {
    const a = new FairRng('s'.repeat(64), 'cliente', 7);
    const b = new FairRng('s'.repeat(64), 'cliente', 7);
    const xs = Array.from({ length: 50 }, () => a.next());
    assert.deepEqual(xs, Array.from({ length: 50 }, () => b.next()));
    assert.ok(xs.every((x) => x >= 0 && x < 1));
    const c = new FairRng('s'.repeat(64), 'cliente', 8);
    assert.notDeepEqual(xs.slice(0, 8), Array.from({ length: 8 }, () => c.next()));
    const shuffled = new FairRng('x', 'y', 1).shuffle(Array.from({ length: 52 }, (_, i) => i));
    assert.deepEqual([...shuffled].sort((p, q) => p - q), Array.from({ length: 52 }, (_, i) => i));
    assert.throws(() => a.int(0));
  });

  it('el nonce sube con cada apuesta; rotar revela la semilla (cuyo hash es el publicado) y crea otra', () => {
    const w = makeWorld();
    const s = activeSeed(w.ctx, U);
    assert.equal(sha256(s.serverSeed), s.serverSeedHash);
    assert.equal(reserveNonce(w.ctx, U).nonce, 0);
    assert.equal(reserveNonce(w.ctx, U).nonce, 1);
    const r = rotateSeed(w.ctx, U, 'mi-semilla');
    assert.equal(r.revealed.serverSeed, s.serverSeed);
    assert.equal(r.next.clientSeed, 'mi-semilla');
    assert.equal(r.next.nonce, 0);
    assert.notEqual(r.next.serverSeedHash, s.serverSeedHash);
    expectGameError(() => rotateSeed(w.ctx, U, 'con espacios'));
    assert.equal(rngFor(r.revealed, 0).next(), new FairRng(s.serverSeed, s.clientSeed, 0).next());
  });
});

describe('niveles', () => {
  it('el nivel sale de lo apostado y la curva es creciente', () => {
    assert.equal(levelFromWagered(0), 1);
    for (let l = 1; l < 100; l++) {
      assert.equal(levelFromWagered(wageredForLevel(l)), l);
      assert.equal(levelFromWagered(wageredForLevel(l + 1) - 1), l);
      assert.ok(wageredForLevel(l + 1) > wageredForLevel(l));
    }
  });
});

describe('bonos', () => {
  it('diario: uno por día, la racha sube con días seguidos y se corta al saltear uno', () => {
    const w = makeWorld();
    const a = claimDaily(w.ctx, U, G);
    assert.equal(a.streak, 1);
    assert.equal(a.amount, DEFAULT_CASINO.daily.amount);
    expectGameError(() => claimDaily(w.ctx, U, G), /Ya cobraste/);
    w.clock.advance(DAY);
    const b = claimDaily(w.ctx, U, G);
    assert.equal(b.streak, 2);
    assert.equal(b.amount, dailyAmount(DEFAULT_CASINO.daily.amount, 2, DEFAULT_CASINO.daily.streakPct, DEFAULT_CASINO.daily.streakMaxDays));
    w.clock.advance(3 * DAY);
    assert.equal(claimDaily(w.ctx, U, G).streak, 1);
    assert.equal(dailyAmount(1000, 50, 10, 10), 2000, 'la racha tiene tope');
    audit(w);
  });

  it('semanal: cada 7 días; rescate: solo con poco saldo, sin partidas abiertas y con espera', () => {
    const w = makeWorld();
    claimWeekly(w.ctx, U, G);
    expectGameError(() => claimWeekly(w.ctx, U, G));
    w.clock.advance(7 * DAY);
    claimWeekly(w.ctx, U, G);
    expectGameError(() => claimRescue(w.ctx, U, G), /menores/);
    adjustBalance(w.ctx, { actorId: U2, targetId: U, mode: 'set', amount: 10, reason: '', guildId: G });
    const r = claimRescue(w.ctx, U, G);
    assert.equal(r.balance, 10 + DEFAULT_CASINO.rescue.amount);
    adjustBalance(w.ctx, { actorId: U2, targetId: U, mode: 'set', amount: 0, reason: '', guildId: G });
    expectGameError(() => claimRescue(w.ctx, U, G), /Ya usaste/);
    w.clock.advance(DEFAULT_CASINO.rescue.cooldownHours * 3_600_000);
    claimRescue(w.ctx, U, G);
    audit(w);
  });

  it('una cuenta suspendida no cobra bonos', () => {
    const w = makeWorld();
    setFlag(w.ctx, U, FLAG_BLOCKED, true);
    expectGameError(() => claimDaily(w.ctx, U, G), /suspendida/);
  });
});

describe('actividad (anti-farming)', () => {
  const OLD = 1_600_000_000_000;
  const msg = (w: TestWorld, id: string, content: string, user = U) => rewardMessage(w.ctx, guardOf(w), {
    userId: user, guildId: G, messageId: id, content, accountCreatedAt: OLD, memberJoinedAt: OLD,
  }, () => 10);
  const guards = new WeakMap<TestWorld, ActivityGuard>();
  const guardOf = (w: TestWorld) => {
    if (!guards.has(w)) guards.set(w, new ActivityGuard());
    return guards.get(w)!;
  };

  it('filtra mensajes cortos, sin palabras reales, repetidos y casi repetidos', () => {
    const w = makeWorld();
    assert.equal(msg(w, '1', 'hola').awarded, 0);
    assert.equal(msg(w, '2', '<@123456789012345678> https://x.com 😂😂😂').awarded, 0);
    assert.equal(msg(w, '3', 'jaja jaja jaja jaja').awarded, 0);
    assert.ok(msg(w, '4', 'hoy jugué al crash y gané bastante').awarded > 0);
    w.clock.advance(120_000);
    const dup = msg(w, '5', 'Hoy jugué al CRASH y gané bastante!!!');
    assert.equal(dup.awarded, 0);
    assert.equal('reason' in dup && dup.reason, 'duplicate');
    assert.equal(normalizeMessage('Holaaaaa   MUNDO!!'), 'holaa mundo');
    assert.equal(wordCount('a b cd ef ef'), 2);
  });

  it('respeta la espera entre recompensas, el tope diario y el rendimiento decreciente', () => {
    const w = makeWorld();
    const cfg = structuredClone(getCasinoConfig(w.ctx));
    cfg.activity.dailyCap = 25;
    saveCasinoConfig(w.ctx, cfg, null);
    assert.equal(msg(w, 'a', 'primer mensaje con varias palabras').awarded, 10);
    w.clock.advance(10_000);
    const cd = msg(w, 'b', 'segundo mensaje distinto del primero');
    assert.equal('reason' in cd && cd.reason, 'cooldown');
    w.clock.advance(60_000);
    assert.equal(msg(w, 'c', 'tercer mensaje que habla de otra cosa').awarded, 10);
    w.clock.advance(60_000);
    assert.equal(msg(w, 'd', 'cuarto mensaje bastante diferente al resto').awarded, 5, 'recorta al tope diario');
    w.clock.advance(60_000);
    const cap = msg(w, 'e', 'quinto mensaje que ya no debería pagar nada');
    assert.equal('reason' in cap && cap.reason, 'cap');
    assert.equal(decayFactor(29, 30), 1);
    assert.equal(decayFactor(30, 30), 0.5);
    assert.equal(decayFactor(60, 30), 0.25);
    audit(w);
  });

  it('cuentas nuevas, miembros recién llegados, ráfagas y servidores con la actividad apagada no cobran', () => {
    const w = makeWorld();
    const base = { userId: U, guildId: G, content: 'un mensaje normal con varias palabras', accountCreatedAt: OLD, memberJoinedAt: OLD };
    const g = new ActivityGuard();
    assert.equal(rewardMessage(w.ctx, g, { ...base, messageId: 'y', accountCreatedAt: w.clock.t - DAY }, () => 10).awarded, 0);
    assert.equal(rewardMessage(w.ctx, g, { ...base, messageId: 'z', memberJoinedAt: w.clock.t - 60_000 }, () => 10).awarded, 0);
    const burst = new ActivityGuard();
    for (let i = 0; i < 6; i++) rewardMessage(w.ctx, burst, { ...base, userId: U2, messageId: `b${i}`, content: `mensaje número ${i} con palabras distintas ${'x'.repeat(i)}` }, () => 10);
    w.clock.advance(61_000);
    const r = rewardMessage(w.ctx, burst, { ...base, userId: U2, messageId: 'b9', content: 'otro mensaje tranquilo después de la ráfaga' }, () => 10);
    assert.equal('reason' in r && r.reason, 'burst');
    setActivityEnabled(w.ctx, G, false);
    const off = rewardMessage(w.ctx, new ActivityGuard(), { ...base, userId: U3, messageId: 'o' }, () => 10);
    assert.equal('reason' in off && off.reason, 'disabled');
  });

  it('el mismo mensaje nunca paga dos veces', () => {
    const w = makeWorld();
    assert.equal(msg(w, 'same', 'un mensaje con suficientes palabras').awarded, 10);
    w.clock.advance(120_000);
    assert.equal(rewardMessage(w.ctx, new ActivityGuard(), { userId: U, guildId: G, messageId: 'same', content: 'otro texto diferente con palabras', accountCreatedAt: OLD, memberJoinedAt: OLD }, () => 10).awarded, 0);
    audit(w);
  });
});

describe('lluvia de monedas', () => {
  it('una vez por persona, hasta agotar lugares o tiempo; cuentas nuevas no cobran', () => {
    const w = makeWorld();
    const old = w.clock.t - 30 * DAY;
    const d = createDrop(w.ctx, { guildId: G, channelId: '300000000000000001', amountEach: 100, maxClaims: 2, minutes: 5, createdBy: U3 });
    claimDrop(w.ctx, d.id, U, old);
    expectGameError(() => claimDrop(w.ctx, d.id, U, old), /Ya cobraste/);
    expectGameError(() => claimDrop(w.ctx, d.id, U3, w.clock.t - DAY), /días/);
    claimDrop(w.ctx, d.id, U2, old);
    expectGameError(() => claimDrop(w.ctx, d.id, U3, old), /tarde/);
    const d2 = createDrop(w.ctx, { guildId: G, channelId: '300000000000000001', amountEach: 100, maxClaims: 5, minutes: 1, createdBy: U3 });
    w.clock.advance(61_000);
    expectGameError(() => claimDrop(w.ctx, d2.id, U3, old), /tarde/);
    assert.equal(closeExpiredDrops(w.ctx).length, 1);
    assert.equal(getBalance(w.ctx, U), START + 100);
    audit(w);
  });
});

describe('ranking', () => {
  it('ordena por saldo, desempata por antigüedad, oculta cuentas marcadas y filtra por servidor', () => {
    const w = makeWorld();
    for (const [u, extra] of [[U, 300], [U2, 300], [U3, 900]] as const) {
      ensureCasinoUser(w.ctx, u);
      applyTx(w.ctx, { userId: u, amount: extra, type: 'BONUS' });
      w.clock.advance(1000);
    }
    touchUser(w.ctx, U2, G);
    const top = topPage(w.ctx, 'richest');
    assert.deepEqual(top.rows.map((r) => r.userId), [U3, U, U2]);
    for (const r of top.rows) assert.equal(rankOf(w.ctx, 'richest', r.userId).rank, r.rank, 'el puesto personal coincide con la lista');
    assert.deepEqual(topPage(w.ctx, 'richest', { guildId: G }).rows.map((r) => r.userId), [U2]);
    assert.equal(rankOf(w.ctx, 'richest', U2, G).rank, 1);
    setFlag(w.ctx, U3, FLAG_HIDDEN, true);
    assert.deepEqual(topPage(w.ctx, 'richest').rows.map((r) => r.userId), [U, U2]);
    assert.equal(rankOf(w.ctx, 'richest', U3).rank, null);
    assert.equal(topPage(w.ctx, 'rounds').total, 0, 'quien no jugó no aparece en partidas');
    assert.ok(getCasinoUser(w.ctx, U));
  });
});

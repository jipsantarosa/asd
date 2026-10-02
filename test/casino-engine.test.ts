import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CASINO, GAME_IDS, getCasinoConfig, saveCasinoConfig, type GameId } from '../src/casino/config';
import { applyTx, ensureCasinoUser, getBalance, InsufficientFundsError, ledgerAudit } from '../src/casino/economy';
import {
  ActiveRoundError, actOnRound, claimRebet, fairSummaryOf, getRound, playInstant, refundRound, resolveStaleRound, StaleActionError, startRound, tickLiveRound,
  viewOf, type RoundView,
} from '../src/casino/engine';
import { GAMES } from '../src/casino/games';
import type { BjState } from '../src/casino/games/blackjack';
import type { CrashState } from '../src/casino/games/crash';
import { msToReach } from '../src/casino/games/crash';
import type { MinesState } from '../src/casino/games/mines';
import { hiloOdds, type HiloState } from '../src/casino/games/hilo';
import { jackpotAmount } from '../src/casino/jackpot';
import { rotateSeed } from '../src/casino/rng';
import {
  cancelTournament, createTournament, ensureAutoTournaments, finishTournament, joinTournament, standings, startTournament,
} from '../src/casino/tournaments';
import { getCasinoUser } from '../src/casino/users';
import { GameError } from '../src/services/context';
import { G, U, U2, makeWorld, seeded, type TestWorld } from './helpers';

const START = DEFAULT_CASINO.startingBalance;
const expectGameError = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));
const req = (game: GameId, bet: number, params: unknown, user = U) => ({ userId: user, guildId: G, channelId: '300000000000000001', game, bet, params });
const parse = (game: GameId, args: string[] = []) => GAMES[game].parseParams(args);

/** Invariantes de la economía: saldos = transacciones, nada negativo, y las estadísticas cuadran con las rondas. */
function audit(w: TestWorld): void {
  const a = ledgerAudit(w.ctx);
  assert.ok(a.ok, `descuadre: saldos ${a.wallets} vs transacciones ${a.ledger}`);
  const db = w.ctx.db;
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM casino_wallets WHERE balance < 0')!.n, 0);
  // Cada ronda terminada tiene exactamente un movimiento de cierre (pago, pérdida o devolución).
  const bad = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM casino_rounds r WHERE r.status <> 'active' AND
    (SELECT COUNT(*) FROM casino_transactions t WHERE t.round_id = r.id AND t.type IN ('WIN','LOSS','PUSH','REFUND')) <> 1`)!.n;
  assert.equal(bad, 0, 'rondas sin cierre único');
  // Lo apostado de cada ronda = sus débitos; lo pagado = sus créditos (sin contar el jackpot ni los logros).
  const rows = db.all<{ id: number; total_bet: number; payout: number; status: string; debits: number; credits: number; jackpot: number }>(`
    SELECT r.id, r.total_bet, r.payout, r.status,
      (SELECT COALESCE(-SUM(amount), 0) FROM casino_transactions t WHERE t.round_id = r.id AND t.type = 'BET') AS debits,
      (SELECT COALESCE(SUM(amount), 0) FROM casino_transactions t WHERE t.round_id = r.id AND t.type IN ('WIN','PUSH','REFUND','LOSS')) AS credits,
      (SELECT COALESCE(SUM(amount), 0) FROM casino_transactions t WHERE t.round_id = r.id AND t.type = 'JACKPOT') AS jackpot
    FROM casino_rounds r`);
  for (const r of rows) {
    assert.equal(r.debits, r.total_bet, `ronda ${r.id}: apostado`);
    if (r.status !== 'active') assert.equal(r.credits + r.jackpot, r.payout, `ronda ${r.id}: pagado`);
  }
  // Estadísticas del jugador = suma de sus rondas liquidadas (las devueltas no cuentan).
  for (const u of db.all<{ user_id: string; total_wagered: number; total_payout: number; rounds: number }>('SELECT user_id, total_wagered, total_payout, rounds FROM casino_users')) {
    const s = db.get<{ n: number; w: number | null; p: number | null }>("SELECT COUNT(*) AS n, SUM(total_bet) AS w, SUM(payout) AS p FROM casino_rounds WHERE user_id = ? AND status IN ('won','lost','push')", u.user_id)!;
    assert.equal(u.rounds, s.n);
    assert.equal(u.total_wagered, s.w ?? 0);
    assert.equal(u.total_payout, s.p ?? 0);
  }
}

function next(w: TestWorld): void {
  w.clock.advance(1_100); // pasa la espera entre rondas
}

describe('apuestas', () => {
  it('juego instantáneo: cobra, paga y registra en una sola transacción', () => {
    const w = makeWorld();
    const v = playInstant(w.ctx, req('roulette', 100, parse('roulette', ['rojo'])));
    assert.notEqual(v.round.status, 'active');
    // Además del premio, la primera apuesta desbloquea un logro (que paga su recompensa).
    const extras = v.settled!.achievements.reduce((sum, a) => sum + a.reward, 0) + (v.settled!.levelUp?.reward ?? 0);
    assert.equal(v.settled!.achievements[0]?.def.id, 'first_bet');
    assert.equal(v.balance, START - 100 + v.round.payout + extras);
    assert.equal(getCasinoUser(w.ctx, U)!.rounds, 1);
    audit(w);
  });

  it('valida la apuesta en el servidor: entero, mínimo, máximo, saldo, juego cerrado', () => {
    const w = makeWorld();
    for (const bad of [0, -5, 1.5, Number.NaN, 9, 10_000_000]) expectGameError(() => playInstant(w.ctx, req('slots', bad, {})));
    assert.throws(() => playInstant(w.ctx, req('slots', 6_000, {})), InsufficientFundsError);
    const cfg = structuredClone(getCasinoConfig(w.ctx));
    cfg.games.slots.enabled = false;
    saveCasinoConfig(w.ctx, cfg, null);
    expectGameError(() => playInstant(w.ctx, req('slots', 100, {})), /cerrado/);
    assert.equal(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM casino_rounds')!.n, 0, 'una apuesta rechazada no deja rondas ni consume nonce');
    assert.equal(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM casino_transactions')!.n, 0, 'ni movimientos');
    ensureCasinoUser(w.ctx, U);
    assert.equal(getBalance(w.ctx, U), START);
    audit(w);
  });

  it('respeta la espera entre rondas del mismo juego', () => {
    const w = makeWorld();
    playInstant(w.ctx, req('slots', 100, {}));
    expectGameError(() => playInstant(w.ctx, req('slots', 100, {})), /Esperá/);
    playInstant(w.ctx, req('roulette', 100, parse('roulette', ['par'])));
    next(w);
    playInstant(w.ctx, req('slots', 100, {}));
    audit(w);
  });

  it('una sola partida abierta por juego (también desde dos servidores a la vez)', () => {
    const w = makeWorld();
    const v = startRound(w.ctx, req('mines', 100, parse('mines', ['3'])));
    next(w);
    assert.throws(() => startRound(w.ctx, { ...req('mines', 100, parse('mines', ['3'])), guildId: '100000000000000009' }), ActiveRoundError);
    // La base lo garantiza aunque se saltee la verificación del código.
    assert.throws(() => w.ctx.db.run("INSERT INTO casino_rounds (user_id, game, bet, total_bet, rtp, status, seed_id, nonce, created_at, updated_at) VALUES (?, 'mines', 1, 1, 0.97, 'active', ?, 999, 0, 0)", U, v.round.seedId));
    startRound(w.ctx, req('tower', 100, parse('tower')));
    audit(w);
  });
});

describe('decisiones dentro de la partida', () => {
  it('doble clic o botón viejo: la segunda acción con la misma versión no hace nada', () => {
    const w = makeWorld();
    const v = startRound<MinesState>(w.ctx, req('mines', 100, parse('mines', ['1'])));
    const safe = [...Array(25).keys()].filter((i) => !v.state!.mines.includes(i));
    const a = actOnRound<MinesState>(w.ctx, { userId: U, roundId: v.round.id, version: v.round.version, action: { type: 'pick', arg: safe[0] } });
    assert.throws(() => actOnRound(w.ctx, { userId: U, roundId: v.round.id, version: v.round.version, action: { type: 'pick', arg: safe[1] } }), StaleActionError);
    assert.equal(viewOf<MinesState>(w.ctx, v.round.id).state!.revealed.length, 1);
    const c = actOnRound(w.ctx, { userId: U, roundId: v.round.id, version: a.round.version, action: { type: 'cash' } });
    assert.ok(c.settled);
    // Tocar "cobrar" otra vez (o cualquier botón) ya no paga nada.
    expectGameError(() => actOnRound(w.ctx, { userId: U, roundId: v.round.id, version: c.round.version, action: { type: 'cash' } }), /terminó/);
    expectGameError(() => actOnRound(w.ctx, { userId: U, roundId: v.round.id, version: a.round.version, action: { type: 'cash' } }), /terminó/);
    audit(w);
  });

  it('nadie puede tocar la partida de otra persona', () => {
    const w = makeWorld();
    const v = startRound(w.ctx, req('tower', 100, parse('tower')));
    expectGameError(() => actOnRound(w.ctx, { userId: U2, roundId: v.round.id, version: 0, action: { type: 'tile', arg: 0 } }), /otra persona/);
    expectGameError(() => actOnRound(w.ctx, { userId: U, roundId: 999_999, version: 0, action: { type: 'tile', arg: 0 } }), /no existe/);
  });

  it('blackjack: doblar cobra la apuesta extra; sin saldo no cambia nada', () => {
    const w = makeWorld();
    ensureCasinoUser(w.ctx, U);
    // Busca una mano sin blackjack de entrada (el azar es fijo por semilla y nonce).
    let v: RoundView<BjState> | null = null;
    for (let i = 0; i < 30 && !v; i++) {
      const s = startRound<BjState>(w.ctx, req('blackjack', 2_000, {}));
      if (s.settled) next(w);
      else v = s;
    }
    assert.ok(v);
    applyTx(w.ctx, { userId: U, amount: -(getBalance(w.ctx, U) - 1_000), type: 'BET' });
    expectGameError(() => actOnRound(w.ctx, { userId: U, roundId: v!.round.id, version: v!.round.version, action: { type: 'double' } }), /No te alcanza/);
    assert.equal(viewOf<BjState>(w.ctx, v!.round.id).state!.hands[0].cards.length, 2, 'la mano no cambió');
    applyTx(w.ctx, { userId: U, amount: 5_000, type: 'BONUS' });
    const d = actOnRound(w.ctx, { userId: U, roundId: v!.round.id, version: v!.round.version, action: { type: 'double' } });
    assert.equal(d.round.totalBet, 4_000);
    audit(w);
  });
});

describe('devoluciones y partidas interrumpidas', () => {
  it('devolver reintegra todo lo apostado (incluidas las extras) una sola vez', () => {
    const w = makeWorld();
    const v = startRound(w.ctx, req('hilo', 300, {}));
    assert.equal(getBalance(w.ctx, U), START - 300);
    assert.ok(refundRound(w.ctx, v.round.id, 'prueba'));
    assert.equal(refundRound(w.ctx, v.round.id, 'prueba'), null, 'la segunda devolución no hace nada');
    assert.equal(getBalance(w.ctx, U), START);
    expectGameError(() => actOnRound(w.ctx, { userId: U, roundId: v.round.id, version: 0, action: { type: 'cash' } }), /terminó/);
    audit(w);
  });

  it('abandonada: cobra lo ganado si había avanzado; si no, devuelve; blackjack se planta', () => {
    const w = makeWorld();
    const m = startRound<MinesState>(w.ctx, req('mines', 100, parse('mines', ['2'])));
    const safe = [...Array(25).keys()].find((i) => !m.state!.mines.includes(i))!;
    actOnRound(w.ctx, { userId: U, roundId: m.round.id, version: 0, action: { type: 'pick', arg: safe } });
    const t = startRound(w.ctx, req('tower', 100, parse('tower')));
    const rm = resolveStaleRound(w.ctx, m.round.id, w.clock.t)!;
    assert.equal(rm.round.status, 'won');
    assert.equal(resolveStaleRound(w.ctx, t.round.id, w.clock.t)!.round.status, 'refunded');
    assert.equal(resolveStaleRound(w.ctx, t.round.id, w.clock.t), null, 'idempotente');
    audit(w);
  });

  it('crash interrumpido: retiro automático alcanzable se paga; si explotó con el bot vivo, pierde; si no, se devuelve', () => {
    const w = makeWorld();
    const results: string[] = [];
    for (let i = 0; i < 40; i++) {
      const v = startRound<CrashState>(w.ctx, req('crash', 100, parse('crash', i % 2 ? ['1.5x'] : [])));
      const s = v.state!;
      const r = resolveStaleRound(w.ctx, v.round.id, s.startedAt + 3_000)!;
      const reachable = s.auto !== null && s.auto <= s.crashPoint;
      if (reachable) assert.equal(r.round.multiplier, 1.5);
      else if (s.startedAt + msToReach(s.crashPoint) <= s.startedAt + 3_000) assert.equal(r.round.status, 'lost');
      else assert.equal(r.round.status, 'refunded');
      results.push(r.round.status);
      next(w);
    }
    assert.ok(new Set(results).size >= 2, 'se probaron varios casos');
    audit(w);
  });

  it('crash en vivo: el reloj del servidor decide; un retiro tardío pierde', () => {
    const w = makeWorld();
    const v = startRound<CrashState>(w.ctx, req('crash', 100, parse('crash')));
    const s = v.state!;
    w.clock.advance(msToReach(s.crashPoint) + 100);
    const r = actOnRound(w.ctx, { userId: U, roundId: v.round.id, version: 0, action: { type: 'cashout' } });
    assert.equal(r.round.status, 'lost');
    assert.equal(tickLiveRound(w.ctx, v.round.id), null, 'ya liquidada');
    audit(w);
  });
});

describe('repetir, tope de premio y jackpot', () => {
  it('"repetir" se puede usar una sola vez por mensaje', () => {
    const w = makeWorld();
    const v = playInstant(w.ctx, req('slots', 100, {}));
    claimRebet(w.ctx, v.round.id, U);
    expectGameError(() => claimRebet(w.ctx, v.round.id, U), /ya se usó/);
    expectGameError(() => claimRebet(w.ctx, v.round.id, U2));
  });

  it('el premio de una ronda nunca supera el máximo configurado', () => {
    const w = makeWorld();
    const cfg = structuredClone(getCasinoConfig(w.ctx));
    cfg.maxPayout = 1_000;
    saveCasinoConfig(w.ctx, cfg, null);
    applyTx(w.ctx, { userId: U, amount: 100_000, type: 'BONUS' });
    let capped = false;
    for (let i = 0; i < 200 && !capped; i++) {
      const v = playInstant(w.ctx, req('roulette', 100, parse('roulette', ['17'])));
      assert.ok(v.round.payout <= 1_000);
      capped = v.settled!.capped;
      next(w);
    }
    assert.ok(capped, 'un pleno (36x) de 100 llegó al tope de 1.000');
    audit(w);
  });

  it('el jackpot crece con un % de cada apuesta de slots', () => {
    const w = makeWorld();
    const before = jackpotAmount(w.ctx);
    playInstant(w.ctx, req('slots', 1_000, {}));
    assert.equal(jackpotAmount(w.ctx), before + Math.floor(1_000 * DEFAULT_CASINO.jackpot.contributionPct / 100));
  });
});

describe('azar verificable de punta a punta', () => {
  it('después de rotar la semilla, el resultado recalculado coincide con lo que pasó', () => {
    const w = makeWorld();
    const rounds = [];
    for (let i = 0; i < 5; i++) {
      rounds.push(playInstant(w.ctx, req('roulette', 100, parse('roulette', ['rojo']))).round);
      next(w);
    }
    assert.equal(fairSummaryOf(w.ctx, rounds[0]).revealed, false, 'mientras está activa no se revela');
    rotateSeed(w.ctx, U);
    for (const r of rounds) {
      const f = fairSummaryOf(w.ctx, r);
      assert.ok(f.revealed);
      assert.ok(f.summary!.includes(`Salió el ${(r.result as { number: number }).number} `), `${f.summary} vs ${r.summary}`);
    }
  });

  it('no se puede rotar con partidas abiertas (revelaría su resultado)', () => {
    const w = makeWorld();
    startRound(w.ctx, req('mines', 100, parse('mines')));
    expectGameError(() => rotateSeed(w.ctx, U), /partidas abiertas/);
  });
});

describe('torneos', () => {
  it('automáticos: se crean una vez por período y suman las rondas liquidadas', () => {
    const w = makeWorld();
    const created = ensureAutoTournaments(w.ctx);
    assert.equal(created.length, 2);
    assert.equal(ensureAutoTournaments(w.ctx).length, 0, 'idempotente');
    const v = playInstant(w.ctx, req('roulette', 100, parse('roulette', ['rojo'])));
    assert.equal(v.settled!.tournaments.length, 2);
    const daily = created.find((t) => t.kind === 'daily')!;
    assert.equal(standings(w.ctx, daily)[0].rounds, 1);
  });

  it('especial con entrada: unirse cobra una vez, cancelar devuelve, terminar paga una sola vez', () => {
    const w = makeWorld();
    const now = w.clock.t;
    const t = createTournament(w.ctx, { name: 'Plinko Weekend', metric: 'wagered', game: 'plinko', prizes: [1_000, 500], entryFee: 200, minRounds: 1, startsAt: now, endsAt: now + 3_600_000 }, U2);
    startTournament(w.ctx, t.id);
    joinTournament(w.ctx, t.id, U);
    expectGameError(() => joinTournament(w.ctx, t.id, U), /Ya estás/);
    // Otro juego no suma; plinko sí.
    playInstant(w.ctx, req('slots', 100, {}));
    playInstant(w.ctx, req('plinko', 300, parse('plinko')));
    assert.equal(standings(w.ctx, t)[0].wagered, 300);
    const balanceBefore = getBalance(w.ctx, U);
    const r = finishTournament(w.ctx, t.id)!;
    assert.equal(r.winners.length, 1);
    assert.equal(r.winners[0].prize, 1_000 + Math.floor((200 * 1_000) / 1_500), 'las entradas suman al pozo');
    const achievements = r.winners[0].achievements.reduce((sum, a) => sum + a.reward, 0);
    assert.equal(r.winners[0].achievements[0]?.def.id, 'tournament_win');
    assert.equal(getBalance(w.ctx, U), balanceBefore + r.winners[0].prize + achievements);
    assert.equal(finishTournament(w.ctx, t.id), null, 'cerrar dos veces no paga dos veces');
    assert.equal(getCasinoUser(w.ctx, U)!.tournamentsWon, 1);

    const t2 = createTournament(w.ctx, { name: 'Cancelado', metric: 'profit', prizes: [100], entryFee: 50, startsAt: now, endsAt: now + 3_600_000 }, U2);
    startTournament(w.ctx, t2.id);
    const b = getBalance(w.ctx, U);
    joinTournament(w.ctx, t2.id, U);
    cancelTournament(w.ctx, t2.id);
    assert.equal(getBalance(w.ctx, U), b);
    audit(w);
  });

  it('sin las rondas mínimas no hay premio', () => {
    const w = makeWorld();
    const now = w.clock.t;
    const t = createTournament(w.ctx, { name: 'Exigente', metric: 'wagered', prizes: [1_000], minRounds: 3, startsAt: now, endsAt: now + 60_000 }, U2);
    startTournament(w.ctx, t.id);
    playInstant(w.ctx, req('slots', 100, {}));
    assert.equal(finishTournament(w.ctx, t.id)!.winners.length, 0);
  });
});

describe('invariantes con miles de rondas al azar', () => {
  it('saldos = transacciones, nada negativo, cada ronda cerrada una vez, estadísticas exactas', () => {
    const w = makeWorld();
    const pick = seeded(2026);
    const users = [U, U2, '200000000000000005', '200000000000000006'];
    const rand = (n: number) => Math.floor(pick() * n);
    for (let i = 0; i < 1_500; i++) {
      const user = users[rand(users.length)];
      const game = GAME_IDS[rand(GAME_IDS.length)];
      ensureCasinoUser(w.ctx, user);
      const bal = getBalance(w.ctx, user);
      if (bal < 10) {
        applyTx(w.ctx, { userId: user, amount: 2_000, type: 'BONUS' });
        continue;
      }
      const bet = 10 + rand(Math.min(bal, 800) - 9);
      const params = game === 'roulette' ? parse('roulette', [['rojo', '17', 'd2', '1-6'][rand(4)]])
        : game === 'mines' ? parse('mines', [String(1 + rand(24))])
          : game === 'plinko' ? parse('plinko', [['bajo', 'medio', 'alto'][rand(3)], String(8 + rand(9))])
            : game === 'crash' ? parse('crash', rand(2) ? ['2x'] : [])
              : game === 'tower' ? parse('tower', [['facil', 'medio', 'dificil', 'experto'][rand(4)]])
                : game === 'chicken' ? parse('chicken', [['facil', 'normal', 'dificil'][rand(3)]])
                  : parse(game);
      try {
        if (GAMES[game].kind === 'instant') playInstant(w.ctx, req(game, bet, params, user));
        else {
          let v: RoundView<any> = startRound(w.ctx, req(game, bet, params, user)); // eslint-disable-line @typescript-eslint/no-explicit-any
          for (let step = 0; step < 40 && v.round.status === 'active'; step++) {
            const s = v.state;
            let action: { type: string; arg?: number };
            if (game === 'crash') {
              w.clock.advance(rand(8_000));
              action = { type: rand(3) ? 'cashout' : 'tick' };
              if (action.type === 'tick') {
                v = tickLiveRound(w.ctx, v.round.id) ?? viewOf(w.ctx, v.round.id);
                continue;
              }
            } else if (game === 'blackjack') action = { type: ['hit', 'stand', 'double', 'split'][rand(4)] };
            else if (game === 'mines') action = rand(5) === 0 && s.revealed.length ? { type: 'cash' } : { type: 'pick', arg: rand(25) };
            else if (game === 'hilo') {
              const o = hiloOdds(s as HiloState, 0.97);
              action = rand(6) === 0 && s.correct ? { type: 'cash' } : { type: rand(10) === 0 ? 'skip' : o.higher >= o.lower ? 'higher' : 'lower' };
            } else if (game === 'chicken') action = rand(4) === 0 && s.lane ? { type: 'cash' } : { type: 'go' };
            else if (game === 'balloons') action = rand(4) === 0 && s.level ? { type: 'cash' } : { type: 'pop', arg: rand(6) };
            else action = rand(4) === 0 && s.floor ? { type: 'cash' } : { type: 'tile', arg: rand(4) };
            try {
              v = actOnRound(w.ctx, { userId: user, roundId: v.round.id, version: v.round.version, action });
            } catch (e) {
              if (!(e instanceof GameError)) throw e; // jugada inválida (sin saldo para doblar, casilla repetida…): sigue igual
            }
          }
          if (v.round.status === 'active') resolveStaleRound(w.ctx, v.round.id, w.clock.t);
        }
      } catch (e) {
        if (!(e instanceof GameError)) throw e;
      }
      w.clock.advance(1_100);
    }
    const rounds = w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM casino_rounds WHERE status <> 'active'")!.n;
    assert.ok(rounds > 1_000, `rondas jugadas: ${rounds}`);
    assert.equal(w.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM casino_rounds WHERE status = 'active'")!.n, 0);
    audit(w);
    for (const r of w.ctx.db.all<{ id: number }>('SELECT id FROM casino_rounds LIMIT 50')) assert.ok(getRound(w.ctx, r.id));
  });
});

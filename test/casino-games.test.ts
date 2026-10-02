import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActContext, PlayContext, Settlement, Step } from '../src/casino/engine';
import { balloons, balloonsMultiplier, LEVELS, NEEDLES, PER_LEVEL } from '../src/casino/games/balloons';
import { blackjack, canSplit, handValue, type BjState } from '../src/casino/games/blackjack';
import { chicken, chickenMultiplier, LANES, SURVIVAL } from '../src/casino/games/chicken';
import { crash, crashPointFrom, msToReach, multiplierAt, parseAuto, type CrashParams, type CrashState } from '../src/casino/games/crash';
import { hilo, hiloOdds, type HiloState } from '../src/casino/games/hilo';
import { mines, minesMultiplier, survival, type MinesState } from '../src/casino/games/mines';
import { binomial, dropBall, parsePlinko, plinkoTable, tableRtp, type PlinkoRisk } from '../src/casino/games/plinko';
import { parseRouletteBet, roulette, rouletteMultiplier } from '../src/casino/games/roulette';
import { evaluateLine, paytable, slots, slotsRtp, slotsScale, SYMBOLS } from '../src/casino/games/slots';
import { buildTower, DIFFICULTY, FLOORS, tower, towerMultiplier, type TowerDifficulty, type TowerState } from '../src/casino/games/tower';
import { FairRng } from '../src/casino/rng';
import { GameError } from '../src/services/context';

const RTP = 0.97;
const rng = (n: number) => new FairRng('semilla-de-prueba', 'cliente', n);
const play = <P>(p: P, n: number, bet = 100): PlayContext<P> => ({ rng: rng(n), bet, params: p, rtp: RTP, now: 0 });
const act = <P>(p: P, extra: Partial<ActContext<P>> = {}): ActContext<P> => ({ rtp: RTP, now: 0, bet: 100, totalBet: 100, params: p, lastAlive: 0, ...extra });
const expectGameError = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));

describe('ruleta', () => {
  it('entiende todas las apuestas y rechaza las inválidas', () => {
    assert.equal(parseRouletteBet(['rojo']).numbers.length, 18);
    assert.equal(parseRouletteBet(['d2']).numbers[0], 13);
    assert.deepEqual(parseRouletteBet(['7,17,23']).numbers, [7, 17, 23]);
    assert.deepEqual(parseRouletteBet(['5-8']).numbers, [5, 6, 7, 8]);
    assert.deepEqual(parseRouletteBet(['0']).numbers, [0]);
    for (const bad of [['37'], ['8-5'], ['azul'], []]) expectGameError(() => parseRouletteBet(bad));
  });

  it('todas las apuestas tienen el mismo valor esperado: 36/37 (salvo el redondeo hacia abajo)', () => {
    for (const b of ['rojo', 'par', 'd1', 'c3', '17', '1,2', '1-3', '1-4', '1-6', '1-36']) {
      const bet = parseRouletteBet([b]);
      const ev = (bet.numbers.length / 37) * rouletteMultiplier(bet);
      assert.ok(ev <= 36 / 37 + 1e-9 && ev > 36 / 37 - 0.01, `${b}: ${ev}`);
    }
  });

  it('paga lo que corresponde según el número que sale', () => {
    for (let n = 0; n < 200; n++) {
      const s = roulette.play!(play(parseRouletteBet(['rojo']), n));
      assert.equal(s.multiplier, (s.result as { hit: boolean }).hit ? 2 : 0);
    }
  });
});

describe('slots', () => {
  it('la tabla escalada da exactamente el RTP pedido (±0,5 %)', () => {
    for (const rtp of [0.9, 0.95, 0.961, 0.97, 0.99]) {
      const got = slotsRtp(slotsScale(rtp));
      assert.ok(got <= rtp + 1e-9 && got > rtp - 0.005, `${rtp}: ${got}`);
    }
    assert.equal(paytable(0.95).length, SYMBOLS.length + 1);
  });

  it('comodín, jackpot solo con 7 reales y par de cerezas', () => {
    const idx = (id: string) => SYMBOLS.findIndex((s) => s.id === id);
    const [cherry, lemon, seven, star] = ['cherry', 'lemon', 'seven', 'star'].map(idx);
    assert.equal(evaluateLine([seven, seven, seven]).jackpot, true);
    assert.equal(evaluateLine([seven, star, seven]).jackpot, false);
    assert.equal(evaluateLine([seven, star, seven]).base, 60);
    assert.equal(evaluateLine([star, star, star]).base, 30);
    assert.equal(evaluateLine([cherry, cherry, lemon]).kind, 'pair');
    assert.equal(evaluateLine([cherry, lemon, seven]).base, 0);
    const s = slots.play!(play({}, 3));
    assert.equal((s.result as { grid: string[][] }).grid.length, 3);
  });
});

describe('crash', () => {
  it('P(llegar a x) = RTP / x (medido sobre una grilla fina de azar)', () => {
    const N = 200_000;
    for (const x of [1.5, 2, 5, 10, 100]) {
      let hits = 0;
      for (let i = 0; i < N; i++) if (crashPointFrom((i + 0.5) / N, RTP) >= x) hits += 1;
      const p = hits / N;
      assert.ok(Math.abs(p - RTP / x) < 0.002, `x=${x}: ${p} vs ${RTP / x}`);
    }
    assert.equal(crashPointFrom(0, RTP), 1, 'nunca menos de 1x');
  });

  it('retirar antes de explotar paga el multiplicador del reloj; después, pierde', () => {
    const s: CrashState = { crashPoint: 3, startedAt: 0, auto: null };
    const p: CrashParams = { auto: null };
    const at = (ms: number) => crash.act!(structuredClone(s), { type: 'cashout' }, act(p, { now: ms }));
    expectGameError(() => at(0), /despegó/);
    assert.equal(at(msToReach(2)).settle!.multiplier, multiplierAt(msToReach(2)));
    assert.equal(at(msToReach(3.5)).settle!.multiplier, 0);
    assert.equal(crash.act!(structuredClone(s), { type: 'tick' }, act(p, { now: 1000 })).settle, undefined);
    assert.equal(crash.act!(structuredClone(s), { type: 'tick' }, act(p, { now: msToReach(3) + 50 })).settle!.multiplier, 0);
  });

  it('retiro automático: paga exactamente ese multiplicador aunque el reloj lo pase', () => {
    const s: CrashState = { crashPoint: 5, startedAt: 0, auto: 2.5 };
    const r = crash.act!(s, { type: 'tick' }, act({ auto: 2.5 }, { now: msToReach(4) }));
    assert.equal(r.settle!.multiplier, 2.5);
    assert.equal(parseAuto('2.5x'), 2.5);
    assert.equal(parseAuto('2,5'), 2.5);
    expectGameError(() => parseAuto('1'));
    expectGameError(() => parseAuto('9999'));
  });

  it('interrumpido por un reinicio: auto alcanzable paga, explotado mientras vivía pierde, si no se devuelve', () => {
    const base = (auto: number | null): CrashState => ({ crashPoint: 4, startedAt: 0, auto });
    const resolve = (auto: number | null, lastAlive: number) => crash.resolveAbandoned!(base(auto), act({ auto }, { lastAlive }));
    assert.equal((resolve(2, 0) as Settlement).multiplier, 2);
    assert.equal(resolve(5, 0), 'refund', 'auto inalcanzable y explotó después del último latido');
    assert.equal((resolve(null, msToReach(4) + 1000) as Settlement).multiplier, 0);
    assert.equal(resolve(null, msToReach(2)), 'refund');
  });
});

describe('plinko', () => {
  it('cada tabla queda en el RTP (como mucho 1,5 % por debajo), es simétrica y paga más en los bordes', () => {
    for (const risk of ['low', 'medium', 'high'] as PlinkoRisk[]) {
      for (let rows = 8; rows <= 16; rows++) {
        const t = plinkoTable(risk, rows, RTP);
        const r = tableRtp(t);
        assert.ok(r <= RTP + 1e-9 && r >= RTP - 0.015, `${risk}/${rows}: ${r}`);
        assert.deepEqual(t, [...t].reverse());
        assert.equal(Math.max(...t), t[0]);
      }
    }
    assert.ok(Math.abs(binomial(12).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  });

  it('la casilla es la cantidad de rebotes a la derecha; parámetros validados', () => {
    const { path, bucket } = dropBall(rng(1), 16);
    assert.equal(path.length, 16);
    assert.equal(bucket, path.reduce((a, b) => a + b, 0));
    assert.deepEqual(parsePlinko(['alto', '16']), { risk: 'high', rows: 16 });
    assert.deepEqual(parsePlinko([]), { risk: 'medium', rows: 12 });
    expectGameError(() => parsePlinko(['20']));
  });
});

/** Valor esperado de cobrar en cada paso: multiplicador × probabilidad de llegar. Nunca supera el RTP. */
function assertFairLadder(name: string, steps: number, mult: (k: number) => number, reach: (k: number) => number): void {
  for (let k = 1; k <= steps; k++) {
    const ev = mult(k) * reach(k);
    assert.ok(ev <= RTP + 1e-9 && ev >= RTP - 0.012, `${name} paso ${k}: EV ${ev}`);
  }
}

describe('minas', () => {
  it('cobrar en cualquier casilla tiene valor esperado = RTP', () => {
    for (const m of [1, 3, 10, 24]) assertFairLadder(`minas ${m}`, Math.min(25 - m, 8), (k) => minesMultiplier(m, k, RTP), (k) => survival(m, k));
  });

  it('reglas: mina pierde, casilla repetida o inválida se rechaza, cobrar exige una casilla, todas las seguras cobra sola', () => {
    const p = { mines: 24 };
    const start = mines.start!(play(p, 5)).state;
    assert.equal(new Set(start.mines).size, 24);
    const safe = [...Array(25).keys()].find((i) => !start.mines.includes(i))!;
    expectGameError(() => mines.act!(structuredClone(start), { type: 'cash' }, act(p)), /al menos/);
    expectGameError(() => mines.act!(structuredClone(start), { type: 'pick', arg: 25 }, act(p)), /inválida/);
    const won = mines.act!(structuredClone(start), { type: 'pick', arg: safe }, act(p));
    assert.ok(won.settle && won.settle.multiplier! > 20, 'con 24 minas, la única segura cobra sola');
    const lost = mines.act!(structuredClone(start), { type: 'pick', arg: start.mines[0] }, act(p));
    assert.equal(lost.settle!.multiplier, 0);
    const s3: MinesState = { mines: [0, 1, 2], revealed: [5], hit: null };
    expectGameError(() => mines.act!(s3, { type: 'pick', arg: 5 }, act({ mines: 3 })), /destapada/);
    assert.equal(mines.resolveAbandoned!({ mines: [0], revealed: [], hit: null }, act({ mines: 1 })), 'refund');
  });
});

describe('pollo, globos y dragon tower', () => {
  it('cada paso tiene valor esperado = RTP', () => {
    for (const d of ['easy', 'medium', 'hard'] as const) {
      assertFairLadder(`pollo ${d}`, LANES, (k) => chickenMultiplier(d, k, RTP), (k) => SURVIVAL[d].slice(0, k).reduce((a, b) => a * b, 1));
    }
    assertFairLadder('globos', LEVELS, (k) => balloonsMultiplier(k, RTP), (k) => NEEDLES.slice(0, k).reduce((a, n) => a * ((PER_LEVEL - n) / PER_LEVEL), 1));
    for (const d of Object.keys(DIFFICULTY) as TowerDifficulty[]) {
      const { safe, tiles } = DIFFICULTY[d];
      assertFairLadder(`torre ${d}`, FLOORS, (k) => towerMultiplier(d, k, RTP), (k) => (safe / tiles) ** k);
    }
  });

  it('el riesgo de los globos sube nivel a nivel', () => {
    for (let i = 1; i < NEEDLES.length; i++) assert.ok(NEEDLES[i] >= NEEDLES[i - 1]);
  });

  it('el pollo muere donde lo decide el azar al apostar (siempre 10 números) y retirarse paga', () => {
    const s = chicken.start!(play({ difficulty: 'medium' as const }, 9)).state;
    let st = structuredClone(s);
    let last: Step<typeof st> = { state: st };
    for (let lane = 1; lane <= LANES; lane++) {
      last = chicken.act!(st, { type: 'go' }, act({ difficulty: 'medium' as const }));
      st = last.state;
      if (last.settle) break;
    }
    if (s.deathLane === null) assert.equal(last.settle!.multiplier, chickenMultiplier('medium', LANES, RTP));
    else {
      assert.equal(st.lane, s.deathLane);
      assert.equal(last.settle!.multiplier, 0);
    }
  });

  it('dragon tower: casillas seguras por piso, dragón pierde, cobrar paga el piso alcanzado', () => {
    const p = { difficulty: 'hard' as const };
    const s: TowerState = { safe: buildTower(rng(4), 'hard'), floor: 0, picks: [], hit: null };
    assert.ok(s.safe.every((f) => f.length === 1));
    const up = tower.act!(structuredClone(s), { type: 'tile', arg: s.safe[0][0] }, act(p));
    assert.equal(up.state.floor, 1);
    assert.equal(tower.act!(structuredClone(up.state), { type: 'cash' }, act(p)).settle!.multiplier, towerMultiplier('hard', 1, RTP));
    const bad = 1 - s.safe[0][0];
    assert.equal(tower.act!(structuredClone(s), { type: 'tile', arg: bad }, act(p)).settle!.multiplier, 0);
    expectGameError(() => tower.act!(structuredClone(s), { type: 'tile', arg: 2 }, act(p)));
  });

  it('globos: aguja pierde, cobrar exige un nivel', () => {
    const s = balloons.start!(play({}, 2)).state;
    expectGameError(() => balloons.act!(structuredClone(s), { type: 'cash' }, act({})));
    const needle = s.needles[0][0];
    assert.equal(balloons.act!(structuredClone(s), { type: 'pop', arg: needle }, act({})).settle!.multiplier, 0);
  });
});

describe('hilo', () => {
  it('las probabilidades suman 1 y cada acierto vale lo mismo en promedio (RTP)', () => {
    const s = hilo.start!(play({}, 11)).state;
    const o = hiloOdds(s, RTP);
    assert.ok(Math.abs(o.higher + o.lower + o.equal - 1) < 1e-12);
    // EV de un acierto ignorando empates (que no cambian nada): P(gana | no empata) × multiplicador = RTP.
    for (const side of ['higher', 'lower'] as const) {
      const m = side === 'higher' ? o.higherMult : o.lowerMult;
      if (!m) continue;
      const p = (side === 'higher' ? o.higher : o.lower) / (o.higher + o.lower);
      assert.ok(Math.abs(p * m - RTP) < 0.01 * m, `${side}: ${p * m}`);
    }
  });

  it('simulación: jugar hasta 3 aciertos devuelve cerca del RTP', () => {
    let bet = 0;
    let paid = 0;
    for (let n = 0; n < 6000; n++) {
      let s: HiloState = hilo.start!(play({}, n)).state;
      bet += 1;
      for (let guess = 0; guess < 20; guess++) {
        const o = hiloOdds(s, RTP);
        const r = hilo.act!(s, { type: o.higher >= o.lower ? 'higher' : 'lower' }, act({}));
        s = r.state;
        if (r.settle) { paid += r.settle.multiplier ?? 0; break; }
        if (s.correct >= 3) { paid += hilo.act!(s, { type: 'cash' }, act({})).settle!.multiplier!; break; }
      }
    }
    assert.ok(Math.abs(paid / bet - RTP) < 0.04, `retorno ${paid / bet}`);
  });
});

describe('blackjack', () => {
  it('valor de las manos con ases blandos', () => {
    assert.deepEqual(handValue([0, 1]), { total: 12, soft: true });      // A + A
    assert.deepEqual(handValue([0, 36, 40]), { total: 21, soft: false }); // A + 10 + J
    assert.deepEqual(handValue([24, 28]), { total: 15, soft: false });   // 7 + 8
  });

  it('dividir solo pares; doblar agrega una apuesta y da una carta', () => {
    const pair: BjState = { shoe: Array.from({ length: 20 }, (_, i) => (i * 7) % 52), dealer: [36, 20], hands: [{ cards: [28, 29], bet: 100, doubled: false, done: false, fromSplit: false }], active: 0 };
    assert.ok(canSplit(pair));
    const split = blackjack.act!(structuredClone(pair), { type: 'split' }, act({}));
    assert.equal(split.extraBet, 100);
    assert.equal(split.state.hands.length, 2);
    const noPair: BjState = { ...structuredClone(pair), hands: [{ cards: [28, 32], bet: 100, doubled: false, done: false, fromSplit: false }] };
    expectGameError(() => blackjack.act!(structuredClone(noPair), { type: 'split' }, act({})));
    const dbl = blackjack.act!(structuredClone(noPair), { type: 'double' }, act({}));
    assert.equal(dbl.extraBet, 100);
    assert.equal(dbl.state.hands[0].cards.length, 3);
    assert.ok(dbl.settle, 'después de doblar juega el crupier');
  });

  it('simulación con estrategia simple: el retorno queda en un rango razonable y el crupier se planta en 17', () => {
    let bet = 0;
    let paid = 0;
    for (let n = 0; n < 8000; n++) {
      let step = blackjack.start!(play({}, n));
      bet += 100;
      let extra = 0;
      while (!step.settle) {
        const h = step.state.hands[step.state.active];
        step = blackjack.act!(step.state, { type: handValue(h.cards).total < 17 ? 'hit' : 'stand' }, act({}));
        extra += step.extraBet ?? 0;
      }
      bet += extra;
      paid += step.settle.payout ?? 0;
      const d = handValue(step.state.dealer).total;
      if (step.state.dealer.length > 2) assert.ok(d >= 17, 'el crupier pide hasta 17');
    }
    assert.ok(paid / bet > 0.9 && paid / bet < 1.0, `retorno ${paid / bet}`);
  });
});

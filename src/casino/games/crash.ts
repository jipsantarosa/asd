import { GameError } from '../../services/context';
import type { ActContext, CasinoGame, PlayContext, Settlement, Step } from '../engine';
import type { FairRng } from '../rng';
import { floor2 } from './util';

/**
 * Crash: un cohete cuyo multiplicador crece con el tiempo (se duplica cada 6 s) hasta explotar.
 * - El punto de explosión se decide al apostar: max(1, floor(100 × RTP / (1 − f)) / 100) con f ∈ [0, 1).
 *   Así P(llegar a x) = RTP / x, y el valor esperado de retirar en CUALQUIER x es exactamente el RTP.
 * - El reloj del servidor decide: al tocar "Retirar" se calcula el multiplicador en ese instante.
 *   Si para entonces el cohete ya explotó, se pierde (lo que se ve en Discord puede llegar un poco tarde).
 * - Retiro automático opcional (p. ej. 2,5x): si el cohete llega, se paga exactamente ese multiplicador.
 */

export const GROWTH = Math.log(2) / 6;
export const MAX_CRASH = 10_000;
export const MIN_CASHOUT = 1.01;

export interface CrashParams {
  auto: number | null;
}

export interface CrashState {
  crashPoint: number;
  startedAt: number;
  auto: number | null;
}

export function crashPointFrom(f: number, rtp: number): number {
  return Math.min(MAX_CRASH, Math.max(1, Math.floor((100 * rtp) / (1 - f)) / 100));
}

export function multiplierAt(elapsedMs: number): number {
  return floor2(Math.exp((GROWTH * Math.max(0, elapsedMs)) / 1000));
}

export function msToReach(multiplier: number): number {
  return (Math.log(multiplier) / GROWTH) * 1000;
}

export function parseAuto(raw: string | undefined): number | null {
  if (!raw) return null;
  const v = Number(raw.toLowerCase().replace(/x$/, '').replace(',', '.'));
  if (!Number.isFinite(v) || v < MIN_CASHOUT || v > 1_000) throw new GameError(`El retiro automático tiene que ser entre ${MIN_CASHOUT}x y 1000x (ej: \`2.5x\`).`);
  return floor2(v);
}

const bust = (s: CrashState): Settlement => ({
  multiplier: 0,
  summary: `🚀 💥 explotó en ${s.crashPoint.toFixed(2)}x`,
  result: { crash: s.crashPoint, cashout: null },
});

const cashout = (s: CrashState, at: number, auto: boolean): Settlement => ({
  multiplier: at,
  summary: `🚀 retiró en ${at.toFixed(2)}x${auto ? ' (auto)' : ''} · explotó en ${s.crashPoint.toFixed(2)}x`,
  result: { crash: s.crashPoint, cashout: at, auto },
});

export const crash: CasinoGame<CrashParams, CrashState> = {
  id: 'crash',
  name: 'Crash',
  emoji: '🚀',
  color: 0xe67e22,
  kind: 'live',
  tagline: 'El cohete sube… retirá antes de que explote. Con retiro automático opcional.',
  usage: '<apuesta> [retiro automático, ej: 2.5x]',
  parseParams: (args) => ({ auto: parseAuto(args[0]) }),
  describeParams: (p) => (p.auto ? `retiro automático ${p.auto.toFixed(2)}x` : 'retiro manual'),

  start(c: PlayContext<CrashParams>): Step<CrashState> {
    return { state: { crashPoint: crashPointFrom(c.rng.next(), c.rtp), startedAt: c.now, auto: c.params.auto } };
  },

  act(s: CrashState, action, c: ActContext<CrashParams>): Step<CrashState> {
    const now = multiplierAt(c.now - s.startedAt);
    const autoHit = s.auto !== null && s.auto <= s.crashPoint && now >= s.auto;
    if (action.type === 'tick') {
      if (autoHit) return { state: s, settle: cashout(s, s.auto!, true) };
      if (now >= s.crashPoint) return { state: s, settle: bust(s) };
      return { state: s };
    }
    if (action.type === 'cashout') {
      if (autoHit) return { state: s, settle: cashout(s, s.auto!, true) };
      if (now >= s.crashPoint) return { state: s, settle: bust(s) };
      if (now < MIN_CASHOUT) throw new GameError('El cohete todavía no despegó: esperá a que pase de 1.00x.');
      return { state: s, settle: cashout(s, now, false) };
    }
    throw new GameError('Acción inválida.');
  },

  /**
   * Interrumpida (reinicio del bot): con retiro automático alcanzable, se paga. Si el cohete explotó mientras
   * el bot todavía estaba prendido, cuenta como pérdida. Si no, se devuelve: el jugador no pudo retirar.
   */
  resolveAbandoned(s: CrashState, c: ActContext<CrashParams>): Settlement | 'refund' {
    if (s.auto !== null && s.auto <= s.crashPoint) return cashout(s, s.auto, true);
    if (s.startedAt + msToReach(s.crashPoint) <= c.lastAlive) return bust(s);
    return 'refund';
  },

  fairSummary(rng: FairRng, _p, rtp): string {
    return `Explotaba en ${crashPointFrom(rng.next(), rtp).toFixed(2)}x`;
  },
};

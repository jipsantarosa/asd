import crypto from 'node:crypto';
import { GameError, type GameContext } from '../services/context';
import { casinoDay, casinoDayStart, getCasinoConfig } from './config';
import { applyTx, ensureCasinoUser, getBalance } from './economy';
import { assertNotBlocked, touchUser } from './users';

/**
 * !work — trabajos con sueldo chico, pensados para que la economía sea difícil de farmear:
 * - una sola espera para todos los trabajos (cambiar de trabajo no saltea la espera);
 * - tope de turnos por día del casino (global: varios servidores no suman más);
 * - las cuentas de Discord nuevas no pueden trabajar (anti cuentas alternativas);
 * - los mejores trabajos se desbloquean con experiencia (turnos trabajados), y el mejor pagado tiene riesgo de multa.
 * El sueldo sale de crypto (no de Math.random) y cada turno es una sola transacción.
 */

export type JobId = 'pedidosya' | 'cirujeo' | 'informes' | 'verdulero' | 'hacker';

export interface Outcome {
  /** Peso relativo (probabilidad = peso / suma). */
  weight: number;
  /** Rango del sueldo base (antes del % configurado). Negativo = multa. */
  min: number;
  max: number;
  kind: 'ok' | 'great' | 'bad' | 'fine';
  texts: string[];
}

export interface Job {
  id: JobId;
  name: string;
  emoji: string;
  description: string;
  /** Turnos trabajados (en cualquier trabajo) para desbloquearlo. */
  requires: number;
  outcomes: Outcome[];
}

/** Ordenados del que menos paga al que más (el orden también es el de desbloqueo). */
export const JOBS: Job[] = [
  {
    id: 'cirujeo', name: 'Cirujeando', emoji: '🗑️', requires: 0,
    description: 'Revolvé la calle buscando algo para vender. Muy variable.',
    outcomes: [
      { weight: 50, min: 5, max: 25, kind: 'ok', texts: ['Juntaste cartón y latas.', 'Vendiste unas botellas de vidrio.', 'Encontraste cables con un poco de cobre.'] },
      { weight: 35, min: 0, max: 5, kind: 'bad', texts: ['Hoy no apareció nada que sirva.', 'Un perro te corrió tres cuadras.'] },
      { weight: 15, min: 50, max: 90, kind: 'great', texts: ['¡Alguien tiró una tostadora que anda!', 'Encontraste una bici vieja y la vendiste.'] },
    ],
  },
  {
    id: 'pedidosya', name: 'Pedidos Ya', emoji: '🛵', requires: 0,
    description: 'Repartí pedidos en bici. Paga poco pero casi siempre.',
    outcomes: [
      { weight: 70, min: 20, max: 35, kind: 'ok', texts: ['Hiciste {n} entregas por el centro.', 'Repartiste empanadas toda la tarde.', 'Llevaste sushi a tres departamentos sin ascensor.'] },
      { weight: 20, min: 35, max: 50, kind: 'great', texts: ['Llovía y te dejaron buena propina.', 'Un cliente te dio propina en efectivo. 🙌'] },
      { weight: 10, min: 5, max: 10, kind: 'bad', texts: ['Se te pinchó la rueda a mitad de camino.', 'Te cancelaron el pedido cuando ya habías llegado.'] },
    ],
  },
  {
    id: 'verdulero', name: 'Verdulero', emoji: '🥬', requires: 5,
    description: 'Atendé la verdulería del barrio. Estable. Requiere 5 turnos de experiencia.',
    outcomes: [
      { weight: 80, min: 30, max: 45, kind: 'ok', texts: ['Vendiste {n} kilos de papa.', 'Armaste la vidriera de frutas.', 'Atendiste a todo el barrio un sábado.'] },
      { weight: 12, min: 45, max: 60, kind: 'great', texts: ['Llegó un pedido grande de un restaurante.'] },
      { weight: 8, min: 10, max: 20, kind: 'bad', texts: ['Se te pudrió un cajón de tomates.'] },
    ],
  },
  {
    id: 'informes', name: 'Vender informes', emoji: '📄', requires: 15,
    description: 'Escribí y vendé informes. Paga mejor. Requiere 15 turnos de experiencia.',
    outcomes: [
      { weight: 65, min: 35, max: 55, kind: 'ok', texts: ['Vendiste un informe de mercado.', 'Te encargaron un informe técnico.'] },
      { weight: 20, min: 55, max: 80, kind: 'great', texts: ['Una empresa te compró tres informes juntos.'] },
      { weight: 15, min: 0, max: 10, kind: 'bad', texts: ['El cliente nunca pagó.', 'Te rechazaron el informe por errores de formato.'] },
    ],
  },
  {
    id: 'hacker', name: 'Hacker', emoji: '💻', requires: 40,
    description: 'Contratos de seguridad informática. El que más paga, pero te pueden multar. Requiere 40 turnos.',
    outcomes: [
      { weight: 50, min: 70, max: 110, kind: 'ok', texts: ['Encontraste una vulnerabilidad y cobraste la recompensa.', 'Auditaste un servidor para una pyme.'] },
      { weight: 15, min: 140, max: 200, kind: 'great', texts: ['¡Programa de recompensas! Encontraste un fallo crítico.'] },
      { weight: 35, min: -60, max: -25, kind: 'fine', texts: ['Te pasaste del alcance del contrato y te multaron.', 'Rompiste producción: pagás los daños.'] },
    ],
  },
];

export function jobOf(raw: string | null | undefined): Job | null {
  if (!raw) return null;
  const v = raw.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[\s_-]+/g, '');
  const aliases: Record<string, JobId> = {
    pedidosya: 'pedidosya', pedidos: 'pedidosya', delivery: 'pedidosya', repartidor: 'pedidosya', py: 'pedidosya',
    cirujeando: 'cirujeo', cirujeo: 'cirujeo', ciruja: 'cirujeo', cirujear: 'cirujeo',
    venderinformes: 'informes', informes: 'informes', informe: 'informes',
    verdulero: 'verdulero', verduleria: 'verdulero', verdura: 'verdulero',
    hacker: 'hacker', hackear: 'hacker', hack: 'hacker',
  };
  const id = aliases[v];
  return id ? JOBS.find((j) => j.id === id)! : null;
}

/** Entero uniforme en [0, n) — inyectable para los tests. */
export type Roll = (n: number) => number;
export const cryptoRoll: Roll = (n) => crypto.randomInt(n);

export interface WorkStatus {
  shifts: number;
  todayShifts: number;
  maxPerDay: number;
  /** Cuándo se puede volver a trabajar (0 = ya). */
  readyAt: number;
}

export function workStatus(ctx: GameContext, userId: string): WorkStatus {
  const cfg = getCasinoConfig(ctx);
  const now = ctx.now();
  const u = ctx.db.get<{ work_shifts: number; last_work_at: number | null }>('SELECT work_shifts, last_work_at FROM casino_users WHERE user_id = ?', userId);
  const today = ctx.db.get<{ shifts: number }>('SELECT shifts FROM casino_work WHERE user_id = ? AND day = ?', userId, casinoDay(cfg, now))?.shifts ?? 0;
  const byCooldown = u?.last_work_at ? u.last_work_at + cfg.work.cooldownMinutes * 60_000 : 0;
  const byCap = today >= cfg.work.maxShiftsPerDay ? casinoDayStart(cfg, now) + 86_400_000 : 0;
  const readyAt = Math.max(byCooldown, byCap);
  return { shifts: u?.work_shifts ?? 0, todayShifts: today, maxPerDay: cfg.work.maxShiftsPerDay, readyAt: readyAt > now ? readyAt : 0 };
}

export interface WorkResult {
  job: Job;
  kind: Outcome['kind'];
  text: string;
  /** Positivo = cobró; negativo = pagó una multa. */
  amount: number;
  balance: number;
  status: WorkStatus;
  unlocked: Job[];
}

export function doWork(ctx: GameContext, userId: string, guildId: string | null, jobId: JobId, accountCreatedAt: number, roll: Roll = cryptoRoll): WorkResult {
  const job = JOBS.find((j) => j.id === jobId);
  if (!job) throw new GameError('Ese trabajo no existe.');
  return ctx.db.transaction(() => {
    const cfg = getCasinoConfig(ctx);
    if (!cfg.work.enabled) throw new GameError('🔒 Los trabajos están cerrados por ahora.');
    const now = ctx.now();
    if (now - accountCreatedAt < cfg.work.minAccountDays * 86_400_000) throw new GameError(`Tu cuenta de Discord tiene que tener al menos ${cfg.work.minAccountDays} días para trabajar.`);
    ensureCasinoUser(ctx, userId);
    assertNotBlocked(ctx, userId);
    const st = workStatus(ctx, userId);
    if (st.shifts < job.requires) throw new GameError(`${job.emoji} **${job.name}** requiere ${job.requires} turnos de experiencia (tenés ${st.shifts}).`);
    if (st.readyAt) {
      throw new GameError(st.todayShifts >= st.maxPerDay
        ? `Ya hiciste los ${st.maxPerDay} turnos de hoy. Volvé <t:${Math.ceil(st.readyAt / 1000)}:R>.`
        : `Estás cansado. Podés volver a trabajar <t:${Math.ceil(st.readyAt / 1000)}:R>.`, st.readyAt);
    }
    // La espera se marca con un UPDATE condicional: dos comandos a la vez no cobran dos turnos.
    const last = ctx.db.get<{ last_work_at: number | null }>('SELECT last_work_at FROM casino_users WHERE user_id = ?', userId)!.last_work_at;
    const upd = ctx.db.run('UPDATE casino_users SET last_work_at = ?, work_shifts = work_shifts + 1, last_active_at = ? WHERE user_id = ? AND last_work_at IS ?', now, now, userId, last);
    if (upd.changes !== 1) throw new GameError('Ya estás trabajando.');

    const total = job.outcomes.reduce((s, o) => s + o.weight, 0);
    let r = roll(total);
    const outcome = job.outcomes.find((o) => (r -= o.weight) < 0) ?? job.outcomes[0];
    const base = outcome.min + roll(outcome.max - outcome.min + 1);
    let amount = Math.trunc((base * cfg.work.payPct) / 100);
    const balanceBefore = getBalance(ctx, userId);
    if (amount < 0) amount = -Math.min(-amount, balanceBefore); // la multa nunca deja saldo negativo
    if (amount > 0) applyTx(ctx, { userId, amount, type: 'WORK', guildId, meta: { job: job.id, kind: outcome.kind } });
    else if (amount < 0) applyTx(ctx, { userId, amount, type: 'FINE', guildId, meta: { job: job.id } });

    const day = casinoDay(cfg, now);
    ctx.db.run(`INSERT INTO casino_work (user_id, day, shifts, earned) VALUES (?, ?, 1, ?)
                ON CONFLICT (user_id, day) DO UPDATE SET shifts = shifts + 1, earned = earned + excluded.earned`, userId, day, amount);
    touchUser(ctx, userId, guildId);
    const status = workStatus(ctx, userId);
    const unlocked = JOBS.filter((j) => j.requires === status.shifts && j.requires > 0);
    const text = outcome.texts[roll(outcome.texts.length)].replace('{n}', String(3 + roll(8)));
    return { job, kind: outcome.kind, text, amount, balance: getBalance(ctx, userId), status, unlocked };
  });
}

/** Sueldo esperado de un turno (para mostrar y para los tests de balance). */
export function expectedPay(job: Job, payPct = 100): number {
  const total = job.outcomes.reduce((s, o) => s + o.weight, 0);
  return (job.outcomes.reduce((s, o) => s + (o.weight / total) * ((o.min + o.max) / 2), 0) * payPct) / 100;
}

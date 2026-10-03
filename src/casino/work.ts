import crypto from 'node:crypto';
import { GameError, type GameContext } from '../services/context';
import { casinoDay, casinoDayStart, getCasinoConfig } from './config';
import { applyTx, ensureCasinoUser, getBalance } from './economy';
import { assertNotBlocked, touchUser } from './users';

/**
 * !work — trabajos con riesgo:
 * - cada trabajo tiene su probabilidad de salir bien, su rango de sueldo y, los más caros, una fianza;
 * - si sale bien, cobrás el sueldo; si sale mal, no cobrás y perdés la fianza;
 * - cada trabajo tiene su propia espera (1 hora): mientras uno descansa, podés hacer otro;
 * - cupo diario de ganancias (global: varios servidores no suman más) y racha de días trabajados;
 * - las cuentas de Discord nuevas no pueden trabajar (anti cuentas alternativas).
 * El azar sale de crypto (no de Math.random) y cada turno es una sola transacción.
 */

export type JobId =
  | 'cirujeo' | 'pedidosya' | 'lavacoches' | 'paseador' | 'verdulero' | 'plomero'
  | 'informes' | 'dj' | 'hacker' | 'revendedor' | 'cazatesoros';

export type Risk = 'Seguro' | 'Moderado' | 'Arriesgado';

export interface Job {
  id: JobId;
  name: string;
  emoji: string;
  risk: Risk;
  /** Probabilidad de que salga bien (%). */
  chance: number;
  /** Sueldo si sale bien (antes del % configurado y la racha). */
  min: number;
  max: number;
  /** Se pierde si sale mal (0 = sin fianza). Hay que tenerla para tomar el trabajo. */
  bail: number;
  success: string[];
  fail: string[];
}

/** Ordenados del más barato y seguro al más caro y arriesgado. */
export const JOBS: Job[] = [
  {
    id: 'cirujeo', name: 'Cirujeando', emoji: '🗑️', risk: 'Seguro', chance: 100, min: 10, max: 30, bail: 0,
    success: ['Juntaste cartón y latas.', 'Vendiste unas botellas de vidrio.', 'Encontraste cables con un poco de cobre.', 'Alguien tiró una tostadora que anda.'],
    fail: [],
  },
  {
    id: 'pedidosya', name: 'Pedidos Ya', emoji: '🛵', risk: 'Seguro', chance: 100, min: 15, max: 35, bail: 0,
    success: ['Hiciste {n} entregas por el centro.', 'Repartiste empanadas toda la tarde.', 'Llevaste sushi a tres departamentos sin ascensor.', 'Llovía y te dejaron buena propina.'],
    fail: [],
  },
  {
    id: 'lavacoches', name: 'Lavacoches', emoji: '🧽', risk: 'Seguro', chance: 100, min: 20, max: 40, bail: 0,
    success: ['Lavaste {n} autos en la esquina.', 'Dejaste una camioneta brillando.', 'Un taxista te pagó el lavado completo.'],
    fail: [],
  },
  {
    id: 'paseador', name: 'Paseador de perros', emoji: '🐕', risk: 'Moderado', chance: 90, min: 25, max: 55, bail: 0,
    success: ['Paseaste {n} perros por la plaza.', 'Un ovejero te arrastró pero llegaron todos.', 'Los dueños quedaron contentos y te pagaron extra.'],
    fail: ['Se te escapó un caniche y no cobraste.', 'Los perros se pelearon y te echaron.'],
  },
  {
    id: 'verdulero', name: 'Verdulero', emoji: '🥬', risk: 'Moderado', chance: 85, min: 40, max: 90, bail: 10,
    success: ['Vendiste {n} kilos de papa.', 'Armaste la vidriera de frutas.', 'Llegó un pedido grande de un restaurante.'],
    fail: ['Se te pudrió un cajón de tomates.', 'Te dieron un billete falso.'],
  },
  {
    id: 'plomero', name: 'Plomero', emoji: '🔧', risk: 'Moderado', chance: 75, min: 75, max: 165, bail: 20,
    success: ['Destapaste {n} cañerías.', 'Arreglaste una pérdida en un edificio.', 'Cambiaste el termotanque de una casa.'],
    fail: ['Inundaste la cocina del cliente.', 'Rompiste un caño y pagaste el repuesto.'],
  },
  {
    id: 'informes', name: 'Vender informes', emoji: '📄', risk: 'Moderado', chance: 70, min: 110, max: 240, bail: 30,
    success: ['Vendiste un informe de mercado.', 'Te encargaron un informe técnico.', 'Una empresa te compró tres informes juntos.'],
    fail: ['El cliente nunca pagó.', 'Te rechazaron el informe por errores de formato.'],
  },
  {
    id: 'dj', name: 'DJ de fiestas', emoji: '🎧', risk: 'Moderado', chance: 60, min: 200, max: 420, bail: 60,
    success: ['La pista explotó toda la noche.', 'Te contrataron para un casamiento.', 'Tocaste en una fiesta de {n} personas.'],
    fail: ['Se cortó la luz y no cobraste.', 'Se te quemó un parlante alquilado.'],
  },
  {
    id: 'hacker', name: 'Hacker', emoji: '💻', risk: 'Arriesgado', chance: 45, min: 450, max: 1_000, bail: 150,
    success: ['Encontraste una vulnerabilidad y cobraste la recompensa.', 'Auditaste un servidor para una pyme.', '¡Encontraste un fallo crítico en un programa de recompensas!'],
    fail: ['Te pasaste del alcance del contrato y te multaron.', 'Rompiste producción y pagaste los daños.'],
  },
  {
    id: 'revendedor', name: 'Revendedor de entradas', emoji: '🎟️', risk: 'Arriesgado', chance: 40, min: 600, max: 1_400, bail: 200,
    success: ['Vendiste {n} entradas para el recital.', 'Conseguiste entradas para la final y las revendiste.'],
    fail: ['Suspendieron el show y te quedaste con las entradas.', 'Te las compraron con una transferencia falsa.'],
  },
  {
    id: 'cazatesoros', name: 'Cazatesoros', emoji: '🗺️', risk: 'Arriesgado', chance: 35, min: 1_100, max: 2_500, bail: 300,
    success: ['Encontraste un cofre en una isla perdida.', 'Desenterraste monedas antiguas.', 'El mapa era real: ¡tesoro!'],
    fail: ['El mapa era falso y perdiste el equipo.', 'Te robaron el tesoro antes de volver.'],
  },
];

export const RISK_EMOJI: Record<Risk, string> = { Seguro: '🟢', Moderado: '🟡', Arriesgado: '🔴' };

export function jobOf(raw: string | null | undefined): Job | null {
  if (!raw) return null;
  const v = raw.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[\s_-]+/g, '');
  const aliases: Record<string, JobId> = {
    cirujeando: 'cirujeo', cirujeo: 'cirujeo', ciruja: 'cirujeo', cirujear: 'cirujeo',
    pedidosya: 'pedidosya', pedidos: 'pedidosya', delivery: 'pedidosya', repartidor: 'pedidosya', py: 'pedidosya',
    lavacoches: 'lavacoches', lavaautos: 'lavacoches', lavar: 'lavacoches',
    paseadordeperros: 'paseador', paseador: 'paseador', perros: 'paseador',
    verdulero: 'verdulero', verduleria: 'verdulero', verdura: 'verdulero',
    plomero: 'plomero', plomeria: 'plomero',
    venderinformes: 'informes', informes: 'informes', informe: 'informes',
    djdefiestas: 'dj', dj: 'dj',
    hacker: 'hacker', hackear: 'hacker', hack: 'hacker',
    revendedordeentradas: 'revendedor', revendedor: 'revendedor', reventa: 'revendedor', entradas: 'revendedor',
    cazatesoros: 'cazatesoros', tesoro: 'cazatesoros', tesoros: 'cazatesoros',
  };
  const id = aliases[v] ?? JOBS.find((j) => j.id === v)?.id;
  return id ? JOBS.find((j) => j.id === id)! : null;
}

/** Entero uniforme en [0, n) — inyectable para los tests. */
export type Roll = (n: number) => number;
export const cryptoRoll: Roll = (n) => crypto.randomInt(n);

export interface WorkStatus {
  /** Turnos trabajados en total. */
  shifts: number;
  /** Días seguidos trabajando (0 si se cortó). */
  streak: number;
  /** % extra de sueldo por la racha. */
  streakBonusPct: number;
  earnedToday: number;
  dailyCap: number;
  remaining: number;
  /** Cuándo se renueva el cupo. */
  resetAt: number;
  /** Cuándo vuelve a estar listo cada trabajo (0 = ya). */
  jobs: Record<JobId, number>;
  /** Trabajos listos ahora. */
  readyCount: number;
}

const yesterdayOf = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export function streakBonusPct(streak: number, pct: number, maxDays: number): number {
  return Math.min(Math.max(0, streak - 1), maxDays) * pct;
}

export function workStatus(ctx: GameContext, userId: string): WorkStatus {
  const cfg = getCasinoConfig(ctx);
  const now = ctx.now();
  const today = casinoDay(cfg, now);
  const shifts = ctx.db.get<{ work_shifts: number }>('SELECT work_shifts FROM casino_users WHERE user_id = ?', userId)?.work_shifts ?? 0;
  const earned = ctx.db.get<{ earned: number }>('SELECT earned FROM casino_work WHERE user_id = ? AND day = ?', userId, today)?.earned ?? 0;
  const s = ctx.db.get<{ streak: number; last_day: string }>('SELECT streak, last_day FROM casino_work_streaks WHERE user_id = ?', userId);
  const streak = s && (s.last_day === today || s.last_day === yesterdayOf(today)) ? s.streak : 0;
  const cd = cfg.work.cooldownMinutes * 60_000;
  const last = new Map(ctx.db.all<{ job_id: string; last_at: number }>('SELECT job_id, last_at FROM casino_job_cooldowns WHERE user_id = ?', userId).map((r) => [r.job_id, r.last_at]));
  const jobs = {} as Record<JobId, number>;
  for (const j of JOBS) {
    const at = (last.get(j.id) ?? -Infinity) + cd;
    jobs[j.id] = at > now ? at : 0;
  }
  const dailyCap = cfg.work.dailyCap;
  return {
    shifts,
    streak,
    streakBonusPct: streakBonusPct(streak, cfg.work.streakPct, cfg.work.streakMaxDays),
    earnedToday: Math.max(0, earned),
    dailyCap,
    remaining: Math.max(0, dailyCap - Math.max(0, earned)),
    resetAt: casinoDayStart(cfg, now) + 86_400_000,
    jobs,
    readyCount: JOBS.filter((j) => !jobs[j.id]).length,
  };
}

export interface WorkResult {
  job: Job;
  success: boolean;
  text: string;
  /** Positivo = cobró; negativo = perdió la fianza; 0 = no ganó nada. */
  amount: number;
  /** El sueldo se recortó por el cupo diario. */
  capped: boolean;
  balance: number;
  status: WorkStatus;
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
    if (st.jobs[job.id]) {
      throw new GameError(`${job.emoji} **${job.name}** vuelve a estar listo <t:${Math.ceil(st.jobs[job.id] / 1000)}:R>. Mientras, podés hacer otro trabajo.`, st.jobs[job.id]);
    }
    if (st.remaining <= 0) {
      throw new GameError(`Ya llegaste al cupo de hoy (🪙 ${st.dailyCap.toLocaleString('es-AR')}). Se renueva <t:${Math.ceil(st.resetAt / 1000)}:R>.`, st.resetAt);
    }
    const balanceBefore = getBalance(ctx, userId);
    if (job.bail > balanceBefore) {
      throw new GameError(`${job.emoji} **${job.name}** pide una fianza de 🪙 **${job.bail.toLocaleString('es-AR')}** (la perdés si sale mal). Tenés 🪙 ${balanceBefore.toLocaleString('es-AR')}.`);
    }
    // La espera se marca con un upsert condicional: dos comandos a la vez no cobran dos turnos del mismo trabajo.
    const cd = cfg.work.cooldownMinutes * 60_000;
    const mark = ctx.db.run(
      `INSERT INTO casino_job_cooldowns (user_id, job_id, last_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, job_id) DO UPDATE SET last_at = excluded.last_at WHERE casino_job_cooldowns.last_at <= ?`,
      userId, job.id, now, now - cd,
    );
    if (mark.changes !== 1) throw new GameError('Ya estás haciendo ese trabajo.');
    ctx.db.run('UPDATE casino_users SET work_shifts = work_shifts + 1, last_work_at = ?, last_active_at = ? WHERE user_id = ?', now, now, userId);

    // Racha: días seguidos trabajando (cuenta una vez por día).
    const today = casinoDay(cfg, now);
    const prev = ctx.db.get<{ streak: number; last_day: string }>('SELECT streak, last_day FROM casino_work_streaks WHERE user_id = ?', userId);
    const streak = !prev ? 1 : prev.last_day === today ? prev.streak : prev.last_day === yesterdayOf(today) ? prev.streak + 1 : 1;
    ctx.db.run(`INSERT INTO casino_work_streaks (user_id, streak, last_day) VALUES (?, ?, ?)
                ON CONFLICT (user_id) DO UPDATE SET streak = excluded.streak, last_day = excluded.last_day`, userId, streak, today);

    const success = roll(100) < job.chance;
    let amount = 0;
    let capped = false;
    if (success) {
      const base = job.min + roll(job.max - job.min + 1);
      const bonus = streakBonusPct(streak, cfg.work.streakPct, cfg.work.streakMaxDays);
      const pay = Math.trunc((base * cfg.work.payPct * (100 + bonus)) / 10_000);
      amount = Math.min(pay, st.remaining);
      capped = amount < pay;
      if (amount > 0) applyTx(ctx, { userId, amount, type: 'WORK', guildId, meta: { job: job.id, streak, bonus } });
    } else if (job.bail > 0) {
      amount = -Math.min(job.bail, balanceBefore); // la fianza nunca deja saldo negativo
      applyTx(ctx, { userId, amount, type: 'FINE', guildId, meta: { job: job.id, bail: job.bail } });
    }
    // El cupo cuenta solo lo cobrado (perder una fianza no lo devuelve).
    ctx.db.run(`INSERT INTO casino_work (user_id, day, shifts, earned) VALUES (?, ?, 1, ?)
                ON CONFLICT (user_id, day) DO UPDATE SET shifts = shifts + 1, earned = earned + excluded.earned`, userId, today, Math.max(0, amount));
    touchUser(ctx, userId, guildId);
    const texts = success || !job.fail.length ? job.success : job.fail;
    const text = texts[roll(texts.length)].replace('{n}', String(3 + roll(8)));
    return { job, success, text, amount, capped, balance: getBalance(ctx, userId), status: workStatus(ctx, userId) };
  });
}

/** Ganancia esperada de un turno (sueldo promedio × probabilidad − fianza × probabilidad de fallar). */
export function expectedPay(job: Job, payPct = 100): number {
  const p = job.chance / 100;
  return (p * ((job.min + job.max) / 2) * payPct) / 100 - (1 - p) * job.bail;
}

/** Límite de acciones por usuario (comandos, botones y menús): 8 cada 10 s; 5 choques en una hora = aviso al staff. */
export const ANTISPAM = { actionsPerWindow: 8, windowSeconds: 10, flagThreshold: 5 } as const;
/** Botones de los juegos del casino: 20 cada 10 s (más que eso es un autoclicker). */
export const ANTISPAM_GAMES = { actionsPerWindow: 20, windowSeconds: 10, flagThreshold: 5 } as const;

/**
 * Limitador en memoria por usuario (ventana deslizante). No necesita persistir:
 * tras un reinicio el límite simplemente vuelve a empezar.
 * Además cuenta cuántas veces alguien choca contra el límite para avisar a los admins.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly strikes = new Map<string, { count: number; since: number; flagged: boolean }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Devuelve 'ok', 'limited' o 'flag' (limitado y además superó el umbral de sospecha). */
  check(key: string, maxActions: number, windowMs: number, flagThreshold: number): 'ok' | 'limited' | 'flag' {
    const now = this.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= maxActions) {
      this.hits.set(key, list);
      const s = this.strikes.get(key);
      const strike = s && now - s.since < 3_600_000 ? s : { count: 0, since: now, flagged: false };
      strike.count += 1;
      this.strikes.set(key, strike);
      if (strike.count >= flagThreshold && !strike.flagged) {
        strike.flagged = true;
        return 'flag';
      }
      return 'limited';
    }
    list.push(now);
    this.hits.set(key, list);
    return 'ok';
  }

  sweep(): void {
    const now = this.now();
    for (const [k, v] of this.hits) if (v.every((t) => now - t > 120_000)) this.hits.delete(k);
    for (const [k, v] of this.strikes) if (now - v.since > 3_600_000) this.strikes.delete(k);
  }
}

/**
 * Candado por clave: si una acción del mismo usuario ya está en curso, la segunda se descarta.
 * Protege las partes asíncronas (respuestas a Discord, cambios de roles) contra clics dobles.
 */
export class KeyedLock {
  private readonly busy = new Set<string>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.busy.has(key)) return { ran: false };
    this.busy.add(key);
    try {
      return { ran: true, value: await fn() };
    } finally {
      this.busy.delete(key);
    }
  }

  isBusy(key: string): boolean {
    return this.busy.has(key);
  }
}

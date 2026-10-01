import { ApiError } from './api';

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const num = (n: number) => Math.floor(n).toLocaleString('es-AR');
export const kg = (n: number) => `${n.toLocaleString('es-AR', { maximumFractionDigits: 2 })} kg`;

/** Reloj sincronizado con el servidor (las esperas las decide el servidor). */
export const clock = {
  offset: 0,
  sync(serverNow: number) { this.offset = serverNow - Date.now(); },
  now() { return Date.now() + this.offset; },
};

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function vigorNow(v: { current: number; max: number; regenMs: number }, serverNow: number): number {
  return Math.min(v.max, v.current + Math.max(0, clock.now() - serverNow) / v.regenMs);
}

export function toast(text: string, kind: 'ok' | 'warn' | 'error' = 'ok'): void {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

export function reportError(err: unknown): void {
  toast(err instanceof Error ? err.message : 'Algo salió mal.', err instanceof ApiError && err.status < 500 ? 'warn' : 'error');
}

export function showLevelUp(skill: string, lv: { to: number; coins: number; reachedMax: boolean }, currency: string): void {
  const ov = $('#overlay');
  const confetti = Array.from({ length: 28 }, (_, i) =>
    `<span class="confetti" style="--x:${(i * 37) % 100}%;--d:${(i % 7) * 0.12}s;--h:${(i * 47) % 360}"></span>`).join('');
  ov.innerHTML = `<div class="levelup">${confetti}
    <div class="levelup-card">
      <div class="levelup-badge">${lv.to}</div>
      <h2>¡Subiste de nivel!</h2>
      <p>${esc(skill)} ahora es nivel <b>${lv.to}</b>.</p>
      ${lv.coins ? `<p class="levelup-coins">+${num(lv.coins)} ${esc(currency)}</p>` : ''}
      ${lv.reachedMax ? '<p>👑 ¡Alcanzaste el nivel máximo!</p>' : ''}
      <button class="btn btn-primary" id="levelup-close">Seguir jugando</button>
    </div></div>`;
  ov.hidden = false;
  $('#levelup-close').onclick = () => { ov.hidden = true; ov.innerHTML = ''; };
}

/** Actualiza las monedas del encabezado (cada sección las recibe en su estado). */
export function setCoins(coins: number, emoji: string): void {
  const el = document.getElementById('coins');
  if (el) el.textContent = `${emoji} ${num(coins)}`;
}

export function reqList(reqs: { label: string; ok: boolean }[]): string {
  return `<ul class="reqs">${reqs.map((r) => `<li class="${r.ok ? 'ok' : 'no'}">${r.ok ? '✓' : '✗'} ${esc(r.label)}</li>`).join('')}</ul>`;
}

export interface View {
  mount(root: HTMLElement): void;
  load(): Promise<void>;
  tick(): void;
}

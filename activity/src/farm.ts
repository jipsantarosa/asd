import type { FarmState, HarvestEvent, ZoneView } from '../../src/activity/types';
import { action, auth, call } from './api';
import { $, clock, esc, fmtDuration, num, reportError, reqList, setCoins, showLevelUp, toast, vigorNow, type View } from './ui';

let state: FarmState | null = null;
let root: HTMLElement;
let tab: 'zonas' | 'granero' | 'objetos' | 'equipo' = 'zonas';
let busy = false;
let fieldZone = '';

function setState(s: FarmState): void {
  state = s;
  clock.sync(s.serverNow);
  setCoins(s.player.coins, s.currency.emoji);
  render();
}

function layout(): void {
  root.innerHTML = `
    <div class="layout">
      <section class="stage card">
        <div class="skill-row"><div class="level-badge" id="f-lvl"></div><div class="grow"><div class="skill-head"><b>Granja</b><span class="sub" id="f-xptext"></span></div><div class="bar"><div class="bar-fill xp" id="f-xpbar"></div></div></div></div>
        <div class="zone-banner" id="f-zone"></div>
        <div class="field" id="field"></div>
        <div class="action"><button class="big-btn" id="farm-btn"><span class="big-emoji">🌾</span><span class="big-label" id="farm-label">Farmear</span><span class="big-sub" id="farm-sub"></span><span class="big-progress" id="farm-progress"></span></button></div>
        <div class="meters">
          <div class="meter"><div class="meter-head"><span>⚡ Vigor</span><span id="f-vigor-text"></span></div><div class="bar"><div class="bar-fill vigor" id="f-vigorbar"></div></div><div class="sub" id="f-vigor-regen"></div></div>
          <div class="chips"><span class="chip" id="f-fatigue"></span><span class="chip" id="f-fert"></span><span class="chip" id="f-bonus"></span></div>
        </div>
        <div class="harvest" id="harvest"></div>
      </section>
      <aside class="side card">
        <nav class="tabs" id="f-tabs"><button data-tab="zonas">🗺️ Zonas</button><button data-tab="granero">🧺 Granero</button><button data-tab="objetos">🧪 Objetos</button><button data-tab="equipo">🧰 Equipo</button></nav>
        <div class="tab-body" id="f-tab"></div>
      </aside>
    </div>`;
  fieldZone = '';
  $('#farm-btn', root).onclick = () => void harvest();
  $('#f-tabs', root).onclick = (e) => {
    const t = (e.target as HTMLElement).closest('button')?.dataset.tab as typeof tab | undefined;
    if (t) { tab = t; renderTab(); }
  };
  $('#f-tab', root).onclick = (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.zone) void changeZone(b.dataset.zone);
    if (b.dataset.use) void useItem(b.dataset.use);
  };
}

function render(): void {
  const s = state;
  if (!s || !root) return;
  if (!$('#farm-btn', root)) layout();
  $('#f-lvl', root).textContent = String(s.player.level);
  $('#f-xpbar', root).style.width = s.player.atMax ? '100%' : `${Math.min(100, (s.player.xp / Math.max(1, s.player.need)) * 100)}%`;
  $('#f-xptext', root).textContent = s.player.atMax ? '👑 Nivel máximo' : `${num(s.player.xp)} / ${num(s.player.need)} XP · ${num(s.player.farmsTotal)} cosechas`;
  $('#f-zone', root).innerHTML = `<span class="zone-emoji">${s.zone.emoji}</span><div><b>${esc(s.zone.name)}</b><div class="sub">${esc(s.zone.description)}</div></div>`;
  $('#f-fatigue', root).textContent = `${s.fatigue.multiplier >= 1 ? '🟢' : s.fatigue.multiplier > 0.7 ? '🟡' : '🔴'} ${s.fatigue.label}${s.fatigue.multiplier < 1 ? ` · ${Math.round(s.fatigue.multiplier * 100)}%` : ''}`;
  $('#f-fert', root).textContent = s.fertilizer > 0 ? `🌿 Abono · ${s.fertilizer}` : '🌿 Sin abono';
  $('#f-bonus', root).textContent = `📦 ×${s.bonuses.yield.toFixed(2)} cosecha`;
  if (fieldZone !== s.zone.id) {
    fieldZone = s.zone.id;
    const crops = s.zone.crops.length ? s.zone.crops : [{ name: '', emoji: '🌾' }];
    $('#field', root).innerHTML = Array.from({ length: 12 }, (_, i) =>
      `<div class="plot" style="--i:${i}"><span class="plant" data-crop="${crops[i % crops.length].emoji}"></span></div>`).join('');
  }
  renderHarvest(s.last ? { drops: s.last.drops, golden: s.last.golden, fertilized: s.last.fertilized, xp: s.last.xp, fatigueMult: 1, levelUp: null, achievements: [], activity: 0 } : null, false);
  renderTab();
  tick();
}

function renderHarvest(ev: HarvestEvent | null, fresh: boolean): void {
  const box = $('#harvest', root);
  if (!ev) { box.innerHTML = '<div class="empty">Tu primera cosecha aparecerá acá.</div>'; return; }
  const tags = [ev.golden ? '<span class="tag gold">🌟 Cosecha dorada</span>' : '', ev.fertilized ? '<span class="tag">🌿 Abonada</span>' : '',
    ev.fatigueMult < 1 ? `<span class="tag warn">😮‍💨 ${Math.round(ev.fatigueMult * 100)}%</span>` : ''].join('');
  box.innerHTML = `<div class="harvest-head"><b>${fresh ? '¡Cosecha!' : 'Última cosecha'}</b><span class="xp-gain">+${num(ev.xp)} XP</span></div>
    <div class="drops">${ev.drops.map((d, i) => `<div class="drop${d.special ? ' special' : ''}${fresh ? ' fresh' : ''}" style="--c:${d.color};--i:${i}" title="${esc(d.rarityLabel)}">
      <span class="drop-emoji">${d.emoji}</span><span class="drop-name">${esc(d.name)}</span><span class="drop-qty">×${d.qty}</span></div>`).join('') || '<div class="empty">La tierra no dio nada esta vez.</div>'}</div>
    <div class="tags">${tags}</div>`;
}

function zoneCard(z: ZoneView): string {
  return `<div class="place-card${z.current ? ' current' : ''}${z.unlocked ? '' : ' locked'}">
    <div class="place-head"><span class="zone-emoji">${z.unlocked ? z.emoji : '🔒'}</span><div><b>${esc(z.name)}</b><div class="sub">Nivel ${z.level} · ${z.vigorCost} ⚡ · ${z.baseXp} XP</div></div></div>
    <div class="place-icons">${z.crops.map((c) => `<span title="${esc(c.name)}">${c.emoji}</span>`).join('')}</div>
    ${z.unlocked
    ? `<button class="btn ${z.current ? 'btn-ghost' : 'btn-primary'}" data-zone="${esc(z.id)}" ${z.current ? 'disabled' : ''}>${z.current ? 'Trabajando acá' : 'Trabajar acá'}</button>`
    : `${reqList(z.requirements)}<div class="hint">Comprá el permiso en <code>/mercado</code> → Permisos.</div>`}
  </div>`;
}

function renderTab(): void {
  const s = state!;
  root.querySelectorAll<HTMLButtonElement>('#f-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const body = $('#f-tab', root);
  if (tab === 'zonas') body.innerHTML = `<div class="places">${s.zones.map(zoneCard).join('')}</div>`;
  if (tab === 'granero') {
    body.innerHTML = s.barn.length
      ? `<div class="grid-items">${s.barn.map((b) => `<div class="drop" style="--c:${b.color}"><span class="drop-emoji">${b.emoji}</span><span class="drop-name">${esc(b.name)}</span><b>×${num(b.qty)}</b></div>`).join('')}</div>
         <div class="hint">Vendé tu cosecha en <code>/mercado</code> → Vender. Si todos venden lo mismo, el precio baja.</div>`
      : '<div class="empty">El granero está vacío. ¡A cosechar!</div>';
  }
  if (tab === 'objetos') {
    body.innerHTML = s.consumables.length
      ? `<div class="items">${s.consumables.map((c) => `<div class="item-row"><span class="drop-emoji">${c.emoji}</span><div class="grow"><b>${esc(c.name)}</b> ×${num(c.qty)}<div class="sub">${esc(c.effect)}${c.limit ? ` · máx. ${c.limit}/día` : ''}</div></div>
          <button class="btn btn-primary" data-use="${esc(c.id)}">Usar</button></div>`).join('')}</div>`
      : '<div class="empty">No tenés objetos usables. Conseguí mate en el <code>/mercado</code> y abono pescando.</div>';
  }
  if (tab === 'equipo') {
    body.innerHTML = `<div class="items">${s.equipment.map((e) => `<div class="item-row"><span class="drop-emoji">${e.emoji}</span><div class="grow"><div class="sub">${esc(e.slot)}</div><b>${esc(e.name)}</b></div></div>`).join('')}</div>
      <div class="stats"><div><span>Cosecha</span><b>×${s.bonuses.yield.toFixed(2)}</b></div><div><span>Ahorro de vigor</span><b>${Math.round(s.bonuses.vigorDiscount * 100)}%</b></div>
      <div><span>Vigor máximo</span><b>${s.vigor.max}</b></div><div><span>Nivel total</span><b>${s.player.totalLevel}</b></div></div>
      <div class="hint">Mejorá herramientas, accesorios y bonificaciones en <code>/mercado</code>.</div>`;
  }
}

function tick(): void {
  const s = state;
  if (!s || !root || !$('#farm-btn', root)) return;
  const now = clock.now();
  const vigor = vigorNow(s.vigor, s.serverNow);
  $('#f-vigorbar', root).style.width = `${(vigor / s.vigor.max) * 100}%`;
  $('#f-vigor-text', root).textContent = `${Math.floor(vigor)} / ${s.vigor.max}`;
  $('#f-vigor-regen', root).textContent = vigor >= s.vigor.max ? 'Lleno · compartido con la pesca' : `lleno en ${fmtDuration((s.vigor.max - vigor) * s.vigor.regenMs)} · compartido con la pesca`;

  const left = Math.max(0, s.readyAt - now);
  const growth = s.cooldownMs > 0 ? 1 - left / s.cooldownMs : 1;
  const stage = left > 0 ? Math.min(2, Math.floor(growth * 3)) : 3;
  root.querySelectorAll<HTMLElement>('.plant').forEach((p) => {
    p.dataset.stage = String(stage);
    p.textContent = stage === 3 ? p.dataset.crop! : stage === 2 ? '🌿' : stage === 1 ? '🌱' : '·';
  });

  const btn = $<HTMLButtonElement>('#farm-btn', root);
  let label = 'Farmear';
  let sub = `−${s.vigor.cost} ⚡`;
  let ready = false;
  if (!s.toolOk) { label = 'Herramienta insuficiente'; sub = 'Mejorala en /mercado'; }
  else if (left > 0) { label = 'Creciendo…'; sub = fmtDuration(left); }
  else if (vigor < s.vigor.cost) { label = 'Sin vigor'; sub = `listo en ${fmtDuration((s.vigor.cost - vigor) * s.vigor.regenMs)}`; }
  else ready = true;
  btn.disabled = busy || !ready;
  btn.classList.toggle('ready', ready && !busy);
  $('#farm-label', root).textContent = busy ? 'Cosechando…' : label;
  $('#farm-sub', root).textContent = sub;
  $('#farm-progress', root).style.width = left > 0 ? `${growth * 100}%` : '0%';
}

async function harvest(): Promise<void> {
  if (busy || !state) return;
  busy = true;
  tick();
  const field = $('#field', root);
  field.classList.add('reaping');
  try {
    const r = await action<{ event: HarvestEvent; state: FarmState }>('/farm/harvest');
    setState(r.state);
    renderHarvest(r.event, true);
    if (r.event.golden) {
      document.body.classList.add('golden');
      setTimeout(() => document.body.classList.remove('golden'), 1600);
    }
    const float = document.createElement('div');
    float.className = 'float-xp';
    float.textContent = `+${num(r.event.xp)} XP`;
    $('.action', root).appendChild(float);
    setTimeout(() => float.remove(), 1300);
    if (r.event.drops.some((d) => d.special)) toast('✨ ¡Encontraste algo especial!');
    for (const a of r.event.achievements) toast(`🏅 ¡Logro desbloqueado! ${a.emoji} ${a.name}`);
    if (r.event.levelUp) showLevelUp('Tu granja', r.event.levelUp, r.state.currency.name);
  } catch (err) {
    reportError(err);
    await farmView.load().catch(() => undefined);
  } finally {
    busy = false;
    setTimeout(() => field.classList.remove('reaping'), 450);
    tick();
  }
}

async function changeZone(zone: string): Promise<void> {
  try {
    const r = await action<{ notice: string; state: FarmState }>('/farm/zone', { zone });
    setState(r.state);
    toast(r.notice);
  } catch (err) {
    reportError(err);
  }
}

async function useItem(item: string): Promise<void> {
  try {
    const r = await action<{ notice: string; state: FarmState }>('/farm/use', { item });
    setState(r.state);
    toast(r.notice.replace(/\*\*/g, ''));
  } catch (err) {
    reportError(err);
  }
}

export const farmView: View = {
  mount(el) {
    root = el;
    root.innerHTML = '';
    if (state) render();
  },
  async load() {
    const r = await call<{ state: FarmState }>(`/farm?guild=${auth.guildId}`);
    setState(r.state);
  },
  tick,
};

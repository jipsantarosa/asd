import type { CastView, FishState } from '../../src/activity/types';
import { action, auth, call } from './api';
import { $, clock, esc, fmtDuration, kg, num, reportError, setCoins, showLevelUp, toast, vigorNow, type View } from './ui';

let state: FishState | null = null;
let root: HTMLElement;
let tab: 'suerte' | 'canas' | 'coleccion' = 'suerte';
let busy = false;
let last: CastView | null = null;

const pct = (x: number) => `${(x * 100).toLocaleString('es-AR', { maximumFractionDigits: x < 0.01 ? 2 : 1 })}%`;

function setState(s: FishState): void {
  state = s;
  clock.sync(s.serverNow);
  setCoins(s.player.coins, s.currency.emoji);
  render();
}

function layout(): void {
  root.innerHTML = `
    <div class="layout">
      <section class="stage card">
        <div class="skill-row"><div class="level-badge fish" id="p-lvl"></div><div class="grow"><div class="skill-head"><b>Pesca</b><span class="sub" id="p-xptext"></span></div><div class="bar"><div class="bar-fill xp-fish" id="p-xpbar"></div></div></div></div>
        <div class="lake idle" id="lake">
          <div class="wave w1"></div><div class="wave w2"></div>
          <div class="line"></div><div class="bobber"></div><div class="ripple" id="ripple"></div>
        </div>
        <div class="action"><button class="big-btn fish" id="fish-btn"><span class="big-emoji">🎣</span><span class="big-label" id="fish-label">Pescar</span><span class="big-sub" id="fish-sub"></span><span class="big-progress" id="fish-progress"></span></button></div>
        <div class="meters">
          <div class="meter"><div class="meter-head"><span>⚡ Vigor</span><span id="p-vigor-text"></span></div><div class="bar"><div class="bar-fill vigor" id="p-vigorbar"></div></div></div>
          <div class="chips" id="p-chips"></div>
          <div class="meter" id="p-pity"></div>
        </div>
        <div class="harvest" id="p-result"></div>
      </section>
      <aside class="side card">
        <nav class="tabs three" id="p-tabs"><button data-tab="suerte">🎲 Suerte</button><button data-tab="canas">🎣 Cañas</button><button data-tab="coleccion">📚 Colección</button></nav>
        <div class="tab-body" id="p-tab"></div>
      </aside>
    </div>`;
  $('#fish-btn', root).onclick = () => void doFish();
  $('#p-tabs', root).onclick = (e) => {
    const t = (e.target as HTMLElement).closest('button')?.dataset.tab as typeof tab | undefined;
    if (t) { tab = t; renderTab(); }
  };
  $('#p-tab', root).onclick = (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b && !b.disabled && b.dataset.rod) void changeRod(b.dataset.rod);
  };
}

function render(): void {
  const s = state;
  if (!s || !root) return;
  if (!$('#lake', root)) layout();
  $('#p-lvl', root).textContent = String(s.player.level);
  $('#p-xpbar', root).style.width = s.player.atMax ? '100%' : `${Math.min(100, (s.player.xp / Math.max(1, s.player.need)) * 100)}%`;
  $('#p-xptext', root).textContent = s.player.atMax ? '👑 Nivel máximo' : `${num(s.player.xp)} / ${num(s.player.need)} XP · ${num(s.player.catches)} capturas`;
  const rod = s.rods.find((r) => r.equipped)!;
  $('#p-chips', root).innerHTML = [
    `<span class="chip">${s.bait.emoji} Carnada ×${num(s.bait.qty)}</span>`,
    `<span class="chip">${rod.image ? `<img class="chip-img" src="${esc(rod.image)}" alt="">` : rod.emoji} ${esc(rod.name)}</span>`,
    `<span class="chip">🍀 Suerte +${Math.round(s.loadout.luck * 100)}%</span>`,
    s.loadout.baitSave > 0 ? `<span class="chip">♻️ Ahorro ${Math.round(s.loadout.baitSave * 100)}%</span>` : '',
    ...s.buffs.map((b) => `<span class="chip buff" title="${esc(b.description)}">${b.emoji} ${esc(b.name)}${b.guildWide ? ' (servidor)' : ''}</span>`),
  ].join('');
  $('#p-pity', root).innerHTML = s.pity.threshold > 0
    ? `<div class="meter-head"><span>🧵 Racha de la suerte</span><span>${Math.min(s.pity.current, s.pity.threshold)}/${s.pity.threshold}</span></div><div class="bar"><div class="bar-fill xp" style="width:${Math.min(100, (s.pity.current / s.pity.threshold) * 100)}%"></div></div><div class="sub">Al llenarse, la próxima línea trae un Épico seguro.</div>`
    : '';
  renderResult();
  renderTab();
  tick();
}

function renderResult(): void {
  const box = $('#p-result', root);
  const c = last;
  if (!c) { box.innerHTML = '<div class="empty">Tocá <b>Pescar</b>: cada línea es una tirada de rareza.</div>'; return; }
  const extra = [
    `${state?.bait.emoji ?? '🪱'} −${c.baitUsed}${c.baitSaved ? ` (${c.baitSaved} ahorrada${c.baitSaved > 1 ? 's' : ''})` : ''}`,
    `⚡ −${c.vigorSpent}`,
    c.activity ? `🔥 +${c.activity}` : '',
    ...c.extras.map((e) => `🎁 ${e.emoji} ${esc(e.name)}`),
    ...c.collections.map((x) => `📚 Colección ${esc(x.label)} completa: +${num(x.coins)}`),
  ].filter(Boolean).map((t) => `<span class="tag">${t}</span>`).join('');
  box.innerHTML = `<div class="harvest-head"><b>Lance de ${c.lines} ${c.lines === 1 ? 'línea' : 'líneas'}</b><span class="xp-gain">+${num(c.xp)} XP</span></div>
    <div class="drops">${c.catches.map((x, i) => `<div class="drop fresh${['Épico', 'Legendario', 'Ultralegendario'].includes(x.rarityLabel) ? ' special' : ''}" style="--c:${x.color};--i:${i}" title="${esc(x.rarityLabel)}">
      <span class="drop-emoji">${x.emoji}</span><span class="drop-name">${esc(x.name)}<br><span class="sub">${esc(x.rarityLabel)} · ${kg(x.weight)}</span></span>
      <span class="drop-qty">${x.newSpecies ? '🆕' : ''}${x.echo ? '×2' : ''}${x.pity ? '🧵' : ''}</span></div>`).join('')}</div>
    <div class="tags">${extra}</div>
    ${c.lines < c.wantedLines ? `<div class="hint">Tiraste ${c.lines} de ${c.wantedLines} líneas por falta de carnada o vigor.</div>` : ''}`;
}

function renderTab(): void {
  const s = state!;
  root.querySelectorAll<HTMLButtonElement>('#p-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const body = $('#p-tab', root);
  if (tab === 'suerte') {
    body.innerHTML = `<div class="odds">${s.odds.map((o) => `<div class="odd-row"><span>${o.emoji} ${esc(o.label)}</span><div class="bar"><div class="bar-fill" style="width:${Math.max(0.6, Math.min(100, o.chance * 100 / 0.6))}%;background:${o.color}"></div></div><b>${pct(o.chance)}</b></div>`).join('')}</div>
      <div class="hint">Probabilidad de cada línea con tu suerte actual (caña + Buena estrella + potenciadores).</div>
      <div class="skill-head" style="margin-top:14px"><b>✨ Potenciadores</b></div>
      ${s.buffs.length ? `<div class="items">${s.buffs.map((b) => `<div class="item-row"><span class="drop-emoji">${b.emoji}</span><div class="grow"><b>${esc(b.name)}</b>${b.guildWide ? ' <span class="sub">(servidor)</span>' : ''}<div class="sub">${esc(b.description)}</div></div><span class="sub" data-until="${b.expiresAt}"></span></div>`).join('')}</div>`
    : '<div class="empty">Ninguno activo. Se compran en <code>/mercado</code> → Suministros o se ganan en eventos, y se activan desde la granja.</div>'}`;
  }
  if (tab === 'canas') {
    body.innerHTML = `<div class="places">${s.rods.map((r) => `<div class="place-card${r.equipped ? ' current' : ''}${r.owned ? '' : ' locked'}">
      <div class="place-head">${r.image ? `<img class="rod-img${r.owned ? '' : ' dim'}" src="${esc(r.image)}" alt="" loading="lazy">` : `<span class="zone-emoji">${r.owned ? r.emoji : '🔒'}</span>`}<div><b>${esc(r.name)}</b><div class="sub">${r.lines} líneas · suerte +${Math.round(r.luck * 100)}% · ahorro ${Math.round(r.baitSave * 100)}% · espera ${r.cooldownSeconds} s${r.special ? ` · ${esc(r.special)}` : ''}</div></div></div>
      <div class="sub">${esc(r.description)}</div>
      ${r.owned
    ? `<button class="btn ${r.equipped ? 'btn-ghost' : 'btn-primary'}" data-rod="${esc(r.id)}" ${r.equipped ? 'disabled' : ''}>${r.equipped ? 'Equipada' : 'Equipar'}</button>`
    : `<div class="hint">${s.currency.emoji} ${num(r.price)} · pesca nivel ${r.fishLevel} — se compra en <code>/mercado</code> → Cañas.</div>`}
    </div>`).join('')}</div>`;
  }
  if (tab === 'coleccion') {
    body.innerHTML = `<div class="items">${s.collections.map((c) => `<div class="item-row${c.claimed ? ' selected' : ''}"><span class="drop-emoji">${c.emoji}</span>
      <div class="grow"><b style="color:${c.color}">${esc(c.label)}</b><div class="bar"><div class="bar-fill" style="width:${(c.found / Math.max(1, c.total)) * 100}%;background:${c.color}"></div></div></div>
      <span class="sub">${c.found}/${c.total}${c.claimed ? ' ✅' : ` · +${num(c.reward)}`}</span></div>`).join('')}</div>
      <div class="grid-items" style="margin-top:12px">${s.species.map((x) => `<div class="drop${x.found ? '' : ' unknown'}" style="--c:${x.color}"><span class="drop-emoji">${x.emoji}</span>
        <span class="drop-name">${esc(x.name)}<br><span class="sub">${x.found ? `×${num(x.caught)} · ${kg(x.best)}` : `desde nivel ${x.minLevel}`}</span></span></div>`).join('')}</div>`;
  }
}

function tick(): void {
  const s = state;
  if (!s || !root || !$('#fish-btn', root)) return;
  const now = clock.now();
  const vigor = vigorNow(s.vigor, s.serverNow);
  $('#p-vigorbar', root).style.width = `${(vigor / s.vigor.max) * 100}%`;
  $('#p-vigor-text', root).textContent = `${Math.floor(vigor)} / ${s.vigor.max}`;
  root.querySelectorAll<HTMLElement>('[data-until]').forEach((el) => { el.textContent = fmtDuration(Number(el.dataset.until) - now); });

  const left = Math.max(0, s.readyAt - now);
  const btn = $<HTMLButtonElement>('#fish-btn', root);
  let label = 'Pescar';
  let sub = `${s.next.lines} ${s.next.lines === 1 ? 'línea' : 'líneas'} · −${s.next.vigorCost} ⚡ · ${s.bait.emoji} ${num(s.bait.qty)}`;
  let ready = false;
  if (s.bait.qty < 1) { label = 'Sin carnada'; sub = `Mercado: ${num(s.bait.price)} c/u · también sale farmeando`; }
  else if (left > 0) { label = 'Preparando la caña…'; sub = fmtDuration(left); }
  else if (vigor < s.next.vigorCost) { label = 'Sin vigor'; sub = `listo en ${fmtDuration((s.next.vigorCost - vigor) * s.vigor.regenMs)}`; }
  else ready = true;
  btn.disabled = busy || !ready;
  btn.classList.toggle('ready', ready && !busy);
  $('#fish-label', root).textContent = busy ? 'Pescando…' : label;
  $('#fish-sub', root).textContent = sub;
  $('#fish-progress', root).style.width = left > 0 ? `${(1 - left / Math.max(1, s.loadout.cooldownMs)) * 100}%` : '0%';
}

async function doFish(): Promise<void> {
  if (busy || !state) return;
  busy = true;
  tick();
  const lake = $('#lake', root);
  lake.className = 'lake fighting';
  const ripple = $('#ripple', root);
  ripple.classList.remove('go');
  void ripple.offsetWidth;
  ripple.classList.add('go');
  try {
    const r = await action<{ cast: CastView; state: FishState }>('/fish/cast');
    last = r.cast;
    setState(r.state);
    const top = r.cast.catches.find((c) => c.rarityLabel === 'Ultralegendario') ?? r.cast.catches.find((c) => c.rarityLabel === 'Legendario');
    if (top) {
      document.body.classList.add('golden');
      setTimeout(() => document.body.classList.remove('golden'), 1600);
      toast(`🌟 ¡${top.rarityLabel}! ${top.emoji} ${top.name}`);
    } else if (r.cast.catches.some((c) => c.newSpecies)) toast('📖 ¡Especie nueva en tu colección!');
    for (const a of r.cast.achievements) toast(`🏅 ¡Logro desbloqueado! ${a.emoji} ${a.name}`);
    if (r.cast.levelUp) showLevelUp('Tu pesca', r.cast.levelUp, r.state.currency.name);
  } catch (err) {
    reportError(err);
    await fishView.load().catch(() => undefined);
  } finally {
    busy = false;
    setTimeout(() => { lake.className = 'lake idle'; }, 700);
    tick();
  }
}

async function changeRod(rod: string): Promise<void> {
  try {
    const r = await action<{ notice: string; state: FishState }>('/fish/rod', { rod });
    setState(r.state);
    toast(r.notice);
  } catch (err) {
    reportError(err);
  }
}

export const fishView: View = {
  mount(el) {
    root = el;
    root.innerHTML = '';
    if (state) render();
  },
  async load() {
    const r = await call<{ state: FishState }>(`/fish?guild=${auth.guildId}`);
    setState(r.state);
  },
  tick,
};

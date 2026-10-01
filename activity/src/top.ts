import type { TopCategory, TopView } from '../../src/activity/types';
import { auth, call } from './api';
import { esc, num, reportError, type View } from './ui';

let root: HTMLElement;
let view: TopView | null = null;
let category: TopCategory = 'total';
const MEDALS = ['🥇', '🥈', '🥉'];

function fmtValue(v: TopView, value: number): string {
  return v.category === 'monedas' ? `${v.unit} ${num(value)}` : `${num(value)} ${v.unit}`;
}

function render(): void {
  const v = view;
  if (!v || !root) return;
  const podium = v.entries.slice(0, 3);
  const rest = v.entries.slice(3);
  const inTop = v.entries.some((e) => e.me);
  const nextReward = v.rewards.find((r) => !r.earned);

  root.innerHTML = `
    <div class="layout">
      <section class="stage card">
        <div class="skill-head"><b>🏆 Top del servidor</b><span class="sub">${num(v.players)} jugadores</span></div>
        <div class="chips cats">${v.categories.map((c) => `<button class="chip-btn${c.id === v.category ? ' active' : ''}" data-cat="${c.id}">${c.emoji} ${esc(c.label)}</button>`).join('')}</div>
        ${v.entries.length ? `
          <div class="podium">${[1, 0, 2].map((i) => podium[i]).filter(Boolean).map((e) => `
            <div class="podium-col p${e!.rank}${e!.me ? ' me' : ''}">
              <div class="podium-medal">${MEDALS[e!.rank - 1]}</div>
              <div class="podium-name">${esc(e!.name)}</div>
              <div class="podium-value">${fmtValue(v, e!.value)}</div>
              <div class="podium-block">${e!.rank}</div>
            </div>`).join('')}</div>
          <div class="ranking">${rest.map((e) => `<div class="rank-row${e.me ? ' me' : ''}"><span class="rank-n">#${e.rank}</span><span class="grow">${esc(e.name)}</span><b>${fmtValue(v, e.value)}</b></div>`).join('')}</div>
          ${v.me && !inTop ? `<div class="rank-row me"><span class="rank-n">#${v.me.rank}</span><span class="grow">Vos</span><b>${fmtValue(v, v.me.value)}</b></div>` : ''}
          ${!v.me ? '<div class="hint">Todavía no aparecés: cosechá o pescá para entrar al ranking.</div>' : ''}`
    : '<div class="empty">Nadie jugó todavía en este servidor. ¡Sé el primero!</div>'}
      </section>
      <aside class="side card">
        <div class="skill-head"><b>🏅 Distinciones</b><span class="sub">roles por progreso</span></div>
        ${v.rewards.length ? `
          ${nextReward ? `<div class="next-reward">Próxima: <b style="color:${nextReward.color}">@${esc(nextReward.roleName)}</b><div class="bar"><div class="bar-fill xp" style="width:${Math.min(100, (nextReward.current / nextReward.level) * 100)}%"></div></div><div class="sub">${esc(nextReward.skill)} ${nextReward.current}/${nextReward.level}</div></div>` : '<div class="next-reward">👑 ¡Tenés todas las distinciones!</div>'}
          <div class="items">${v.rewards.map((r) => `<div class="item-row${r.earned ? ' selected' : ''}"><span class="role-dot" style="background:${r.color}"></span>
            <div class="grow"><b style="color:${r.color}">@${esc(r.roleName)}</b><div class="sub">${r.skill === "actividad" ? `${num(r.level)} pts de actividad` : `${esc(r.skill)} nivel ${r.level}`}</div></div><span>${r.earned ? '✅' : `${r.current}/${r.level}`}</span></div>`).join('')}</div>
          <div class="hint">Los roles se entregan solos al subir de nivel (jugando acá o con el bot).</div>`
    : '<div class="empty">Este servidor todavía no configuró distinciones. Un admin puede hacerlo con <code>/roles</code>.</div>'}
      </aside>
    </div>`;
  root.querySelectorAll<HTMLButtonElement>('[data-cat]').forEach((b) => {
    b.onclick = () => {
      category = b.dataset.cat as TopCategory;
      void topView.load().catch(reportError);
    };
  });
}

export const topView: View = {
  mount(el) {
    root = el;
    root.innerHTML = '<div class="empty">Cargando ranking…</div>';
    if (view) render();
  },
  async load() {
    const r = await call<{ top: TopView }>(`/top?guild=${auth.guildId}&cat=${category}`);
    view = r.top;
    render();
  },
  tick() {},
};

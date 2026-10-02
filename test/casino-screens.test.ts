import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ContainerBuilder, type APIEmbed } from 'discord.js';
import { GAME_IDS, type GameId } from '../src/casino/config';
import { actOnRound, playInstant, startRound, type RoundView } from '../src/casino/engine';
import { applyTx, ensureCasinoUser } from '../src/casino/economy';
import { GAMES } from '../src/casino/games';
import { ensureAutoTournaments } from '../src/casino/tournaments';
import type { Panel, Viewer } from '../src/discord/app';
import { SCREENS } from '../src/discord/casino/games';
import type { Screen } from '../src/discord/casino/screen';
import { auditPanel, configPanel } from '../src/discord/casino/ui/admin';
import { fairnessPanel, verifyPanel } from '../src/discord/casino/ui/fairness';
import { lobbyGamePanel, lobbyPanel, walletPanel } from '../src/discord/casino/ui/lobby';
import { achievementsPanel, historyPanel, profilePanel, statsPanel } from '../src/discord/casino/ui/profile';
import { tournamentListPanel } from '../src/discord/casino/ui/tournaments';
import { helpPanel, HELP_PAGE_IDS } from '../src/discord/ui/helpPanel';
import { G, U, makeWorld, type TestWorld } from './helpers';

const viewer: Viewer = { guildId: G, userId: U, name: 'Jugadora de prueba', avatar: 'https://cdn.discordapp.com/embed/avatars/0.png' };

/** Revisa los límites de Discord: embeds, filas, botones por fila, customId y total de componentes en V2. */
function checkEmbeds(embeds: { toJSON(): APIEmbed }[]): void {
  for (const e of embeds) {
    const j = e.toJSON();
    assert.ok((j.description ?? '').length <= 4096, `descripción de ${j.description?.length}`);
    assert.ok((j.title ?? '').length <= 256);
    assert.ok((j.fields ?? []).length <= 25);
    for (const f of j.fields ?? []) assert.ok(f.value.length <= 1024 && f.name.length <= 256);
    const total = (j.title ?? '').length + (j.description ?? '').length + (j.footer?.text ?? '').length + (j.author?.name ?? '').length
      + (j.fields ?? []).reduce((s, f) => s + f.name.length + f.value.length, 0);
    assert.ok(total <= 6000, `embed de ${total} caracteres`);
  }
}

function countComponents(c: unknown): number {
  const j = c as { components?: unknown[] };
  return 1 + (j.components ?? []).reduce((s: number, x) => s + countComponents(x), 0);
}

function checkRows(rows: { toJSON(): unknown }[], v2: boolean): void {
  const json = rows.map((r) => r.toJSON() as { type: number; components?: { type: number; custom_id?: string; components?: unknown[] }[] });
  const ids: string[] = [];
  const walk = (n: { type: number; custom_id?: string; components?: unknown[] }) => {
    if (n.custom_id) {
      assert.ok(n.custom_id.length <= 100, n.custom_id);
      ids.push(n.custom_id);
    }
    if (n.type === 1) assert.ok((n.components ?? []).length <= 5, 'más de 5 botones en una fila');
    for (const c of (n.components ?? []) as typeof n[]) walk(c);
  };
  json.forEach(walk);
  assert.equal(new Set(ids).size, ids.length, 'customId repetido en un mismo mensaje');
  if (v2) assert.ok(json.reduce((s, c) => s + countComponents(c), 0) <= 40, 'más de 40 componentes (V2)');
  else assert.ok(json.length <= 5, 'más de 5 filas');
}

function checkScreen(s: Screen): void {
  if (s.v2) {
    assert.ok(s.components.some((c) => c instanceof ContainerBuilder));
    checkRows(s.components, true);
  } else {
    checkEmbeds(s.embeds);
    checkRows(s.components, false);
  }
}

function checkPanel(p: Panel): void {
  checkEmbeds(p.embeds);
  checkRows(p.components, false);
}

const PARAMS: Partial<Record<GameId, string[]>> = { roulette: ['7,17,23'], mines: ['24'], plinko: ['alto', '16'], crash: ['2x'], tower: ['experto'] };

function playSome(w: TestWorld, game: GameId): RoundView[] {
  const views: RoundView[] = [];
  const params = GAMES[game].parseParams(PARAMS[game] ?? []);
  for (let i = 0; i < 4; i++) {
    const req = { userId: U, guildId: G, channelId: '300000000000000001', game, bet: 100, params };
    let v: RoundView = GAMES[game].kind === 'instant' ? playInstant(w.ctx, req) : startRound(w.ctx, req);
    views.push(v);
    // Una decisión válida para ver la pantalla "en curso" y otra para terminar.
    const s = v.state as Record<string, unknown> | null;
    const tryAct = (type: string, arg?: number) => {
      try {
        v = actOnRound(w.ctx, { userId: U, roundId: v.round.id, version: v.round.version, action: { type, arg } });
        views.push(v);
      } catch { /* jugada inválida para este estado */ }
    };
    if (v.round.status === 'active') {
      if (game === 'mines') tryAct('pick', [...Array(25).keys()].find((k) => !(s!.mines as number[]).includes(k)));
      else if (game === 'blackjack') { tryAct('hit'); tryAct('stand'); }
      else if (game === 'hilo') { tryAct('skip'); tryAct('higher'); }
      else if (game === 'chicken') tryAct('go');
      else if (game === 'balloons') tryAct('pop', 0);
      else if (game === 'tower') tryAct('tile', 0);
      if (game === 'crash') w.clock.advance(2_000); // en 1,00x todavía no se puede retirar
      if (v.round.status === 'active') tryAct(game === 'crash' ? 'cashout' : 'cash');
    }
    w.clock.advance(5_000);
  }
  return views;
}

describe('pantallas de los juegos', () => {
  for (const game of GAME_IDS) {
    it(`${game}: reglas, partida en curso, animación y resultado respetan los límites de Discord`, () => {
      const w = makeWorld();
      ensureCasinoUser(w.ctx, U);
      applyTx(w.ctx, { userId: U, amount: 100_000, type: 'BONUS' });
      checkEmbeds([SCREENS[game].rules(w.ctx, '!')]);
      for (const view of playSome(w, game)) {
        const o = { ctx: w.ctx, view, viewer, ownerId: U };
        checkScreen(SCREENS[game].render(o));
        for (const f of SCREENS[game].frames?.(o) ?? []) checkScreen(f);
      }
    });
  }
});

describe('paneles', () => {
  it('lobby, billetera, perfil, estadísticas, historial, logros, fairness, torneos, admin y ayuda', () => {
    const w = makeWorld();
    ensureCasinoUser(w.ctx, U);
    ensureAutoTournaments(w.ctx);
    const v = playInstant(w.ctx, { userId: U, guildId: G, channelId: null, game: 'slots', bet: 100, params: {} });
    const t = { id: U, name: viewer.name, avatar: viewer.avatar };
    const panels: Panel[] = [
      lobbyPanel(w.ctx, viewer, '!'), lobbyGamePanel(w.ctx, viewer, 'crash', '!'), walletPanel(w.ctx, viewer, { coins: 10, cap: 600 }, 'aviso'),
      profilePanel(w.ctx, viewer, t), statsPanel(w.ctx, viewer, t, null), statsPanel(w.ctx, viewer, t, 'slots'),
      historyPanel(w.ctx, viewer, t, 'all', 0), historyPanel(w.ctx, viewer, t, 'tx', 0), historyPanel(w.ctx, viewer, t, 'slots', 3),
      achievementsPanel(w.ctx, viewer, t), fairnessPanel(w.ctx, viewer), verifyPanel(w.ctx, v.round),
      tournamentListPanel(w.ctx, viewer, true), configPanel(w.ctx, U, 'ok'), auditPanel(w.ctx),
      ...HELP_PAGE_IDS.map((p) => helpPanel(w.ctx, viewer, p)),
    ];
    panels.forEach(checkPanel);
  });
});

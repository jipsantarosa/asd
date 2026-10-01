import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameError } from '../src/services/context';
import { hideViewsOf, logView, viewStats } from '../src/services/historyViews';
import { getPremium, grantPremium, isGhost, listPremium, requireTier, revokePremium, setGhost, tierOf } from '../src/services/premium';
import { clearMedia, mediaHistory, recordMedia } from '../src/services/userMedia';
import { clearNames, nameHistory, recordName } from '../src/services/userNames';
import { G, U, U2, makeWorld } from './helpers';

const OWNER = '200000000000000100';
const V = (n: number) => `2000000000000005${String(n).padStart(2, '0')}`;
const expectGameError = (fn: () => unknown, re?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));

describe('premium', () => {
  it('los niveles son acumulativos y el mensaje dice qué nivel hace falta', () => {
    const w = makeWorld();
    expectGameError(() => requireTier(w.ctx, U, 1, '!clearavatars'), /Booster.*Pedíselo al dueño/);
    grantPremium(w.ctx, U, 3, OWNER, null);
    assert.doesNotThrow(() => requireTier(w.ctx, U, 1, '!clearavatars'));
    assert.doesNotThrow(() => requireTier(w.ctx, U, 3, '!mstats'));
    expectGameError(() => requireTier(w.ctx, U, 4, '!ghostmode'), /Tier 4.*Tenés Tier 3/);
  });

  it('vence solo y se puede quitar', () => {
    const w = makeWorld();
    grantPremium(w.ctx, U, 2, OWNER, 1);
    assert.equal(tierOf(w.ctx, U), 2);
    w.clock.advance(86_400_001);
    assert.equal(getPremium(w.ctx, U), null);
    assert.equal(listPremium(w.ctx).length, 0);
    grantPremium(w.ctx, U, 4, OWNER, null);
    assert.equal(revokePremium(w.ctx, U), true);
    assert.equal(tierOf(w.ctx, U), 0);
  });

  it('valida nivel y días', () => {
    const w = makeWorld();
    expectGameError(() => grantPremium(w.ctx, U, 5, OWNER, null), /1, 2, 3 o 4/);
    expectGameError(() => grantPremium(w.ctx, U, 1, OWNER, 0), /días/);
  });
});

describe('historial de nombres y tags', () => {
  it('registra sin duplicar; los apodos van por servidor', () => {
    const w = makeWorld();
    assert.equal(recordName(w.ctx, U, 'username', 'juan'), true);
    assert.equal(recordName(w.ctx, U, 'username', 'juan'), false);
    w.clock.advance(1000);
    recordName(w.ctx, U, 'username', 'juancito');
    recordName(w.ctx, U, 'nick', 'Juanchi', G);
    recordName(w.ctx, U, 'nick', 'Otro', '100000000000000999');
    assert.deepEqual(nameHistory(w.ctx, U, ['username']).map((e) => e.value), ['juancito', 'juan']);
    assert.deepEqual(nameHistory(w.ctx, U, ['nick'], G).map((e) => e.value), ['Juanchi']);
  });

  it('ignora vacíos, demasiado largos e IDs raros', () => {
    const w = makeWorld();
    assert.equal(recordName(w.ctx, U, 'display', null), false);
    assert.equal(recordName(w.ctx, U, 'display', '   '), false);
    assert.equal(recordName(w.ctx, U, 'display', 'x'.repeat(65)), false);
    assert.equal(recordName(w.ctx, 'abc', 'display', 'hola'), false);
  });

  it('las limpiezas borran solo lo pedido y solo de esa persona', () => {
    const w = makeWorld();
    recordName(w.ctx, U, 'username', 'juan');
    recordName(w.ctx, U, 'tag', 'XYE', G);
    recordName(w.ctx, U2, 'username', 'pepe');
    recordMedia(w.ctx, U, 'avatar', 'a'.repeat(32));
    recordMedia(w.ctx, U, 'banner', 'b'.repeat(32));
    recordMedia(w.ctx, U2, 'avatar', 'c'.repeat(32));
    assert.equal(clearNames(w.ctx, U, ['tag']), 1);
    assert.equal(nameHistory(w.ctx, U, ['username']).length, 1, 'el nombre sigue');
    assert.equal(clearMedia(w.ctx, U, ['avatar', 'banner']), 2);
    assert.equal(mediaHistory(w.ctx, U2, 'avatar').length, 1, 'lo de otra persona no se toca');
    assert.equal(nameHistory(w.ctx, U2, ['username']).length, 1);
  });
});

describe('!mstats y !ghostmode', () => {
  it('cuenta personas distintas, ignora mirarse a uno mismo y no infla con vistas repetidas', () => {
    const w = makeWorld();
    assert.equal(logView(w.ctx, U, U, 'avatar', G), false);
    logView(w.ctx, V(1), U, 'avatar', G);
    logView(w.ctx, V(1), U, 'avatar', G); // repetida en menos de 10 min: no cuenta
    logView(w.ctx, V(1), U, 'names', G);
    logView(w.ctx, V(2), U, 'tags', G);
    const s = viewStats(w.ctx, U);
    assert.equal(s.people, 2);
    assert.equal(s.total, 3);
    assert.equal(s.byKind.avatar, 1);
    assert.equal(s.byKind.tags, 1);
  });

  it('el listado completo muestra las últimas 10 personas (una vez cada una, la vista más reciente)', () => {
    const w = makeWorld();
    for (let i = 0; i < 15; i++) {
      w.clock.advance(60_000);
      logView(w.ctx, V(i), U, 'avatar', G);
    }
    w.clock.advance(60_000);
    logView(w.ctx, V(3), U, 'names', G); // V3 vuelve a mirar: pasa a ser la más reciente
    const r = viewStats(w.ctx, U).recent;
    assert.equal(r.length, 10);
    assert.equal(r[0].viewerId, V(3));
    assert.equal(r[0].kind, 'names');
    assert.equal(new Set(r.map((x) => x.viewerId)).size, 10, 'sin personas repetidas');
  });

  it('ghostmode: solo Tier 4, no registra tus vistas y borra las anteriores', () => {
    const w = makeWorld();
    logView(w.ctx, U2, U, 'avatar', G);
    grantPremium(w.ctx, U2, 3, OWNER, null);
    expectGameError(() => setGhost(w.ctx, U2, true), /Tier 4/);
    grantPremium(w.ctx, U2, 4, OWNER, null);
    setGhost(w.ctx, U2, true);
    assert.equal(isGhost(w.ctx, U2), true);
    assert.equal(hideViewsOf(w.ctx, U2), 1);
    w.clock.advance(700_000);
    assert.equal(logView(w.ctx, U2, U, 'banner', G), false);
    assert.equal(viewStats(w.ctx, U).people, 0);
    // Si el premium se quita, el modo fantasma deja de valer.
    revokePremium(w.ctx, U2);
    assert.equal(isGhost(w.ctx, U2), false);
  });
});

describe('!botperfil: lugares', () => {
  it('un servidor lo personaliza una sola persona', () => {
    const w = makeWorld();
    w.ctx.db.run('INSERT INTO bot_profile_slots (user_id, guild_id, claimed_at) VALUES (?, ?, 0)', U, G);
    assert.throws(() => w.ctx.db.run('INSERT INTO bot_profile_slots (user_id, guild_id, claimed_at) VALUES (?, ?, 0)', U2, G));
  });
});

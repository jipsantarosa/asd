import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { missingEnglish, t } from '../src/i18n';
import { fillBoostText, getBoostConfig, parseColor, saveBoostConfig, BoostDedupe } from '../src/services/boost';
import { GameError } from '../src/services/context';
import { getSettings, setLanguage } from '../src/services/guildSettings';
import { answerProposal, cancelProposal, divorce, getMarriage, propose, PROPOSAL_TTL_MS } from '../src/services/marriage';
import { getWebhookGuard, judgeWebhookCreator, saveWebhookGuard, WebhookFlood, webhookMessageProblem, type WebhookCreator } from '../src/services/webhookGuard';
import { G, U, U2, makeWorld } from './helpers';

const U3 = '200000000000000009';
const expectGameError = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));

describe('casamientos', () => {
  it('proponer, aceptar, una pareja por persona y divorcio', () => {
    const w = makeWorld();
    const p = propose(w.ctx, G, U, U2);
    expectGameError(() => answerProposal(w.ctx, p.id, U3, true), /no es para vos/);
    answerProposal(w.ctx, p.id, U2, true);
    assert.equal(getMarriage(w.ctx, U)!.partnerId, U2);
    assert.equal(getMarriage(w.ctx, U2)!.partnerId, U);
    expectGameError(() => answerProposal(w.ctx, p.id, U2, true), /ya fue respondida/);
    expectGameError(() => propose(w.ctx, G, U3, U), /ya está casada/);
    expectGameError(() => propose(w.ctx, G, U, U3), /Ya estás casado/);
    assert.equal(divorce(w.ctx, U2).partnerId, U);
    assert.equal(getMarriage(w.ctx, U), null);
    expectGameError(() => divorce(w.ctx, U), /No estás casado/);
  });

  it('no con uno mismo; una propuesta abierta a la vez; vence a los 10 minutos; se puede retirar', () => {
    const w = makeWorld();
    expectGameError(() => propose(w.ctx, G, U, U), /vos mismo/);
    const p = propose(w.ctx, G, U, U2);
    expectGameError(() => propose(w.ctx, G, U, U3), /esperando respuesta/);
    w.clock.advance(PROPOSAL_TTL_MS + 1);
    expectGameError(() => answerProposal(w.ctx, p.id, U2, true), /venció/);
    const p2 = propose(w.ctx, G, U, U3);
    cancelProposal(w.ctx, p2.id, U);
    expectGameError(() => answerProposal(w.ctx, p2.id, U3, true), /ya fue respondida/);
  });

  it('si dos propuestas cruzadas se aceptan, la segunda no puede casar a nadie dos veces', () => {
    const w = makeWorld();
    const a = propose(w.ctx, G, U, U2);
    const b = propose(w.ctx, G, U3, U2);
    answerProposal(w.ctx, a.id, U2, true);
    expectGameError(() => answerProposal(w.ctx, b.id, U2, true), /Ya estás casado/);
    assert.equal(w.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM marriages')!.n, 1);
  });
});

describe('boost tracker', () => {
  it('colores por nombre o código y textos con variables (sin @everyone)', () => {
    assert.equal(parseColor('Oro'), 0xf1c40f);
    assert.equal(parseColor('#ff66cc'), 0xff66cc);
    expectGameError(() => parseColor('arcoiris'));
    const text = fillBoostText('Gracias {user} ({username}) por boostear {server}: {boosts} boosts, nivel {tier} @everyone', { userId: U, username: 'Ana', server: 'Mi server', boosts: 7, tier: 2 });
    assert.equal(text, `Gracias <@${U}> (Ana) por boostear Mi server: 7 boosts, nivel 2 @​everyone`);
  });

  it('guarda y valida título, descripción, imagen y footer', () => {
    const w = makeWorld();
    assert.equal(getBoostConfig(w.ctx, G).enabled, false);
    saveBoostConfig(w.ctx, G, { enabled: true, channelId: '300000000000000001', color: 0xf1c40f, footer: 'gracias' });
    assert.equal(getBoostConfig(w.ctx, G).footer, 'gracias');
    expectGameError(() => saveBoostConfig(w.ctx, G, { imageUrl: 'http://inseguro.com/x.png' }), /https/);
    expectGameError(() => saveBoostConfig(w.ctx, G, { title: '' }));
    const d = new BoostDedupe(60_000);
    assert.equal(d.first('g:u', 0), true);
    assert.equal(d.first('g:u', 1_000), false, 'el mismo boost no se anuncia dos veces');
    assert.equal(d.first('g:u', 120_000), true);
  });
});

describe('anti-webhooks', () => {
  const creator = (over: Partial<WebhookCreator> = {}): WebhookCreator => ({ id: U, isSelf: false, isOwner: false, isBot: false, isAdmin: false, roleIds: [], ...over });

  it('decide quién puede crear webhooks', () => {
    const w = makeWorld();
    assert.equal(judgeWebhookCreator(getWebhookGuard(w.ctx, G), creator()), 'allow', 'desactivado no hace nada');
    const cfg = saveWebhookGuard(w.ctx, G, { enabled: true, allowRoles: ['300000000000000005', 'basura'] });
    assert.deepEqual(cfg.allowRoles, ['300000000000000005']);
    assert.equal(judgeWebhookCreator(cfg, creator()), 'delete');
    assert.equal(judgeWebhookCreator(cfg, creator({ isBot: true })), 'delete_kick');
    assert.equal(judgeWebhookCreator(cfg, creator({ isOwner: true })), 'allow');
    assert.equal(judgeWebhookCreator(cfg, creator({ isSelf: true, isBot: true })), 'allow');
    assert.equal(judgeWebhookCreator(cfg, creator({ isAdmin: true })), 'allow');
    assert.equal(judgeWebhookCreator({ ...cfg, allowAdmins: false }, creator({ isAdmin: true })), 'delete');
    assert.equal(judgeWebhookCreator(cfg, creator({ roleIds: ['300000000000000005'] })), 'allow');
    assert.equal(judgeWebhookCreator({ ...cfg, kickBots: false }, creator({ isBot: true })), 'delete');
  });

  it('mensajes peligrosos y ráfagas de un webhook', () => {
    assert.ok(webhookMessageProblem('hola @everyone', false));
    assert.ok(webhookMessageProblem('entren a discord.gg/abc', false));
    assert.equal(webhookMessageProblem('aviso normal', false), null);
    const f = new WebhookFlood(5, 5_000);
    const hits = Array.from({ length: 6 }, (_, i) => f.hit('w', i * 100));
    assert.deepEqual(hits, [false, false, false, false, false, true]);
    assert.equal(f.hit('w', 60_000), false);
  });
});

describe('idioma', () => {
  it('!setlang guarda el idioma por servidor y todos los textos tienen inglés', () => {
    const w = makeWorld();
    assert.equal(getSettings(w.ctx, G).lang, 'es');
    assert.equal(setLanguage(w.ctx, G, 'EN'), 'en');
    assert.equal(getSettings(w.ctx, G).lang, 'en');
    assert.equal(getSettings(w.ctx, '100000000000000099').lang, 'es', 'cada servidor tiene el suyo');
    expectGameError(() => setLanguage(w.ctx, G, 'fr'));
    assert.deepEqual(missingEnglish(), []);
    assert.match(t('en', 'marry.accepted', { a: 'A', b: 'B' }), /A and B just got married/);
    assert.match(t('es', 'marry.accepted', { a: 'A', b: 'B' }), /A y B se casaron/);
  });
});

describe('autorol', () => {
  it('personas y bots por separado, se desactivan por separado', async () => {
    const { autoRoleFor, getAutoRoles, setAutoRole } = await import('../src/services/autoRole');
    const w = makeWorld();
    const R1 = '300000000000000001';
    const R2 = '300000000000000002';
    assert.deepEqual(getAutoRoles(w.ctx, G), { members: null, bots: null });
    setAutoRole(w.ctx, G, 'members', R1);
    setAutoRole(w.ctx, G, 'bots', R2);
    assert.equal(autoRoleFor(w.ctx, G, false), R1);
    assert.equal(autoRoleFor(w.ctx, G, true), R2);
    setAutoRole(w.ctx, G, 'bots', null);
    assert.deepEqual(getAutoRoles(w.ctx, G), { members: R1, bots: null });
    expectGameError(() => setAutoRole(w.ctx, G, 'members', 'nope'), /inválido/);
  });
});

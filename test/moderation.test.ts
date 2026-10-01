import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameError } from '../src/services/context';
import {
  DEFAULT_AUTOMOD, activeWarnCount, caseSummary, cleanReason, countCases, createCase, escalationFor, formatDuration, getAutomod, getCase,
  getRaidUntil, levelFromRoles, listCases, listModRoles, normalizeAutomod, normalizeDomains, parseDuration, revokeCase, saveAutomod,
  setAutomodNumber, setCaseReason, setModRoles, setRaidUntil,
} from '../src/services/moderation';
import { G, U, U2, makeWorld } from './helpers';

const MOD = '200000000000000500';
const R1 = '900000000000000001';
const R2 = '900000000000000002';
const expectGameError = (fn: () => unknown, re?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));

describe('moderación: casos', () => {
  it('numeración por servidor, sin huecos ni repetidos, y aislada entre servidores', () => {
    const w = makeWorld();
    const a = createCase(w.ctx, { guildId: G, action: 'warn', targetId: U, moderatorId: MOD, reason: 'spam' });
    const b = createCase(w.ctx, { guildId: G, action: 'timeout', targetId: U2, moderatorId: MOD, reason: 'flood', durationMs: 600_000 });
    const other = createCase(w.ctx, { guildId: '100000000000000999', action: 'ban', targetId: U, moderatorId: MOD });
    assert.deepEqual([a.number, b.number, other.number], [1, 2, 1]);
    assert.equal(getCase(w.ctx, G, 2)!.expiresAt, w.clock.t + 600_000, 'el aislamiento guarda cuándo termina');
    assert.equal(getCase(w.ctx, '100000000000000999', 2), null);
    assert.equal(getCase(w.ctx, G, 0), null);
    assert.equal(getCase(w.ctx, G, Number.NaN), null);
  });

  it('motivo limpio: sin @everyone, una línea, tope de largo, y "Sin motivo" por defecto', () => {
    assert.equal(cleanReason(null), 'Sin motivo');
    assert.equal(cleanReason('   '), 'Sin motivo');
    assert.equal(cleanReason('hola\n\n@everyone  mundo'), 'hola @​everyone mundo');
    assert.equal(cleanReason('x'.repeat(900)).length, 500);
  });

  it('advertencias activas: vencen, se anulan y no cuentan las de otros', () => {
    const w = makeWorld();
    createCase(w.ctx, { guildId: G, action: 'warn', targetId: U, moderatorId: MOD });
    const second = createCase(w.ctx, { guildId: G, action: 'warn', targetId: U, moderatorId: MOD });
    createCase(w.ctx, { guildId: G, action: 'warn', targetId: U2, moderatorId: MOD });
    assert.equal(activeWarnCount(w.ctx, G, U), 2);
    revokeCase(w.ctx, G, second.number, MOD);
    assert.equal(activeWarnCount(w.ctx, G, U), 1, 'la anulada no cuenta');
    expectGameError(() => revokeCase(w.ctx, G, second.number, MOD), /ya estaba anulado/);
    w.clock.advance(DEFAULT_AUTOMOD.warns.expireDays * 86_400_000 + 1);
    assert.equal(activeWarnCount(w.ctx, G, U), 0, 'vencida a los 30 días');
    assert.equal(countCases(w.ctx, G, U), 2, 'el historial las conserva');
  });

  it('advertencias que no vencen (0 días) y resumen del historial', () => {
    const w = makeWorld();
    setAutomodNumber(w.ctx, G, 'warns.expireDays', 0);
    createCase(w.ctx, { guildId: G, action: 'warn', targetId: U, moderatorId: MOD });
    createCase(w.ctx, { guildId: G, action: 'kick', targetId: U, moderatorId: MOD });
    w.clock.advance(400 * 86_400_000);
    const s = caseSummary(w.ctx, G, U);
    assert.equal(s.activeWarns, 1);
    assert.equal(s.byAction.kick, 1);
    assert.equal(s.total, 2);
    assert.deepEqual(listCases(w.ctx, G, U).map((c) => c.number), [2, 1], 'el más nuevo primero');
  });

  it('editar motivo', () => {
    const w = makeWorld();
    const c = createCase(w.ctx, { guildId: G, action: 'warn', targetId: U, moderatorId: MOD, reason: 'viejo' });
    assert.equal(setCaseReason(w.ctx, G, c.number, '  nuevo  ').reason, 'nuevo');
    expectGameError(() => setCaseReason(w.ctx, G, 99, 'x'), /No existe/);
  });
});

describe('moderación: duraciones', () => {
  it('formatos aceptados', () => {
    assert.equal(parseDuration('10m'), 600_000);
    assert.equal(parseDuration('1h30m'), 5_400_000);
    assert.equal(parseDuration('2d'), 172_800_000);
    assert.equal(parseDuration('1w'), 604_800_000);
    assert.equal(parseDuration('10 min'), 600_000);
    assert.equal(parseDuration('2 horas'), 7_200_000);
    assert.equal(parseDuration('3 días'), 259_200_000);
  });
  it('rechaza lo inválido, lo muy corto y más de 28 días', () => {
    for (const bad of ['', 'abc', '10', '-5m', '1x', '3s']) expectGameError(() => parseDuration(bad));
    expectGameError(() => parseDuration('29d'), /28 días/);
    expectGameError(() => parseDuration('5w'), /28 días/);
  });
  it('se muestra legible', () => {
    assert.equal(formatDuration(5_400_000), '1 h 30 min');
    assert.equal(formatDuration(600_000), '10 min');
    assert.equal(formatDuration(8 * 86_400_000), '1 sem 1 d');
  });
});

describe('moderación: roles', () => {
  it('niveles mod/admin: el más alto gana y un rol está en un solo nivel', () => {
    const w = makeWorld();
    setModRoles(w.ctx, G, 'mod', [R1, R2, G, 'basura']);
    assert.equal(levelFromRoles(w.ctx, G, [R1]), 'mod');
    setModRoles(w.ctx, G, 'admin', [R2]);
    assert.deepEqual(listModRoles(w.ctx, G).map((r) => [r.roleId, r.level]), [[R2, 'admin'], [R1, 'mod']]);
    assert.equal(levelFromRoles(w.ctx, G, [R1, R2]), 'admin');
    assert.equal(levelFromRoles(w.ctx, G, ['900000000000000003']), null);
    setModRoles(w.ctx, G, 'mod', []);
    assert.equal(levelFromRoles(w.ctx, G, [R1]), null, 'se puede vaciar una lista');
    expectGameError(() => setModRoles(w.ctx, G, 'mod', Array.from({ length: 11 }, (_, n) => String(910000000000000000n + BigInt(n)))), /máximo/);
  });
});

describe('automod: configuración', () => {
  it('JSON roto o con valores fuera de rango nunca rompe: se normaliza', () => {
    const cfg = normalizeAutomod({ spam: { enabled: 'si', maxMessages: 9999, perSeconds: -3 }, links: { mode: 'raro', allow: ['https://www.YouTube.com/watch', 'no es dominio'] }, exemptRoles: ['x', R1, R1] });
    assert.equal(cfg.spam.enabled, true, 'valor no booleano → por defecto');
    assert.equal(cfg.spam.maxMessages, 30, 'se recorta al máximo');
    assert.equal(cfg.spam.perSeconds, 2, 'se recorta al mínimo');
    assert.equal(cfg.links.mode, 'invites');
    assert.deepEqual(cfg.links.allow, ['youtube.com']);
    assert.deepEqual(cfg.exemptRoles, [R1]);
    assert.deepEqual(normalizeAutomod('basura'), normalizeAutomod({}));
  });

  it('persiste, se cachea y se puede cambiar campo por campo con validación', () => {
    const w = makeWorld();
    assert.equal(getAutomod(w.ctx, G).spam.maxMessages, DEFAULT_AUTOMOD.spam.maxMessages);
    setAutomodNumber(w.ctx, G, 'spam.maxMessages', 10);
    assert.equal(getAutomod(w.ctx, G).spam.maxMessages, 10);
    expectGameError(() => setAutomodNumber(w.ctx, G, 'spam.maxMessages', 1000), /entre/);
    const cfg = structuredClone(getAutomod(w.ctx, G));
    cfg.links.mode = 'all';
    saveAutomod(w.ctx, G, cfg);
    assert.equal(getAutomod(w.ctx, G).links.mode, 'all');
    assert.equal(getAutomod(w.ctx, '100000000000000999').links.mode, DEFAULT_AUTOMOD.links.mode, 'otro servidor no cambia');
  });

  it('modo raid con vencimiento', () => {
    const w = makeWorld();
    assert.equal(getRaidUntil(w.ctx, G), 0);
    setRaidUntil(w.ctx, G, w.clock.t + 60_000);
    assert.equal(getRaidUntil(w.ctx, G), w.clock.t + 60_000);
    setRaidUntil(w.ctx, G, null);
    assert.equal(getRaidUntil(w.ctx, G), 0);
  });

  it('dominios: se limpian esquema, www, rutas y basura', () => {
    assert.deepEqual(normalizeDomains('https://www.Tenor.com/view/x, giphy.com  spam!!, a.b'), ['tenor.com', 'giphy.com']);
  });
});

describe('moderación: escalado por advertencias', () => {
  it('aislar y expulsar al llegar justo al umbral; banear desde el umbral', () => {
    const cfg = normalizeAutomod({ warns: { timeoutAt: 3, timeoutMinutes: 60, kickAt: 5, banAt: 7 } });
    assert.equal(escalationFor(cfg, 2), null);
    assert.deepEqual(escalationFor(cfg, 3), { action: 'timeout', ms: 3_600_000 });
    assert.equal(escalationFor(cfg, 4), null, 'no se repite el aislamiento en cada advertencia');
    assert.deepEqual(escalationFor(cfg, 5), { action: 'kick' });
    assert.equal(escalationFor(cfg, 6), null);
    assert.deepEqual(escalationFor(cfg, 7), { action: 'ban' });
    assert.deepEqual(escalationFor(cfg, 9), { action: 'ban' });
  });
  it('con todo en 0 no hay sanciones automáticas', () => {
    const cfg = normalizeAutomod({ warns: { timeoutAt: 0, kickAt: 0, banAt: 0 } });
    for (let n = 0; n < 20; n++) assert.equal(escalationFor(cfg, n), null);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  JoinTracker, MessageTracker, StrikeTracker, findLinks, hostAllowed, isNewAccount, lineCount, linkViolation, normalizeContent,
} from '../src/services/automod';

describe('automod: enlaces', () => {
  it('detecta invitaciones con y sin esquema', () => {
    for (const s of ['entren a discord.gg/abc123', 'https://discord.com/invite/xyz', 'discordapp.com/invite/q-w', 'dsc.gg/servidor']) {
      assert.equal(findLinks(s).invites.length, 1, s);
    }
  });

  it('modo "invitaciones": bloquea invitaciones y deja pasar el resto', () => {
    assert.match(linkViolation('mirá discord.gg/raid', 'invites', []) ?? '', /invitaciones/);
    assert.equal(linkViolation('mirá https://youtube.com/watch?v=1', 'invites', []), null);
    assert.equal(linkViolation('nada que ver', 'invites', []), null);
  });

  it('modo "todos": permite lista blanca, subdominios y enlaces de Discord', () => {
    const allow = ['youtube.com', 'tenor.com'];
    assert.equal(linkViolation('https://www.youtube.com/watch?v=1', 'all', allow), null);
    assert.equal(linkViolation('https://m.youtube.com/x', 'all', allow), null, 'subdominio permitido');
    assert.equal(linkViolation('https://discord.com/channels/1/2/3', 'all', allow), null, 'enlace a un mensaje');
    assert.equal(linkViolation('https://cdn.discordapp.com/attachments/a.png', 'all', allow), null);
    assert.match(linkViolation('compren en https://estafa.example/oferta', 'all', allow) ?? '', /enlaces/);
    assert.match(linkViolation('entren a free-nitro.ru/gift', 'all', allow) ?? '', /enlaces/, 'dominio "pelado" con TLD conocido');
    assert.equal(hostAllowed('fakeyoutube.com', allow), false, 'no confunde un dominio que solo termina parecido');
  });

  it('no confunde texto común con enlaces', () => {
    for (const s of ['hola.que tal', 'versión 1.2.3', 'son las 10.30', 'mi correo es ana@gmail.com', 'ok...dale', '']) {
      assert.equal(linkViolation(s, 'all', []), null, s);
    }
  });

  it('modo apagado nunca bloquea', () => {
    assert.equal(linkViolation('discord.gg/x https://a.com', 'off', []), null);
  });
});

describe('automod: ráfagas, repetidos e infracciones', () => {
  it('normaliza para comparar repetidos', () => {
    assert.equal(normalizeContent('  HOLA​   Mundo '), 'hola mundo');
    assert.equal(lineCount('a\nb\nc'), 3);
    assert.equal(lineCount(''), 0);
  });

  it('cuenta mensajes por ventana y repetidos por contenido', () => {
    const t = new MessageTracker();
    const k = 'g:u';
    for (let n = 0; n < 5; n++) t.record(k, { id: String(n), channelId: 'c', hash: n < 3 ? 'spam' : `otro${n}`, at: 1000 + n * 100 });
    assert.equal(t.recent(k, 1500, 5000).length, 5);
    assert.equal(t.recent(k, 7000, 5000).length, 0, 'fuera de la ventana');
    assert.equal(t.duplicates(k, 'spam', 1500), 3);
    assert.equal(t.duplicates(k, '', 1500), 0, 'los mensajes vacíos (solo adjuntos) no cuentan como repetidos');
    t.clear(k);
    assert.equal(t.recent(k, 1500, 5000).length, 0);
  });

  it('la memoria no crece sin límite', () => {
    const t = new MessageTracker(60_000, 50);
    for (let n = 0; n < 500; n++) t.record('k', { id: String(n), channelId: 'c', hash: 'x', at: n });
    assert.equal(t.recent('k', 600, 60_000).length, 50);
    t.sweep(10_000_000);
    assert.equal(t.size, 0);
  });

  it('infracciones en 10 minutos', () => {
    const s = new StrikeTracker();
    assert.equal(s.add('k', 0), 1);
    assert.equal(s.add('k', 1000), 2);
    assert.equal(s.add('k', 11 * 60_000), 1, 'las viejas vencen');
    s.reset('k');
    assert.equal(s.add('k', 11 * 60_000), 1);
  });
});

describe('automod: raids', () => {
  it('cuenta entradas por ventana y por servidor', () => {
    const j = new JoinTracker();
    for (let n = 0; n < 10; n++) j.record('g1', `u${n}`, n * 1000, 30_000);
    assert.equal(j.record('g1', 'u10', 10_000, 30_000), 11);
    assert.equal(j.record('g2', 'x', 10_000, 30_000), 1, 'otro servidor no suma');
    assert.equal(j.record('g1', 'tarde', 100_000, 30_000), 1, 'fuera de la ventana');
    assert.deepEqual(j.recent('g1', 10_000, 3_000), ['u8', 'u9', 'u10']);
  });

  it('cuenta nueva', () => {
    const day = 86_400_000;
    assert.equal(isNewAccount(0, 3 * day, 7), true);
    assert.equal(isNewAccount(0, 8 * day, 7), false);
    assert.equal(isNewAccount(0, 999 * day, 0), true, '0 días = todas las cuentas');
  });
});

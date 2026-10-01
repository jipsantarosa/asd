import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCollage, COLLAGE_MAX, thumbUrl } from '../src/discord/media/collage';
import { blank, decodePng, encodePng, fill } from '../src/discord/media/png';
import { GameError } from '../src/services/context';
import { claimKissReply, kiss, kissBack, kissCount } from '../src/services/social';
import { G, U, U2, makeWorld } from './helpers';

const expectGameError = (fn: () => unknown, re?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));

describe('PNG sin dependencias', () => {
  it('ida y vuelta exacta (RGBA)', () => {
    const img = blank(7, 5);
    for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 37) % 256;
    const back = decodePng(encodePng(img))!;
    assert.equal(back.width, 7);
    assert.equal(back.height, 5);
    assert.deepEqual(Buffer.from(back.data), Buffer.from(img.data));
  });

  it('lee PNG con paleta y transparencia (generado con otra herramienta)', () => {
    const img = decodePng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAUAAAADBAMAAACpGNjLAAAAHlBMVEUAAMgyAMgAUMgyoMhkUMiWAMiWoMjIUMgAAAAAAADfqYP3AAAACHRSTlMA/////////9XKVDIAAAAUSURBVHicY2BkZWCRVzBgYGZjAAADBwCDHWH3cgAAAABJRU5ErkJggg==', 'base64'))!;
    const expected: number[][] = [[0, 0, 200, 0], [50, 0, 200, 255], [0, 0, 200, 0], [150, 0, 200, 255], [0, 0, 200, 0], [0, 80, 200, 255], [0, 0, 200, 0], [100, 80, 200, 255], [0, 0, 200, 0], [200, 80, 200, 255], [0, 0, 200, 0], [50, 160, 200, 255], [0, 0, 200, 0], [150, 160, 200, 255], [0, 0, 200, 0]];
    expected.forEach((px, i) => px.forEach((v, c) => assert.ok(Math.abs(v - img.data[i * 4 + c]) <= 1, `píxel ${i} canal ${c}`)));
  });

  it('archivos dañados devuelven null en vez de romper', () => {
    assert.equal(decodePng(Buffer.from('nada que ver')), null);
    const ok = encodePng(fill(blank(4, 4), 1, 2, 3));
    assert.equal(decodePng(ok.subarray(0, ok.length - 20)), null);
  });
});

describe('collage del historial', () => {
  const entry = (i: number) => ({ hash: String(i), url: `https://cdn.discordapp.com/avatars/1/${i}.gif?size=1024`, firstSeenAt: i, lastSeenAt: i });

  it('pide miniaturas PNG chicas a la CDN (también de avatares animados)', () => {
    assert.equal(thumbUrl('https://cdn.discordapp.com/avatars/1/a_x.gif?size=1024', 64), 'https://cdn.discordapp.com/avatars/1/a_x.png?size=64');
  });

  it('arma la grilla, marca en gris lo que ya no está y respeta el tope', async () => {
    const urls: string[] = [];
    const c = (await buildCollage(Array.from({ length: 80 }, (_, i) => entry(i)), 'avatar', async (u) => {
      urls.push(u);
      return u.includes('/3.') ? null : fill(blank(64, 64), 200, 10, 10);
    }))!;
    assert.equal(c.shown, COLLAGE_MAX);
    assert.equal(c.missing, 1);
    assert.equal(urls.length, COLLAGE_MAX);
    const img = decodePng(c.png)!;
    assert.equal(img.width, 8 * 64 + 7 * 4);
    assert.equal(img.height, 8 * 64 + 7 * 4);
  });

  it('sin historial no hay collage', async () => {
    assert.equal(await buildCollage([], 'avatar'), null);
  });
});

describe('kiss: corresponder y rechazar', () => {
  it('corresponder suma un beso a la pareja una sola vez, aunque se toque dos veces', () => {
    const w = makeWorld();
    kiss(w.ctx, G, U, U2);
    const r = kissBack(w.ctx, 'msg1', G, U2, U);
    assert.equal(r.pair, 2);
    expectGameError(() => kissBack(w.ctx, 'msg1', G, U2, U), /ya fue respondido/);
    assert.equal(kissCount(w.ctx, G, U, U2), 2);
  });

  it('rechazar bloquea corresponder después', () => {
    const w = makeWorld();
    kiss(w.ctx, G, U, U2);
    claimKissReply(w.ctx, 'msg2', G, U2, 'rechazado');
    expectGameError(() => kissBack(w.ctx, 'msg2', G, U2, U), /ya fue respondido/);
    assert.equal(kissCount(w.ctx, G, U, U2), 1);
  });

  it('corresponder no usa la espera de besos (es una respuesta única por mensaje)', () => {
    const w = makeWorld();
    kiss(w.ctx, G, U2, '200000000000000999'); // U2 acaba de besar a otra persona: su espera está activa
    assert.equal(kissBack(w.ctx, 'msg3', G, U2, U).pair, 1);
  });

  it('si corresponder falla, la respuesta no queda marcada y se puede reintentar', () => {
    const w = makeWorld();
    expectGameError(() => kissBack(w.ctx, 'msg4', G, U, U), /vos mismo/);
    assert.equal(kissBack(w.ctx, 'msg4', G, U2, U).pair, 1, 'la marca del intento fallido se deshizo con la transacción');
  });
});

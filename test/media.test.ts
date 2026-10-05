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

describe('archivo de avatares (las imágenes se guardan en la base)', () => {
  const H1 = 'a'.repeat(32);
  const H2 = 'b'.repeat(32);
  const HA = `a_${'c'.repeat(32)}`;

  it('guarda la imagen apenas la ve y el collage la usa aunque Discord ya no la tenga', async () => {
    const { recordMedia, mediaHistory } = await import('../src/services/userMedia');
    const { MediaArchiver } = await import('../src/discord/media/archive');
    const { getMediaFile, archiveStats } = await import('../src/services/mediaArchive');
    const w = makeWorld();
    const png = encodePng(fill(blank(8, 8), 10, 200, 10));
    const seen: string[] = [];
    const archiver = new MediaArchiver(w.ctx, async (url) => {
      seen.push(url);
      return { status: 200, body: url.includes('.gif') ? Buffer.from('GIF89a') : png };
    });
    recordMedia(w.ctx, U, 'avatar', H1);
    archiver.ensure(U, 'avatar', H1);
    recordMedia(w.ctx, U, 'avatar', HA);
    archiver.ensure(U, 'avatar', HA);
    archiver.ensure(U, 'avatar', H1); // repetido: no se baja dos veces
    await archiver.idle();
    assert.deepEqual(getMediaFile(w.ctx, U, 'avatar', H1)!.png, png);
    assert.equal(getMediaFile(w.ctx, U, 'avatar', HA)!.gif!.toString(), 'GIF89a', 'los animados también se guardan como GIF');
    assert.equal(seen.length, 3);
    assert.equal(archiveStats(w.ctx).ok, 2);

    // Después Discord ya no tiene ninguna: el collage sale igual con las copias guardadas.
    const history = mediaHistory(w.ctx, U, 'avatar');
    const c = (await buildCollage(history, 'avatar', async () => null, (e) => getMediaFile(w.ctx, U, 'avatar', e.hash)?.png ?? null))!;
    assert.equal(c.missing, 0);
  });

  it('si Discord ya la borró queda como no disponible; si falla la red se reintenta', async () => {
    const { recordMedia } = await import('../src/services/userMedia');
    const { MediaArchiver } = await import('../src/discord/media/archive');
    const { mediaFileStatus, unarchivedMedia, MAX_ATTEMPTS } = await import('../src/services/mediaArchive');
    const w = makeWorld();
    recordMedia(w.ctx, U, 'avatar', H1);
    recordMedia(w.ctx, U, 'avatar', H2);
    const gone = new MediaArchiver(w.ctx, async (url) => ({ status: url.includes(H1) ? 404 : 0, body: null }));
    assert.equal(gone.backfill(), 2);
    await gone.idle();
    assert.equal(mediaFileStatus(w.ctx, U, 'avatar', H1), 'gone');
    assert.equal(mediaFileStatus(w.ctx, U, 'avatar', H2), 'pending');
    assert.deepEqual(unarchivedMedia(w.ctx).map((x) => x.hash), [H2], 'lo que desapareció no se reintenta');
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      gone.ensure(U, 'avatar', H2);
      await gone.idle();
    }
    assert.equal(mediaFileStatus(w.ctx, U, 'avatar', H2), 'gone', 'después de varios intentos se deja de intentar');
  });

  it('borrar el historial (premium) también borra las copias guardadas', async () => {
    const { recordMedia, clearMedia } = await import('../src/services/userMedia');
    const { saveMediaFile, getMediaFile } = await import('../src/services/mediaArchive');
    const w = makeWorld();
    recordMedia(w.ctx, U, 'avatar', H1);
    saveMediaFile(w.ctx, U, 'avatar', H1, encodePng(blank(2, 2)), null);
    clearMedia(w.ctx, U, ['avatar']);
    assert.equal(getMediaFile(w.ctx, U, 'avatar', H1), null);
  });
});

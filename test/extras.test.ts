import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import jpeg from 'jpeg-js';
import { decodeImage, encodeGif, fitWithin } from '../src/discord/media/gif';
import { blank, encodePng, fill } from '../src/discord/media/png';
import { GameError } from '../src/services/context';
import { fetchCs2, fetchValorant, parseRiotId, parseSteamInput, readCs2Stats, valoSummary, type JsonFetcher } from '../src/services/gameStats';

const expectGameError = async (p: Promise<unknown> | (() => unknown), re?: RegExp) => {
  const run = typeof p === 'function' ? Promise.resolve().then(p) : p;
  await assert.rejects(run, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));
};

describe('!gif', () => {
  it('PNG → GIF quieto (achicado a 512 sin deformar)', () => {
    const img = decodeImage(encodePng(fill(blank(1024, 512), 200, 30, 30)));
    assert.deepEqual([fitWithin(img).width, fitWithin(img).height], [512, 256]);
    const gif = encodeGif([img]);
    assert.equal(gif.subarray(0, 6).toString('latin1'), 'GIF89a');
    assert.equal(gif.readUInt16LE(6), 512);
    assert.equal(gif.readUInt16LE(8), 256);
  });

  it('JPG también, y varias fotos arman una animación', () => {
    const raw = { width: 40, height: 30, data: Buffer.from(fill(blank(40, 30), 10, 120, 200).data) };
    const jpg = jpeg.encode(raw, 90).data;
    const a = decodeImage(Buffer.from(jpg));
    assert.equal(a.width, 40);
    const gif = encodeGif([a, decodeImage(encodePng(fill(blank(80, 60), 250, 250, 0)))]);
    // Dos cuadros = dos "Image Descriptor" (0x2C) después del encabezado.
    const frames = [...gif.subarray(13)].filter((b, i, arr) => b === 0x21 && arr[i + 1] === 0xf9).length;
    assert.equal(frames, 2);
  });

  it('formatos que no se pueden leer dan un mensaje claro', async () => {
    await expectGameError(() => decodeImage(Buffer.from('RIFF....WEBP')), /PNG.*JPG/);
    await expectGameError(() => decodeImage(Buffer.from('GIF89a......')), /ya es un GIF/);
  });
});

describe('!uservalo', () => {
  it('lee el Riot ID con espacios y con el # separado', () => {
    assert.deepEqual(parseRiotId('TenZ#0505'), { name: 'TenZ', tag: '0505' });
    assert.deepEqual(parseRiotId('el pibe #LAS'), { name: 'el pibe', tag: 'LAS' });
    assert.throws(() => parseRiotId('sin-tag'), GameError);
  });

  it('cuenta, rango y últimas partidas', async () => {
    const calls: string[] = [];
    const fetcher: JsonFetcher = async (url, h) => {
      calls.push(url);
      assert.equal(h?.Authorization, 'CLAVE');
      if (url.includes('/v1/account/')) return { status: 200, json: { data: { name: 'TenZ', tag: '0505', region: 'NA', account_level: 412, card: { wide: 'https://x/card.png' } } } };
      if (url.includes('/v2/mmr/')) return { status: 200, json: { data: { current_data: { currenttierpatched: 'Radiant', ranking_in_tier: 512, images: { small: 'https://x/r.png' } }, highest_rank: { patched_tier: 'Radiant' } } } };
      const me = (k: number, d: number, team: string) => ({ name: 'tenz', tag: '0505', character: 'Jett', team, stats: { kills: k, deaths: d, assists: 3, headshots: 10, bodyshots: 30, legshots: 0 } });
      return { status: 200, json: { data: [
        { metadata: { map: 'Ascent', mode: 'Competitive', game_start: 1_700_000_000 }, players: { all_players: [me(25, 10, 'Red')] }, teams: { red: { has_won: true }, blue: { has_won: false } } },
        { metadata: { map: 'Bind', mode: 'Competitive' }, players: { all_players: [me(15, 15, 'Blue')] }, teams: { red: { has_won: true }, blue: { has_won: false } } },
      ] } };
    };
    const p = await fetchValorant('TenZ#0505', 'CLAVE', fetcher);
    assert.equal(p.level, 412);
    assert.equal(p.rank, 'Radiant');
    assert.ok(calls[1].includes('/v2/mmr/na/'));
    const s = valoSummary(p.matches);
    assert.deepEqual([s.played, s.wins, s.kd, s.hs], [2, 1, 1.6, 25]);
  });

  it('errores de la API con mensajes claros', async () => {
    await expectGameError(fetchValorant('Nadie#000', 'K', async () => ({ status: 404, json: null })), /No encontré/);
    await expectGameError(fetchValorant('A#1', 'K', async () => ({ status: 403, json: null })), /clave/);
  });
});

describe('!cs2', () => {
  it('reconoce enlaces, SteamID64 y nombres personalizados', () => {
    assert.deepEqual(parseSteamInput('https://steamcommunity.com/profiles/76561198000000001/'), { steamId: '76561198000000001' });
    assert.deepEqual(parseSteamInput('steamcommunity.com/id/s1mple'), { vanity: 's1mple' });
    assert.deepEqual(parseSteamInput('76561198000000001'), { steamId: '76561198000000001' });
    assert.throws(() => parseSteamInput('no válido!!'), GameError);
  });

  it('calcula K/D, headshots, precisión y horas', () => {
    const s = readCs2Stats({ playerstats: { stats: [
      { name: 'total_kills', value: 1000 }, { name: 'total_deaths', value: 800 }, { name: 'total_kills_headshot', value: 450 },
      { name: 'total_shots_fired', value: 10_000 }, { name: 'total_shots_hit', value: 2_000 }, { name: 'total_time_played', value: 360_000 },
      { name: 'total_matches_played', value: 100 }, { name: 'total_matches_won', value: 55 }, { name: 'total_mvps', value: 70 },
    ] } });
    assert.deepEqual([s.kd, s.headshotPct, s.accuracyPct, s.hours, s.winPct, s.mvps], [1.25, 45, 20, 100, 55, 70]);
  });

  it('perfil privado: lo avisa en vez de fallar', async () => {
    const fetcher: JsonFetcher = async (url) => {
      if (url.includes('ResolveVanityURL')) return { status: 200, json: { response: { success: 1, steamid: '76561198000000001' } } };
      if (url.includes('GetPlayerSummaries')) return { status: 200, json: { response: { players: [{ steamid: '76561198000000001', personaname: 'x', communityvisibilitystate: 1 }] } } };
      return { status: 403, json: null };
    };
    await expectGameError(fetchCs2('alguien', 'K', fetcher), /privado/);
  });
});

describe('enlaces a Tracker.gg y CSRep.gg', () => {
  it('arma los enlaces de perfil', async () => {
    const { trackerUrl, csrepUrl, steamProfileUrl } = await import('../src/services/gameStats');
    assert.equal(trackerUrl('el pibe', 'LAS'), 'https://tracker.gg/valorant/profile/riot/el%20pibe%23LAS/overview');
    assert.equal(csrepUrl('76561198000000001', 'https://csrep.gg/player/{steamid}'), 'https://csrep.gg/player/76561198000000001');
    assert.equal(csrepUrl('76561198000000001', 'https://otra.gg/p/{steamid}/stats'), 'https://otra.gg/p/76561198000000001/stats');
    assert.equal(steamProfileUrl({ vanity: 's1mple' }), 'https://steamcommunity.com/id/s1mple');
  });
});

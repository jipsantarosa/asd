import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlagsBits as F } from 'discord.js';
import { GameError } from '../src/services/context';
import {
  DEFAULT_NAME_TEMPLATE, MAX_ACCESS_ENTRIES, MAX_TEMP_CHANNELS_PER_GUILD, RenameLimiter, creationProblem, forgetTempChannel, getTempChannel,
  getVoiceConfig, getVoiceProfile, listAccess, listTempChannels, registerTempChannel, removeAccess, renderChannelName, saveVoiceConfig,
  saveVoiceProfile, setAccess, setTempOwner, tempChannelOf, validateChannelName, validateLimit,
} from '../src/services/tempVoice';
import { G, U, U2, makeWorld } from './helpers';

const U3 = '200000000000000777';
const C1 = '300000000000000001';
const C2 = '300000000000000002';
const expectGameError = (fn: () => unknown, re?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));

describe('canales temporales: configuración', () => {
  it('sin configurar está apagado y con valores de fábrica; lo guardado persiste', () => {
    const w = makeWorld();
    const c = getVoiceConfig(w.ctx, G);
    assert.equal(c.enabled, false);
    assert.equal(c.nameTemplate, DEFAULT_NAME_TEMPLATE);
    saveVoiceConfig(w.ctx, G, { enabled: true, hubChannelId: C1, nameTemplate: 'Sala de {usuario}', defaultLimit: 5 });
    const again = getVoiceConfig(w.ctx, G);
    assert.deepEqual([again.enabled, again.hubChannelId, again.nameTemplate, again.defaultLimit], [true, C1, 'Sala de {usuario}', 5]);
    assert.equal(getVoiceConfig(w.ctx, '100000000000000999').enabled, false, 'otro servidor no se ve afectado');
  });

  it('rechaza plantillas y límites inválidos sin guardar nada', () => {
    const w = makeWorld();
    expectGameError(() => saveVoiceConfig(w.ctx, G, { nameTemplate: '@everyone {usuario}' }), /everyone/);
    expectGameError(() => saveVoiceConfig(w.ctx, G, { defaultLimit: 100 }), /entre 0/);
    assert.equal(getVoiceConfig(w.ctx, G).nameTemplate, DEFAULT_NAME_TEMPLATE);
  });
});

describe('canales temporales: un dueño, un canal', () => {
  it('registra, encuentra por dueño y olvida', () => {
    const w = makeWorld();
    registerTempChannel(w.ctx, G, C1, U);
    assert.equal(tempChannelOf(w.ctx, G, U)!.channelId, C1);
    assert.equal(getTempChannel(w.ctx, C1)!.ownerId, U);
    assert.equal(creationProblem(w.ctx, G, U), 'ya tenés un canal temporal');
    assert.equal(forgetTempChannel(w.ctx, C1), true);
    assert.equal(forgetTempChannel(w.ctx, C1), false, 'olvidar dos veces no rompe');
    assert.equal(creationProblem(w.ctx, G, U), null);
  });

  it('dos creaciones casi simultáneas: la segunda falla y no queda nada duplicado', () => {
    const w = makeWorld();
    registerTempChannel(w.ctx, G, C1, U);
    expectGameError(() => registerTempChannel(w.ctx, G, C2, U), /ya tenés/);
    assert.equal(listTempChannels(w.ctx, G).length, 1);
  });

  it('tope por servidor', () => {
    const w = makeWorld();
    for (let n = 0; n < MAX_TEMP_CHANNELS_PER_GUILD; n++) registerTempChannel(w.ctx, G, String(400000000000000000n + BigInt(n)), String(500000000000000000n + BigInt(n)));
    assert.match(creationProblem(w.ctx, G, U) ?? '', /máximo/);
    expectGameError(() => registerTempChannel(w.ctx, G, C1, U), /máximo/);
  });

  it('transferir y reclamar: condicional sobre el dueño anterior (sin carreras)', () => {
    const w = makeWorld();
    registerTempChannel(w.ctx, G, C1, U);
    setTempOwner(w.ctx, C1, U, U2);
    assert.equal(getTempChannel(w.ctx, C1)!.ownerId, U2);
    // Un segundo "reclamar" que todavía cree que el dueño es U pierde.
    expectGameError(() => setTempOwner(w.ctx, C1, U, U3), /cambió de dueño/);
    expectGameError(() => setTempOwner(w.ctx, C1, U2, U2), /ya es la dueña/);
    registerTempChannel(w.ctx, G, C2, U3);
    expectGameError(() => setTempOwner(w.ctx, C1, U2, U3), /su propio canal/);
    assert.equal(getTempChannel(w.ctx, C1)!.ownerId, U2);
    expectGameError(() => setTempOwner(w.ctx, '300000000000000099', U, U2), /ya no es un canal temporal/);
  });
});

describe('canales temporales: preferencias y listas', () => {
  it('las preferencias del dueño persisten y se mezclan', () => {
    const w = makeWorld();
    assert.deepEqual(getVoiceProfile(w.ctx, G, U), { name: null, limit: null, locked: false, hidden: false, region: null });
    saveVoiceProfile(w.ctx, G, U, { name: 'La cueva', locked: true });
    saveVoiceProfile(w.ctx, G, U, { limit: 4 });
    assert.deepEqual(getVoiceProfile(w.ctx, G, U), { name: 'La cueva', limit: 4, locked: true, hidden: false, region: null });
  });

  it('permitir y bloquear se excluyen, sin duplicados, sin uno mismo y con tope', () => {
    const w = makeWorld();
    const r = setAccess(w.ctx, G, U, [U2, U2, U, 'no-es-id'], 'trust');
    assert.deepEqual(r.changed, [U2]);
    assert.deepEqual(r.skipped.map((s) => s.reason).sort(), ['sos vos', 'usuario inválido']);
    setAccess(w.ctx, G, U, [U2], 'block');
    assert.deepEqual(listAccess(w.ctx, G, U, 'trust'), [], 'bloquear saca de permitidos');
    assert.deepEqual(listAccess(w.ctx, G, U, 'block'), [U2]);
    assert.deepEqual(removeAccess(w.ctx, G, U, [U2, U3], 'block'), [U2]);
    const many = Array.from({ length: MAX_ACCESS_ENTRIES + 3 }, (_, n) => String(600000000000000000n + BigInt(n)));
    const big = setAccess(w.ctx, G, U, many, 'trust');
    assert.equal(big.changed.length, MAX_ACCESS_ENTRIES);
    assert.equal(big.skipped.length, 3);
  });
});

describe('canales temporales: validaciones', () => {
  it('nombres', () => {
    assert.equal(validateChannelName('  Sala\n de   juegos '), 'Sala de juegos');
    expectGameError(() => validateChannelName('   '), /vacío/);
    expectGameError(() => validateChannelName('x'.repeat(101)), /100/);
    expectGameError(() => validateChannelName('entren discord.gg/abc'), /enlaces/);
    expectGameError(() => validateChannelName('https://spam.example'), /enlaces/);
    expectGameError(() => validateChannelName('hola @here'), /here/);
  });

  it('plantilla: {usuario} y caída segura a la de fábrica', () => {
    assert.equal(renderChannelName('Sala de {usuario}', 'salo'), 'Sala de salo');
    assert.equal(renderChannelName('{usuario} y {usuario}', 'h'), 'h y h');
    assert.equal(renderChannelName('Canal de {usuario}', '@everyone'), 'Canal de everyone', 'un nombre no puede colar una mención masiva');
    assert.ok(renderChannelName('{usuario}', 'x'.repeat(200)).length <= 100);
    assert.equal(renderChannelName('{usuario}', '   '), 'alguien');
  });

  it('límite de usuarios', () => {
    assert.equal(validateLimit('0'), 0);
    assert.equal(validateLimit(' 99 '), 99);
    for (const bad of ['-1', '100', '2.5', 'abc', '']) expectGameError(() => validateLimit(bad), /entre 0/);
  });

  it('renombres: 2 cada 10 minutos por canal, como Discord', () => {
    const r = new RenameLimiter();
    const t0 = 1_000_000;
    assert.equal(r.readyAt(C1, t0), null);
    r.record(C1, t0);
    r.record(C1, t0 + 1000);
    assert.equal(r.readyAt(C1, t0 + 2000), t0 + 600_000);
    assert.equal(r.readyAt(C2, t0 + 2000), null, 'cada canal por separado');
    assert.equal(r.readyAt(C1, t0 + 600_001), null);
    r.sweep(t0 + 10_000_000);
    assert.equal(r.readyAt(C1, t0 + 10_000_000), null);
  });
});


describe('canales temporales: permisos del canal nuevo', () => {
  // Servidor simulado: el bot tiene todo menos PrioritySpeaker (no puede otorgar lo que no tiene).
  const load = () => import('../src/discord/voice/tempVoice');
  const BOT = '700000000000000001';
  async function fakeGuild(categoryOverwrites: { id: string; type: number; allow: bigint; deny: bigint }[] = []) {
    const has = (f: bigint) => f !== F.PrioritySpeaker;
    const perms = { has };
    const guild = { id: G, members: { me: { id: BOT, permissions: perms } } };
    const parent = {
      permissionsFor: () => perms,
      permissionOverwrites: { cache: new Map(categoryOverwrites.map((o) => [o.id, { id: o.id, type: o.type, allow: { bitfield: o.allow }, deny: { bitfield: o.deny } }])) },
    };
    return { guild, parent };
  }

  it('privado + oculto, permitidos, bloqueados, dueño y bot; hereda la categoría', async () => {
    const { buildOverwrites } = await load();
    const STAFF_ROLE = '800000000000000001';
    const { guild, parent } = await fakeGuild([{ id: STAFF_ROLE, type: 0, allow: F.ViewChannel | F.Connect, deny: 0n }]);
    const ow = buildOverwrites(guild as never, parent as never, U, { name: null, limit: null, locked: true, hidden: true, region: null }, [U2], [U3]);
    const by = new Map(ow.map((o) => [String(o.id), o as { allow: bigint; deny: bigint }]));
    assert.equal(by.get(STAFF_ROLE)!.allow, F.ViewChannel | F.Connect, 'conserva los permisos de la categoría');
    assert.equal(by.get(G)!.deny, F.Connect | F.ViewChannel, '@everyone sin Ver ni Conectar');
    assert.equal(by.get(U2)!.allow, F.ViewChannel | F.Connect, 'permitido');
    assert.equal(by.get(U3)!.deny, F.ViewChannel | F.Connect, 'bloqueado');
    const owner = by.get(U)!;
    assert.ok((owner.allow & F.Connect) && (owner.allow & F.Speak));
    assert.equal(owner.allow & F.PrioritySpeaker, 0n, 'no otorga lo que el bot no tiene');
    assert.equal(owner.allow & F.ManageChannels, 0n, 'el dueño nunca recibe permisos de gestión');
    assert.ok(by.get(BOT)!.allow & F.ManageChannels, 'el bot se asegura de poder manejar el canal');
  });

  it('abierto y visible: no toca @everyone; el dueño en su propia lista se ignora', async () => {
    const { buildOverwrites } = await load();
    const { guild, parent } = await fakeGuild();
    const ow = buildOverwrites(guild as never, parent as never, U, { name: null, limit: null, locked: false, hidden: false, region: null }, [U], [U]);
    assert.equal(ow.some((o) => String(o.id) === G), false);
    const owner = ow.find((o) => String(o.id) === U) as { deny: bigint };
    assert.equal(owner.deny, 0n, 'el dueño nunca queda bloqueado en su canal');
  });
});

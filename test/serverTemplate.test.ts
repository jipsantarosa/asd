import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { GameError } from '../src/services/context';
import {
  botServerTemplate, BUILTIN_TEMPLATE, cleanTemplateName, deleteTemplate, fillTemplateText, getTemplate, listTemplates, nameKey, parseTemplate,
  parseTemplateText, permBits, permNames, planApply, saveTemplate, snapshotToTemplate, templateStats, templateToText, type GuildSnapshot,
} from '../src/services/serverTemplate';
import { U, makeWorld } from './helpers';

const expectGameError = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));
const base = { format: 'casino-template', version: 1, name: 'Prueba', roles: [], channels: [], categories: [] };

describe('plantillas de servidor: plantilla incluida', () => {
  const tpl = botServerTemplate();

  it('es válida, tiene anuncios, invitación, soporte, staff y autorroles', () => {
    const st = templateStats(tpl);
    assert.ok(st.roles >= 10 && st.channels >= 15 && st.messages >= 5);
    const all = tpl.categories.flatMap((c) => c.channels);
    assert.ok(all.some((c) => c.type === 'announcement'));
    for (const role of ['system', 'rules', 'modUpdates', 'selfRoles'] as const) assert.ok(all.some((c) => c.role === role), role);
    assert.ok(tpl.roles.some((r) => r.selfAssign));
    assert.ok(tpl.roles.some((r) => r.giveToExecutor));
    assert.deepEqual(parseTemplateText(templateToText(tpl)), tpl);
  });

  it('todos los permisos por rol y los {#canal} / {@&rol} de los mensajes apuntan a cosas de la plantilla', () => {
    const roles = new Set(tpl.roles.map((r) => nameKey(r.name)));
    const channels = new Set(tpl.categories.flatMap((c) => c.channels).map((c) => nameKey(c.name)));
    for (const cat of tpl.categories) {
      for (const o of [...(cat.overwrites ?? []), ...cat.channels.flatMap((c) => c.overwrites ?? [])]) {
        assert.ok(o.role === '@everyone' || roles.has(nameKey(o.role)), o.role);
      }
      for (const ch of cat.channels) {
        const text = JSON.stringify(ch.messages ?? []);
        for (const m of text.matchAll(/\{#([^{}]+)\}/g)) assert.ok(channels.has(nameKey(m[1])), m[1]);
        for (const m of text.matchAll(/\{@&([^{}]+)\}/g)) assert.ok(roles.has(nameKey(m[1])), m[1]);
      }
    }
  });

  it('las Coins se presentan como virtuales', () => {
    assert.match(JSON.stringify(tpl), /virtual/i);
  });

  it('nombres simples: sin emojis en roles, categorías ni canales', () => {
    const emoji = /\p{Extended_Pictographic}/u;
    const names = [...tpl.roles.map((r) => r.name), ...tpl.categories.map((c) => c.name), ...tpl.categories.flatMap((c) => c.channels.map((ch) => ch.name))];
    for (const n of names) assert.ok(!emoji.test(n), n);
    // Ningún nombre de canal choca con otro (los {#canal} de los mensajes apuntan a uno solo).
    const keys = tpl.categories.flatMap((c) => c.channels.map((ch) => nameKey(ch.name)));
    assert.equal(new Set(keys).size, keys.length);
  });

  it('un rol por nivel premium', () => {
    assert.deepEqual(tpl.roles.filter((r) => r.premiumTier).map((r) => r.premiumTier).sort(), [1, 2, 3, 4]);
    expectGameError(() => parseTemplate({ ...base, roles: [{ name: 'A', premiumTier: 2 }, { name: 'B', premiumTier: 2 }] }), /premiumTier/);
    expectGameError(() => parseTemplate({ ...base, roles: [{ name: 'A', premiumTier: 7 }] }), /premiumTier/);
  });

  it('estructura pedida: inf, comm, creator (voz temporal) y Staff', async () => {
    const { VOICE_NAMES, normalizeName } = await import('../src/services/tempVoice');
    assert.deepEqual(tpl.categories.map((c) => c.name), ['・inf', '・comm', 'creator', '・Staff']);
    assert.deepEqual(tpl.categories[0].channels.map((c) => c.name), ['・welcome', '・rules', '・ann', '・news', '・bot-invite', '・rol']);
    assert.deepEqual(tpl.categories[1].channels.map((c) => c.name), ['・suggestions', '・txt', '・cmd', '・media', '・partners']);
    // Los canales de creator son los de la voz temporal: el bot los reconoce por nombre y los configura.
    const creator = tpl.categories[2];
    assert.equal(normalizeName(creator.name), normalizeName(VOICE_NAMES.category.name));
    assert.equal(normalizeName(creator.channels[0].name), normalizeName(VOICE_NAMES.iface.name));
    assert.equal(normalizeName(creator.channels[1].name), normalizeName(VOICE_NAMES.hub.name));
    assert.equal(tpl.bot?.tempVoice, true);
  });

  it('autorol separado: Miembro para personas y Bots para bots', () => {
    assert.equal(tpl.roles.find((r) => r.autoRole === 'members')?.name, 'Miembro');
    assert.equal(tpl.roles.find((r) => r.autoRole === 'bots')?.name, 'Bots');
  });
});

describe('plantillas de servidor: validación', () => {
  it('rechaza lo que no es una plantilla del bot', () => {
    expectGameError(() => parseTemplate({ name: 'x' }), /casino-template/);
    expectGameError(() => parseTemplateText('{nope'), /JSON/);
    expectGameError(() => parseTemplate({ ...base, version: 2 }), /versión/);
  });

  it('marca el lugar exacto del error', () => {
    expectGameError(() => parseTemplate({ ...base, roles: [{ name: 'Mod', permissions: ['Volar'] }] }), /rol 1.*Volar/);
    expectGameError(() => parseTemplate({ ...base, categories: [{ name: 'Info', channels: [{ name: 'x', type: 'tienda' }] }] }), /Info.*type/);
    expectGameError(() => parseTemplate({ ...base, roles: [{ name: 'Mod' }, { name: '🛡️ mod' }] }), /repetido/);
    expectGameError(() => parseTemplate({ ...base, channels: [{ name: 'a', type: 'text', messages: [{ footer: 'solo pie' }] }] }), /mensaje 1/);
    expectGameError(() => parseTemplate({ ...base, channels: [{ name: 'a', type: 'text', messages: [{ content: 'hola', buttons: [{ label: 'x', url: 'javascript:alert(1)' }] }] }] }), /https/);
  });

  it('autoRole: "members" o "bots", uno de cada uno', () => {
    expectGameError(() => parseTemplate({ ...base, roles: [{ name: 'A', autoRole: true }] }), /members.*bots/);
    expectGameError(() => parseTemplate({ ...base, roles: [{ name: 'A', autoRole: 'members' }, { name: 'B', autoRole: 'members' }] }), /solo un rol/);
    assert.equal(parseTemplate({ ...base, roles: [{ name: 'A', autoRole: 'members' }, { name: 'B', autoRole: 'bots' }] }).roles[1].autoRole, 'bots');
  });

  it('respeta los límites de Discord', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ name: `c${i}`, type: 'text' }));
    expectGameError(() => parseTemplate({ ...base, channels: many }), /máximo 50/);
    expectGameError(() => parseTemplate({ ...base, channels: [{ name: 'x'.repeat(101), type: 'text' }] }), /100 caracteres/);
    expectGameError(() => parseTemplateText(' '.repeat(600 * 1024)), /KB/);
  });

  it('nombres comparables y permisos ida y vuelta', () => {
    assert.equal(nameKey('💬・General'), 'general');
    assert.equal(nameKey('📢 Anuncios'), nameKey('anuncios'));
    assert.equal(nameKey('Música'), 'musica');
    assert.equal(cleanTemplateName('Mi Servidor_2'), 'mi-servidor-2');
    expectGameError(() => cleanTemplateName('💥💥'));
    const bits = PermissionFlagsBits.ManageMessages | PermissionFlagsBits.KickMembers | PermissionFlagsBits.ManageGuildExpressions;
    assert.equal(permBits(permNames(bits)), bits);
    assert.equal(permNames(bits).length, 3);
  });
});

describe('plantillas de servidor: copiar y pegar', () => {
  const snap: GuildSnapshot = {
    name: 'Mi server',
    everyoneId: '1',
    roles: [
      { id: '1', name: '@everyone', color: 0, hoist: false, mentionable: false, permissions: PermissionFlagsBits.ViewChannel, managed: false, position: 0 },
      { id: '2', name: 'Mod', color: 0xff0000, hoist: true, mentionable: false, permissions: PermissionFlagsBits.KickMembers, managed: false, position: 2 },
      { id: '3', name: 'MiBot', color: 0, hoist: false, mentionable: false, permissions: 0n, managed: true, position: 3 },
      { id: '4', name: 'Mod', color: 0, hoist: false, mentionable: false, permissions: 0n, managed: false, position: 1 },
    ],
    channels: [
      { id: '10', name: 'Info', type: 4, parentId: null, position: 0, overwrites: [] },
      { id: '11', name: 'reglas', type: 0, parentId: '10', position: 0, topic: 'Leé', overwrites: [
        { id: '1', type: 'role', allow: 0n, deny: PermissionFlagsBits.SendMessages },
        { id: '999', type: 'member', allow: PermissionFlagsBits.SendMessages, deny: 0n },
      ] },
      { id: '12', name: 'Charla', type: 2, parentId: '10', position: 0, userLimit: 10, overwrites: [] },
      { id: '13', name: 'staff', type: 0, parentId: '10', position: 1, overwrites: [{ id: '2', type: 'role', allow: PermissionFlagsBits.ViewChannel, deny: 0n }] },
      { id: '14', name: 'suelto', type: 0, parentId: null, position: 0, overwrites: [] },
    ],
    rulesChannelId: '11',
    verification: 2,
    autoRoles: { members: '4', bots: null },
  };

  it('copia roles (sin @everyone ni bots), categorías, canales en orden y permisos por rol', () => {
    const tpl = snapshotToTemplate(snap, 'x');
    assert.deepEqual(tpl.roles.map((r) => r.name), ['Mod', 'Mod (2)']);
    assert.deepEqual(tpl.roles[0].permissions, ['KickMembers']);
    assert.deepEqual(tpl.channels.map((c) => c.name), ['suelto']);
    assert.deepEqual(tpl.categories[0].channels.map((c) => c.name), ['reglas', 'staff', 'Charla']);
    const reglas = tpl.categories[0].channels[0];
    assert.equal(reglas.role, 'rules');
    assert.deepEqual(reglas.overwrites, [{ role: '@everyone', deny: ['SendMessages'] }]);
    assert.equal(tpl.categories[0].channels[2].userLimit, 10);
    assert.equal(tpl.settings?.verification, 'medium');
    assert.equal(tpl.roles[1].autoRole, 'members');
    assert.equal(tpl.roles[0].autoRole, undefined);
  });

  it('pegar reutiliza lo que ya existe y solo crea lo que falta (nunca borra)', () => {
    const tpl = snapshotToTemplate(snap, 'x');
    const fresh = planApply(tpl, { roles: [], categories: [], channels: [] });
    assert.equal(fresh.createRoles.length, 2);
    assert.equal(fresh.createChannels.length, 4);
    const again = planApply(tpl, {
      roles: ['mod', 'Mod (2)'],
      categories: ['📁 INFO'],
      channels: [{ name: 'reglas', kind: 'text', parent: 'INFO' }, { name: 'charla', kind: 'voice', parent: 'info' }, { name: 'staff', kind: 'text', parent: null }],
    });
    assert.equal(again.createRoles.length, 0);
    assert.deepEqual(again.reuseCategories, ['Info']);
    // "staff" existe pero en otra categoría; "suelto" no existe.
    assert.deepEqual(again.createChannels.map((c) => c.channel.name).sort(), ['staff', 'suelto']);
    assert.equal(again.reuseChannels.length, 2);
    assert.ok(!('delete' in again));
  });

  it('un canal de voz no se confunde con uno de texto del mismo nombre', () => {
    const tpl = parseTemplate({ ...base, channels: [{ name: 'general', type: 'voice' }] });
    assert.equal(planApply(tpl, { roles: [], categories: [], channels: [{ name: 'general', kind: 'text', parent: null }] }).createChannels.length, 1);
  });

  it('textos con variables', () => {
    const out = fillTemplateText('{bot} en {server}: {#📜・reglas} {@&Staff} {#nada} {prefix}work {invite}', {
      server: 'S', bot: 'B', invite: 'https://x', prefix: '!', user: '<@1>',
      channel: (n) => (nameKey(n) === 'reglas' ? '55' : null), role: (n) => (n === 'Staff' ? '66' : null),
    });
    assert.equal(out, 'B en S: <#55> <@&66> #nada !work https://x');
  });
});

describe('plantillas de servidor: guardadas', () => {
  it('guardar, no pisar sin permiso, reemplazar, listar y borrar', () => {
    const w = makeWorld();
    const tpl = parseTemplate({ ...base, roles: [{ name: 'A' }] });
    saveTemplate(w.ctx, 'Mi Plantilla', tpl, { by: U });
    assert.equal(getTemplate(w.ctx, 'mi-plantilla')!.template.roles[0].name, 'A');
    expectGameError(() => saveTemplate(w.ctx, 'mi-plantilla', tpl, { by: U }), /Ya existe/);
    saveTemplate(w.ctx, 'mi-plantilla', parseTemplate({ ...base, roles: [{ name: 'B' }] }), { by: U, replace: true });
    assert.equal(getTemplate(w.ctx, 'mi-plantilla')!.template.roles[0].name, 'B');
    assert.deepEqual(listTemplates(w.ctx).map((t) => t.name), ['mi-plantilla']);
    deleteTemplate(w.ctx, 'mi-plantilla');
    assert.equal(getTemplate(w.ctx, 'mi-plantilla'), null);
    expectGameError(() => deleteTemplate(w.ctx, 'mi-plantilla'), /No existe/);
  });

  it('la plantilla incluida siempre está y no se puede pisar ni borrar', () => {
    const w = makeWorld();
    assert.equal(getTemplate(w.ctx, BUILTIN_TEMPLATE)!.template.name, botServerTemplate().name);
    expectGameError(() => saveTemplate(w.ctx, BUILTIN_TEMPLATE, botServerTemplate(), { by: U, replace: true }), /incluida/);
    expectGameError(() => deleteTemplate(w.ctx, BUILTIN_TEMPLATE), /no se puede borrar/);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMMANDS } from '../src/discord/commands';
import { findHelpCategory, findHelpCommand, helpFor, HELP_CATEGORIES, usageOf } from '../src/discord/ui/helpMenu';
import { G, U, makeWorld } from './helpers';

const viewer = { guildId: G, userId: U, name: 'Ana', avatar: 'https://x/a.png' };

describe('!help', () => {
  it('todos los comandos tienen categoría (ninguno queda en "Otros")', () => {
    const known = new Set(HELP_CATEGORIES.flatMap((c) => c.commands));
    assert.deepEqual(COMMANDS.map((c) => c.name).filter((n) => !known.has(n)), []);
  });

  it('portada, categorías y comandos entran en los límites de Discord', () => {
    const w = makeWorld();
    const home = helpFor(w.ctx, viewer, null)!;
    const text = home.embeds[0].toJSON().description!;
    assert.match(text, new RegExp(`\`${COMMANDS.length}\` \\*\\*comandos\\*\\*`));
    assert.match(text, /!help casino/);
    for (const cat of HELP_CATEGORIES) {
      const d = helpFor(w.ctx, viewer, cat.id)!.embeds[0].toJSON().description!;
      assert.ok(d.length <= 4096, cat.id);
    }
    for (const c of COMMANDS) {
      const e = helpFor(w.ctx, viewer, c.name)!.embeds[0].toJSON();
      for (const f of e.fields ?? []) assert.ok(f.value.length <= 1024 && f.value.length > 0, `${c.name}: ${f.name}`);
    }
  });

  it('busca por categoría, nombre o alias (con o sin el prefijo)', () => {
    assert.equal(findHelpCategory('Diversión')?.id, 'diversion');
    assert.equal(findHelpCommand('!trabajar')?.name, 'work');
    assert.equal(findHelpCommand('valo')?.name, 'uservalo');
    assert.equal(helpFor(makeWorld().ctx, viewer, 'cualquiercosa'), null);
  });

  it('muestra el uso con obligatorios <> y opcionales []', () => {
    assert.deepEqual(usageOf(findHelpCommand('cs2')!, '!'), ['!cs2 <steam>']);
    assert.ok(usageOf(findHelpCommand('autorol')!, '!').includes('!autorol miembros <rol>'));
    assert.deepEqual(usageOf(findHelpCommand('warn')!, '!'), ['!warn @usuario [motivo]']);
  });
});

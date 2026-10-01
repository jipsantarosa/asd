import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Los comandos no se pueden importar en los tests (necesitan discord.js), así que se revisan
 * leyendo el código: ningún nombre ni alias puede repetirse (si se repite, el bot no arranca).
 */
const dir = path.join(__dirname, '..', 'src', 'discord', 'commands');

function namesAndAliases(): { token: string; file: string; line: number }[] {
  const out: { token: string; file: string; line: number }[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts') && x !== 'types.ts')) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((text, i) => {
      // name: '…' / aliases: [...] y también los comandos solo por prefijo: prefixOnly('warn', ['advertir', …], …)
      if (!/^\s*(name|aliases):/.test(text) && !/prefixOnly\('/.test(text)) return;
      if (/function prefixOnly/.test(text)) return;
      for (const m of text.matchAll(/'([^']+)'/g)) out.push({ token: m[1].toLowerCase(), file: f, line: i + 1 });
    });
  }
  return out;
}

describe('comandos', () => {
  it('ningún nombre ni alias está repetido', () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const t of namesAndAliases()) {
      const where = `${t.file}:${t.line}`;
      if (seen.has(t.token)) dups.push(`"${t.token}" en ${seen.get(t.token)} y ${where}`);
      else seen.set(t.token, where);
    }
    assert.deepEqual(dups, []);
  });

  it('los atajos pedidos existen: !m (borrar), !avs, !banners, !kiss', () => {
    const tokens = new Set(namesAndAliases().map((t) => t.token));
    for (const t of ['m', 'avs', 'banners', 'kiss', 'mercado', 'tienda', 'besos', 'voz', 'canal', 'warn', 'timeout', 'kick', 'ban', 'unban', 'historial', 'caso', 'automod']) {
      assert.ok(tokens.has(t), `falta ${t}`);
    }
  });
});

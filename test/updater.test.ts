import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
// @ts-expect-error: el actualizador es JavaScript plano (corre antes de compilar).
import { backupDatabase, extractTarGz, readEnv, syncInto } from '../scripts/actualizar.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'upd-test-'));
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (file: string) => fs.readFileSync(file, 'utf8');

describe('actualizador', () => {
  it('lee el .env con comentarios, comillas y CRLF', () => {
    const d = tmp();
    write(path.join(d, '.env'), '# comentario\r\nUPDATE_REPO=yo/bot\r\nUPDATE_BRANCH="main"\r\nGITHUB_TOKEN= abc \r\nVACIO=\r\n');
    assert.deepEqual(readEnv(path.join(d, '.env')), { UPDATE_REPO: 'yo/bot', UPDATE_BRANCH: 'main', GITHUB_TOKEN: 'abc', VACIO: '' });
    assert.deepEqual(readEnv(path.join(d, 'no-existe')), {});
  });

  it('extrae el tar.gz de GitHub (carpeta raíz, rutas largas pax) y descarta rutas peligrosas', () => {
    const d = tmp();
    const src = path.join(d, 'yo-bot-abc123');
    const long = `src/${'carpeta-con-nombre-muy-largo/'.repeat(5)}archivo.ts`;
    write(path.join(src, 'package.json'), '{}');
    write(path.join(src, long), 'export const x = 1;\n');
    write(path.join(src, 'wiki', 'ñandú.md'), '# hola');
    const tgz = path.join(d, 'code.tar.gz');
    execFileSync('tar', ['--format=pax', '-czf', tgz, '-C', d, 'yo-bot-abc123']);
    const root = extractTarGz(fs.readFileSync(tgz), path.join(d, 'out'));
    assert.equal(path.basename(root), 'yo-bot-abc123');
    assert.equal(read(path.join(root, long)), 'export const x = 1;\n');
    assert.equal(read(path.join(root, 'wiki', 'ñandú.md')), '# hola');

    // Un tar con "../" no escribe fuera de la carpeta.
    const evil = path.join(d, 'evil');
    write(path.join(evil, 'ok.txt'), 'ok');
    const etgz = path.join(d, 'evil.tar.gz');
    execFileSync('tar', ['-czf', etgz, '-C', evil, 'ok.txt', '--transform', 's,ok.txt,../escapado.txt,', '-P']);
    assert.throws(() => extractTarGz(fs.readFileSync(etgz), path.join(d, 'out2')), /vacío o dañado/);
    assert.ok(!fs.existsSync(path.join(d, 'escapado.txt')));
  });

  it('reemplaza el código pero nunca .env, data/, node_modules/ ni dist/', () => {
    const d = tmp();
    const bot = path.join(d, 'bot');
    write(path.join(bot, '.env'), 'DISCORD_TOKEN=secreto');
    write(path.join(bot, 'data', 'valle.db'), 'base');
    write(path.join(bot, 'node_modules', 'x', 'index.js'), 'mod');
    write(path.join(bot, 'src', 'viejo.ts'), 'borrado en la versión nueva');
    write(path.join(bot, 'src', 'index.ts'), 'viejo');
    write(path.join(bot, 'mis-notas.txt'), 'mío');
    write(path.join(bot, 'actualizar.bat'), 'viejo bat');

    const nuevo = path.join(d, 'nuevo');
    write(path.join(nuevo, 'package.json'), '{"v":2}');
    write(path.join(nuevo, 'src', 'index.ts'), 'nuevo');
    write(path.join(nuevo, 'scripts', 'actualizar.mjs'), '// nuevo');
    write(path.join(nuevo, '.env'), 'DISCORD_TOKEN=pisado');
    write(path.join(nuevo, 'data', 'valle.db'), 'pisada');
    write(path.join(nuevo, 'actualizar.bat'), 'nuevo bat');

    assert.deepEqual(syncInto(nuevo, bot), { selfUpdated: true });
    assert.equal(read(path.join(bot, '.env')), 'DISCORD_TOKEN=secreto');
    assert.equal(read(path.join(bot, 'data', 'valle.db')), 'base');
    assert.equal(read(path.join(bot, 'node_modules', 'x', 'index.js')), 'mod');
    assert.equal(read(path.join(bot, 'src', 'index.ts')), 'nuevo');
    assert.ok(!fs.existsSync(path.join(bot, 'src', 'viejo.ts')));
    assert.equal(read(path.join(bot, 'package.json')), '{"v":2}');
    assert.equal(read(path.join(bot, 'mis-notas.txt')), 'mío');
    // El .bat que está corriendo no se pisa: queda el nuevo al lado.
    assert.equal(read(path.join(bot, 'actualizar.bat')), 'viejo bat');
    assert.equal(read(path.join(bot, 'actualizar.bat.new')), 'nuevo bat');

    fs.rmSync(path.join(bot, 'actualizar.bat.new'));
    fs.writeFileSync(path.join(bot, 'actualizar.bat'), 'nuevo bat');
    assert.deepEqual(syncInto(nuevo, bot), { selfUpdated: false });
  });

  it('no copia nada si lo bajado no es el bot', () => {
    const d = tmp();
    write(path.join(d, 'raro', 'README.md'), 'otra cosa');
    assert.throws(() => syncInto(path.join(d, 'raro'), path.join(d, 'bot')), /no tiene el código del bot/);
  });

  it('respalda la base (con -wal) antes de actualizar', () => {
    const d = tmp();
    write(path.join(d, 'data', 'valle.db'), 'base');
    write(path.join(d, 'data', 'valle.db-wal'), 'wal');
    const out = backupDatabase(d, 'data/valle.db', new Date(2026, 9, 3, 14, 5, 9));
    assert.equal(path.basename(out), 'antes-de-actualizar-20261003-140509.db');
    assert.equal(read(out), 'base');
    assert.equal(read(`${out}-wal`), 'wal');
    assert.equal(backupDatabase(tmp()), null);
  });
});

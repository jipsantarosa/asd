// Actualizador del bot (lo usa actualizar.bat). Reemplaza SOLO el código: nunca toca .env, data/, node_modules/ ni .git/.
// No usa dependencias: corre con el Node que ya tenés instalado, antes de compilar nada.
//
//   node scripts/actualizar.mjs
//
// De dónde baja el código (en este orden):
//   1. Si la carpeta es un clon de git: git pull (solo avance rápido).
//   2. Si hay GITHUB_TOKEN en el .env: descarga desde la API de GitHub (sirve para repos privados).
//   3. Si Git está instalado: git clone (en un repo privado, Git abre el navegador para iniciar sesión una sola vez).
//   4. Si no: descarga pública (solo funciona si el repo es público).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const DEFAULT_REPO = 'jipsantarosa/asd';
const DEFAULT_BRANCH = 'claude/bot-besos-canales-temporales-qdksf6';

/** Nunca se tocan (datos, configuración, dependencias y compilado). */
export const PROTECTED = new Set(['.env', 'data', 'node_modules', 'dist', '.git']);
/** Carpetas de código: quedan idénticas a la versión nueva (lo que se borró en la versión nueva también se borra acá). */
export const MIRRORED = ['src', 'test', 'wiki', 'docs', 'scripts'];
const SELF_BAT = 'actualizar.bat';

export class UpdateError extends Error {}

// ───────────────────────── .env ─────────────────────────

export function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// ───────────────────────── copia de seguridad ─────────────────────────

export function backupDatabase(root, dbPath = 'data/valle.db', now = new Date()) {
  const db = path.resolve(root, dbPath);
  if (!fs.existsSync(db)) return null;
  const dir = path.join(path.dirname(db), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const target = path.join(dir, `antes-de-actualizar-${stamp}.db`);
  fs.copyFileSync(db, target);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(db + ext)) fs.copyFileSync(db + ext, target + ext);
  return target;
}

// ───────────────────────── tar.gz (sin dependencias) ─────────────────────────

function safeJoin(dest, rel) {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((s) => s === '..')) return null;
  const full = path.resolve(dest, clean);
  return full.startsWith(path.resolve(dest) + path.sep) ? full : null;
}

function parsePax(body) {
  // Cada registro es "<largo> clave=valor\n" y el largo se cuenta en BYTES (importa con tildes y eñes).
  const out = {};
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(body.subarray(i, sp).toString('ascii'), 10);
    if (!len) break;
    const rec = body.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Extrae un .tar.gz (formato de GitHub: ustar + pax) en dest. Ignora enlaces y rutas peligrosas. */
export function extractTarGz(gz, dest) {
  const buf = zlib.gunzipSync(gz);
  fs.mkdirSync(dest, { recursive: true });
  let off = 0;
  let longName = null;
  let paxPath = null;
  let files = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (start, len) => {
      const b = h.subarray(start, start + len);
      const z = b.indexOf(0);
      return b.subarray(0, z < 0 ? len : z).toString('utf8');
    };
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    let name = field(0, 100);
    if (field(257, 5) === 'ustar') {
      const prefix = field(345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { paxPath = parsePax(body).path ?? null; continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = body.toString('utf8').replace(/\0[\s\S]*$/, ''); continue; }
    const rel = paxPath ?? longName ?? name;
    paxPath = null;
    longName = null;
    const full = safeJoin(dest, rel);
    if (!full) continue;
    if (type === '5') fs.mkdirSync(full, { recursive: true });
    else if (type === '0' || type === '7') {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
      files++;
    }
  }
  if (!files) throw new UpdateError('El archivo descargado está vacío o dañado.');
  // GitHub mete todo en una carpeta "usuario-repo-commit/": se devuelve esa.
  const top = fs.readdirSync(dest);
  return top.length === 1 && fs.statSync(path.join(dest, top[0])).isDirectory() ? path.join(dest, top[0]) : dest;
}

// ───────────────────────── copiar la versión nueva ─────────────────────────

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/** Deja dst igual a src (borra lo que sobra). Solo se usa en carpetas de código. */
function mirrorDir(src, dst) {
  if (fs.existsSync(dst)) {
    for (const e of fs.readdirSync(dst, { withFileTypes: true })) {
      const s = path.join(src, e.name);
      if (!fs.existsSync(s) || fs.statSync(s).isDirectory() !== e.isDirectory()) fs.rmSync(path.join(dst, e.name), { recursive: true, force: true });
    }
  }
  copyDir(src, dst);
}

/**
 * Copia el código nuevo sobre la carpeta del bot. .env, data/, node_modules/, dist/ y .git/ no se tocan nunca.
 * actualizar.bat no se pisa mientras corre: se deja como actualizar.bat.new y el .bat se reemplaza al final.
 */
export function syncInto(srcRoot, root) {
  if (!fs.existsSync(path.join(srcRoot, 'package.json')) || !fs.existsSync(path.join(srcRoot, 'src'))) {
    throw new UpdateError('Lo que bajé no tiene el código del bot (falta package.json o src/).');
  }
  let selfUpdated = false;
  for (const e of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    if (PROTECTED.has(e.name)) continue;
    const s = path.join(srcRoot, e.name);
    const d = path.join(root, e.name);
    if (e.isDirectory()) {
      if (MIRRORED.includes(e.name)) mirrorDir(s, d);
      else copyDir(s, d);
    } else if (e.isFile()) {
      if (e.name.toLowerCase() === SELF_BAT) {
        const now = fs.existsSync(d) ? fs.readFileSync(d) : null;
        const next = fs.readFileSync(s);
        if (!now || !now.equals(next)) {
          fs.writeFileSync(`${d}.new`, next);
          selfUpdated = true;
        }
      } else fs.copyFileSync(s, d);
    }
  }
  return { selfUpdated };
}

// ───────────────────────── descargas ─────────────────────────

function hasGit() {
  const r = spawnSync('git', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: 'inherit' });
  return r.status === 0;
}

async function download(repo, branch, token) {
  const url = token
    ? `https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(branch)}`
    : `https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`;
  const headers = { 'User-Agent': 'casino-bot-updater', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, { headers, redirect: 'follow' });
  } catch (err) {
    throw new UpdateError(`No me pude conectar a GitHub (${err.cause?.code ?? err.message}). Revisá tu conexión a internet.`);
  }
  if (res.status === 401) throw new UpdateError('GitHub rechazó el GITHUB_TOKEN del .env (está mal copiado o venció). Creá uno nuevo.');
  if (res.status === 404) {
    throw new UpdateError(token
      ? `GitHub no encuentra ${repo} (rama "${branch}") con ese token. Revisá UPDATE_REPO y UPDATE_BRANCH, y que el token tenga acceso de lectura a ese repositorio.`
      : `No encuentro ${repo} (rama "${branch}"). Si el repositorio es PRIVADO, instalá Git (https://git-scm.com) o poné un GITHUB_TOKEN en el .env. Si no, revisá UPDATE_REPO y UPDATE_BRANCH.`);
  }
  if (!res.ok) throw new UpdateError(`GitHub respondió ${res.status} ${res.statusText}.`);
  return Buffer.from(await res.arrayBuffer());
}

// ───────────────────────── principal ─────────────────────────

export async function main(root) {
  const env = readEnv(path.join(root, '.env'));
  const repo = (env.UPDATE_REPO || DEFAULT_REPO).replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const branch = env.UPDATE_BRANCH || DEFAULT_BRANCH;
  const token = env.GITHUB_TOKEN || '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new UpdateError(`UPDATE_REPO no es válido: "${repo}". Tiene que ser usuario/repositorio.`);
  console.log(`Repositorio: ${repo}  ·  rama: ${branch}`);

  const backup = backupDatabase(root, env.DATABASE_PATH || 'data/valle.db');
  console.log(backup ? `Copia de la base: ${path.relative(root, backup)}` : 'Todavía no hay base de datos: nada que respaldar.');

  // 1) Clon de git: git pull.
  if (fs.existsSync(path.join(root, '.git')) && hasGit()) {
    console.log('Esta carpeta es un clon de git: actualizo con git.');
    if (!git(['fetch', 'origin', branch], root)) throw new UpdateError('git fetch falló (mirá el error de arriba).');
    git(['checkout', branch], root);
    if (!git(['merge', '--ff-only', `origin/${branch}`], root)) {
      throw new UpdateError('No pude actualizar con git porque hay cambios locales en el código. Guardalos o descartalos y volvé a intentar.');
    }
    return { selfUpdated: false };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-update-'));
  try {
    let srcRoot;
    if (token) {
      console.log('Descargando la versión nueva (con GITHUB_TOKEN)...');
      srcRoot = extractTarGz(await download(repo, branch, token), path.join(tmp, 'x'));
    } else if (hasGit()) {
      console.log('Descargando la versión nueva con Git (si el repo es privado, Git te pide iniciar sesión en GitHub una sola vez)...');
      srcRoot = path.join(tmp, 'repo');
      if (!git(['clone', '--depth', '1', '--branch', branch, `https://github.com/${repo}.git`, srcRoot], tmp)) {
        throw new UpdateError(`git clone falló. Revisá UPDATE_REPO ("${repo}") y UPDATE_BRANCH ("${branch}"), y que tu cuenta de GitHub tenga acceso al repositorio.`);
      }
    } else {
      console.log('Descargando la versión nueva...');
      srcRoot = extractTarGz(await download(repo, branch, ''), path.join(tmp, 'x'));
    }
    const res = syncInto(srcRoot, root);
    console.log('Código actualizado. Tu .env y tu carpeta data/ no se tocaron.');
    return res;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  main(root).then(
    () => process.exit(0),
    (err) => {
      console.error(`\n[ERROR] ${err instanceof UpdateError ? err.message : err?.stack ?? err}`);
      process.exit(1);
    },
  );
}

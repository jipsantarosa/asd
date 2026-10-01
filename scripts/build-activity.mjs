// Compila la Actividad de granja (activity/src → activity/dist) con esbuild.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'activity');
const out = path.join(src, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(src, 'src', 'main.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  sourcemap: false,
  outfile: path.join(out, 'main.js'),
  logLevel: 'info',
});
for (const f of ['index.html', 'style.css']) fs.copyFileSync(path.join(src, f), path.join(out, f));
// Imágenes de cañas e insignias de logros (mismos archivos que usa el bot en Discord).
for (const dir of ['rods', 'badges']) {
  const from = path.join(root, 'assets', dir);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(out, dir), { recursive: true });
}
console.log('✅ Actividad compilada en activity/dist');

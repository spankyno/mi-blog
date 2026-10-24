// scripts/test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Ejecutor de pruebas: `npm test`  (opcional: `npm test -- scanner` para filtrar por nombre).
//
// Compila cada tests/**/*.test.ts con esbuild (ya incluido en el proyecto) y los
// ejecuta con el ejecutor nativo de Node (`node --test`), cada fichero en su propio
// proceso. No necesita dependencias nuevas, ni red, ni Cloudflare.
// ─────────────────────────────────────────────────────────────────────────────
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, '.test-build');
const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(join(ROOT, 'tests'))
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => filter.length === 0 || filter.some((t) => f.includes(t)));

if (files.length === 0) {
  console.error('No hay pruebas que ejecutar' + (filter.length ? ` (filtro: ${filter.join(', ')})` : '') + '.');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
await build({
  entryPoints: files,
  outdir: OUT,
  outbase: join(ROOT, 'tests'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
  logLevel: 'warning',
});

const built = files.map((f) => join(OUT, relative(join(ROOT, 'tests'), f).replace(/\.ts$/, '.mjs')));
const child = spawn(process.execPath, ['--test', '--test-reporter=spec', '--enable-source-maps', ...built], { stdio: 'inherit' });
child.on('exit', (code) => {
  rmSync(OUT, { recursive: true, force: true });
  process.exit(code ?? 1);
});

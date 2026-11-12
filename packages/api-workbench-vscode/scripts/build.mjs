// Builds the extension into dist/: extension.js, one bundle with everything but VS Code's own API,
// webview.js and webview.css, the script and Tailwind-built stylesheet of its webviews,
// and cli/, the api-workbench command line it runs (the CLI package's single-file bundle, built by
// `npm run bundle -w @techieutils/api-workbench-cli` first).
//
//   node scripts/build.mjs [--minify]
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(here, '..');
const cliBundle = path.resolve(extension, '../api-workbench-cli/dist/api-workbench.cjs');

await readFile(cliBundle).catch(() => {
  throw new Error('The command line is not bundled yet: run npm run cli:bundle first.');
});
await rm(path.join(extension, 'dist'), { recursive: true, force: true });
await build({
  entryPoints: [path.join(extension, 'src/extension.ts')],
  outfile: path.join(extension, 'dist/extension.js'),
  bundle: true,
  platform: 'node',
  // The shared package's TypeScript source, as the other bundles read it (its `source` export).
  conditions: ['source'],
  // VS Code 1.145, the oldest it supports, runs extensions on Node.js 22.
  target: 'node22',
  format: 'cjs',
  external: ['vscode'],
  minify: process.argv.includes('--minify'),
  sourcemap: !process.argv.includes('--minify'),
  legalComments: 'linked',
  logLevel: 'warning',
});
// The webviews' script, for the browser: it renders what the extension posts, as text.
await build({
  entryPoints: [path.join(extension, 'src/webview/main.ts')],
  outfile: path.join(extension, 'dist/webview.js'),
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  minify: process.argv.includes('--minify'),
  sourcemap: !process.argv.includes('--minify'),
  logLevel: 'warning',
});
// The webviews' stylesheet, built with Tailwind CSS as the app's is: a plain file, as their
// content policy loads no other kind.
execFileSync(
  process.execPath,
  [
    path.resolve(extension, '../../node_modules/@tailwindcss/cli/dist/index.mjs'),
    '-i',
    path.join(extension, 'src/webview/styles.css'),
    '-o',
    path.join(extension, 'dist/webview.css'),
    ...(process.argv.includes('--minify') ? ['--minify'] : []),
  ],
  { cwd: extension, stdio: ['ignore', 'ignore', 'pipe'] },
);
await mkdir(path.join(extension, 'dist/cli'), { recursive: true });
await copyFile(cliBundle, path.join(extension, 'dist/cli/api-workbench.cjs'));
await copyFile(
  `${cliBundle}.LEGAL.txt`,
  path.join(extension, 'dist/cli/api-workbench.cjs.LEGAL.txt'),
);
console.log(
  'Built dist/extension.js, dist/webview.js, dist/webview.css, and dist/cli/api-workbench.cjs',
);

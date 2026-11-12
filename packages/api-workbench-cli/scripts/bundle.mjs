// Bundles the command line into one file, dist/api-workbench.cjs, that runs with Node.js alone:
// what the release attaches for CI pipelines, with no install step or other packages.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: [new URL('../src/cli.ts', import.meta.url).pathname],
  outfile: new URL('../dist/api-workbench.cjs', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  legalComments: 'linked',
  // The source's own shebang line is kept by esbuild.
  define: { 'process.env.API_WORKBENCH_CLI_VERSION': JSON.stringify(version) },
  logLevel: 'warning',
});
console.log('Bundled dist/api-workbench.cjs');

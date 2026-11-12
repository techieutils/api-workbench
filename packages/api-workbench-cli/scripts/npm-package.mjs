// Makes the npm package of the command line, ready for `npm publish`, from the single-file bundle
// (scripts/bundle.mjs). The workspace's own package.json depends on the app's internal packages,
// which are not published; the bundle already holds everything, so the package is that one file
// with no dependencies, its README, its licences, and a manifest written here.
//
//   node scripts/npm-package.mjs [--out <folder>]    (default dist/npm; run npm run bundle first)
//
// The release's publish-cli workflow publishes it to GitHub Packages; tests/cli-package.test.ts
// checks what it contains.
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..');
const root = path.resolve(cli, '../..');
const outIndex = process.argv.indexOf('--out');
const out = path.resolve(outIndex > 0 ? process.argv[outIndex + 1] : path.join(cli, 'dist/npm'));

const source = JSON.parse(await readFile(path.join(cli, 'package.json'), 'utf8'));
const bundle = path.join(cli, 'dist/api-workbench.cjs');
const notices = `${bundle}.LEGAL.txt`;
for (const file of [bundle, notices])
  await readFile(file).catch(() => {
    throw new Error(`${path.relative(root, file)} is missing: run npm run cli:bundle first.`);
  });

const REPOSITORY = 'techieutils/api-workbench';
/** The README with each relative image (`src="../…"`) as an absolute URL on the main branch. */
function packageReadme(text) {
  return text.replace(/src="(\.\.\/[^"]+)"/g, (_match, relative) => {
    const file = path.posix.join('packages/api-workbench-cli', relative);
    return `src="https://raw.githubusercontent.com/${REPOSITORY}/main/${file}"`;
  });
}
const manifest = {
  name: source.name,
  version: source.version,
  description: source.description,
  license: source.license,
  keywords: [
    'api',
    'api-testing',
    'http',
    'rest',
    'graphql',
    'cli',
    'ci',
    'load-testing',
    'postman',
    'openapi',
  ],
  homepage: `https://github.com/${REPOSITORY}/blob/main/docs/cli.md`,
  bugs: { url: `https://github.com/${REPOSITORY}/issues` },
  // GitHub Packages links the package to this repository through this field.
  repository: {
    type: 'git',
    url: `git+https://github.com/${REPOSITORY}.git`,
    directory: 'packages/api-workbench-cli',
  },
  bin: { 'api-workbench': 'api-workbench.cjs' },
  files: ['api-workbench.cjs', 'api-workbench.cjs.LEGAL.txt', 'README.md', 'LICENSE'],
  engines: source.engines,
  publishConfig: { registry: 'https://npm.pkg.github.com', access: 'public' },
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await writeFile(path.join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await copyFile(bundle, path.join(out, 'api-workbench.cjs'));
await copyFile(notices, path.join(out, 'api-workbench.cjs.LEGAL.txt'));
// The README's images are paths in the repository, which the package page cannot follow: point
// them at the files on GitHub instead.
const readme = await readFile(path.join(cli, 'README.md'), 'utf8');
await writeFile(path.join(out, 'README.md'), packageReadme(readme));
await copyFile(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
console.log(`Packed ${manifest.name}@${manifest.version} in ${path.relative(process.cwd(), out)}`);

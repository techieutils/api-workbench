import { copyFile, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, transform } from 'esbuild';
import * as mdi from '@mdi/js';
import { MDI_ICON_NAMES } from '@techieutils/api-workbench-common/icon-names';

/** A file the app package exports, such as `styles/startup.css`. */
const appFile = (subpath: string) => require.resolve(`@techieutils/api-workbench-app/${subpath}`);
async function copyAssets(): Promise<void> {
  const root = path.resolve(__dirname, '../..');
  const app = path.dirname(appFile('package.json'));
  const output = path.join(app, 'dist');
  await mkdir(output, { recursive: true });
  // Node resolves files, not folders: the assets folder is the one holding an exported asset.
  await cp(path.dirname(appFile('assets/favicon-32.png')), path.join(output, 'assets'), {
    recursive: true,
  });
  const fontsDirectory = path.join(output, 'assets/fonts');
  await mkdir(fontsDirectory, { recursive: true });
  for (const family of ['geist', 'inter', 'geist-mono']) {
    const packageDirectory = path.join(root, 'node_modules/@fontsource-variable', family);
    const fontFile = `${family}-latin-wght-normal.woff2`;
    await copyFile(
      path.join(packageDirectory, 'files', fontFile),
      path.join(fontsDirectory, fontFile),
    );
    await copyFile(
      path.join(packageDirectory, 'LICENSE'),
      path.join(fontsDirectory, `${family}-LICENSE.txt`),
    );
  }
  const paths = Object.fromEntries(
    MDI_ICON_NAMES.map((name) => {
      const key =
        'mdi' +
        name
          .split('-')
          .map((part) => part[0].toUpperCase() + part.slice(1))
          .join('');
      const value = (mdi as Record<string, string>)[key];
      if (!value) throw new Error(`Missing MDI icon: ${name}`);
      return [name, value];
    }),
  );
  await writeFile(
    path.join(output, 'mdi-paths.js'),
    `const mdiPaths = Object.freeze(${JSON.stringify(paths)});\n`,
  );
  await copyFile(
    path.join(root, 'node_modules/@mdi/js/LICENSE'),
    path.join(output, 'MDI-LICENSE.txt'),
  );
  const production = process.argv.includes('--minify');
  const startupCSS = await readFile(appFile('styles/startup.css'), 'utf8');
  await writeFile(
    path.join(output, 'startup.css'),
    production ? (await transform(startupCSS, { loader: 'css', minify: true })).code : startupCSS,
  );
  await copyFile(appFile('public/startup-theme.js'), path.join(output, 'startup-theme.js'));
  // CodeMirror's style-mod would add its rules in a <style> element, which the page's policy
  // blocks; the app's wrapper adopts them as a constructed stylesheet (src/editor/style-mod.ts).
  const styleModule = await realpath(path.join(app, 'src/editor/style-mod.ts'));
  await build({
    entryPoints: ['@techieutils/api-workbench-app/editor/runtime'],
    conditions: ['source'],
    absWorkingDir: root,
    plugins: [
      {
        name: 'adopted-style-mod',
        setup(builder) {
          builder.onResolve({ filter: /^style-mod$/ }, (args) =>
            args.importer === styleModule ? undefined : { path: styleModule },
          );
        },
      },
    ],
    outfile: path.join(output, 'editor-runtime.js'),
    bundle: true,
    format: 'iife',
    globalName: 'WorkbenchEditor',
    platform: 'browser',
    target: 'es2022',
    minify: production,
    legalComments: 'eof',
  });
  await build({
    entryPoints: ['@techieutils/api-workbench-common/collection-transfer'],
    conditions: ['source'],
    absWorkingDir: root,
    outfile: path.join(output, 'collection-transfer-runtime.js'),
    bundle: true,
    format: 'iife',
    globalName: 'WorkbenchTransfer',
    platform: 'browser',
    target: 'es2022',
    minify: production,
    legalComments: 'eof',
  });
  await copyFile(
    path.join(root, 'node_modules/codemirror/LICENSE'),
    path.join(output, 'CodeMirror-LICENSE.txt'),
  );
  // The app's page, and the terminal window's (which runs only the terminal; see terminal-window.ts).
  for (const page of ['index.html', 'terminal.html']) {
    const source = appFile(`public/${page}`);
    const destination = path.join(output, page);
    if (!production) {
      await copyFile(source, destination);
      continue;
    }
    const { minify } = await import('html-minifier-terser');
    await writeFile(
      destination,
      await minify(await readFile(source, 'utf8'), {
        collapseWhitespace: true,
        removeComments: true,
        collapseBooleanAttributes: true,
        // Preserve script order and the security policy exactly as authored.
        removeAttributeQuotes: false,
      }),
    );
  }
  // CSS is generated separately by Tailwind CLI in styles:build / styles:prod.
}
copyAssets().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

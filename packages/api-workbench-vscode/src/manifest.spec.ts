import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { SUPPORT_LINKS, isGuideName } from '@techieutils/api-workbench-common/support-links';

// The extension's manifest (package.json) against its code and the rest of the repository.

const folder = path.resolve(__dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8'));
// Every source file but the specs and the in-editor test.
const source = readdirSync(path.join(folder, 'src'), { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts') && !file.startsWith('test'))
  .map((file) => readFileSync(path.join(folder, 'src', file), 'utf8'))
  .join('\n');
const version = (file: string) => JSON.parse(readFileSync(path.join(folder, file), 'utf8')).version;

test('the extension is released with the app and the command line, at their version', () => {
  assert.equal(manifest.version, version('../../package.json'));
  assert.equal(manifest.version, version('../api-workbench-cli/package.json'));
});

test('its id is valid and stays the same from source and from the .vsix', () => {
  // VS Code's id is publisher.name; an npm scope is not allowed in it.
  assert.equal(`${manifest.publisher}.${manifest.name}`, 'techieutils.api-workbench-vscode');
  assert.match(manifest.name, /^[a-z0-9][a-z0-9-]*$/);
  // The in-editor test finds the extension by that id.
  assert.match(
    readFileSync(path.join(folder, 'src/test/host.ts'), 'utf8'),
    /'techieutils\.api-workbench-vscode'/,
  );
});

test('every command in the manifest is registered, and every registered one is declared', () => {
  const declared = (manifest.contributes.commands as { command: string }[])
    .map((c) => c.command)
    .sort();
  const registered = [...source.matchAll(/registerCommand\(\s*'([^']+)'/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(registered, declared);
  // Menus name only declared commands.
  for (const items of Object.values(manifest.contributes.menus) as { command: string }[][])
    for (const item of items) assert.ok(declared.includes(item.command), item.command);
});

test('a workspace can neither run it untrusted nor choose what it runs', () => {
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
  const properties = manifest.contributes.configuration.properties;
  // A repository's .vscode/settings.json must not pick the program run, turn scripts on, or hand
  // saved credentials to language model tools.
  for (const name of [
    'apiWorkbench.engine',
    'apiWorkbench.nodePath',
    'apiWorkbench.cliPath',
    'apiWorkbench.scripts',
    'apiWorkbench.dataDir',
    'apiWorkbench.toolsUseSavedCredentials',
    // Nor stop .http files asking before they send to a new host.
    'apiWorkbench.confirmNewHosts',
  ])
    assert.equal(properties[name].scope, 'machine', name);
  // Every setting the code reads is declared.
  for (const [, name] of source.matchAll(/settings\(\)\.get<[^>]+>\('([^']+)'/g))
    assert.ok(properties[`apiWorkbench.${name}`], name);
});

test('the types match the oldest VS Code it supports', () => {
  const types = manifest.devDependencies['@types/vscode'];
  assert.equal(manifest.engines.vscode, `^${types}`);
});

test('every view and webview is declared where the code creates it', () => {
  const views = Object.values(manifest.contributes.views as Record<string, { id: string }[]>)
    .flat()
    .map((view) => view.id);
  for (const [, id] of source.matchAll(
    /(?:createTreeView|sideView<[^>]+>|registerWebviewViewProvider)\(\s*'([^']+)'/g,
  ))
    assert.ok(views.includes(id), id);
  // The menus' `view ==` conditions name declared views.
  for (const items of Object.values(manifest.contributes.menus) as { when?: string }[][])
    for (const item of items)
      for (const [, id] of (item.when ?? '').matchAll(/view == (apiWorkbench\.\w+)/g))
        assert.ok(views.includes(id), id);
});

test('the .http language and its files ship with the extension', () => {
  const [language] = manifest.contributes.languages;
  assert.equal(language.id, 'http');
  for (const file of [language.configuration, manifest.contributes.grammars[0].path])
    assert.doesNotThrow(() => JSON.parse(readFileSync(path.join(folder, file), 'utf8')), file);
  const packaging = readFileSync(path.join(folder, 'scripts/package.mjs'), 'utf8');
  for (const file of ['webview.css', 'http.tmLanguage.json', 'http.language.json'])
    assert.match(packaging, new RegExp(file.replace('.', '\\.')), file);
  // The webviews' Tailwind-built stylesheet is in the package's file list, and copied into it.
  assert.equal(packaging.match(/'dist\/webview\.css'/g)?.length, 3);
});

test("webviews allow only the extension's own script and styles", () => {
  const panels = readFileSync(path.join(folder, 'src/panels.ts'), 'utf8');
  assert.match(panels, /default-src 'none'/);
  assert.match(panels, /script-src 'nonce-/);
  assert.doesNotMatch(panels, /unsafe-(inline|eval)/);
  assert.match(panels, /enableCommandUris: false/);
  // The script renders text, never HTML.
  const script = readFileSync(path.join(folder, 'src/webview/main.ts'), 'utf8');
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
});

test('every language model tool is declared, registered, activates the extension, and asks before sending', () => {
  const tools = (manifest.contributes.languageModelTools as { name: string; inputSchema: object }[])
    .map((tool) => tool.name)
    .sort();
  const registered = [...source.matchAll(/(\w+): '(apiWorkbench_\w+)'/g)]
    .map((match) => match[2])
    .sort();
  assert.deepEqual(registered, tools);
  for (const name of tools)
    assert.ok(manifest.activationEvents.includes(`onLanguageModelTool:${name}`), name);
  // The tools that send requests confirm first, and never save into the workspace.
  const glue = readFileSync(path.join(folder, 'src/tools.ts'), 'utf8');
  assert.equal(glue.match(/confirmationMessages/g)?.length, 2);
  assert.match(glue, /save: false/);
  // Both apply saved credentials only through the unlocked vault and only when the person's
  // settings allow it, and say so in the confirmation.
  assert.equal(glue.match(/password: toolPassword\(\)/g)?.length, 2);
  assert.doesNotMatch(glue, /password: host\.vaultPassword\(\)/);
  assert.match(
    glue,
    /toolPassword = \(\) => \(host\.credentialsAllowed\(\) \? host\.vaultPassword\(\) : undefined\)/,
  );
  assert.equal(glue.match(/credentialNote\(credentials\(\)\)/g)?.length, 2);
});

test('the walkthrough’s pages ship with the extension', () => {
  const [walkthrough] = manifest.contributes.walkthroughs;
  for (const step of walkthrough.steps)
    assert.doesNotThrow(() => readFileSync(path.join(folder, step.media.markdown)), step.id);
  assert.match(readFileSync(path.join(folder, 'scripts/package.mjs'), 'utf8'), /'walkthrough'/);
});

test('pages link only to guides the extension opens, and guide links reach real headings', () => {
  const page = readFileSync(path.join(folder, 'src/webview/main.ts'), 'utf8');
  const named = [
    ...page.matchAll(/guideButton\('(\w+)'/g),
    ...page.matchAll(/guide: \['(\w+)'/g),
  ].map((match) => match[1]);
  assert.ok(named.length >= 8, 'every page has a Guide button');
  for (const name of named) assert.ok(isGuideName(name), name);
  // Links in the sidebar and the walkthrough go to the documentation site, at a heading it has.
  const docs = readFileSync(path.join(folder, '../../docs/vscode.md'), 'utf8');
  const headings = [...docs.matchAll(/^#+ (.+)$/gm)].map((match) =>
    match[1]
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s/g, '-'),
  );
  const text = JSON.stringify(manifest.contributes);
  const links = [...text.matchAll(/\]\((https:[^)]+)\)/g)].map((match) => match[1]);
  assert.ok(links.length >= 5);
  for (const link of links) {
    assert.ok(link.startsWith(SUPPORT_LINKS.vscode), link);
    const heading = new URL(link).hash.slice(1);
    if (heading) assert.ok(headings.includes(heading), heading);
  }
});

test('the extension’s icon is the desktop app’s, which reads on light and dark alike', () => {
  // A path outside the extension cannot load in VS Code's Extensions view.
  const readme = readFileSync(path.join(folder, 'README.md'), 'utf8');
  for (const [, html, markdown] of readme.matchAll(/<img src="([^"]+)"|!\[[^\]]*\]\(([^)]+)\)/g))
    assert.doesNotMatch(html ?? markdown ?? '', /^\.\.\//, html ?? markdown);
  assert.match(readme, /<img src="media\/icon\.png"/);
  assert.equal(manifest.icon, 'media/icon.png');
  // One icon serves both themes (VS Code takes no light or dark one), so it is the desktop app's,
  // on its own tile, at the Marketplace's 256 px: the bare mark's white T vanished on light.
  const icon = readFileSync(path.join(folder, 'media/icon.png'));
  assert.equal(icon.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([icon.readUInt32BE(16), icon.readUInt32BE(20)], [256, 256]);
  assert.match(
    readFileSync(path.join(folder, '../api-workbench-assets/src/icons/source.svg'), 'utf8'),
    /<rect width="1024" height="1024" rx="\d+" fill="#[0-9A-F]{6}"/i,
    'the desktop icon it is made from has its tile',
  );
  const packaging = readFileSync(path.join(folder, 'scripts/package.mjs'), 'utf8');
  assert.match(packaging, /'icon\.png'/);
  // VS Code would show it broken: the packaged README leaves it out, under the page's own icon.
  assert.match(packaging, /readme\.replace\(logo, ''\)/);
});

test('pages and .http files have the app’s mark in light and dark, as the app draws it', () => {
  const packaging = readFileSync(path.join(folder, 'scripts/package.mjs'), 'utf8');
  const [http] = manifest.contributes.languages.filter(
    (item: { id: string }) => item.id === 'http',
  );
  assert.deepEqual(http.icon, { light: 'media/icon-light.svg', dark: 'media/icon-dark.svg' });
  for (const theme of ['light', 'dark']) {
    const icon = readFileSync(path.join(folder, `media/icon-${theme}.svg`), 'utf8');
    const app = readFileSync(
      path.join(folder, `../api-workbench-app/src/assets/branding/app-icon-${theme}.svg`),
      'utf8',
    );
    // The same shapes and colours as the app's mark for that theme; only the frame differs.
    const shapes = (svg: string) =>
      svg.replace(/<svg[^>]*>|<!--[\s\S]*?-->/g, '').replace(/\s+/g, '');
    assert.equal(shapes(icon), shapes(app), `icon-${theme}.svg is the app's ${theme} mark`);
    assert.match(packaging, new RegExp(`'icon-${theme}\\.svg'`));
  }
  // An editor tab draws its icon as an image, so pages get the coloured marks, not currentColor.
  const panels = readFileSync(path.join(folder, 'src/panels.ts'), 'utf8');
  assert.match(panels, /'icon-light\.svg'/);
  assert.match(panels, /'icon-dark\.svg'/);
});

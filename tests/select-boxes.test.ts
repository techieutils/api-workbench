import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Every select box in the renderer shows an icon beside each option, through withIcons(), the
// language options, or options written with icons.
const components = path.join(
  path.dirname(require.resolve('@techieutils/api-workbench-app/package.json')),
  'src',
  'components',
);
const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(path.join(directory, entry.name))
      : entry.name.endsWith('.vue')
        ? [path.join(directory, entry.name)]
        : [],
  );

test('every select box gives its options icons', () => {
  const missing: string[] = [];
  let boxes = 0;
  for (const file of files(components)) {
    const source = readFileSync(file, 'utf8');
    for (const [element] of source.matchAll(/<UiSelect\b[\s\S]*?\/>/g)) {
      if (path.basename(file) === 'UiSelect.vue') continue;
      boxes++;
      const options = /:options="([^"]*)"/.exec(element)?.[1] ?? '';
      const withIcons =
        /withIcons\(|languageOptions\(|scopeOptions|levelOptions|statusOptions/.test(options);
      if (!withIcons)
        missing.push(`${path.relative(components, file)}: ${element.split('\n')[1]?.trim()}`);
    }
  }
  assert.ok(boxes >= 45, `found ${boxes} select boxes`);
  assert.deepEqual(missing, [], 'select boxes without icons');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** The leading bytes that identify each icon format. */
const signatures: Record<string, number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  icns: [0x69, 0x63, 0x6e, 0x73],
  ico: [0x00, 0x00, 0x01, 0x00],
};

// Every icon the packaged app and the installers use, for each theme.
const icons = [
  'icon.png',
  'icon-mac.png',
  'icon.icns',
  'icon.ico',
  'installer.ico',
  'uninstaller.ico',
];
const themed = ['icon.png', 'icon-mac.png', 'icon.icns', 'icon.ico'];

for (const name of [...icons, ...themed.flatMap((icon) => [`light/${icon}`, `dark/${icon}`])])
  test(`${name} is a valid ${name.split('.').pop()} file`, () => {
    const file = readFileSync(require.resolve(`@techieutils/api-workbench-assets/icons/${name}`));
    const signature = signatures[name.split('.').pop()!];
    assert.deepEqual([...file.subarray(0, signature.length)], signature);
  });

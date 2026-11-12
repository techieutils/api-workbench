// node-pty's prebuilt spawn-helper ships without its execute bit, so macOS terminals fail to start.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

let root;
try {
  root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
} catch {
  process.exit(0);
}
const prebuilds = path.join(root, 'prebuilds');
if (existsSync(prebuilds))
  for (const platform of readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, platform, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }

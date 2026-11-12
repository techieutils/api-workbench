import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const electronDirectory = path.join(root, 'node_modules/electron');
function command(file: string, args: string[]): void {
  execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}
async function prepareExecutable(): Promise<string> {
  const relativeExecutable = (
    await readFile(path.join(electronDirectory, 'path.txt'), 'utf8')
  ).trim();
  const originalExecutable = path.join(electronDirectory, 'dist', relativeExecutable);
  if (process.platform !== 'darwin') return originalExecutable;
  const originalBundle = path.resolve(originalExecutable, '../../..');
  const icon = require.resolve('@techieutils/api-workbench-assets/icons/icon.icns');
  const fingerprint = createHash('sha256')
    .update('api-workbench-development-bundle-v1')
    .update(process.arch)
    .update(await readFile(path.join(electronDirectory, 'dist/version')))
    .update(await readFile(path.join(originalBundle, 'Contents/Info.plist')))
    .update(await readFile(icon))
    .digest('hex')
    .slice(0, 16);
  const directory = path.join(root, 'dist/development', fingerprint);
  const bundle = path.join(directory, 'API Workbench.app');
  const executable = path.join(bundle, 'Contents/MacOS/Electron');
  try {
    await access(path.join(directory, 'ready.json'));
    await access(executable);
    await access(path.join(bundle, 'Contents/Resources/api-workbench.icns'));
    return executable;
  } catch {
    /* Build a fresh cache entry; never modify Electron in node_modules. */
  }
  await mkdir(directory, { recursive: true });
  const temporaryBundle = path.join(directory, `API Workbench.preparing-${process.pid}.app`);
  console.log('Preparing the API Workbench development app with its native macOS icon…');
  command('/usr/bin/ditto', [originalBundle, temporaryBundle]);
  const info = path.join(temporaryBundle, 'Contents/Info.plist');
  command('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleDisplayName API Workbench', info]);
  command('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleName API Workbench', info]);
  command('/usr/libexec/PlistBuddy', [
    '-c',
    'Set :CFBundleIdentifier dev.apiworkbench.desktop.development',
    info,
  ]);
  command('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIconFile api-workbench.icns', info]);
  await copyFile(icon, path.join(temporaryBundle, 'Contents/Resources/api-workbench.icns'));
  // Preserve Electron's JIT entitlements when signing the modified local bundle.
  command('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--preserve-metadata=entitlements,flags,runtime',
    temporaryBundle,
  ]);
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', temporaryBundle]);
  await rename(temporaryBundle, bundle);
  await writeFile(
    path.join(directory, 'ready.json'),
    JSON.stringify(
      {
        fingerprint,
        electronVersion: (
          await readFile(path.join(electronDirectory, 'dist/version'), 'utf8')
        ).trim(),
      },
      null,
      2,
    ),
  );
  return executable;
}
async function main(): Promise<void> {
  const executable = await prepareExecutable();
  if (process.argv.includes('--prepare-only')) {
    console.log(executable);
    return;
  }
  const smoke = process.argv.includes('--smoke');
  const child = spawn(executable, [smoke ? path.join(root, 'dist/scripts/ui-smoke.js') : root], {
    cwd: root,
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

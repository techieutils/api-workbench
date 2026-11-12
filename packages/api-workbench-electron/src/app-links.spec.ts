import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_USER_MODEL_ID, protocolExecutable, URL_SCHEME } from './app-links';

test('macOS, Windows, and Linux each register the scheme once', async () => {
  const manifest = (await import('../../../package.json', { with: { type: 'json' } })).default;
  const { build } = manifest;
  const expected = [{ name: 'API Workbench link', schemes: [URL_SCHEME], role: 'Viewer' }];
  // electron-builder adds a top-level list to each platform's, which would register it twice.
  assert.equal('protocols' in build, false);
  for (const platform of ['mac', 'win', 'linux'] as const)
    assert.deepEqual(build[platform].protocols, expected, platform);
  // The Linux .desktop entry names the same scheme handler.
  assert.equal(build.linux.desktop.entry.MimeType, `x-scheme-handler/${URL_SCHEME};`);
  // Linux links the running window to that entry by desktopName, which names the file.
  assert.equal(manifest.desktopName, `${build.linux.executableName}.desktop`);
  assert.equal(build.linux.syncDesktopName, true);
});

test('Windows registers the portable build by its own file, not its temporary folder', () => {
  const temp = 'C:\\Users\\a\\AppData\\Local\\Temp\\2abc\\API Workbench.exe';
  assert.equal(
    protocolExecutable({ PORTABLE_EXECUTABLE_FILE: 'D:\\Tools\\API Workbench.exe' }, temp),
    'D:\\Tools\\API Workbench.exe',
  );
  assert.equal(
    protocolExecutable({}, 'C:\\Program Files\\API Workbench\\API Workbench.exe'),
    'C:\\Program Files\\API Workbench\\API Workbench.exe',
  );
});

test('Windows runs the app under the ID its installer gives the shortcut', async () => {
  const manifest = (await import('../../../package.json', { with: { type: 'json' } })).default;
  assert.equal(APP_USER_MODEL_ID, manifest.build.appId);
});

test('the packaged app keeps its hardening: fuses, notarization, and only the JIT entitlement', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const manifest = (await import('../../../package.json', { with: { type: 'json' } })).default;
  const build = manifest.build as {
    mac: {
      hardenedRuntime: boolean;
      notarize: boolean;
      entitlements: string;
      entitlementsInherit: string;
    };
    electronFuses: Record<string, boolean>;
  };
  assert.equal(build.mac.hardenedRuntime, true);
  assert.equal(build.mac.notarize, true);
  assert.deepEqual(
    {
      runAsNode: build.electronFuses.runAsNode,
      nodeOptions: build.electronFuses.enableNodeOptionsEnvironmentVariable,
      inspect: build.electronFuses.enableNodeCliInspectArguments,
      asarIntegrity: build.electronFuses.enableEmbeddedAsarIntegrityValidation,
      asarOnly: build.electronFuses.onlyLoadAppFromAsar,
    },
    { runAsNode: false, nodeOptions: false, inspect: false, asarIntegrity: true, asarOnly: true },
  );
  // Library validation and the ban on unsigned executable memory stay on: only V8's JIT is allowed.
  for (const file of new Set([build.mac.entitlements, build.mac.entitlementsInherit])) {
    const plist = await readFile(path.join(__dirname, '../../..', file), 'utf8');
    const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
    assert.deepEqual(keys, ['com.apple.security.cs.allow-jit'], file);
  }
});

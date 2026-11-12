// Tests the extension in a real VS Code: starts the installed editor with the extension loaded from
// source (dist/extension.js), a fresh profile, and a workspace holding a team folder and an app
// data folder written by the app's own WorkspaceStore, both pointing at a local API. The checks
// themselves are src/test/host.ts, which VS Code runs inside its extension host.
//
//   npm run test:vscode -w api-workbench-vscode
//
// VS Code is found at VSCODE_EXECUTABLE, or where it installs on macOS. Without one, the test is
// skipped with a message, unless VSCODE_TEST_REQUIRED is set.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(here, '..');
const require = createRequire(import.meta.url);

const candidates = [
  process.env.VSCODE_EXECUTABLE,
  '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
].filter(Boolean);
const code = candidates.find((candidate) => existsSync(candidate));
if (!code) {
  const message = 'No VS Code found: set VSCODE_EXECUTABLE to run the extension in the editor.';
  if (process.env.VSCODE_TEST_REQUIRED) throw new Error(message);
  console.log(`Skipped: ${message}`);
  process.exit(0);
}
for (const file of ['dist/extension.js', 'dist-spec/test/host.js'])
  if (!existsSync(path.join(extension, file)))
    throw new Error(`${file} is missing: run npm run build and the spec compile first.`);

// A local API: /users answers, /missing is a 404.
const server = createServer((request, response) => {
  const missing = request.url?.startsWith('/missing');
  response.writeHead(missing ? 404 : 200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(missing ? { error: 'no' } : { users: [{ id: 1, name: 'Ada' }] }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const root = await mkdtemp(path.join(os.tmpdir(), 'api-workbench-vscode-host-'));
let exitCode;
try {
  const { WorkspaceStore } = require('@techieutils/api-workbench-electron/workspaces');
  const request = (id, extra) => ({
    id,
    name: id,
    method: 'GET',
    url: '{{base_url}}/users',
    folder: 'Users',
    params: [],
    headers: [],
    body: '',
    auth: 'None',
    token: '',
    username: '',
    password: '',
    tests: 'status 200',
    response: null,
    ...extra,
  });
  const state = {
    requests: [
      request('list', { name: 'List users', tags: ['smoke'] }),
      request('one', { name: 'Get user', url: '{{base_url}}/users/1' }),
      request('miss', { name: 'Missing', url: '{{base_url}}/missing', folder: 'Users/Errors' }),
      request('socket', {
        name: 'Socket',
        protocol: 'websocket',
        url: 'ws://127.0.0.1:1',
        folder: 'Live',
      }),
    ],
    tabs: ['list'],
    active: 'list',
    environments: [{ name: 'Local', variables: [{ enabled: true, key: 'base_url', value: base }] }],
    environment: 0,
    history: [],
  };
  const project = path.join(root, 'project');
  const data = path.join(root, 'data');
  const store = new WorkspaceStore(data);
  await store.list();
  await store.save(state, 'default');
  await store.openFolder(path.join(project, 'api'), state, 'Ada', 'share');
  store.close();

  // A fresh profile: no other extensions, trust off, and the app data folder above.
  const profile = path.join(root, 'profile');
  await mkdir(path.join(profile, 'User'), { recursive: true });
  await writeFile(
    path.join(profile, 'User', 'settings.json'),
    JSON.stringify({
      'security.workspace.trust.enabled': false,
      'apiWorkbench.dataDir': data,
      'apiWorkbench.scripts': 'skip',
      // VSCODE_TEST_ENGINE=builtIn runs the same checks with the command line inside VS Code.
      ...(process.env.VSCODE_TEST_ENGINE
        ? { 'apiWorkbench.engine': process.env.VSCODE_TEST_ENGINE }
        : {}),
      'workbench.startupEditor': 'none',
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
    }),
  );
  const child = spawn(
    code,
    [
      project,
      `--extensionDevelopmentPath=${extension}`,
      `--extensionTestsPath=${path.join(extension, 'dist-spec/test/host.js')}`,
      `--user-data-dir=${profile}`,
      `--extensions-dir=${path.join(root, 'extensions')}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      '--new-window',
    ],
    {
      stdio: 'inherit',
      // The local API, for the test's own .http file.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, API_WORKBENCH_TEST_BASE: base },
    },
  );
  exitCode = await new Promise((resolve) => child.on('exit', (status) => resolve(status ?? 1)));
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}
console.log(
  exitCode === 0 ? 'The extension passed in VS Code.' : `VS Code exited with ${exitCode}.`,
);
process.exit(exitCode);

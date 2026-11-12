import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from './workspaces';
import { TeamGit, findTeamFolders } from './team-git';
import type {
  ApiRequest,
  TeamMember,
  WorkspaceState,
} from '@techieutils/api-workbench-common/types';

/**
 * Git sync for team folders, against a real git and a bare repository standing in for GitHub:
 * Ada shares and connects, Sam clones, and they sync, conflict, and resolve.
 */

// The person's own git settings (signing, hooks, a default branch) must not change the results.
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const ada: TeamMember = { id: '00000000-0000-4000-8000-00000000000a', name: 'Ada' };
const sam: TeamMember = { id: '00000000-0000-4000-8000-00000000000b', name: 'Sam' };
const request = (id: string, extra: Partial<ApiRequest> = {}): ApiRequest => ({
  id,
  name: id,
  method: 'GET',
  url: 'https://api.example.com/orders',
  folder: 'Orders',
  params: [],
  headers: [],
  body: '',
  auth: 'Bearer token',
  token: 'TEST-INLINE-TOKEN',
  username: '',
  password: '',
  tests: '',
  response: null,
  ...extra,
});
const state = (): WorkspaceState => ({
  requests: [request('list'), request('create', { method: 'POST' })],
  active: 'list',
  tabs: ['list'],
  environments: [
    {
      name: 'Staging',
      variables: [{ enabled: true, key: 'client_secret', value: 'TEST-ENV-SECRET' }],
    },
  ],
  environment: 0,
  history: [],
});

let root: string;
let remote: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** Every file in the remote's main branch, as text. */
function remoteFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of git(remote, 'ls-tree', '-r', '--name-only', 'main').split('\n'))
    if (file) files.set(file, git(remote, 'show', `main:${file}`));
  return files;
}
/** A request's file in a team folder, and the file with the request renamed. */
const collectionFile = (folder: string) => path.join(folder, 'collections', 'Orders', 'list.yaml');
const renamed = (text: string, name: string) => text.replace(/^name: .*$/m, `name: ${name}`);

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-git-'));
  remote = path.join(root, 'remote.git');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
});
after(() => fs.rm(root, { recursive: true, force: true }));

test('connect, clone, sync, conflicts, and resolving them', async () => {
  const teamGit = new TeamGit();
  // Ada shares her workspace into a folder and connects it to the empty remote.
  const adaStore = new WorkspaceStore(path.join(root, 'ada-data'));
  await adaStore.list();
  const adaFolder = path.join(root, 'ada', 'api');
  await adaStore.openFolder(adaFolder, state(), 'Ada', 'share');
  const before = await teamGit.status(adaFolder);
  assert.equal(before.available, true);
  assert.equal(before.repository, false);
  await fs.mkdir(path.join(adaFolder, '.workbench', 'presence'), { recursive: true });
  await fs.writeFile(path.join(adaFolder, '.workbench', 'presence', `${ada.id}.json`), '{}');

  const connected = await teamGit.connect(adaFolder, remote, ada);
  assert.equal(connected.status.repository, true);
  assert.equal(connected.status.branch, 'main');
  assert.equal(connected.status.upstream, 'origin/main');
  assert.equal(connected.status.changeCount, 0);
  const files = remoteFiles();
  assert.ok(files.has('workspace.json'));
  assert.equal(files.get('.gitignore'), '.workbench/\n');
  assert.ok(![...files.keys()].some((file) => file.startsWith('.workbench')), 'presence stays out');
  for (const [file, text] of files)
    for (const secret of ['TEST-INLINE-TOKEN', 'TEST-ENV-SECRET'])
      assert.ok(!text.includes(secret), `${secret} is not pushed (${file})`);
  assert.match(
    git(remote, 'log', '-1', '--format=%an <%ae>', 'main'),
    /^Ada <00000000-0000-4000-8000-00000000000a@users\.noreply\.api-workbench\.invalid>/,
    'without git settings, commits carry the team name',
  );

  // Sam clones it, and the clone is found as a team workspace.
  const samParent = path.join(root, 'sam');
  await fs.mkdir(samParent);
  const samFolder = await teamGit.clone(remote, samParent, 'api');
  assert.deepEqual(await findTeamFolders(samFolder), [samFolder]);
  await assert.rejects(teamGit.clone(remote, samParent, 'api'), /already exists and is not empty/);

  // Ada changes a collection; Sam's pull brings it.
  const adaFile = collectionFile(adaFolder);
  const samFile = collectionFile(samFolder);
  const original = await fs.readFile(adaFile, 'utf8');
  await fs.writeFile(adaFile, renamed(original, 'list-by-ada'));
  const adaChanges = await teamGit.status(adaFolder);
  assert.deepEqual(
    adaChanges.changes.map((change) => change.kind),
    ['modified'],
  );
  assert.equal(adaChanges.changes[0].path, path.relative(adaFolder, adaFile).replaceAll('\\', '/'));
  assert.match((await teamGit.sync(adaFolder, 'Rename list', ada)).message, /committed.*pushed/i);
  const pulled = await teamGit.pull(samFolder, sam);
  assert.equal(pulled.message, 'Pulled the latest changes.');
  assert.equal(await fs.readFile(samFile, 'utf8'), await fs.readFile(adaFile, 'utf8'));

  // Both change the same file: the pull is undone and the file named.
  const shared = await fs.readFile(adaFile, 'utf8');
  await fs.writeFile(adaFile, renamed(shared, 'list-ada-again'));
  await teamGit.sync(adaFolder, '', ada);
  await fs.writeFile(samFile, renamed(shared, 'list-by-sam'));
  const conflict = await teamGit.sync(samFolder, 'Sam’s change', sam);
  assert.deepEqual(conflict.conflicts, [path.relative(samFolder, samFile).replaceAll('\\', '/')]);
  assert.match(conflict.message, /Choose whose changes to keep/);
  assert.ok(!existsSync(path.join(samFolder, '.git', 'MERGE_HEAD')), 'nothing is left half-merged');
  assert.match(await fs.readFile(samFile, 'utf8'), /list-by-sam/, 'Sam’s file is as he left it');
  assert.equal(conflict.status.ahead, 1, 'Sam’s commit is kept');

  // Sam keeps Ada's version; the sync finishes and pushes.
  const resolved = await teamGit.sync(samFolder, '', sam, 'theirs');
  assert.ok(!resolved.conflicts);
  assert.match(await fs.readFile(samFile, 'utf8'), /list-ada-again/);
  assert.equal(resolved.status.ahead, 0);
  assert.equal(resolved.status.behind, 0);
  assert.match(
    remoteFiles().get(path.relative(samFolder, samFile).replaceAll('\\', '/'))!,
    /list-ada-again/,
  );
  assert.equal((await teamGit.commit(samFolder, '', sam)).message, 'Nothing to commit.');
  await assert.rejects(teamGit.sync(samFolder, '', sam, 'everyone'), /mine or theirs/);
  adaStore.close();
});

test('in a code repository, only the team folder is committed, and hooks do not run', async () => {
  const teamGit = new TeamGit();
  const repository = path.join(root, 'service');
  await fs.mkdir(path.join(repository, 'api'), { recursive: true });
  git(repository, 'init', '--initial-branch=main');
  await fs.writeFile(path.join(repository, 'server.js'), 'work in progress\n');
  git(repository, 'add', 'server.js');
  await fs.writeFile(path.join(repository, 'api', 'workspace.json'), '{"storage":"team"}\n');
  const marker = path.join(root, 'hook-ran');
  const hook = path.join(repository, '.git', 'hooks', 'pre-commit');
  await fs.writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });

  const status = await teamGit.status(path.join(repository, 'api'));
  assert.deepEqual(
    status.changes.map((change) => change.path).sort(),
    ['.gitignore', 'workspace.json'],
    'changes are listed within the team folder',
  );
  const committed = await teamGit.commit(path.join(repository, 'api'), 'API', ada);
  assert.equal(committed.message, 'Committed your changes.');
  assert.equal(
    git(repository, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort().join(','),
    'api/.gitignore,api/workspace.json',
  );
  assert.match(
    git(repository, 'status', '--porcelain'),
    /^A {2}server\.js/m,
    'other staged work is left alone',
  );
  assert.ok(!existsSync(marker), 'the repository’s hook did not run');
  assert.deepEqual(await findTeamFolders(repository), [path.join(repository, 'api')]);
  await assert.rejects(
    teamGit.push(path.join(repository, 'api')),
    /Connect the team folder to a remote/,
  );
});

test('credentials in remotes never come back, bad URLs are refused, and a missing git is reported', async () => {
  const teamGit = new TeamGit();
  const folder = path.join(root, 'tokens');
  await fs.mkdir(folder);
  git(folder, 'init', '--initial-branch=main');
  git(folder, 'remote', 'add', 'origin', 'https://ada:ghp_TESTTOKEN@127.0.0.1:9/acme/api.git');
  await fs.writeFile(path.join(folder, 'workspace.json'), '{}');
  const status = await teamGit.status(folder);
  assert.equal(status.remote, 'https://127.0.0.1:9/acme/api.git');
  await assert.rejects(teamGit.sync(folder, '', ada), (error: Error) => {
    assert.ok(!error.message.includes('ghp_TESTTOKEN'), error.message);
    return true;
  });
  for (const url of [
    'ext::sh -c touch% /tmp/x',
    '--upload-pack=touch /tmp/x',
    'https://a:b@x/y.git',
  ])
    await assert.rejects(
      teamGit.connect(folder, url, ada),
      /not supported|spaces|repository URL|token/,
    );
  await assert.rejects(teamGit.clone('ext::sh', root, 'x'), /not supported/);
  const missing = new TeamGit({ program: path.join(root, 'no-such-git') });
  assert.equal((await missing.status(folder)).available, false);
  await assert.rejects(missing.commit(folder, '', ada), /Git is not installed/);
});

test('a clone of an empty repository syncs: its upstream does not exist until the first push', async () => {
  const teamGit = new TeamGit();
  const empty = path.join(root, 'empty.git');
  git(root, 'init', '--bare', empty);
  const parent = path.join(root, 'empty-clones');
  await fs.mkdir(parent);
  const folder = await teamGit.clone(empty, parent, 'api');
  assert.deepEqual(await findTeamFolders(folder), []);
  await fs.writeFile(path.join(folder, 'workspace.json'), '{"storage":"team"}\n');
  // Before the first commit, the list already matches what will be committed: presence files
  // stay out, and the .gitignore that keeps them out is in.
  await fs.mkdir(path.join(folder, '.workbench', 'presence'), { recursive: true });
  await fs.writeFile(path.join(folder, '.workbench', 'presence', `${ada.id}.json`), '{}');
  const before = await teamGit.status(folder);
  assert.deepEqual(before.changes.map((change) => change.path).sort(), [
    '.gitignore',
    'workspace.json',
  ]);
  const synced = await teamGit.sync(folder, 'First', ada);
  assert.equal(synced.message, 'Committed your changes and pushed.');
  assert.equal(synced.status.ahead, 0);
  assert.match(git(empty, 'log', '--all', '--format=%s'), /First/);
});

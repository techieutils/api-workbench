import { dialog, safeStorage } from 'electron';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { type SmokeContext, pause, providerTestKey } from './harness';

/**
 * UI smoke checks, part 17: sharing through Git and links. A bare repository stands in for GitHub;
 * a teammate works in their own clone with the git command line.
 */
export default async function gitSyncAndLinks(context: SmokeContext) {
  const { run, capture } = context;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-git-ui-'));
  const remote = path.join(root, 'remote.git');
  const clones = path.join(root, 'clones');
  const teammate = path.join(root, 'teammate');
  fs.mkdirSync(clones);
  // The person's own git settings (signing, default branch) must not change the results.
  const savedEnv = {
    global: process.env.GIT_CONFIG_GLOBAL,
    system: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.GIT_CONFIG_GLOBAL = os.devNull;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Sam', '-c', 'user.email=sam@example.com', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git(root, 'init', '--bare', remote);
  const wait = async (code: string, ms = 20000) => {
    const deadline = Date.now() + ms;
    while (!(await run(code))) {
      if (Date.now() > deadline) {
        // What the panel and toasts said, so a timeout explains itself.
        const seen = await run(
          "JSON.stringify({git:{...teamGitUI,status:teamGitUI.status&&{...teamGitUI.status,changes:teamGitUI.status.changes.slice(0,5)}},transfer:transferUI.error,toasts:[...document.querySelectorAll('.toast')].map(toast=>toast.textContent.trim()).slice(-4)})",
        ).catch(() => 'unavailable');
        throw new Error(`Git sync check timed out: ${code}\n${seen}`);
      }
      await pause(50);
    }
  };
  const type = (selector: string, value: string) =>
    run(
      `(()=>{const field=document.querySelector(${JSON.stringify(selector)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input'));})()`,
    );
  const click = (selector: string) =>
    run(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const toastSays = (text: string) =>
    `[...document.querySelectorAll('.toast')].some(toast=>toast.textContent.includes(${JSON.stringify(text)}))`;
  /** The teammate renames the request whose file holds `from`, and pushes. */
  const teammateRenames = (from: string, to: string, message: string) => {
    git(teammate, 'pull', '--no-rebase', '--no-edit');
    const file = fs
      .readdirSync(path.join(teammate, 'collections'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .find((candidate) => fs.readFileSync(candidate, 'utf8').includes(`name: ${from}\n`));
    assert.ok(file, `the teammate finds the request named ${from}`);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replace(`name: ${from}\n`, `name: ${to}\n`),
    );
    git(teammate, 'commit', '-am', message);
    git(teammate, 'push');
  };

  // The system folder picker answers with the folder clones go in.
  const originalOpenDialog = dialog.showOpenDialog;
  dialog.showOpenDialog = (async () => ({
    canceled: false,
    filePaths: [clones],
  })) as typeof dialog.showOpenDialog;
  const original = (await run('workspaceUI.id')) as string;
  const server = createServer((request, response) => {
    if (request.url === '/acme/shop.postman_collection.json')
      response.end(
        JSON.stringify({
          info: {
            name: 'Linked shop',
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
          },
          item: [
            {
              name: 'Linked request',
              request: { method: 'GET', url: 'https://example.com/linked' },
            },
          ],
        }),
      );
    else {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    // Cloning an empty repository shares this workspace into it.
    await run('openWorkspaceManager()');
    await wait("Boolean(document.querySelector('[data-workspace-team]'))");
    await click('[data-workspace-team]');
    await wait("Boolean(document.querySelector('[data-workspace-clone]'))");
    await type('#team-member-name', 'Ada Tester');
    await type('#team-clone-url', 'ext::sh -c touch% /tmp/x');
    await click('[data-workspace-clone-button]');
    await wait("document.querySelector('#team-clone-error')?.textContent.trim().length>0");
    await type('#team-clone-url', remote);
    await capture('git-clone-form.png');
    await click('[data-workspace-clone-button]');
    await wait(
      `!workspaceUI.open&&!workspaceUI.busy&&${toastSays('Cloned the repository and shared')}`,
    );
    const folder = path.join(clones, 'remote');
    assert.ok(fs.existsSync(path.join(folder, 'workspace.json')), 'shared into the clone');

    // The Git panel shows the new files; Sync commits and pushes them.
    await run('openWorkspaceManager()');
    await wait(
      "Boolean(document.querySelector('[data-team-git-sync-form]'))&&teamGitUI.status?.changeCount>0",
    );
    assert.match(
      (await run("document.querySelector('[data-team-git-summary]').textContent")) as string,
      /changed file/,
    );
    await run("document.querySelector('[data-team-git]').scrollIntoView({block:'end'})");
    await capture('git-sync.png');
    await type('#team-git-message', 'Share the API workspace');
    await click('[data-team-git-sync]');
    await wait(`!teamGitUI.busy&&${toastSays('pushed')}`);
    await wait('teamGitUI.status.changeCount===0&&teamGitUI.status.ahead===0');
    assert.match(git(remote, 'log', '--all', '--format=%s'), /Share the API workspace/);
    assert.equal(
      git(remote, 'log', '--all', '-1', '--format=%an'),
      'Ada Tester\n',
      'without git settings, commits carry the team name',
    );

    // A teammate's pushed change arrives with Pull.
    git(root, 'clone', remote, teammate);
    const name = (await run('state.requests[0].name')) as string;
    teammateRenames(name, 'Renamed in Git', 'Rename from the command line');
    await click('[data-team-git-pull]');
    await wait("state.requests.some(request=>request.name==='Renamed in Git')");

    // Both rename it: the sync stops with the file named, and Take theirs finishes it.
    await run(
      "state.requests.find(request=>request.name==='Renamed in Git').name='Renamed here';persist();render()",
    );
    // The status may already say saved from before, so the file itself is checked.
    const savedHere = () =>
      fs
        .readdirSync(path.join(folder, 'collections'), { recursive: true, withFileTypes: true })
        .some(
          (entry) =>
            entry.isFile() &&
            fs
              .readFileSync(path.join(entry.parentPath, entry.name), 'utf8')
              .includes('name: Renamed here\n'),
        );
    for (const deadline = Date.now() + 20000; !savedHere(); await pause(50))
      if (Date.now() > deadline) throw new Error('The rename was not saved to the team folder.');
    teammateRenames('Renamed in Git', 'Renamed by Sam', 'Sam renames it');
    await click('[data-team-git-sync]');
    await wait("Boolean(document.querySelector('[data-team-git-conflicts]'))");
    assert.match(
      (await run("document.querySelector('[data-team-git-conflicts]').textContent")) as string,
      /collections\/.+\.yaml/,
    );
    await run(
      "document.querySelector('[data-team-git-conflicts]').scrollIntoView({block:'center'})",
    );
    await pause(400);
    await capture('git-conflict.png');
    await click('[data-team-git-take-theirs]');
    await wait(
      "!document.querySelector('[data-team-git-conflicts]')&&state.requests.some(request=>request.name==='Renamed by Sam')",
    );
    await wait('teamGitUI.status.ahead===0&&teamGitUI.status.behind===0');
    await run('closeWorkspaceManager()');
    await wait('!workspaceUI.open');

    // A link to a collection file is downloaded, previewed, and imported.
    await run("window.linkCount=state.requests.length;openCollectionTransfer('import');void 0");
    await wait("Boolean(document.querySelector('[data-transfer-link-form]'))");
    await click('[data-transfer-tab=Link]');
    await wait("!document.querySelector('[data-transfer-link-form]').hidden");
    await type('#transfer-link', `${base}/acme/missing.json`);
    await click('[data-transfer-link]');
    await wait("transferUI.error.includes('answered 404')");
    await type('#transfer-link', `${base}/acme/shop.postman_collection.json`);
    await click('[data-transfer-link]');
    await wait('transferUI.preview?.data.requests.length===1&&!transferUI.busy');
    await capture('import-link.png');
    await click('[data-transfer-confirm]');
    await wait("state.requests.some(request=>request.name==='Linked request')");
    assert.equal(
      await run('state.requests.length'),
      ((await run('window.linkCount')) as number) + 1,
    );
    await run(
      "state.requests=state.requests.filter(request=>request.name!=='Linked request');persist();render()",
    );
    await run('closeCollectionTransfer?.()');
    await run("document.querySelector('[data-transfer-close]')?.click();void 0");
    await wait("!document.querySelector('.collection-transfer')");

    // Export: copied to the clipboard, then published as a secret gist and updated.
    const gists: { method: string; authorization: string; body: string }[] = [];
    const previous = getGlobalDispatcher();
    const github = new MockAgent();
    github.enableNetConnect();
    const api = github.get('https://api.github.com');
    for (const method of ['POST', 'PATCH'])
      api
        .intercept({
          path: method === 'POST' ? '/gists' : '/gists/0123456789abcdef0123',
          method,
        })
        .reply((options) => {
          const headers = options.headers as Record<string, string>;
          gists.push({
            method,
            authorization: headers.authorization ?? headers.Authorization ?? '',
            body: String(options.body),
          });
          return {
            statusCode: method === 'POST' ? 201 : 200,
            data: {
              id: '0123456789abcdef0123',
              html_url: 'https://gist.github.com/ada/0123456789abcdef0123',
              public: false,
            },
          };
        });
    setGlobalDispatcher(github);
    // The vault encrypts with the system keychain; the suite's test key stands in for it, as in
    // parts 6 and 10, so a vault copied from an earlier part still opens.
    const keychain = {
      available: safeStorage.isAsyncEncryptionAvailable,
      encrypt: safeStorage.encryptStringAsync,
      decrypt: safeStorage.decryptStringAsync,
    };
    const key = providerTestKey;
    safeStorage.isAsyncEncryptionAvailable = async () => true;
    safeStorage.encryptStringAsync = async (value) => {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
    };
    safeStorage.decryptStringAsync = async (value) => {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return {
        result: Buffer.concat([
          decipher.update(value.subarray(12, -16)),
          decipher.final(),
        ]).toString(),
        shouldReEncrypt: false,
      };
    };
    let tokenId = '';
    try {
      await run("openCollectionTransfer('export');void 0");
      await wait(
        "Boolean(transferUI.exported)&&Boolean(document.querySelector('[data-transfer-destination=gist]'))",
      );
      await run(
        "document.querySelector('#transfer-format').value='postman';document.querySelector('#transfer-format').dispatchEvent(new Event('change'));void 0",
      );
      await wait("transferUI.exported?.name.endsWith('.json')");
      // The smoke window is not focused, so the clipboard is stood in for, as in other parts.
      await run(
        "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.exportCopied=value;}}})",
      );
      await click('[data-transfer-destination=copy]');
      await click('[data-transfer-confirm]');
      await wait(`${toastSays('Export copied')}||Boolean(transferUI.error)`);
      assert.equal(await run('transferUI.error'), '', 'copying works');
      assert.ok(
        (JSON.parse((await run('window.exportCopied')) as string) as { info: { name: string } })
          .info.name,
        'the export is on the clipboard',
      );
      await click('[data-transfer-destination=gist]');
      await wait("Boolean(document.querySelector('[data-transfer-gist]'))");
      if (await run("Boolean(document.querySelector('[data-transfer-unlock]'))")) {
        await click('[data-transfer-unlock]');
        await wait("!document.querySelector('[data-transfer-unlock]')");
      }
      assert.equal(
        await run("document.querySelector('[data-transfer-confirm]').disabled"),
        true,
        'a token is needed',
      );
      await click('[data-transfer-add-token]');
      await wait("Boolean(document.querySelector('[data-transfer-token-form]'))");
      await type('#transfer-token-name', 'UI GitHub token');
      await type('#transfer-token', 'TEST-GIST-TOKEN');
      await click('[data-transfer-save-token]');
      await wait('!gistUI.adding&&Boolean(gistUI.credentialId)');
      tokenId = (await run('gistUI.credentialId')) as string;
      await type('#transfer-gist-description', 'Shop API from the UI');
      await capture('export-gist.png');
      await click('[data-transfer-confirm]');
      await wait(
        "gistUI.result?.updated===false&&Boolean(document.querySelector('[data-gist-result]'))",
      );
      assert.equal(gists[0].authorization, 'Bearer TEST-GIST-TOKEN', 'the token is sent to GitHub');
      const created = JSON.parse(gists[0].body);
      assert.equal(created.public, false, 'gists are secret by default');
      assert.equal(created.description, 'Shop API from the UI');
      assert.ok(Object.keys(created.files)[0].endsWith('.json'));
      assert.ok(!gists[0].body.includes('TEST-GIST-TOKEN'), 'the token is not in the gist');
      assert.ok(
        !((await run('JSON.stringify(gistUI)')) as string).includes('TEST-GIST-TOKEN'),
        'the renderer no longer holds the token',
      );
      await capture('export-gist-published.png');
      assert.equal(
        await run("document.querySelector('[data-transfer-confirm]').textContent.trim()"),
        'Update gist',
        'publishing again updates the same gist',
      );

      // Opened again, the export updates the same gist.
      await run("document.querySelector('[data-transfer-close]').click();void 0");
      await run("openCollectionTransfer('export');void 0");
      await run(
        "document.querySelector('#transfer-format').value='postman';document.querySelector('#transfer-format').dispatchEvent(new Event('change'));void 0",
      );
      await click('[data-transfer-destination=gist]');
      await wait("gistUI.mode==='update'&&gistUI.target.includes('0123456789abcdef0123')");
      assert.equal(
        await run("document.querySelector('[data-transfer-confirm]').textContent.trim()"),
        'Update gist',
      );
      await click('[data-transfer-confirm]');
      await wait('gistUI.result?.updated===true');
      assert.equal(gists[1].method, 'PATCH');
      await run("document.querySelector('[data-transfer-close]').click();void 0");
    } finally {
      setGlobalDispatcher(previous);
      await github.close();
      if (tokenId) await run(`window.workbench.credentials.delete(${JSON.stringify(tokenId)})`);
      safeStorage.isAsyncEncryptionAvailable = keychain.available;
      safeStorage.encryptStringAsync = keychain.encrypt;
      safeStorage.decryptStringAsync = keychain.decrypt;
    }
  } finally {
    dialog.showOpenDialog = originalOpenDialog;
    server.closeAllConnections();
    server.close();
  }
  // Back to the original workspace; the clone stays where it is, so leaving keeps it.
  const teamId = (await run('workspaceUI.id')) as string;
  await run(`selectWorkspace(${JSON.stringify(original)})`);
  await wait(`workspaceUI.id===${JSON.stringify(original)}&&!workspaceUI.busy`);
  if (teamId !== original)
    await run(`window.workbench.workspaces.delete(${JSON.stringify(teamId)})`);
  if (savedEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedEnv.global;
  if (savedEnv.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = savedEnv.system;
  fs.rmSync(root, { recursive: true, force: true });
}

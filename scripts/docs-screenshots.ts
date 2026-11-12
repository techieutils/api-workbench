import { app, BrowserWindow, dialog, safeStorage } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { WebSocketServer } from 'ws';

/**
 * Captures the screenshots in docs/images from the real app: a disposable profile, a sample
 * "Acme Store" workspace, and a local mock API, so every image shows realistic, repeatable data.
 * Run with `npm run docs:screenshots`.
 */
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'api-workbench-docs-'));
app.setPath('userData', temporary);
// A stand-in for OS encryption, so the vault and Interceptor CA work without the real keychain.
safeStorage.isAsyncEncryptionAvailable = async () => true;
safeStorage.getSelectedStorageBackend = () => 'unknown';
safeStorage.encryptStringAsync = async (value) => Buffer.from(value).reverse();
safeStorage.decryptStringAsync = async (value) => ({
  result: Buffer.from(value).reverse().toString(),
  shouldReEncrypt: false,
});
// The main process asks before HTTPS decryption or trusting a certificate, in a
// native dialog (packages/api-workbench-electron/src/confirmations.ts); tests answer yes.
dialog.showMessageBox = (async () => ({
  response: 0,
  checkboxChecked: false,
})) as typeof dialog.showMessageBox;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Register the app's ready listener before ours.
require('@techieutils/api-workbench-electron/bootstrap');

const output = path.join(process.cwd(), 'docs', 'images');
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => {
  console.error('Docs screenshots timed out');
  app.exit(1);
}, 300_000);

// The mock "Acme Store" API the sample workspace calls.
const users = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@techieutils.dev', role: 'admin', active: true },
  { id: 2, name: 'Grace Hopper', email: 'grace@techieutils.dev', role: 'editor', active: true },
  { id: 3, name: 'Alan Turing', email: 'alan@techieutils.dev', role: 'viewer', active: false },
];
function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Request-Id': `req_${Math.random().toString(36).slice(2, 10)}`,
    ...headers,
  });
  response.end(status === 204 ? undefined : JSON.stringify(body));
}
function api(request: IncomingMessage, response: ServerResponse): void {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () =>
    // A little latency, so timings and runner charts look like a real service.
    setTimeout(
      () => {
        const url = new URL(request.url || '/', 'http://localhost');
        const id = Number(/^\/users\/(\d+)$/.exec(url.pathname)?.[1]);
        if (url.pathname === '/users' && request.method === 'GET')
          return json(response, 200, {
            data: users.slice(0, Number(url.searchParams.get('limit')) || users.length),
            total: users.length,
            page: 1,
          });
        if (url.pathname === '/users' && request.method === 'POST') {
          const created = {
            id: 4,
            ...JSON.parse(body || '{}'),
            active: true,
            createdAt: '2026-10-22T09:30:00Z',
          };
          return json(response, 201, created, { Location: '/users/4' });
        }
        if (id && request.method === 'GET')
          return json(response, 200, users.find((user) => user.id === id) || users[0]);
        if (id && request.method === 'PATCH')
          return json(response, 200, { ...users[0], ...JSON.parse(body || '{}') });
        if (id && request.method === 'DELETE') return json(response, 204, null);
        if (url.pathname === '/orders')
          return json(response, 200, {
            data: [
              { id: 'ord_1042', status: 'shipped', total: 129.5, currency: 'USD' },
              { id: 'ord_1043', status: 'processing', total: 42, currency: 'USD' },
            ],
          });
        if (url.pathname === '/login')
          return json(
            response,
            200,
            { token: 'eyJhbGciOiJIUzI1NiJ9.demo', expiresIn: 3600 },
            { 'Set-Cookie': 'session=s%3Adocs-demo; Path=/; HttpOnly; SameSite=Lax' },
          );
        if (url.pathname === '/graphql')
          return json(response, 200, {
            data: {
              products: [
                { sku: 'TEE-01', name: 'Workbench tee', price: 24 },
                { sku: 'MUG-02', name: 'API mug', price: 12 },
              ],
            },
          });
        if (url.pathname === '/health')
          return json(response, 200, { status: 'ok', version: '2.4.1' });
        json(response, 404, { error: 'Not found' });
      },
      8 + Math.random() * 30,
    ),
  );
}

app.whenReady().then(async () => {
  const server = createServer(api);
  const sockets = new WebSocketServer({ server, path: '/ws' });
  sockets.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'welcome', channel: 'orders' }));
    socket.on('message', (data) =>
      socket.send(JSON.stringify({ type: 'echo', received: JSON.parse(String(data)) })),
    );
  });
  await new Promise<void>((resolve) =>
    server
      .listen(4010, '127.0.0.1', resolve)
      .once('error', () => server.listen(0, '127.0.0.1', resolve)),
  );
  const port = (server.address() as { port: number }).port;
  const base = `http://localhost:${port}`;

  for (let attempt = 0; !BrowserWindow.getAllWindows().length && attempt < 250; attempt++)
    await pause(20);
  const window = BrowserWindow.getAllWindows()[0];
  window.webContents.setBackgroundThrottling(false);
  window.removeAllListeners('ready-to-show');
  window.hide();
  window.setSize(1440, 900);
  const run = (code: string) => window.webContents.executeJavaScript(code);
  const waitFor = async (expression: string, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    while (!(await run(`Boolean(${expression})`))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${expression}`);
      await pause(50);
    }
  };
  fs.mkdirSync(output, { recursive: true });
  const shots: string[] = [];
  /** Captures the window; notices are cleared first unless `keepToasts` is set. */
  // DOCS_ONLY=tests,request-scripts writes just those images; every step still runs.
  const only = process.env.DOCS_ONLY?.split(',').map((name) => name.trim());
  const capture = async (name: string, keepToasts = false) => {
    // A light-theme twin comes with its image: DOCS_ONLY=scripts-levels makes both.
    if (only && !only.includes(name) && !only.includes(name.replace(/-light$/, ''))) return;
    await run(`${keepToasts ? '' : 'clearToasts();'}document.activeElement?.blur?.()`);
    await pause(250);
    const file = path.join(output, `${name}.png`);
    fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG());
    shots.push(file);
    console.log(`Captured ${name}`);
  };
  /**
   * The image in the dark theme, then its light-theme twin (`name-light.png`), which the docs
   * site shows to readers using the light theme.
   */
  const captureThemes = async (name: string, keepToasts = false) => {
    await capture(name, keepToasts);
    if (only && !only.includes(name)) return;
    await run("state.settings.theme='light';applyTheme();render()");
    await pause(400);
    await capture(`${name}-light`, keepToasts);
    await run("state.settings.theme='dark';applyTheme();render()");
    await pause(300);
  };
  try {
    await waitFor("typeof state==='object'&&document.querySelector('.rail')", 20000);
    // The sample workspace.
    await run(`(()=>{
      const make=(name,method,path,folder,extra={})=>Object.assign(makeRequest(name,method,'{{base_url}}'+path,folder),{tests:'status 200\\nresponse-time < 1000'},extra);
      const json=(value)=>JSON.stringify(value,null,2);
      const header=(key,value)=>({enabled:true,key,value});
      const requests=[
        make('List users','GET','/users','Users',{params:[{enabled:true,key:'limit',value:'10',description:'Page size'}],auth:'Bearer token',token:'{{token}}',tests:'// @case "Succeeds"\\nstatus 200\\n// @case "Fast enough"\\nresponse-time < 500\\n// @case "Returns users"\\njson-type $.data array\\njson-length $.data > 0\\njson $.data[0].role equals "admin"'}),
        make('Get a user','GET','/users/1','Users',{auth:'Bearer token',token:'{{token}}',tests:'status 200\\njson-exists $.email'}),
        make('Create a user','POST','/users','Users',{bodyType:'raw',rawContentType:'application/json',headers:[header('Content-Type','application/json')],body:json({name:'Katherine Johnson',email:'katherine@techieutils.dev',role:'editor'}),auth:'Bearer token',token:'{{token}}',tests:'status 201\\nheader-exists location\\njson $.name equals "Katherine Johnson"'}),
        make('Update a user','PATCH','/users/2','Users',{bodyType:'raw',rawContentType:'application/json',headers:[header('Content-Type','application/json')],body:json({role:'admin'}),auth:'Bearer token',token:'{{token}}'}),
        make('Delete a user','DELETE','/users/3','Users',{auth:'Bearer token',token:'{{token}}',tests:'status 204'}),
        make('List orders','GET','/orders','Orders',{auth:'Bearer token',token:'{{token}}'}),
        make('Sign in','POST','/login','Auth',{bodyType:'raw',rawContentType:'application/json',headers:[header('Content-Type','application/json')],body:json({email:'ada@techieutils.dev',password:'{{password}}'})}),
        make('Products query','POST','/graphql','Catalog',{bodyType:'raw',rawContentType:'application/json',editorLanguage:'graphql',headers:[header('Content-Type','application/json')],body:json({query:'{ products { sku name price } }'})}),
        make('Health check','GET','/health','Catalog'),
        Object.assign(makeRequest('Order updates','GET','ws://localhost:${port}/ws','Realtime'),{protocol:'websocket',body:json({subscribe:'orders',since:'2026-10-22'})}),
      ];
      state={...state,requests,active:requests[0].id,tabs:requests.slice(0,3).map(request=>request.id).concat(requests[9].id),recentTabs:[],closedTabs:[],environment:0,history:[],cookieJar:{enabled:true,cookies:[]},collectionAuth:{},
        environments:[
          {name:'Development',variables:[header('base_url','${base}'),header('token','dev-7f3c9a1e'),header('password','correct-horse')]},
          {name:'Staging',variables:[header('base_url','https://staging.api.techieutils.dev'),header('token','{{staging_token}}'),header('password','')]},
          {name:'Production',variables:[header('base_url','https://api.techieutils.dev'),header('token',''),header('password','')]},
        ]};
      state.settings.workspaceName='Acme Store';
      persist();view='Overview';render();
    })()`);
    await pause(300);
    const open = async (name: string) => {
      await run(
        `openRequest(state.requests.find(request=>request.name===${JSON.stringify(name)}).id)`,
      );
      await pause(150);
    };
    const send = async (name: string) => {
      await open(name);
      await run("action('send')");
      await waitFor('current().response&&!busy');
      await pause(200);
    };
    for (const name of [
      'Sign in',
      'List orders',
      'Get a user',
      'Update a user',
      'Products query',
      'Create a user',
      'List users',
    ])
      await send(name);

    // The looping demo on the docs home page: type a URL and send it, check the tests, then watch a
    // load test draw its charts. Frame durations are set per frame, so slow steps play back quickly.
    // `name` is the file: demo.webp in the dark theme, demo-light.webp in the light one.
    const recordTake = async (name: string) => {
      const frames = fs.mkdtempSync(path.join(temporary, 'demo-'));
      const timeline: [string, number][] = [];
      const frame = async (ms: number) => {
        await run('clearToasts();document.activeElement?.blur?.()');
        const file = path.join(frames, `${String(timeline.length).padStart(4, '0')}.png`);
        const image = await window.webContents.capturePage();
        fs.writeFileSync(file, image.resize({ width: 1280, quality: 'best' }).toPNG());
        timeline.push([file, ms]);
      };
      await open('List orders');
      await run(
        "Object.assign(current(),{url:'{{base_url}}',response:null});requestTab='Params';responseTab='Body';render()",
      );
      await pause(200);
      await frame(900);
      const typed = '/orders';
      for (let index = 1; index <= typed.length; index++) {
        await run(`current().url='{{base_url}}'+${JSON.stringify(typed.slice(0, index))};render()`);
        await pause(40);
        await frame(index === typed.length ? 500 : 90);
      }
      await run("action('send')");
      await waitFor('current().response&&!busy');
      await pause(200);
      await frame(2200);
      await open('List users');
      await run("current().response=null;requestTab='Tests';responseTab='Tests';render()");
      await pause(200);
      await frame(700);
      await run("action('send')");
      await waitFor('current().response&&!busy');
      await pause(200);
      await frame(2400);
      await run(
        "initializeRunner();view='Runner';runnerState.folder='Users';runnerState.selected=null;runnerState.report=null;Object.assign(runnerState.config,{mode:'performance',loadModel:'workers',concurrency:6,warmupIterations:2,durationSeconds:6,rampUpSeconds:2,maxRequests:20000,delayMs:0});render()",
      );
      await pause(200);
      await frame(800);
      // Not awaited: the frames are captured while it runs.
      await run('void startRunner()');
      await waitFor('runnerState.running');
      while (await run('runnerState.running')) {
        await run("document.querySelector('.runner-chart')?.scrollIntoView({block:'center'})");
        await frame(160);
        await pause(250);
      }
      await run("document.querySelector('.runner-chart')?.scrollIntoView({block:'center'})");
      await pause(300);
      await frame(3000);
      const file = path.join(output, `${name}.webp`);
      try {
        execFileSync(
          'img2webp',
          [
            '-loop',
            '0',
            '-lossy',
            '-q',
            '80',
            '-m',
            '6',
            ...timeline.flatMap(([png, ms]) => ['-d', String(ms), png]),
            '-o',
            file,
          ],
          { stdio: 'ignore' },
        );
        console.log(`Recorded ${name} (${timeline.length} frames)`);
      } catch {
        console.warn(`Skipped ${name}.webp: install img2webp (libwebp) to record it`);
      }
    };
    /** The demo in the dark theme, then its light-theme twin for readers using the light theme. */
    const recordDemo = async () => {
      await recordTake('demo');
      await run("view='Collections';state.settings.theme='light';applyTheme();render()");
      await pause(400);
      await recordTake('demo-light');
      await run("view='Collections';state.settings.theme='dark';applyTheme();render()");
      await pause(300);
    };
    const type = (selector: string, value: string) =>
      run(
        `(()=>{const field=document.querySelector(${JSON.stringify(selector)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input'));field.dispatchEvent(new Event('change'));})()`,
      );
    const click = (selector: string) =>
      run(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);

    /**
     * Import from a link, export, and publishing a gist. GitHub is stood in for by undici's mock
     * agent, which the main process's downloads and gist publishing use, so nothing leaves the
     * computer and the token is made up.
     */
    const shareScreens = async () => {
      const previous = getGlobalDispatcher();
      const github = new MockAgent();
      github.enableNetConnect();
      const request = (name: string, method: string, url: string) => ({
        name,
        request: { method, url: `{{base_url}}${url}`, header: [] },
      });
      github
        .get('https://raw.githubusercontent.com')
        .intercept({ path: '/techieutils/acme-store-api/main/acme-store.postman_collection.json' })
        .reply(200, {
          info: {
            name: 'Acme Store',
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
          },
          item: [
            {
              name: 'Users',
              item: [
                request('List users', 'GET', '/users'),
                request('Get a user', 'GET', '/users/1'),
                request('Create a user', 'POST', '/users'),
              ],
            },
            {
              name: 'Orders',
              item: [
                request('List orders', 'GET', '/orders'),
                request('Refund an order', 'POST', '/orders/ord_1042/refund'),
              ],
            },
            { name: 'Catalog', item: [request('Health check', 'GET', '/health')] },
          ],
          variable: [{ key: 'base_url', value: 'https://api.techieutils.dev' }],
        });
      github
        .get('https://api.github.com')
        .intercept({ path: '/gists', method: 'POST' })
        .reply(201, {
          id: '5f2c8e1a9b7d4c3e6f0a',
          html_url: 'https://gist.github.com/techieutils/5f2c8e1a9b7d4c3e6f0a',
          public: false,
        });
      setGlobalDispatcher(github);
      try {
        await run("openCollectionTransfer('import');void 0");
        await waitFor("document.querySelector('[data-transfer-link-form]')");
        await click('[data-transfer-tab=Link]');
        await type(
          '#transfer-link',
          'https://github.com/techieutils/acme-store-api/blob/main/acme-store.postman_collection.json',
        );
        await click('[data-transfer-link]');
        await waitFor('transferUI.preview?.data.requests.length===6&&!transferUI.busy', 10000);
        await captureThemes('import-preview');
        await run("document.querySelector('[data-transfer-close]').click();void 0");
        await waitFor("!document.querySelector('.collection-transfer')");

        await run("openCollectionTransfer('export');void 0");
        await waitFor("transferUI.exported&&document.querySelector('#transfer-format')");
        await type('#transfer-format', 'postman');
        await waitFor("transferUI.exported?.name.endsWith('.json')");
        await captureThemes('export');

        await run(
          "window.workbench.credentials.save({name:'GitHub (techieutils)',kind:'bearer',allowedOrigin:'https://api.github.com',secret:'docs-github-token'}).then(()=>loadCredentials()).then(()=>true)",
        );
        await click('[data-transfer-destination=gist]');
        await waitFor("document.querySelector('[data-transfer-gist]')");
        if (await run("Boolean(document.querySelector('[data-transfer-unlock]'))")) {
          await click('[data-transfer-unlock]');
          await waitFor("!document.querySelector('[data-transfer-unlock]')");
        }
        await waitFor('gistUI.credentialId');
        await type('#transfer-gist-description', 'Acme Store API, Postman collection');
        await click('[data-transfer-confirm]');
        await waitFor("gistUI.result&&document.querySelector('[data-gist-result]')", 10000);
        await captureThemes('export-gist');
        await run("document.querySelector('[data-transfer-close]').click();void 0");
        await waitFor("!document.querySelector('.collection-transfer')");
      } finally {
        setGlobalDispatcher(previous);
        await github.close();
      }
    };

    /**
     * Cloning a repository into a team workspace, and its Git panel. A bare repository on disk
     * stands in for GitHub; the clone's remote is then pointed at a GitHub address for the picture,
     * which is never contacted because nothing is pushed.
     */
    const gitScreens = async () => {
      // Outside the app's data folder, where the app refuses to put a team workspace.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-workbench-docs-git-'));
      const remote = path.join(root, 'acme-store-api.git');
      const clones = path.join(root, 'clones');
      fs.mkdirSync(clones);
      // The person's own git settings (signing, default branch) must not change the pictures.
      process.env.GIT_CONFIG_GLOBAL = os.devNull;
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { stdio: 'ignore' });
      const showOpenDialog = dialog.showOpenDialog;
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [clones],
      })) as typeof dialog.showOpenDialog;
      const original = (await run('workspaceUI.id')) as string;
      try {
        await run('openWorkspaceManager()');
        await waitFor("document.querySelector('[data-workspace-team]')");
        await click('[data-workspace-team]');
        await waitFor("document.querySelector('[data-workspace-clone]')");
        await type('#team-member-name', 'Ada Lovelace');
        await type('#team-clone-url', 'https://github.com/techieutils/acme-store-api.git');
        await run(
          "document.querySelector('[data-workspace-clone]').scrollIntoView({block:'center'})",
        );
        await captureThemes('team-clone');
        await type('#team-clone-url', remote);
        await click('[data-workspace-clone-button]');
        await waitFor(
          '!workspaceUI.open&&!workspaceUI.busy&&workspaceUI.id!==' + JSON.stringify(original),
          30000,
        );
        execFileSync(
          'git',
          ['remote', 'set-url', 'origin', 'https://github.com/techieutils/acme-store-api.git'],
          { cwd: path.join(clones, 'acme-store-api'), stdio: 'ignore' },
        );
        await run('openWorkspaceManager()');
        await waitFor(
          "document.querySelector('[data-team-git-sync-form]')&&teamGitUI.status?.changeCount>0&&teamGitUI.status?.remote?.includes('github.com')",
          15000,
        );
        await type('#team-git-message', 'Share the Acme Store workspace');
        await run("document.querySelector('[data-team-git]').scrollIntoView({block:'end'})");
        await captureThemes('team-git');
        await run('closeWorkspaceManager()');
        await waitFor('!workspaceUI.open');
      } finally {
        dialog.showOpenDialog = showOpenDialog;
        await run(`selectWorkspace(${JSON.stringify(original)})`);
        await waitFor(`workspaceUI.id===${JSON.stringify(original)}&&!workspaceUI.busy`, 15000);
        fs.rmSync(root, { recursive: true, force: true });
      }
    };

    if (process.env.DOCS_DEMO_ONLY) {
      await recordDemo();
      return;
    }

    // Getting started
    await run("view='Overview';render()");
    await captureThemes('overview');
    await run("requestTab='Params';responseTab='Body';render()");
    await open('List users');
    await captureThemes('request-response');
    await run('document.querySelector(\'[data-collection-menu="Users"]\').click()');
    await pause(200);
    await captureThemes('collection-menu');
    await run(
      "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));document.querySelector('[data-collection-menu=\"Users\"]').nextElementSibling?.hidePopover?.()",
    );
    await open('Create a user');
    await run("requestTab='Body';responseTab='Headers';render()");
    await captureThemes('request-body');
    await open('List users');
    await run("requestTab='Tests';responseTab='Tests';render()");
    await captureThemes('tests');
    // A post-response script, written as the person would, and its test with the response's.
    await run(
      `scriptsStore.edit(current(),'post',${JSON.stringify("const users = aw.response.json().data;\n\naw.test('lists users', () => {\n  aw.expect(aw.response.status).toBe(200);\n  aw.expect(users.length).toBeGreaterThan(0);\n});\n\naw.vars.set('first_user_id', users[0].id);\n")});requestTab='Scripts';responseTab='Tests';render()`,
    );
    await pause(200);
    await run("document.querySelector('[data-script-phase=post]').click()");
    await run("action('send')");
    await waitFor('current().response&&!busy');
    await pause(300);
    await run(
      "[...document.querySelectorAll('#response-panel *')].find(item=>item.children.length===0&&item.textContent==='lists users')?.scrollIntoView({block:'center'})",
    );
    await captureThemes('request-scripts');
    await run("scriptsStore.edit(current(),'post','');requestTab='Tests';render()");

    // Scripts: levels and their order, the library, snippets, paused scripts, and the console.
    // The request side gets most of the height, so the editor and the panels beside it show.
    // A taller window for these, so the run order below the editor shows too.
    window.setSize(1440, 1040);
    await pause(300);
    await run('requestPanels.share=72;render()');
    await run(
      `scriptsStore.editWorkspace('pre',${JSON.stringify("aw.vars.set('request_id', aw.uuid());\n")});scriptsStore.editFolder('Users','pre',${JSON.stringify("// Every request in Users is signed with the shared library.\nconst { sign, stamp } = aw.require('signing');\nconst timestamp = stamp();\naw.request.headers.set('X-Timestamp', timestamp);\naw.request.headers.set('X-Signature', sign(timestamp + aw.request.url));\n")});scriptsStore.addModule('signing');scriptsStore.editModule('signing',${JSON.stringify("// Shared by every script: const { sign } = aw.require('signing');\n\nexports.stamp = () => String(Date.now());\n\nexports.sign = (text) =>\n  aw.crypto.hmac('sha256', aw.vars.get('signing_key') ?? 'dev-key', text, 'hex');\n")});requestTab='Scripts';responseTab='Body';render()`,
    );
    await pause(200);
    await run("document.querySelector('[data-script-level=collection]').click()");
    await run("document.querySelector('[data-script-phase=pre]').click()");
    await pause(300);
    await captureThemes('scripts-levels');
    await run("document.querySelector('[data-script-level=library]').click()");
    await pause(300);
    await captureThemes('script-library');

    // The snippets panel, with one of the workspace's own snippets first.
    await run(
      `scriptsStore.saveSnippet({title:'Check our error format',description:'Errors have a code and a message.',places:['post'],code:${JSON.stringify("aw.test('error has a code and message', () => {\n  const body = aw.response.json();\n  aw.expect(body).toHaveProperty('error.code');\n  aw.expect(body).toHaveProperty('error.message');\n});")}});render()`,
    );
    await run(
      `scriptsStore.edit(current(),'post',${JSON.stringify('const { data } = aw.response.json();\n\n')});render()`,
    );
    await run("document.querySelector('[data-script-level=request]').click()");
    await run("document.querySelector('[data-script-phase=post]').click()");
    await pause(300);
    await captureThemes('script-snippets');

    // What the console shows: each script's lines, labelled with where it comes from.
    await run(
      `scriptsStore.edit(current(),'post',${JSON.stringify("const { data } = aw.response.json();\naw.info('Listed', data.length, 'users');\nif (aw.response.time > 200) aw.warn('Slow response:', aw.response.time, 'ms');\naw.test('lists users', () => aw.expect(data.length).toBeGreaterThan(0));\n")});render()`,
    );
    // The console starts empty for this request, so the lines shown are this send's.
    await run("devTools.open=true;devTools.tab='Console';render()");
    await pause(300);
    await run("document.querySelector('[data-console-clear]').click()");
    await pause(200);
    await run("action('send')");
    await waitFor('current().response&&!busy');
    await pause(300);
    // Only the scripts' lines, which each say where the script comes from.
    await run(
      "(()=>{const input=document.querySelector('[aria-label=\"Filter console events\"]');input.value='script';input.dispatchEvent(new Event('input',{bubbles:true}));})()",
    );
    await pause(400);
    await captureThemes('script-console');
    await run('devTools.open=false;render()');

    // A script that arrived from elsewhere is paused, with Allow scripts.
    await run(
      `current().scripts={post:${JSON.stringify("// Added by a teammate's change\naw.vars.set('report_url', aw.response.headers.get('location') ?? '');\n")}};render()`,
    );
    await pause(500);
    await run("document.querySelector('[data-script-phase=post]').click()");
    await pause(300);
    await captureThemes('scripts-paused');

    await run(
      "delete current().scripts;scriptsStore.editWorkspace('pre','');scriptsStore.editFolder('Users','pre','');delete state.scriptLibrary;delete state.scriptSnippets;requestPanels.share=55;requestTab='Tests';persist();render()",
    );
    await run(
      "(()=>{const input=document.querySelector('[aria-label=\"Filter console events\"]');if(input){input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));}})()",
    );
    window.setSize(1440, 900);
    await pause(300);
    await run("requestTab='Auth';responseTab='Timeline';render()");
    // Without waiting, the dark image caught the Tests and Body tabs still on screen.
    await waitFor("document.querySelector('.network-timing [data-timing-row=total]')");
    await pause(500);
    await captureThemes('auth-and-timeline');
    await run("requestTab='Params';responseTab='Body';render();action('code')");
    await waitFor('codeDialog?.result?.code');
    await captureThemes('code-generator');
    await run("action('code')");
    await run("view='Environments';render()");
    await captureThemes('environments');

    // Live protocols
    await open('Order updates');
    await run("document.querySelector('[data-protocol-connect]').click()");
    await waitFor(
      "document.querySelector('[data-protocol-send]')&&!document.querySelector('[data-protocol-send]').disabled",
    );
    await run("document.querySelector('[data-protocol-send]').click()");
    await pause(600);
    await captureThemes('websocket');
    await run("document.querySelector('[data-protocol-connect]').click()");

    // Runner
    // Tags: on a request under its name, then choosing what a run sends by them.
    await run(
      "const tag=(name,tags)=>{state.requests.find(r=>r.name===name).tags=tags};tag('List users',['smoke','users']);tag('Get a user',['smoke','users']);tag('Create a user',['users','write']);tag('Update a user',['users','write']);tag('Delete a user',['users','write','slow']);persist();render()",
    );
    await run("state.collectionTags={Users:['api']};persist();render()");
    await open('List users');
    await run("view='Collections';requestTab='Params';responseTab='Body';render()");
    await pause(200);
    await captureThemes('request-tags');
    // The explorer's tag bar: only requests tagged smoke are shown.
    await run("document.querySelector('[data-explorer-tags] [data-runner-tag=smoke]')?.click()");
    await pause(200);
    await captureThemes('explorer-tags');
    await run(
      "document.querySelector('[data-explorer-tags] [data-action=clear-tag-filter]')?.click()",
    );
    await pause(150);
    // History by tag, and the command palette's #tag search.
    await run("view='History';render()");
    await pause(300);
    await run("document.querySelector('[data-history-tags] [data-runner-tag=smoke]')?.click()");
    await pause(200);
    await captureThemes('history-tags');
    await run(
      "document.querySelector('[data-history-tags] [data-action=clear-tag-filter]')?.click()",
    );
    await run("view='Collections';commandPalette.open=true;commandPalette.query='';render()");
    await pause(200);
    await run("commandPalette.query='#users';render()");
    await pause(300);
    await captureThemes('palette-tags');
    await run("commandPalette.open=false;commandPalette.query='';render()");
    await pause(150);
    // The Docs screen by tag.
    await run(
      "view='Documentation';documentationState.collection='Users';documentationState.mode='Swagger';render()",
    );
    await pause(300);
    await run("document.querySelector('[data-docs-tags] [data-runner-tag=write]')?.click()");
    await pause(250);
    await captureThemes('docs-tags');
    await run("document.querySelector('[data-docs-tags] [data-action=clear-tag-filter]')?.click()");
    await run("view='Collections';render()");
    await pause(150);
    // Workspace search by tag.
    await run(
      "workspaceSearch.open=true;workspaceSearch.query='';workspaceSearch.category='All';render()",
    );
    await pause(200);
    await run("document.querySelector('[data-search-tags] [data-runner-tag=write]')?.click()");
    await pause(250);
    await captureThemes('search-tags');
    await run(
      "workspaceSearch.open=false;workspaceSearch.tags={include:[],mode:'any',exclude:[]};render()",
    );
    await pause(150);
    // A collection's tags, which every request in it has too.
    await run('document.querySelector(\'[data-collection-menu="Users"]\').click()');
    await pause(150);
    await run(
      "document.querySelector('[data-collection-menu=\"Users\"]').nextElementSibling.querySelector('[data-menu-item=tags]').click()",
    );
    await pause(300);
    await captureThemes('folder-tags');
    await run("document.querySelector('[data-folder-tags-done]').click()");
    await pause(200);
    await run(
      "initializeRunner();view='Runner';runnerState.folder='Users';runnerState.selected=null;runnerState.tags={include:['users'],mode:'any',exclude:['slow']};render()",
    );
    await pause(300);
    await run("document.querySelector('[data-runner-tags]')?.scrollIntoView({block:'center'})");
    await pause(200);
    await captureThemes('runner-tags');
    // Back to the top of the Runner, as the screenshots after this one expect.
    await run(
      "(()=>{for(let element=document.querySelector('[data-runner-tags]');element;element=element.parentElement)if(element.scrollTop)element.scrollTop=0;})()",
    );
    await run(
      "runnerState.tags={include:[],mode:'any',exclude:[]};for(const request of state.requests)delete request.tags;delete state.collectionTags;persist();render()",
    );
    await run(
      "initializeRunner();view='Runner';runnerState.folder='Users';runnerState.selected=null;render()",
    );
    await pause(200);
    await run(
      "Object.assign(runnerState.config,{mode:'collection',iterations:2,concurrency:1,delayMs:0});startRunner()",
    );
    await waitFor('runnerState.report&&!runnerState.running', 30000);
    await captureThemes('runner-collection');
    await run(
      "Object.assign(runnerState.config,{mode:'performance',loadModel:'workers',concurrency:6,warmupIterations:2,durationSeconds:8,rampUpSeconds:2,maxRequests:20000,delayMs:0});startRunner()",
    );
    await waitFor(
      "runnerState.report&&!runnerState.running&&runnerState.report.mode==='performance'",
      40000,
    );
    await run("document.querySelector('.runner-results')?.scrollIntoView({block:'start'})");
    await captureThemes('runner-performance');
    await run(
      "document.querySelector('.runner-chart')?.closest('section, .overview-card, div')?.scrollIntoView({block:'start'})",
    );
    await captureThemes('runner-charts');

    // Credentials
    await run(`(async()=>{
      await window.workbench.credentials.save({name:'Acme API token',kind:'bearer',allowedOrigin:'https://api.techieutils.dev',secret:'acme-live-token'});
      await window.workbench.credentials.save({name:'Partner API key',kind:'api-key',allowedOrigin:'https://partners.techieutils.dev',headerName:'X-API-Key',secret:'pk_live_123'});
      await window.workbench.credentials.save({name:'Billing service',kind:'basic',allowedOrigin:'https://billing.techieutils.dev',username:'svc-billing',secret:'billing-secret'});
      await window.workbench.credentials.save({name:'Acme OAuth (client credentials)',kind:'oauth2',allowedOrigin:'https://api.techieutils.dev',oauth:{...defaultOAuth(),grantType:'client_credentials',tokenUrl:'https://auth.techieutils.dev/oauth/token',clientId:'workbench-docs',clientSecret:'client-secret',clientAuth:'basic',scope:'orders:read users:read'}});
      openCredentialsPage();
    })()`);
    await waitFor(
      "document.querySelectorAll('.credential-table tbody tr, [data-credential-row]').length>=4||document.body.textContent.includes('Partner API key')",
      10000,
    );
    await captureThemes('credentials');

    // Interceptor: real traffic through the capture proxy.
    const proxyPort = port + 1;
    await run(`document.querySelector('[data-view=Interceptor]').click()`);
    await waitFor("document.querySelector('[data-interceptor-port]')");
    await run(
      `(()=>{const input=document.querySelector('[data-interceptor-port]');input.value='${proxyPort}';input.dispatchEvent(new Event('change'));const domains=document.querySelector('[data-interceptor-domains]');if(domains){domains.value='example.test';domains.dispatchEvent(new Event('input'))}setTimeout(()=>document.querySelector('[data-interceptor-start]').click(),50);})()`,
    );
    await waitFor(
      "document.querySelector('[data-interceptor-state]').textContent.includes('Listening')",
    );
    const viaProxy = (method: string, target: string, body?: string) =>
      new Promise<void>((resolve, reject) => {
        const outgoing = httpRequest(
          {
            host: '127.0.0.1',
            port: proxyPort,
            method,
            path: `${base}${target}`,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh) AcmeStorefront/3.2',
              Accept: 'application/json',
              ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
          },
          (response) => {
            response.resume();
            response.on('end', resolve);
          },
        );
        outgoing.on('error', reject);
        outgoing.end(body);
      });
    await viaProxy('GET', '/health');
    await viaProxy('GET', '/users?limit=2');
    await viaProxy(
      'POST',
      '/login',
      JSON.stringify({ email: 'grace@techieutils.dev', password: 'hunter2' }),
    );
    await viaProxy('GET', '/orders');
    await viaProxy('POST', '/users', JSON.stringify({ name: 'Mary Jackson', role: 'viewer' }));
    await viaProxy('GET', '/missing');
    await waitFor("document.querySelectorAll('[data-capture]').length>=6");
    await pause(300);
    await run("document.querySelectorAll('[data-capture]')[1].click()");
    await captureThemes('interceptor');
    await run("document.querySelector('[data-interceptor-stop]').click()");

    // History, cookies, docs, settings, dialogs
    await run("view='History';render()");
    await captureThemes('history');
    await run("view='Cookies';render()");
    await captureThemes('cookies');
    await run("view='Documentation';documentationState.collection='Users';render()");
    await pause(300);
    await captureThemes('documentation');
    await run("view='Settings';render()");
    await captureThemes('settings');
    await run("document.querySelector('[data-settings-section=Requests]')?.click()");
    await pause(200);
    await captureThemes('settings-requests');
    // Updates: a build run from source never finds one, so the screenshots set each state.
    await run(
      "window.savedUpdateInfo=updatesStore.info;document.querySelector('[data-settings-section=Updates]')?.click()",
    );
    await run(
      "updatesStore.info={...updatesStore.info,currentVersion:'1.0.0',lastChecked:new Date().toISOString(),preferences:{mode:'notify',prerelease:false},status:{state:'available',version:'1.1.0',releaseDate:'2026-11-03T00:00:00Z',notes:'Capture values from any response view.\\nClick the status bar version to check for updates.\\nFaster History search.'}};document.querySelector('[data-version-button]').click()",
    );
    await pause(400);
    await captureThemes('updates', true);
    await run(
      "clearToasts();updatesStore.info={...updatesStore.info,status:{state:'downloading',version:'1.1.0',percent:64}}",
    );
    await pause(300);
    await captureThemes('update-downloading');
    await run(
      "updatesStore.info={...updatesStore.info,status:{state:'downloaded',version:'1.1.0'}};document.querySelector('[data-version-button]').click()",
    );
    await pause(400);
    await captureThemes('update-ready', true);
    await run('clearToasts();updatesStore.info=window.savedUpdateInfo;render()');
    await open('List users');
    await run('openCommandPalette()');
    await pause(200);
    await captureThemes('command-palette');
    await run('closeCommandPalette()');
    await run("openCollectionTransfer('import')");
    await pause(200);
    await captureThemes('import');
    await shareScreens();
    await run('openWorkspaceManager()');
    await pause(200);
    await captureThemes('workspaces');
    await run("closeWorkspaceManager();state.settings.theme='light';applyTheme();render()");
    await pause(300);
    await capture('light-theme');
    await run("state.settings.theme='dark';applyTheme();render()");
    if (!only) await recordDemo();
    await gitScreens();

    // Smaller files for the repository: 1600 px wide is sharp on docs pages.
    if (process.platform === 'darwin')
      for (const file of shots)
        execFileSync('sips', ['--resampleWidth', '1600', file], { stdio: 'ignore' });
    console.log(`Saved ${shots.length} screenshots to ${path.relative(process.cwd(), output)}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    sockets.close();
    server.close();
    fs.rmSync(temporary, { recursive: true, force: true });
    app.exit(Number(process.exitCode ?? 0));
  }
});

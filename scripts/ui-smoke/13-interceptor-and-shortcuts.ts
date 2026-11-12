import { safeStorage } from 'electron';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { pause, type SmokeContext } from './harness';

/** UI smoke checks, part 13: interceptor and shortcuts. */
export default async function interceptorAndShortcuts(context: SmokeContext) {
  const { window, run, capture, tabsReachable, rightClick } = context;
  // Interceptor: a local capture proxy whose traffic can be inspected and saved as requests.
  const interceptedOrigin = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ intercepted: true, path: request.url }));
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => interceptedOrigin.once('listening', resolve));
  const originPort = (interceptedOrigin.address() as { port: number }).port;
  const probe = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => probe.once('listening', resolve));
  const proxyPort = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  await run(
    "window.interceptorOriginal=structuredClone(state);document.querySelector('[data-view=Interceptor]').click()",
  );
  assert.equal(
    await run(
      "document.querySelector('.layout').classList.contains('management')&&document.querySelector('[data-interceptor-state]').textContent.includes('Stopped')",
    ),
    true,
    'the Interceptor opens full width, stopped',
  );
  // OS encryption is unavailable here, so the CA key cannot be protected and HTTPS stays tunnelled.
  for (
    let attempt = 0;
    attempt < 30 &&
    !(await run(
      "Boolean(document.querySelector('.interceptor-certificate')?.textContent.includes('cannot be decrypted'))",
    ));
    attempt++
  )
    await pause(100);
  assert.match(
    await run("document.querySelector('.interceptor-certificate').textContent"),
    /Set up the API Workbench vault/,
    'without OS encryption the CA is not created',
  );
  const interceptorStorage = {
    available: safeStorage.isAsyncEncryptionAvailable,
    encrypt: safeStorage.encryptStringAsync,
    decrypt: safeStorage.decryptStringAsync,
  };
  safeStorage.isAsyncEncryptionAvailable = async () => true;
  safeStorage.encryptStringAsync = async (value) => Buffer.from(value).reverse();
  safeStorage.decryptStringAsync = async (value) => ({
    result: Buffer.from(value).reverse().toString(),
    shouldReEncrypt: false,
  });
  await run(
    `(()=>{const input=document.querySelector('[data-interceptor-port]');input.value='${proxyPort}';input.dispatchEvent(new Event('change'));const domains=document.querySelector('[data-interceptor-domains]');if(domains){domains.value='example.test';domains.dispatchEvent(new Event('input'))}setTimeout(()=>document.querySelector('[data-interceptor-start]').click(),50);})()`,
  );
  for (
    let attempt = 0;
    attempt < 50 &&
    !(await run(
      "document.querySelector('[data-interceptor-state]').textContent.includes('Listening')",
    ));
    attempt++
  )
    await pause(100);
  assert.match(
    await run("document.querySelector('[data-interceptor-state]').textContent"),
    new RegExp(`Listening on 127\\.0\\.0\\.1:${proxyPort}`),
  );
  assert.match(
    await run("document.querySelector('.interceptor-certificate').textContent"),
    /API Workbench Interceptor CA/,
    'starting with decryption creates the CA',
  );
  const proxied = await new Promise<string>((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'POST',
        path: `http://127.0.0.1:${originPort}/orders?page=2`,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer UI-INTERCEPT' },
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve(body));
      },
    );
    outgoing.on('error', reject);
    outgoing.end('{"item":"book"}');
  });
  assert.deepEqual(
    JSON.parse(proxied),
    { intercepted: true, path: '/orders?page=2' },
    'the proxy forwards traffic',
  );
  for (
    let attempt = 0;
    attempt < 50 &&
    !(await run(
      "Boolean(document.querySelector('[data-capture] .ui-badge')?.textContent.includes('200'))",
    ));
    attempt++
  )
    await pause(100);
  assert.equal(
    await run(
      "(()=>{const row=document.querySelector('[data-capture]');return row.textContent.includes('POST')&&row.textContent.includes('/orders?page=2')&&row.textContent.includes('200');})()",
    ),
    true,
    'captured traffic is listed',
  );
  // Squeezed, the traffic filters scroll with arrows.
  const trafficFilters = '[aria-label="Filter captured traffic"]';
  await run(
    `document.querySelector(${JSON.stringify(trafficFilters)}).closest('.ui-tabs-frame').style.width='180px'`,
  );
  await pause(80);
  assert.equal(
    await tabsReachable(trafficFilters),
    'reachable',
    'traffic filters that do not fit are reachable with the arrows',
  );
  await run(
    `(()=>{const row=document.querySelector(${JSON.stringify(trafficFilters)});row.scrollLeft=0;row.closest('.ui-tabs-frame').style.width=''})()`,
  );
  await rightClick('[data-capture]');
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-capture-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
    ),
    'details,save,copy,host,method',
    'right-clicking a capture lists its actions',
  );
  await run("document.querySelector('[data-capture-menu] [data-menu-item=details]').click()");
  assert.match(
    await run("document.querySelector('[data-interceptor-response-body]').textContent"),
    /"intercepted": true/,
    'the response body is shown, formatted',
  );
  await run("document.querySelector('[data-interceptor-tab=Request]').click()");
  assert.equal(
    await run(
      "document.querySelector('.interceptor-detail').textContent.includes('Bearer UI-INTERCEPT')&&document.querySelector('.interceptor-body').textContent.includes('book')",
    ),
    true,
    'request headers and body are shown',
  );
  await run("document.querySelector('[data-interceptor-tab=Response]').click()");
  assert.equal(
    await run(
      "(()=>{const list=document.querySelector('.interceptor-list').getBoundingClientRect(),detail=document.querySelector('.interceptor-detail').getBoundingClientRect();return detail.left>=list.right-1&&detail.width>=300;})()",
    ),
    true,
    'details sit beside the list',
  );
  await capture('interceptor.png');
  await run("document.querySelector('[data-interceptor-filter=HTTPS]').click()");
  assert.equal(
    await run("document.querySelectorAll('[data-capture]').length"),
    0,
    'filters narrow the list',
  );
  await run("document.querySelector('[data-interceptor-filter=All]').click()");
  await run(
    "document.querySelector('select[data-interceptor-method]').closest('.ui-select').querySelector('.ui-select-trigger').click()",
  );
  assert.equal(
    await run(
      "[...document.querySelector('select[data-interceptor-method]').closest('.ui-select').querySelectorAll('[role=option]')].map(option=>option.querySelector('.ui-select-option-text > span').textContent+'·'+option.querySelector('small').textContent).join('|')",
    ),
    'All methods·1 capture|POST·1 capture',
    'the method filter lists captured methods with counts',
  );
  await run(
    "document.querySelector('select[data-interceptor-method]').closest('.ui-select').querySelectorAll('[role=option]')[1].click()",
  );
  assert.equal(
    await run("document.querySelectorAll('[data-capture]').length"),
    1,
    'filtering by a captured method keeps it',
  );
  await run(
    `(()=>{const select=document.querySelector('select[data-interceptor-host]');select.value='127.0.0.1:${originPort}';select.dispatchEvent(new Event('change'));})()`,
  );
  assert.equal(
    await run(
      `document.querySelector('select[data-interceptor-host]').closest('.ui-select').querySelector('.ui-select-value').textContent.trim()==='127.0.0.1:${originPort}'&&document.querySelectorAll('[data-capture]').length===1`,
    ),
    true,
    'filtering by host keeps its captures',
  );
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-capture] .method')].every(badge=>badge.querySelector('.method-icon'))&&document.querySelectorAll('[data-capture] .method .method-icon').length===1",
    ),
    true,
    'Interceptor captures show their method icon',
  );
  await run(
    "for(const name of ['host','method']){const select=document.querySelector('select[data-interceptor-'+name+']');select.value='';select.dispatchEvent(new Event('change'));}",
  );
  await run("document.querySelector('[data-interceptor-save]').click()");
  for (let attempt = 0; attempt < 30 && (await run('view')) !== 'Collections'; attempt++)
    await pause(100);
  assert.equal(
    await run(
      `(()=>{const request=current();return request.folder==='Intercepted'&&request.method==='POST'&&request.url==='http://127.0.0.1:${originPort}/orders?page=2'&&request.body==='{"item":"book"}'&&!request.headers.some(row=>/^(host|content-length|connection)$/i.test(row.key));})()`,
    ),
    true,
    'a capture saves as a request in Intercepted, without connection headers',
  );
  await run("document.querySelector('[data-view=Interceptor]').click()");
  assert.equal(
    await run("document.querySelectorAll('[data-capture]').length"),
    1,
    'captures stay while switching screens',
  );
  await run("document.querySelector('[data-interceptor-stop]').click()");
  for (
    let attempt = 0;
    attempt < 30 &&
    !(await run(
      "document.querySelector('[data-interceptor-state]').textContent.includes('Stopped')",
    ));
    attempt++
  )
    await pause(100);
  await assert.rejects(
    new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        { host: '127.0.0.1', port: proxyPort, path: `http://127.0.0.1:${originPort}/` },
        resolve,
      );
      outgoing.on('error', reject);
      outgoing.end();
    }),
    'stopping closes the proxy',
  );
  interceptedOrigin.close();
  Object.assign(safeStorage, {
    isAsyncEncryptionAvailable: interceptorStorage.available,
    encryptStringAsync: interceptorStorage.encrypt,
    decryptStringAsync: interceptorStorage.decrypt,
  });
  await run(
    "document.querySelector('[data-interceptor-clear]').click();state=window.interceptorOriginal;view='Collections';render()",
  );
  await run(
    "window.colorOriginal=structuredClone(state);const methods=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'];state.requests.push(...methods.map(method=>({...structuredClone(current()),id:'color-'+method,name:method+' example',method,folder:'Method colors',protocol:'http',response:null})),{...structuredClone(current()),id:'color-ws',name:'Socket example',method:'GET',protocol:'websocket',folder:'Method colors',url:'ws://localhost/ws',response:null});state.tabs=[...methods.map(method=>'color-'+method),'color-ws'];state.active='color-PATCH';view='Collections';requestTab='Params';render()",
  );
  const methodColors = async () =>
    run(
      "(()=>{const color=element=>getComputedStyle(element).color;const result={};for(const method of ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']){const tree=document.querySelector('.request-item[data-open=\"color-'+method+'\"] .method');const tab=[...document.querySelectorAll('.request-tab')].find(item=>item.querySelector('[data-open=\"color-'+method+'\"]'))?.querySelector('.method');result[method]={tree:color(tree),tab:color(tab)};}result.WS=color(document.querySelector('.request-item[data-open=\"color-ws\"] .method'));return result;})()",
    );
  const dark = (await methodColors()) as Record<string, { tree: string; tab: string } | string>;
  const httpColors = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(
    (method) => dark[method] as { tree: string; tab: string },
  );
  assert.ok(
    httpColors.every((entry) => entry.tree === entry.tab),
    'tree and tab badges share a color per method',
  );
  assert.equal(
    new Set(httpColors.map((entry) => entry.tree)).size,
    7,
    'every HTTP method has its own color',
  );
  assert.ok(
    !httpColors.some((entry) => entry.tree === dark.WS),
    'live protocols use their own color, not the underlying method',
  );
  assert.equal(
    await run(
      "getComputedStyle(document.querySelector('.urlbar > .method-select .ui-select-value')).color",
    ),
    (dark.PATCH as { tree: string }).tree,
    'the method picker matches the request list color',
  );
  await run("current().method='DELETE';render()");
  assert.equal(
    await run(
      "getComputedStyle(document.querySelector('.urlbar > .method-select .ui-select-value')).color",
    ),
    (dark.DELETE as { tree: string }).tree,
    'the method picker follows the selected method',
  );
  await capture('method-colors-dark.png');
  await run("state.settings={...settings(),theme:'light'};render()");
  const light = (await methodColors()) as Record<string, { tree: string } | string>;
  assert.notEqual(
    (light.GET as { tree: string }).tree,
    (dark.GET as { tree: string }).tree,
    'light theme uses its own method palette',
  );
  await capture('method-colors-light.png');
  await run("state.active='color-ws';render()");
  assert.equal(
    await run("getComputedStyle(document.querySelector('.urlbar > .request-type-select')).color"),
    light.WS,
    'the live protocol in the URL bar matches its list badge',
  );
  await run(
    "state=window.colorOriginal;state.settings={...settings(),theme:'dark'};view='Collections';render()",
  );
  await run(
    "window.paneOriginal=structuredClone(state);current().protocol='http';current().response={status:201,statusText:'Created',headers:{},body:'{}',time:37,size:2,url:'https://example.com'};view='Collections';requestTab='Params';responseTab='Body';Object.assign(requestPanels,{request:true,response:true,layout:'stacked',share:55});devTools.open=false;render()",
  );
  const key = (key: string, extra: Record<string, boolean> = {}) =>
    run(
      `document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},metaKey:true,bubbles:true,...${JSON.stringify(extra)}}))`,
    );
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-panel-layout]')].map(item=>item.dataset.panelLayout).join()",
    ),
    'stacked,side,auto',
    'layout menu offers stacked, side by side, and auto',
  );
  await run("document.querySelector('[data-panel-layout=auto]').click()");
  assert.equal(
    await run(
      "paneLayout()==='side'&&document.querySelector('.status-layout-trigger').textContent.includes('Auto · Side by side')&&document.querySelector('.request-response-panes').classList.contains('side')",
    ),
    true,
    'auto uses side by side on wide windows',
  );
  window.setSize(1024, 720);
  await pause(250);
  assert.equal(
    await run(
      "paneLayout()==='stacked'&&document.querySelector('.request-response-panes').classList.contains('stacked')",
    ),
    true,
    'auto switches to stacked when the window narrows',
  );
  window.setSize(1440, 960);
  await pause(250);
  assert.equal(
    await run("JSON.parse(localStorage.getItem('api-workbench:panes')).layout"),
    'auto',
    'the layout choice is remembered',
  );
  await key('\\');
  assert.equal(
    await run('requestPanels.layout'),
    'stacked',
    'Cmd+\\ switches layout from the resolved one',
  );
  await run(
    "document.querySelector('.request-response-panes > .pane-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))",
  );
  assert.equal(
    await run(
      "requestPanels.share===60&&JSON.parse(localStorage.getItem('api-workbench:panes')).share===60",
    ),
    true,
    'keyboard resizing is remembered',
  );
  await run(
    "document.querySelector('.request-response-panes > .pane-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  assert.equal(
    await run('requestPanels.share'),
    50,
    'double-clicking the divider resets the split',
  );
  await run("document.querySelector('.response-maximize').click()");
  assert.equal(
    await run(
      "!requestPanels.request&&!document.querySelector('.request-pane')&&document.querySelector('.pane-strip-request').textContent.includes('Show request')&&document.querySelector('.response-maximize').getAttribute('aria-pressed')==='true'",
    ),
    true,
    'maximizing the response leaves a request strip',
  );
  await capture('panes-maximized.png');
  await key('M', { shiftKey: true });
  assert.equal(
    await run(
      "requestPanels.request&&requestPanels.response&&Boolean(document.querySelector('.request-pane'))",
    ),
    true,
    'Cmd+Shift+M restores the split',
  );
  await run("document.querySelector('[data-toggle-panel=response]').click()");
  assert.equal(
    await run(
      "document.querySelector('.pane-strip-response').textContent.includes('201 Created · 37 ms')",
    ),
    true,
    'a hidden response shows its last status',
  );
  await capture('panes-response-hidden.png');
  await run("document.querySelector('[data-show-pane=response]').click()");
  assert.equal(
    await run("requestPanels.response&&!document.querySelector('.pane-strip')"),
    true,
    'the strip restores the response',
  );
  await key('j');
  assert.equal(
    await run(
      "devTools.open&&Boolean(document.querySelector('.devtools .request-console'))&&JSON.parse(localStorage.getItem('api-workbench:dev-tools')).open",
    ),
    true,
    'Cmd+J shows dev tools and remembers it',
  );
  await key('j');
  await run("document.querySelector('[data-reset-panes]').click()");
  assert.equal(
    await run(
      "requestPanels.layout==='stacked'&&requestPanels.share===55&&!devTools.open&&requestPanels.request&&requestPanels.response",
    ),
    true,
    'reset restores the default layout',
  );
  await run("state=window.paneOriginal;view='Collections';render()");
  if (context.screenshotsAvailable()) {
    // Gallery of primary views for visual review; skipped without --screenshots.
    await run(
      "window.galleryOriginal=structuredClone(state);current().response={status:200,statusText:'OK',headers:{'content-type':'application/json'},body:JSON.stringify({data:[{id:1,name:'Ada'},{id:2,name:'Grace'}],total:2}),time:42,size:64,url:'https://example.com'};state.history=[{requestId:current().id,method:'GET',url:'https://api.example.com/users?page=1',status:200,date:new Date().toISOString()},{requestId:current().id,method:'POST',url:'https://api.example.com/users',status:422,date:new Date().toISOString()}];view='Environments';render()",
    );
    await capture('gallery-environments.png');
    await run("view='History';render()");
    await capture('gallery-history.png');
    await run("view='Runner';render()");
    await capture('gallery-runner.png');
    await run("view='Documentation';render()");
    await capture('gallery-docs.png');
    await run(
      "view='Collections';requestTab='Params';responseTab='Body';responseMode='Pretty';render()",
    );
    await capture('gallery-request-dark.png');
    await run("state.settings={...settings(),theme:'light'};render()");
    await capture('gallery-request-light.png');
    await run("view='Overview';render()");
    await capture('gallery-overview-light.png');
    await run("view='Collections';requestPanels.layout='side';render()");
    await capture('gallery-side-light.png');
    await run(
      "state.settings={...settings(),theme:'dark'};requestPanels.layout='stacked';render()",
    );
    window.setSize(1024, 700);
    await pause(200);
    await run('render()');
    await capture('gallery-narrow.png');
    window.setSize(1440, 960);
    await pause(200);
    await run("state=window.galleryOriginal;view='Collections';render()");
  }
}

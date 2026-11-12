import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pause, type SmokeContext } from './harness';

/** UI smoke checks, part 9: chaining cookies and auth. */
export default async function chainingCookiesAndAuth(context: SmokeContext) {
  const { run, capture, tabsReachable, rightClick, answerConfirm } = context;
  const chainServer = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('X-Trace', 'trace-' + request.url);
    response.end(
      JSON.stringify({
        token: 'T-123',
        items: [{ id: 1 }, { id: 2 }],
        auth: request.headers.authorization || '',
        requestId: request.headers['x-request-id'] || '',
      }),
    );
  });
  await new Promise<void>((resolve) => chainServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = chainServer.address() as { port: number };
    await run(
      `window.chainOriginal=structuredClone(state);view='Collections';current().url='http://127.0.0.1:${port}/login';current().method='GET';current().auth='None';current().bodyType='none';current().params=[];current().headers=[];current().captures=[{enabled:true,key:'session_token',value:'$.token'},{enabled:true,key:'trace',value:'header x-trace'},{enabled:true,key:'missing_value',value:'$.missing'}];execute(current())`,
    );
    assert.equal(
      await run(
        "JSON.stringify(state.environments[state.environment].variables.filter(v=>['session_token','trace'].includes(v.key)).map(v=>v.value))",
      ),
      JSON.stringify(['T-123', 'trace-/login']),
      'captures write JSON and header values into the active environment',
    );
    assert.equal(
      await run('captureResults.get(current().id).filter(result=>result.error).length'),
      1,
      'missing capture paths are reported without blocking others',
    );
    await run("responseTab='Tests';render()");
    assert.equal(
      await run(
        "document.querySelector('.capture-results-title')!==null&&document.querySelector('#response-panel').textContent.includes('MISS')",
      ),
      true,
      'response tests tab lists captured variables',
    );
    await capture('response-captures.png');
    await run("requestTab='Vars';responseTab='Body';render()");
    assert.equal(
      await run(
        "document.querySelector('.kv-table thead').textContent.includes('VARIABLE')&&document.querySelectorAll('[data-type=captures][data-field=key]').length===4",
      ),
      true,
      'Vars tab edits capture rows',
    );
    // Each source previews what it captures from the last response; a secret's value is hidden.
    assert.deepEqual(
      await run(
        "[...document.querySelectorAll('[data-capture-preview]')].map(item=>item.className.replace('capture-preview ','')+' '+item.querySelector('.capture-preview-text').textContent.trim())",
      ),
      [
        'is-ok •••••• (5 characters)',
        'is-ok trace-/login',
        'is-warning ' +
          (await run('captureResults.get(current().id).find(result=>result.error).error')),
      ],
      'previews show captured values, hide secret ones, and explain a miss',
    );
    // Typing a source suggests what the response holds; Enter takes the highlighted one.
    const source = "[data-type=captures][data-field=value][data-row='3']";
    await run(
      `(()=>{const field=document.querySelector(${JSON.stringify(source)});field.focus();field.value='$.';field.setSelectionRange(2,2);field.dispatchEvent(new Event('input'));})()`,
    );
    await pause(100);
    assert.deepEqual(
      await run(
        "[...document.querySelectorAll('#kv-suggestion-list [role=option] strong')].map(item=>item.textContent).slice(0,4)",
      ),
      ['$.token', '$.items', '$.auth', '$.requestId'],
      'JSON paths of the last response are offered',
    );
    await capture('request-vars-suggestions.png');
    await run(
      `(()=>{const field=document.querySelector(${JSON.stringify(source)});field.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));field.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`,
    );
    await pause(100);
    assert.equal(
      await run('current().captures.at(-1).value'),
      '$.token',
      'choosing a suggestion fills in the source',
    );
    // After a pipe, transforms; the reference and suggestions add rows in one click.
    await run(
      `(()=>{const field=document.querySelector(${JSON.stringify("[data-type=captures][data-field=value][data-row='3']")});field.focus();field.value='$.token | jw';field.setSelectionRange(12,12);field.dispatchEvent(new Event('input'));})()`,
    );
    await pause(100);
    assert.deepEqual(
      await run(
        "[...document.querySelectorAll('#kv-suggestion-list [role=option] strong')].map(item=>item.textContent)",
      ),
      ['jwt $.'],
      'transforms are offered after a pipe',
    );
    // The dotted forms: body. paths, status.code and .text, and header. names.
    const offered = async (text: string) => {
      await run(
        `(()=>{const field=document.querySelector("[data-type=captures][data-field=value][data-row='3']");field.focus();field.value=${JSON.stringify(text)};field.setSelectionRange(${text.length},${text.length});field.dispatchEvent(new Event('input'));})()`,
      );
      await pause(100);
      return run(
        "[...document.querySelectorAll('#kv-suggestion-list [role=option] strong')].map(item=>item.textContent)",
      ) as Promise<string[]>;
    };
    assert.deepEqual(
      (await offered('body.')).slice(0, 3),
      ['body.token', 'body.items', 'body.auth'],
      'body. offers the paths of the parsed body',
    );
    assert.deepEqual(await offered('status.'), ['status.code', 'status.text']);
    assert.ok(
      (await offered('header.')).includes('header.x-trace'),
      'header. offers the response’s header names',
    );
    await run(
      "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.activeElement.blur()",
    );
    await run(
      "current().captures=current().captures.slice(0,3);render();document.querySelector('[data-captures-reference] > summary')?.click()",
    );
    await pause(100);
    await run('document.querySelector(\'[data-capture-example="header.x-request-id"]\').click()');
    await pause(100);
    assert.deepEqual(
      await run('JSON.stringify(current().captures.at(-1))'),
      JSON.stringify({ enabled: true, key: 'x_request_id', value: 'header.x-request-id' }),
      'an example from the reference becomes a named capture',
    );
    await run('current().captures=current().captures.slice(0,3);persist();render()');
    await pause(50);
    // The badge says what each source reads, and the type of what it captured.
    assert.deepEqual(
      await run(
        "[...document.querySelectorAll('[data-capture-kind]')].map(item=>item.dataset.captureKind).concat([...document.querySelectorAll('[data-capture-type]')].map(item=>item.textContent.trim()))",
      ),
      ['json-path', 'header', 'json-path', 'Text · 5', 'Text · 12'],
      'each source is labelled, and its value typed',
    );
    // A slip is caught before sending, with a fix one click away.
    await run(
      "current().captures.push({enabled:true,key:'first_id',value:'$.items[*].id | frist'});persist();render()",
    );
    await pause(100);
    assert.match(
      await run('document.querySelector(\'[data-capture-preview="3"]\').textContent'),
      /“frist” is not a transform\..*Use first/,
      'an unknown transform is flagged with a fix',
    );
    await run('document.querySelector(\'[data-capture-preview="3"] [data-capture-fix]\').click()');
    await pause(100);
    assert.equal(await run('current().captures[3].value'), '$.items[*].id | first');
    // A chain shows each step's value.
    await run(
      'document.querySelector(\'[data-capture-preview="3"] [data-capture-steps-toggle]\').click()',
    );
    await pause(100);
    assert.deepEqual(
      await run(
        "[...document.querySelectorAll('[data-capture-steps] li')].map(item=>item.textContent.replace(/\\s+/g,' ').trim())",
      ),
      ['1$.items[*].idlist · [1,2]', '2| firstnumber · 1'],
      'the steps view shows the value after each transform',
    );
    await capture('request-vars-steps.png');
    await run('current().captures=current().captures.slice(0,3);persist();render()');
    await pause(50);
    await capture('request-vars.png');
    await run(
      "current().auth='Bearer token';current().token='{{session_token}}';current().headers=[{enabled:true,key:'X-Request-Id',value:'{{$guid}}'}];current().captures=[];execute(current())",
    );
    assert.equal(
      await run('JSON.parse(current().response.body).auth'),
      'Bearer T-123',
      'captured variables chain into later requests',
    );
    assert.match(
      await run('JSON.parse(current().response.body).requestId'),
      /^[0-9a-f-]{36}$/,
      'dynamic variables resolve when sending',
    );
    await run(
      "responseTab='Body';responseMode='Pretty';requestTab='Params';render();(()=>{const input=document.querySelector('#response-filter');input.value='$.items[*].id';input.dispatchEvent(new Event('input'));})()",
    );
    await pause(300);
    assert.equal(
      await run('JSON.stringify(JSON.parse(responseSourceEditor.getValue()))'),
      '[1,2]',
      'response filter applies wildcard JSON paths',
    );
    await capture('response-filter.png');
    // Squeezed, the response toolbar scrolls with arrows.
    await run(
      "document.querySelector('.response .code-toolbar').closest('.ui-tabs-frame').style.width='200px'",
    );
    await pause(80);
    assert.equal(
      await tabsReachable('.response .code-toolbar'),
      'reachable',
      'response toolbar controls that do not fit are reachable with the arrows',
    );
    await run(
      "document.querySelector('.response .code-toolbar').closest('.ui-tabs-frame').style.width=''",
    );
    await run('render()');
    assert.equal(
      await run('JSON.stringify(JSON.parse(responseSourceEditor.getValue()))'),
      '[1,2]',
      'response filter survives re-rendering',
    );
    await run(
      "(()=>{const input=document.querySelector('#response-filter');input.value='$.items[';input.dispatchEvent(new Event('input'));})()",
    );
    await pause(300);
    assert.equal(
      await run(
        "!document.querySelector('#response-filter-status').hidden&&document.querySelector('.response-filter').classList.contains('has-error')",
      ),
      true,
      'invalid filters show an inline error',
    );
    await run(
      "document.querySelector('#response-filter').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
    );
    assert.equal(
      await run("responseFilter===''&&JSON.parse(responseSourceEditor.getValue()).token==='T-123'"),
      true,
      'Escape clears the response filter',
    );
    const jwt =
      [
        '{"alg":"HS256","typ":"JWT"}',
        '{"sub":"user-42","iss":"https://issuer.example","exp":4102444800}',
      ]
        .map((part) => Buffer.from(part).toString('base64url'))
        .join('.') + '.signature';
    await run(`current().token=${JSON.stringify(jwt)};requestTab='Auth';render()`);
    assert.equal(
      await run(
        "(()=>{const inspector=document.querySelector('details#jwt-inspector');return Boolean(inspector)&&inspector.textContent.includes('HS256')&&inspector.textContent.includes('user-42')&&inspector.textContent.includes('Expires');})()",
      ),
      true,
      'bearer JWTs are decoded in the Auth tab',
    );
    await run("document.querySelector('details#jwt-inspector').open=true");
    await capture('request-jwt.png');
    await run("current().url='{{undefined_host}}/path';requestTab='Params';render()");
    assert.equal(
      await run(
        "document.querySelector('#composer-variables').textContent.includes('1 unresolved')",
      ),
      true,
      'composer warns about unresolved variables',
    );
    await run(
      `current().url='http://127.0.0.1:${port}/x';document.querySelector('#url').value=current().url;document.querySelector('#url').dispatchEvent(new Event('input'))`,
    );
    assert.equal(
      await run(
        "document.querySelector('#composer-variables').textContent.includes('All variables resolved')",
      ),
      true,
      'variable status updates while typing',
    );
    await run(
      `state=structuredClone(window.chainOriginal);state.requests.push(...[['login','$.token'],['profile','']].map(([name,source])=>({...structuredClone(current()),id:'chain-'+name,name:'Chain '+name,folder:'Chain UI',url:'http://127.0.0.1:${port}/'+name,method:'GET',auth:name==='profile'?'Bearer token':'None',token:'{{run_token}}',params:[],headers:[],bodyType:'none',tests:'status 200',captures:source?[{enabled:true,key:'run_token',value:source}]:[],response:null})));initializeRunner();runnerState.folder='Chain UI';runnerState.selected=null;Object.assign(runnerState.config,{mode:'collection',iterations:1,concurrency:1,warmupIterations:0,delayMs:0});startRunner()`,
    );
    assert.equal(
      await run(
        "JSON.parse(state.requests.find(request=>request.id==='chain-profile').response.body).auth",
      ),
      'Bearer T-123',
      'collection runs chain captured variables between requests',
    );
  } finally {
    chainServer.closeAllConnections();
    await new Promise<void>((resolve) => chainServer.close(() => resolve()));
    await run(
      "state=window.chainOriginal;captureResults.clear();setResponseFilter('');requestTab='Params';responseTab='Body';responseMode='Pretty';view='Collections';render()",
    );
  }
  const cookieServer = createServer((request, response) => {
    if (request.url === '/login') {
      response.setHeader('Set-Cookie', [
        'session=abc123; Path=/; HttpOnly',
        'pref=compact; Max-Age=3600',
        'bad=1; Domain=other.example',
      ]);
      response.statusCode = 302;
      response.setHeader('Location', '/me');
      response.end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ cookie: request.headers.cookie || '' }));
  });
  await new Promise<void>((resolve) => cookieServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = cookieServer.address() as { port: number };
    await run(
      `window.cookieOriginal=structuredClone(state);view='Collections';current().url='http://127.0.0.1:${port}/login';current().method='GET';current().auth='None';current().bodyType='none';current().params=[];current().headers=[];current().captures=[];current().httpSettings={followRedirects:true};execute(current())`,
    );
    assert.equal(
      await run('JSON.parse(current().response.body).cookie'),
      'session=abc123; pref=compact',
      'redirect hop receives cookies set during the redirect',
    );
    assert.equal(
      await run("cookieJar().map(cookie=>cookie.name).sort().join(',')"),
      'pref,session',
      'valid cookies are stored and invalid domains rejected',
    );
    await run(`current().url='http://127.0.0.1:${port}/me';execute(current())`);
    assert.equal(
      await run('JSON.parse(current().response.body).cookie'),
      'session=abc123; pref=compact',
      'later requests send stored cookies',
    );
    await run("requestTab='Headers';automaticHeaderVisibility.expanded=true;render()");
    assert.equal(
      await run(
        "[...document.querySelectorAll('.automatic-header-row')].some(row=>row.textContent.includes('Cookie')&&row.textContent.includes('2 from the cookie jar'))",
      ),
      true,
      'automatic headers show jar cookies',
    );
    await run(`current().url='http://127.0.0.1:${port}/login';execute(current())`);
    await run("responseTab='Cookies';responseMode='Pretty';render()");
    assert.equal(
      await run(
        "document.querySelectorAll('.cookie-response-table tbody tr').length===3&&document.querySelector('.cookie-response-table').textContent.includes('Rejected')",
      ),
      true,
      'response cookies tab lists accepted and rejected cookies',
    );
    await capture('response-cookies.png');
    await run(
      "automaticHeaderVisibility.expanded=false;requestTab='Params';responseTab='Body';view='Cookies';render()",
    );
    assert.equal(
      await run(
        "document.querySelectorAll('.cookie-domain').length===1&&document.querySelectorAll('.cookie-table tbody tr').length===2",
      ),
      true,
      'cookie page groups cookies by domain',
    );
    await run("document.querySelector('[data-cookie-add]').click()");
    await run(
      "(()=>{const form=document.querySelector('#cookie-add-form');form.querySelector('[name=domain]').value='api.example.com';form.querySelector('[name=name]').value='manual';form.querySelector('[name=value]').value='42';form.requestSubmit();})()",
    );
    assert.equal(
      await run(
        "cookieJar().some(cookie=>cookie.domain==='api.example.com'&&cookie.name==='manual'&&cookie.value==='42')",
      ),
      true,
      'cookies can be added manually',
    );
    assert.equal(
      await run(
        "(()=>{const rows=[...document.querySelectorAll('.cookie-table tbody tr')];return rows.length>0&&rows.every(row=>row.querySelector('.cookie-name .mdi-icon')&&row.querySelector('.cookie-expiry .mdi-icon')&&[...row.querySelectorAll('.cookie-flags .badge')].every(badge=>badge.querySelector('.mdi-icon')));})()",
      ),
      true,
      'cookie rows show icons for their name, expiry, and flags',
    );
    await capture('cookies.png');
    await run(
      "(()=>{const input=document.querySelector('#cookie-filter');input.value='manual';input.dispatchEvent(new Event('input'));})()",
    );
    assert.equal(
      await run("document.querySelectorAll('.cookie-table tbody tr').length"),
      1,
      'cookie filter narrows the jar',
    );
    // With several domains, a domain filter row appears; squeezed, it scrolls with arrows.
    await run(
      "window.cookieFilterBefore=cookieUI.filter;cookieUI.filter='';window.jarBefore=structuredClone(cookieJar());cookieJar().push(...['auth.example.com','billing.example.com','catalog.example.com','delivery.example.com'].map(domain=>({...structuredClone(cookieJar()[0]),domain,name:'sid'})));render()",
    );
    await pause(50);
    assert.equal(
      await run(
        "(()=>{const chips=[...document.querySelectorAll('[data-cookie-domain-filter]')].map(chip=>chip.dataset.cookieDomainFilter);return chips[0]===''&&['api.example.com','auth.example.com','billing.example.com','catalog.example.com','delivery.example.com'].every(domain=>chips.includes(domain))})()",
      ),
      true,
      'the cookie jar offers All and a filter chip for each domain',
    );
    await run('document.querySelector(\'[data-cookie-domain-filter="auth.example.com"]\').click()');
    await pause(30);
    assert.equal(
      await run(
        "[...document.querySelectorAll('.cookie-domain')].map(section=>section.getAttribute('aria-label')).join()",
      ),
      'Cookies for auth.example.com',
      "a domain chip shows only that domain's cookies",
    );
    await run(
      "document.querySelector('.cookie-domain-filter').closest('.ui-tabs-frame').style.width='260px'",
    );
    await pause(80);
    assert.equal(
      await tabsReachable('.cookie-domain-filter'),
      'reachable',
      'domain chips that do not fit are reachable with the arrows',
    );
    await run(
      "document.querySelector('.cookie-domain-filter').closest('.ui-tabs-frame').style.width='';cookieUI.domain='';cookieUI.filter=window.cookieFilterBefore;cookieJar().splice(0,cookieJar().length,...window.jarBefore);render()",
    );
    await pause(30);
    await run(
      "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.cookieCopied=value;}}})",
    );
    await rightClick('.cookie-table tbody tr');
    assert.equal(
      await run(
        "[...document.querySelectorAll('[data-cookie-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
      ),
      'edit,copy,header,delete,domain',
      'right-clicking a cookie lists its actions',
    );
    await run("document.querySelector('[data-cookie-menu] [data-menu-item=header]').click()");
    await pause(30);
    assert.match(
      await run('window.cookieCopied'),
      /^Cookie: manual=/,
      'Copy as Cookie header copies the name and value',
    );
    await run("cookieUI.filter='';render();document.querySelector('#cookie-jar-enabled').click()");
    assert.equal(
      await run('cookieJarEnabled()===false&&prepare(current()).cookieJar===undefined'),
      true,
      'turning the jar off stops sending cookies',
    );
    await run(
      "document.querySelector('#cookie-jar-enabled').click();document.querySelector('[data-cookie-clear-domain=\"api.example.com\"]').click()",
    );
    assert.match(
      await answerConfirm(true),
      /cookies? for api\.example\.com/,
      'clearing cookies asks first',
    );
    assert.equal(
      await run('cookieJar().length===2&&cookieJarEnabled()'),
      true,
      'clearing one domain keeps the others',
    );
    assert.equal(
      await run('backupWorkspace().cookieJar.cookies.length'),
      0,
      'exports never include cookies',
    );
    await run(
      "view='Collections';render();document.dispatchEvent(new KeyboardEvent('keydown',{key:'P',metaKey:true,shiftKey:true,bubbles:true}))",
    );
    assert.equal(
      await run("commandPalette.open&&document.activeElement.id==='command-palette-input'"),
      true,
      'Cmd+Shift+P opens the command palette',
    );
    await capture('command-palette.png');
    await run(
      "(()=>{const input=document.querySelector('#command-palette-input');input.value='environment production';input.dispatchEvent(new Event('input'));})()",
    );
    assert.equal(
      await run(
        "document.querySelector('.command-result.is-selected').textContent.includes('Switch environment to Production')",
      ),
      true,
      'palette filters commands by every token',
    );
    await run(
      "document.querySelector('#command-palette-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
    );
    assert.equal(
      await run("!commandPalette.open&&state.environments[state.environment].name==='Production'"),
      true,
      'Enter runs the selected command',
    );
    await run('openCommandPalette()');
    assert.equal(
      await run("document.querySelector('.command-group').textContent"),
      'Recent',
      'recently run commands appear first',
    );
    await run(
      "document.querySelector('#command-palette-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
    );
    assert.equal(await run('commandPalette.open'), false, 'Escape closes the palette');
    await run('openWorkspaceSearch()');
    await run(
      "(()=>{const input=document.querySelector('#global-workspace-search');input.value='>theme';input.dispatchEvent(new Event('input'));})()",
    );
    assert.equal(
      await run(
        "commandPalette.open&&!workspaceSearch.open&&commandPalette.query==='theme'&&document.querySelectorAll('.command-result').length>=1",
      ),
      true,
      'typing > in search switches to commands',
    );
    await run("closeCommandPalette();document.querySelector('[data-open-palette]').click()");
    assert.equal(await run('commandPalette.open'), true, 'status bar button opens the palette');
    await run('closeCommandPalette()');
  } finally {
    cookieServer.closeAllConnections();
    await new Promise<void>((resolve) => cookieServer.close(() => resolve()));
    await run(
      "commandPalette.open=false;recentCommands.length=0;state=window.cookieOriginal;requestTab='Params';responseTab='Body';responseMode='Pretty';view='Collections';render()",
    );
  }
  const authServer = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        url: request.url,
        authorization: request.headers.authorization || '',
        apiKey: request.headers['x-api-key'] || '',
      }),
    );
  });
  await new Promise<void>((resolve) => authServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = authServer.address() as { port: number };
    await run(
      `window.authOriginal=structuredClone(state);view='Collections';requestTab='Auth';authScope='request';current().url='http://127.0.0.1:${port}/secure';current().method='GET';current().bodyType='none';current().params=[];current().headers=[];current().captures=[];current().httpSettings={};current().auth='None';render()`,
    );
    assert.equal(
      await run(
        "[...document.querySelectorAll('#auth optgroup')].map(group=>group.label).join('|')",
      ),
      'General|Tokens and keys|Username and password|Request signing|Encrypted vault',
      'auth types are grouped',
    );
    assert.equal(
      await run("document.querySelectorAll('#auth option').length"),
      15,
      'HTTP requests offer every auth type',
    );
    await run(
      "document.querySelector('#auth').closest('.ui-select').querySelector('.ui-select-trigger').click()",
    );
    await pause(150);
    assert.equal(
      await run(
        "(()=>{const options=[...document.querySelector('#auth').closest('.ui-select').querySelectorAll('.ui-select-option')];return options.length===15&&options.every(option=>option.querySelector('.ui-select-option-icon'));})()",
      ),
      true,
      'every auth type in the select box has an icon',
    );
    await capture('auth-type-select.png');
    await run(
      "document.querySelector('#auth').closest('.ui-select').querySelector('.ui-select-menu').hidePopover()",
    );
    const fieldsFor = async (type: string) =>
      run(
        `(async()=>{const select=document.querySelector('#auth');select.value=${JSON.stringify(type)};select.dispatchEvent(new Event('input'));await new Promise(resolve=>WorkbenchShell.afterUpdate(resolve));return [...document.querySelectorAll('.auth-details [data-auth],.auth-details [data-auth-option]')].map(input=>input.dataset.auth||input.dataset.authOption).join(',');})()`,
      );
    assert.equal(
      await fieldsFor('Digest auth'),
      'username,password',
      'Digest asks for username and password',
    );
    assert.equal(
      await fieldsFor('AWS Signature'),
      'username,password,awsRegion,awsService,awsSessionToken',
      'AWS asks for keys, region, service, and session token',
    );
    assert.equal(
      await fieldsFor('OAuth 1.0'),
      'username,password,oauth1Token,oauth1TokenSecret,oauth1SignatureMethod,oauth1Realm',
      'OAuth 1.0 asks for consumer and token credentials',
    );
    assert.equal(
      await fieldsFor('NTLM'),
      'username,password,ntlmDomain,ntlmWorkstation',
      'NTLM asks for the account, domain, and workstation',
    );
    assert.equal(
      await fieldsFor('WSSE'),
      'username,password',
      'WSSE asks for username and password',
    );
    assert.equal(
      await fieldsFor('Akamai EdgeGrid'),
      'username,password,token,edgegridHeadersToSign,edgegridMaxBody',
      'EdgeGrid asks for client and access tokens and what to sign',
    );
    assert.equal(
      await fieldsFor('Hawk'),
      'username,password,hawkAlgorithm,hawkExt,hawkApp,hawkDlg,hawkPayloadHash',
      'Hawk asks for credentials, algorithm, and optional fields',
    );
    assert.equal(
      await fieldsFor('JWT bearer'),
      'jwtAlgorithm,jwtPrefix,jwtExpiresIn,password,jwtSecretBase64,jwtPayload,jwtHeader',
      'JWT asks for algorithm, secret, and payload',
    );
    await run(
      "(()=>{const select=document.querySelector('[data-auth-option=jwtAlgorithm]');select.value='RS256';select.dispatchEvent(new Event('change'));})()",
    );
    assert.equal(
      await run(
        "document.querySelector('textarea[data-auth=password]')!==null&&!document.querySelector('[data-auth-option=jwtSecretBase64]')",
      ),
      true,
      'asymmetric JWT algorithms take a PEM private key',
    );
    await run(
      "(()=>{const select=document.querySelector('[data-auth-option=jwtAlgorithm]');select.value='HS256';select.dispatchEvent(new Event('change'));const secret=document.querySelector('[data-auth=password]');secret.value='{{jwt_secret}}';secret.dispatchEvent(new Event('input'));})()",
    );
    await capture('auth-jwt.png');
    await run(
      "state.environments[state.environment].variables.push({enabled:true,key:'jwt_secret',value:'s3cret'});execute(current())",
    );
    assert.match(
      await run('JSON.parse(current().response.body).authorization'),
      /^Bearer eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/,
      'JWT bearer tokens are generated with resolved variables',
    );
    await fieldsFor('AWS Signature');
    await run(
      "Object.assign(current(),{username:'AKIDEXAMPLE',password:'secret'});current().authOptions={...current().authOptions,awsRegion:'us-east-1',awsService:'execute-api'};render();execute(current())",
    );
    assert.match(
      await run('JSON.parse(current().response.body).authorization'),
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/execute-api\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/,
      'AWS requests are signed when sent',
    );
    await capture('auth-aws.png');
    await fieldsFor('Hawk');
    await run(
      "Object.assign(current(),{username:'hawk-id',password:'hawk-key'});render();execute(current())",
    );
    assert.match(
      await run('JSON.parse(current().response.body).authorization'),
      /^Hawk id="hawk-id", ts="\d+", nonce="[^"]+", mac="[^"]+"$/,
      'Hawk requests are signed when sent',
    );
    await fieldsFor('Akamai EdgeGrid');
    await run(
      "Object.assign(current(),{username:'akab-client',password:'secret',token:'akab-access'});render();execute(current())",
    );
    assert.match(
      await run('JSON.parse(current().response.body).authorization'),
      /^EG1-HMAC-SHA256 client_token=akab-client;access_token=akab-access;timestamp=\d{8}T[\d:]{8}\+0000;nonce=[\w-]+;signature=\S+$/,
      'EdgeGrid requests are signed when sent',
    );
    await fieldsFor('API key');
    await run(
      "Object.assign(current(),{username:'api_key',token:'K-1'});current().authOptions={...current().authOptions,apiKeyIn:'query'};execute(current())",
    );
    assert.equal(
      await run('JSON.parse(current().response.body).url'),
      '/secure?api_key=K-1',
      'API keys can be sent as query parameters',
    );
    await fieldsFor('Inherit from collection');
    assert.equal(
      await run("document.querySelector('.auth-inherit').textContent.includes('uses None')"),
      true,
      'inherit explains the empty collection default',
    );
    await run("document.querySelector('.auth-inherit [data-auth-scope=collection]').click()");
    assert.equal(
      await run(
        "authScope==='collection'&&![...document.querySelectorAll('#auth option')].some(option=>option.value==='Inherit from collection')&&document.querySelector('.auth-note').textContent.includes('1 request inherits')",
      ),
      true,
      'collection auth cannot inherit and shows how many requests use it',
    );
    await run(
      "(()=>{const select=document.querySelector('#auth');select.value='Bearer token';select.dispatchEvent(new Event('input'));})()",
    );
    await run(
      "(()=>{const token=document.querySelector('[data-auth=token]');token.value='COLLECTION-TOKEN';token.dispatchEvent(new Event('input'));})()",
    );
    assert.equal(
      await run(
        "current().auth==='Inherit from collection'&&current().token!=='COLLECTION-TOKEN'&&state.collectionAuth[current().folder].token==='COLLECTION-TOKEN'",
      ),
      true,
      'collection scope edits the collection, not the request',
    );
    await capture('auth-collection.png');
    // Squeezed, the authentication levels scroll with arrows.
    await run(
      "document.querySelector('.auth-scope').closest('.ui-tabs-frame').style.width='110px'",
    );
    await pause(80);
    assert.equal(
      await tabsReachable('.auth-scope'),
      'reachable',
      'authentication levels that do not fit are reachable with the arrows',
    );
    await run("document.querySelector('.auth-scope').closest('.ui-tabs-frame').style.width=''");
    await run("document.querySelector('[data-auth-scope=request]').click();execute(current())");
    assert.equal(
      await run('JSON.parse(current().response.body).authorization'),
      'Bearer COLLECTION-TOKEN',
      'inheriting requests send collection auth',
    );
    assert.equal(
      await run(
        "document.querySelector('.auth-inherit').textContent.includes('uses Bearer token')",
      ),
      true,
      'inherit summarizes the collection auth',
    );
    assert.equal(
      await run('backupWorkspace().collectionAuth[current().folder].token'),
      '',
      'exports exclude collection auth secrets',
    );
  } finally {
    authServer.closeAllConnections();
    await new Promise<void>((resolve) => authServer.close(() => resolve()));
    await run(
      "state=window.authOriginal;authScope='request';requestTab='Params';responseTab='Body';view='Collections';render()",
    );
  }
}

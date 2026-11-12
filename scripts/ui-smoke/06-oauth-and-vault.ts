import { safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { type SmokeContext, keychain, pause, providerTestKey, temporary } from './harness';

/** UI smoke checks, part 6: oauth and vault. */
export default async function oauthAndVault(context: SmokeContext) {
  const { run, capture, tabsReachable, rightClick } = context;
  // An OAuth credential being edited, for discovery to fill in.
  await run(
    "if(!document.querySelector('[name=clientId]')){credentialDraft={name:'Production identity',kind:'oauth2',allowedOrigin:'https://api.example.com',oauth:defaultOAuth()};render()}",
  );
  await pause(100);
  // OAuth discovery: an API's protected resource metadata names its authorization server.
  const metadata = createServer((request, response) => {
    const base = `http://127.0.0.1:${(metadata.address() as { port: number }).port}`;
    const documents: Record<string, unknown> = {
      '/.well-known/oauth-protected-resource/mcp': {
        resource: `${base}/mcp`,
        resource_name: 'Docs MCP',
        authorization_servers: [`${base}/auth`],
        scopes_supported: ['docs:read'],
      },
      '/.well-known/oauth-authorization-server/auth': {
        issuer: `${base}/auth`,
        authorization_endpoint: `${base}/auth/authorize`,
        token_endpoint: `${base}/auth/token`,
        registration_endpoint: `${base}/auth/register`,
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
      },
    };
    response.statusCode = documents[request.url!] ? 200 : 404;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(documents[request.url!] ?? {}));
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => metadata.once('listening', resolve));
  const metadataBase = `http://127.0.0.1:${(metadata.address() as { port: number }).port}`;
  const discover = async (url: string, expect = '[data-oauth-discover-result]') => {
    await run(
      `(()=>{const input=document.querySelector('[data-oauth-discover-url]');input.value=${JSON.stringify(url)};input.dispatchEvent(new Event('input'));document.querySelector('[data-oauth-discover]').click();})()`,
    );
    await pause(50);
    for (
      let attempt = 0;
      attempt < 50 &&
      !(await run(
        `Boolean(document.querySelector('${expect}'))&&!document.querySelector('[data-oauth-discover]').disabled`,
      ));
      attempt++
    )
      await pause(100);
  };
  await run(
    "document.querySelector('[name=clientId]').value='docs-client';document.querySelector('[name=clientSecret]').value='typed-secret'",
  );
  await discover(`${metadataBase}/mcp`);
  assert.equal(
    await run(
      `(()=>{const field=name=>document.querySelector('[name='+name+']').value;return field('authorizationUrl')==='${metadataBase}/auth/authorize'&&field('tokenUrl')==='${metadataBase}/auth/token'&&field('resource')==='${metadataBase}/mcp'&&field('scope')==='docs:read'&&field('clientId')==='docs-client'&&field('clientSecret')==='typed-secret';})()`,
    ),
    true,
    'discovery fills the credential form and keeps what was typed',
  );
  assert.match(
    await run("document.querySelector('[data-oauth-discover-result]').textContent"),
    /Filled Authorization URL, Token URL, Resource, Scopes.*Docs MCP.*dynamic client registration/s,
    'the credential form reports what discovery filled',
  );
  await discover(`${metadataBase}/nothing-here`, '[data-oauth-discover-error]');
  assert.match(
    await run("document.querySelector('[data-oauth-discover-error]').textContent"),
    /No OAuth metadata was found/,
    'a failed discovery explains what it tried',
  );
  await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
  assert.equal(await run('credentialDraft'), null);
  await run(
    `window.discoveryOriginal=structuredClone(current());Object.assign(current(),{url:'${metadataBase}/mcp/tools',protocol:undefined,auth:'OAuth 2.0 (request)',authOptions:{oauth2ClientId:'inline-client'}});view='Collections';requestTab='Auth';render()`,
  );
  assert.equal(
    await run("document.querySelector('[data-oauth-discover-url]').value"),
    metadataBase,
    'the request form suggests the request origin',
  );
  await discover(`${metadataBase}/mcp`);
  assert.equal(
    await run(
      `(()=>{const options=current().authOptions;return options.oauth2TokenUrl==='${metadataBase}/auth/token'&&options.oauth2AuthorizationUrl==='${metadataBase}/auth/authorize'&&options.oauth2Resource==='${metadataBase}/mcp'&&options.oauth2Scope==='docs:read'&&options.oauth2ClientId==='inline-client'&&document.querySelector('[data-auth-option=oauth2Resource]').value==='${metadataBase}/mcp';})()`,
    ),
    true,
    'discovery fills request-level OAuth 2.0',
  );
  await capture('oauth-discovery.png');
  await run("Object.assign(current(),window.discoveryOriginal);requestTab='Params';render()");
  metadata.close();
  // The system's credential store, stood in for with a test key; without one, the API Workbench
  // vault is used instead (part 19).
  const originalSecretStorage = {
    available: safeStorage.isAsyncEncryptionAvailable,
    encrypt: safeStorage.encryptStringAsync,
    decrypt: safeStorage.decryptStringAsync,
  };
  safeStorage.isAsyncEncryptionAvailable = async () => {
    keychain.checks++;
    return true;
  };
  safeStorage.encryptStringAsync = async (value) => {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', providerTestKey, iv);
    return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
  };
  safeStorage.decryptStringAsync = async (value) => {
    const decipher = createDecipheriv('aes-256-gcm', providerTestKey, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(-16));
    return {
      result: Buffer.concat([
        decipher.update(value.subarray(12, -16)),
        decipher.final(),
      ]).toString(),
      shouldReEncrypt: false,
    };
  };
  // A request that needs the locked vault offers to unlock it where the error appears.
  await run(
    "window.vaultNoticeOriginal=structuredClone(current());Object.assign(current(),{url:'https://api.example.com/vault',method:'GET',auth:'Saved credential',credentialId:'missing-credential',bodyType:'none',params:[],headers:[]});view='Collections';responseTab='Body';render();action('send')",
  );
  assert.equal(
    await run('vaultIssue(current().response.error)'),
    'locked',
    'requests that need the vault report it as locked',
  );
  assert.equal(
    await run("document.querySelector('.error-empty [data-vault-unlock]')?.textContent.trim()"),
    'Unlock vault and resend',
    'the response error offers to unlock and resend',
  );
  assert.equal(
    await run("Boolean(document.querySelector('.error-empty [data-vault-open]'))"),
    true,
    'the response error links to Credentials',
  );
  // Encryption is available now: unlocking from a fresh error opens the vault and resends.
  await run("view='Collections';render();action('send')");
  for (
    let attempt = 0;
    attempt < 30 &&
    !(await run("Boolean(document.querySelector('.error-empty [data-vault-unlock]'))"));
    attempt++
  )
    await pause(100);
  await run("document.querySelector('[data-vault-unlock]').click()");
  for (
    let attempt = 0;
    attempt < 30 && (await run("vaultIssue(current().response?.error)==='locked'"));
    attempt++
  )
    await pause(100);
  assert.match(
    await run('current().response.error'),
    /no longer exists/,
    'after unlocking, the request is resent and reaches the vault',
  );
  assert.equal(
    await run("credentialsLoaded&&!document.querySelector('.vault-unlock')"),
    true,
    'the unlock notice goes once the vault is open',
  );
  await run("Object.assign(current(),window.vaultNoticeOriginal);view='Credentials';render()");
  let providerLookups = 0,
    providerMode = 'ok';
  const providerServer = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/secret/data/api') {
      providerLookups++;
      if (providerMode === 'slow') {
        setTimeout(
          () => response.end(JSON.stringify({ data: { data: { token: 'REMOTE-TOKEN' } } })),
          500,
        );
        return;
      }
      if (providerMode === 'denied') {
        response.statusCode = 403;
        response.end('{"error":"PRIVATE-PROVIDER-BODY"}');
        return;
      }
      response.end(
        JSON.stringify({
          data: { data: { token: 'REMOTE-TOKEN', oauth: 'REMOTE-CLIENT-SECRET' } },
        }),
      );
      return;
    }
    if (request.url === '/protected') {
      response.statusCode = request.headers.authorization === 'Bearer REMOTE-TOKEN' ? 200 : 401;
      response.end('{"ok":true}');
      return;
    }
    if (request.url === '/token') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const expected = 'Basic ' + Buffer.from('client:REMOTE-CLIENT-SECRET').toString('base64');
        response.statusCode = request.headers.authorization === expected ? 200 : 401;
        response.end(
          JSON.stringify({
            access_token: 'ISSUED-ACCESS-TOKEN',
            token_type: 'bearer',
            expires_in: 3600,
          }),
        );
      });
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = providerServer.address() as { port: number };
    await run('openCredentialsPage()');
    await run('openCredential()');
    await run(
      "document.querySelector('[name=name]').value='Cloud UI profile';document.querySelector('#credential-source').value='aws-secrets-manager';document.querySelector('#credential-source').dispatchEvent(new Event('change'))",
    );
    assert.equal(
      await run("document.querySelectorAll('#credential-source option').length"),
      7,
      'credential sources include local and six remote providers',
    );
    await run(
      "document.querySelector('[name=\"provider:auth\"]').value='keys';document.querySelector('[name=\"provider:auth\"]').dispatchEvent(new Event('change'))",
    );
    assert.equal(
      await run('document.querySelector(\'[name="provider:secretAccessKey"]\').type'),
      'password',
      'AWS authentication fields mask secrets',
    );
    for (const source of [
      'azure-key-vault',
      'sap-btp',
      'gcp-secret-manager',
      'aws-ssm',
      'hashicorp-vault',
    ]) {
      await run(
        `document.querySelector('#credential-source').value=${JSON.stringify(source)};document.querySelector('#credential-source').dispatchEvent(new Event('change'))`,
      );
      assert.equal(
        await run(
          "Boolean(document.querySelector('.provider-configuration'))&&!document.querySelector('[name=secret]')",
        ),
        true,
        'remote source replaces inline secret field',
      );
    }
    await run(
      `document.querySelector('[name=allowedOrigin]').value='http://127.0.0.1:${port}';document.querySelector('[name="provider:vaultUrl"]').value='http://127.0.0.1:${port}';document.querySelector('[name="provider:path"]').value='api';document.querySelector('[name="provider:token"]').value='PROVIDER-AUTH-TOKEN';document.querySelector('[name=secretField]').value='/token';window.waitCredentialSave=async()=>{const end=Date.now()+5000;while(credentialDraft&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));if(credentialDraft)throw new Error(document.querySelector('#credential-error').textContent||'Credential save timed out');};document.querySelector('#credential-form').requestSubmit();window.waitCredentialSave()`,
    );
    assert.equal(await run('credentials.length'), 1, 'external profile saves through Electron');
    assert.equal(
      await run(
        "JSON.stringify(credentials).includes('PROVIDER-AUTH-TOKEN')||JSON.stringify(credentials).includes('REMOTE-TOKEN')",
      ),
      false,
      'provider authentication and values stay out of summaries',
    );
    assert.equal(
      fs
        .readFileSync(path.join(temporary, 'credentials.enc'))
        .includes(Buffer.from('PROVIDER-AUTH-TOKEN')),
      false,
      'provider auth is encrypted on disk',
    );
    await run(
      "document.querySelector('[data-test-provider]').click();(async()=>{while(providerCheckPending)await new Promise(resolve=>setTimeout(resolve,10));})()",
    );
    assert.equal(
      await run('Boolean(providerChecks.get(credentials[0].id).checkedAt)'),
      true,
      'Test access performs the saved lookup',
    );
    const remoteResponse = await run(
      `window.workbench.send({id:'external-ui-request',url:'http://127.0.0.1:${port}/protected',method:'GET',headers:{},body:'',credentialId:credentials[0].id})`,
    );
    assert.equal(
      remoteResponse.status,
      200,
      'saved credential injects remote value into HTTP request',
    );
    providerMode = 'slow';
    await run(
      `window.externalPending=window.workbench.send({id:'external-cancel',url:'http://127.0.0.1:${port}/protected',method:'GET',headers:{},body:'',credentialId:credentials[0].id});void 0`,
    );
    await pause(30);
    await run("window.workbench.cancel('external-cancel')");
    assert.match(
      (await run('window.externalPending')).error,
      /cancelled/,
      'request cancellation interrupts provider lookup',
    );
    providerMode = 'ok';
    const beforeBlocked = providerLookups;
    const blockedRemote = await run(
      "window.workbench.send({id:'external-origin-block',url:'https://other.example.com',method:'GET',headers:{},body:'',credentialId:credentials[0].id})",
    );
    assert.match(blockedRemote.error, /restricted/);
    assert.equal(
      providerLookups,
      beforeBlocked,
      'origin mismatch is rejected before contacting provider',
    );
    // Editing goes through the credential's context menu, which lists the row's actions.
    await rightClick('[data-credential-row]');
    assert.equal(
      await run(
        "[...document.querySelectorAll('[data-credential-menu] [data-menu-item]')].map(item=>item.dataset.menuItem).join()",
      ),
      'edit,test,origin,delete',
      'right-clicking an external credential lists its actions',
    );
    await run("document.querySelector('[data-credential-menu] [data-menu-item=edit]').click()");
    assert.equal(
      await run(
        "document.querySelector('[name=\"provider:token\"]').value===''&&!document.querySelector('[name=\"provider:token\"]').required",
      ),
      true,
      'editing retains provider auth without revealing it',
    );
    await run(
      "document.querySelector('#credential-form').requestSubmit();window.waitCredentialSave()",
    );
    providerMode = 'denied';
    await run(
      "document.querySelector('[data-test-provider]').click();(async()=>{while(providerCheckPending)await new Promise(resolve=>setTimeout(resolve,10));})()",
    );
    assert.equal(
      await run(
        "providerChecks.get(credentials[0].id).error.includes('HTTP 403')&&!document.body.textContent.includes('PRIVATE-PROVIDER-BODY')",
      ),
      true,
      'provider access errors are useful and redact response bodies',
    );
    providerMode = 'ok';
    await run(
      `(async()=>{window.remoteOAuth=await window.workbench.credentials.save({name:'Remote OAuth',kind:'oauth2',allowedOrigin:'http://127.0.0.1:${port}',external:{provider:'hashicorp-vault',config:{...WorkbenchSecretProviders.defaults('hashicorp-vault').config,vaultUrl:'http://127.0.0.1:${port}',path:'api'}},providerSecrets:{token:'PROVIDER-AUTH-TOKEN'},secretField:'/oauth',oauth:{...defaultOAuth(),grantType:'client_credentials',clientAuth:'basic',clientId:'client',tokenUrl:'http://127.0.0.1:${port}/token'}});return window.workbench.oauth.authorize(window.remoteOAuth.id);})()`,
    );
    assert.equal(
      await run(
        'window.workbench.credentials.list().then(entries=>entries.find(item=>item.id===window.remoteOAuth.id).connected)',
      ),
      true,
      'OAuth exchanges resolve external client secret',
    );
    await run('loadCredentials()');
    await run("view='Credentials';render()");
    await pause(100);
    assert.equal(
      await run(
        "(()=>{const rows=[...document.querySelectorAll('.credential-table tbody tr')];return rows.length>1&&rows.every(row=>row.querySelector('.credential-icon .mdi-icon')&&row.querySelector('.credential-source-label .mdi-icon'))&&[...document.querySelectorAll('[data-credential-kind]')].every(pill=>pill.querySelector('.mdi-icon'));})()",
      ),
      true,
      'credential rows show kind and source icons, and the kind filters have icons',
    );
    // Squeezed, the credential type filters scroll with arrows.
    await run(
      "document.querySelector('.filter-pills').closest('.ui-tabs-frame').style.width='280px'",
    );
    await pause(80);
    assert.equal(
      await tabsReachable('.filter-pills'),
      'reachable',
      'credential type filters that do not fit are reachable with the arrows',
    );
    await run(
      "(()=>{const row=document.querySelector('.filter-pills');row.scrollLeft=0;row.closest('.ui-tabs-frame').style.width=''})()",
    );
    await capture('credentials-list.png');
    await run(
      "document.querySelector('#credential-provider-filter').value='aws-ssm';document.querySelector('#credential-provider-filter').dispatchEvent(new Event('change'))",
    );
    assert.equal(
      await run("document.querySelectorAll('.credential-table tbody tr').length"),
      0,
      'provider filter narrows credential list',
    );
    let inlineTokens = 0;
    const authEcho = createServer((request, response) => {
      if (request.url === '/token') {
        inlineTokens++;
        let body = '';
        request.on('data', (chunk) => (body += chunk));
        request.on('end', () => {
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify({
              access_token: `inline-${inlineTokens}`,
              token_type: 'Bearer',
              expires_in: 3600,
            }),
          );
        });
        return;
      }
      if (
        request.url?.startsWith('/digest') &&
        !(request.headers.authorization || '').startsWith('Digest ')
      ) {
        response.statusCode = 401;
        response.setHeader(
          'WWW-Authenticate',
          'Digest realm="smoke", qop="auth", nonce="n1", algorithm=MD5',
        );
        response.end();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          url: request.url,
          authorization: request.headers.authorization || '',
        }),
      );
    });
    await new Promise<void>((resolve) => authEcho.listen(0, '127.0.0.1', resolve));
    try {
      const echoPort = (authEcho.address() as { port: number }).port;
      const origin = `http://127.0.0.1:${echoPort}`;
      await run(
        `window.vaultAuthOriginal=structuredClone(current());credentialDraft={name:'AWS signing',kind:'aws',allowedOrigin:${JSON.stringify(origin)}};view='Credentials';render()`,
      );
      assert.equal(
        await run(
          "['username','secret','awsRegion','awsService','extraSecret'].every(name=>document.querySelector('#credential-form [name=\"'+name+'\"]'))",
        ),
        true,
        'the vault dialog asks for AWS keys, region, service, and session token',
      );
      await capture('vault-aws.png');
      await run(
        "(()=>{const form=document.querySelector('#credential-form');const set=(name,value)=>form.querySelector('[name=\"'+name+'\"]').value=value;set('username','AKIDEXAMPLE');set('secret','vault-secret');set('awsRegion','us-east-1');set('awsService','execute-api');set('extraSecret','SESSION-TOKEN');form.requestSubmit();})();window.waitCredentialSave()",
      );
      assert.equal(
        await run(
          "credentials.some(item=>item.kind==='aws'&&item.hasExtraSecret&&item.options.awsRegion==='us-east-1')&&!JSON.stringify(credentials).includes('vault-secret')",
        ),
        true,
        'AWS vault credentials save without exposing secrets',
      );
      await run(
        `Object.assign(current(),{url:${JSON.stringify(origin + '/aws')},method:'GET',auth:'Saved credential',credentialId:credentials.find(item=>item.kind==='aws').id,bodyType:'none',params:[],headers:[],httpSettings:{}});view='Collections';execute(current())`,
      );
      assert.match(
        await run('JSON.parse(current().response.body).authorization'),
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/execute-api\/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
        'vault AWS credentials sign requests',
      );
      await run(
        `(async()=>{const digest=await window.workbench.credentials.save({name:'Digest',kind:'digest',allowedOrigin:${JSON.stringify(origin)},username:'ada',secret:'pw'});const key=await window.workbench.credentials.save({name:'Query key',kind:'api-key',allowedOrigin:${JSON.stringify(origin)},headerName:'api_key',secret:'Q-1',options:{apiKeyIn:'query'}});await loadCredentials();window.vaultDigest=digest.id;window.vaultQuery=key.id;})()`,
      );
      await run(
        `current().url=${JSON.stringify(origin + '/digest')};current().credentialId=window.vaultDigest;execute(current())`,
      );
      assert.equal(
        await run(
          'current().response.status===200&&JSON.parse(current().response.body).authorization.startsWith(\'Digest username="ada"\')',
        ),
        true,
        'vault Digest credentials answer the challenge',
      );
      await run(
        `current().url=${JSON.stringify(origin + '/key')};current().credentialId=window.vaultQuery;execute(current())`,
      );
      assert.equal(
        await run('JSON.parse(current().response.body).url'),
        '/key?api_key=Q-1',
        'vault API keys can be sent in the query string',
      );
      await run(
        `Object.assign(current(),{auth:'OAuth 2.0 (request)',credentialId:undefined,token:'',url:${JSON.stringify(origin + '/inline')},authOptions:{oauth2GrantType:'client_credentials',oauth2TokenUrl:${JSON.stringify(origin + '/token')},oauth2ClientId:'app',oauth2ClientSecret:'shh',oauth2ClientAuth:'basic'}});requestTab='Auth';authScope='request';render()`,
      );
      assert.equal(
        await run(
          "document.querySelector('[data-inline-oauth-get]')!==null&&document.querySelector('.oauth-inline-token').textContent.includes('No access token')",
        ),
        true,
        'inline OAuth 2.0 offers to get a token',
      );
      await run("document.querySelector('[data-inline-oauth-get]').click()");
      await pause(300);
      assert.equal(
        await run(
          "current().token==='inline-1'&&current().authOptions.oauth2ExpiresAt>Date.now()&&document.querySelector('.oauth-inline-token').textContent.includes('Valid until')",
        ),
        true,
        'Get new access token stores the token and its expiry',
      );
      await capture('auth-oauth2-inline.png');
      await run('execute(current())');
      assert.equal(
        await run('JSON.parse(current().response.body).authorization'),
        'Bearer inline-1',
        'inline OAuth 2.0 tokens are sent as Bearer',
      );
      await run('current().authOptions.oauth2ExpiresAt=Date.now()-1000;execute(current())');
      assert.equal(
        await run('JSON.parse(current().response.body).authorization'),
        'Bearer inline-2',
        'expired client-credentials tokens renew automatically on send',
      );
      assert.equal(
        await run(
          'backupWorkspace().requests.find(item=>item.id===current().id).authOptions.oauth2ClientSecret',
        ),
        undefined,
        'exports exclude inline OAuth client secrets',
      );
    } finally {
      authEcho.closeAllConnections();
      await new Promise<void>((resolve) => authEcho.close(() => resolve()));
      await run("Object.assign(current(),window.vaultAuthOriginal);requestTab='Params';render()");
    }
    await run(
      "(async()=>{for(const credential of credentials)await window.workbench.credentials.delete(credential.id);credentialProviderFilter='all';providerChecks.clear();await loadCredentials();})()",
    );
  } finally {
    safeStorage.isAsyncEncryptionAvailable = originalSecretStorage.available;
    safeStorage.encryptStringAsync = originalSecretStorage.encrypt;
    safeStorage.decryptStringAsync = originalSecretStorage.decrypt;
    providerServer.closeAllConnections();
    await new Promise<void>((resolve) => providerServer.close(() => resolve()));
    await run("credentialDraft=null;view='Credentials';render()");
  }
  await run("view='Collections';requestTab='Auth';current().auth='Saved credential';render()");
  assert.equal(await run("Boolean(document.querySelector('#request-credential'))"), true);
  assert.equal(
    await run(
      "![...document.querySelectorAll('#auth option')].some(option=>option.value==='OAuth 2.0')&&[...document.querySelectorAll('#auth optgroup[label=\"Encrypted vault\"] option')].map(option=>option.value).join()==='Saved credential'",
    ),
    true,
    'the vault group offers Saved credential only',
  );
  assert.equal(
    await run(
      "(()=>{const legacy=structuredClone(state);legacy.requests[0].auth='OAuth 2.0';legacy.requests[0].credentialId='profile-1';legacy.collectionAuth={Legacy:{auth:'OAuth 2.0',token:'',username:'',password:'',credentialId:'profile-2'}};const migrated=normalizeWorkspaceState(legacy);return migrated.requests[0].auth==='Saved credential'&&migrated.requests[0].credentialId==='profile-1'&&migrated.collectionAuth.Legacy.auth==='Saved credential';})()",
    ),
    true,
    'saved OAuth 2.0 selections migrate to Saved credential with the same profile',
  );
  await capture('request-authentication.png');
  assert.equal(
    await run(
      "(()=>{current().token='INLINE-SECRET';current().password='PASSWORD-SECRET';current().headers.push({key:'Authorization',value:'HEADER-SECRET',enabled:true});current().credentialId='PRIVATE-REFERENCE';state.environments[0].variables.push({key:'api_key',value:'VARIABLE-SECRET',enabled:true});const backup=JSON.stringify(backupWorkspace());return !['INLINE-SECRET','PASSWORD-SECRET','HEADER-SECRET','PRIVATE-REFERENCE','VARIABLE-SECRET'].some(secret=>backup.includes(secret));})()",
    ),
    true,
    'backup redacts recognized secrets',
  );
  assert.equal(
    await run(
      "(()=>{current().response={error:'RESPONSE-SECRET'};return persistedWorkspace().requests.find(r=>r.id===state.active).response===null;})()",
    ),
    true,
    'responses not persisted by default',
  );
  await run(
    "view='Collections';responseTab='Tests';current().response={status:200,statusText:'OK',headers:{},body:'{}',time:10,size:2,url:'https://example.com'};render()",
  );
  assert.equal(
    await run(
      "document.querySelector('.assertion-result.passed .mdi-icon')?.getAttribute('data-mdi')",
    ),
    'check-circle-outline',
  );
  await run("view='Overview';render()");
  await run('Promise.all(Array.from(document.images, image => image.decode()))');
  assert.equal(
    await run(
      "[...document.querySelectorAll('.overview-card .section-heading h2')].map(heading=>Boolean(heading.querySelector('.section-heading-icon'))).join()",
    ),
    'true,true',
    'the overview card headings have icons',
  );
  await capture('overview.png');
}

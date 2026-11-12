import { dialog, safeStorage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createHTTPSServer } from 'node:https';
import { createTLSFixture } from '@techieutils/api-workbench-electron/testing/tls-fixture';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { type SmokeContext, keychain, pause, providerTestKey } from './harness';

/** UI smoke checks, part 10: certificates and comparison. */
export default async function certificatesAndComparison(context: SmokeContext) {
  const { run, capture } = context;
  // The encryption to put back after this part's test encryption.
  const originalSecretStorage = {
    available: safeStorage.isAsyncEncryptionAvailable,
    encrypt: safeStorage.encryptStringAsync,
    decrypt: safeStorage.decryptStringAsync,
  };
  const mtlsFixture = await createTLSFixture();
  const mtlsServer = createHTTPSServer(
    {
      key: mtlsFixture.key,
      cert: mtlsFixture.cert + mtlsFixture.ca,
      ca: mtlsFixture.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          client: (request.socket as import('node:tls').TLSSocket).getPeerCertificate().subject?.CN,
        }),
      );
    },
  );
  await new Promise<void>((resolve) => mtlsServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = mtlsServer.address() as { port: number };
    await run(
      `window.mtlsOriginal=structuredClone(state);state.settings={...settings(),httpSettings:{...settings().httpSettings,caCertificates:''}};view='Settings';settingsSection='Certificates';render()`,
    );
    assert.equal(
      await run(
        "Boolean(document.querySelector('.cert-section'))&&document.querySelector('.settings-content').textContent.includes('No client certificates')&&Boolean(document.querySelector('[data-cert-manage]'))&&!document.querySelector('.settings-save')",
      ),
      true,
      'certificate settings point to Credentials and show an empty state',
    );
    // A certificate saved by file path in an older workspace moves into the vault once it is unlocked.
    const legacyPfx = path.join(os.tmpdir(), `legacy-${Date.now()}.p12`);
    fs.copyFileSync(mtlsFixture.clientPfxPath, legacyPfx);
    await run(
      `state.clientCertificates=[{id:'legacy',host:'127.0.0.1',port:${port},enabled:true,type:'pfx',pfxPath:${JSON.stringify(legacyPfx)},passphrase:'p12-secret'}];render()`,
    );
    assert.equal(
      await run(
        "document.querySelector('.cert-files').textContent.includes('moves into the vault')",
      ),
      true,
      'file-based certificates are flagged until they move',
    );
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
    await run('openCredentialsPage()');
    for (
      let attempt = 0;
      attempt < 50 && !(await run('Boolean(clientCertificates()[0]?.credentialId)'));
      attempt++
    )
      await pause(100);
    assert.equal(
      await run(
        "(()=>{const entry=clientCertificates()[0];return entry.id==='legacy'&&Boolean(entry.credentialId)&&!entry.pfxPath&&!entry.passphrase&&/CN=workbench-client/.test(entry.subject)&&credentials.some(credential=>credential.id===entry.credentialId&&credential.kind==='client-certificate');})()",
      ),
      true,
      'unlocking moves file-based certificates into the vault, keeping only a reference in the workspace',
    );
    fs.rmSync(legacyPfx);
    await run("view='Settings';settingsSection='Certificates';render()");
    assert.equal(
      await run(
        "document.querySelector('.cert-files').textContent.includes('Stored in the credential vault')",
      ),
      true,
      'settings show the certificate as stored in the vault',
    );
    await capture('settings-certificates.png');
    await run('openCredentialsPage()');
    assert.equal(
      await run(
        "Boolean(document.querySelector('[data-credential-kind=\"client-certificate\"]'))&&document.querySelector('.credential-table').textContent.includes('https://127.0.0.1:'+" +
          port +
          ')',
      ),
      true,
      'certificates are listed with credentials and their host',
    );
    await run(`setWorkspaceCA(${JSON.stringify(mtlsFixture.ca.trim())})`);
    await run(
      `view='Collections';requestTab='Settings';httpSettingsScope='request';current().url='https://127.0.0.1:${port}/mtls';current().method='GET';current().auth='None';current().bodyType='none';current().params=[];current().headers=[];current().httpSettings={};render()`,
    );
    assert.equal(
      await run("document.querySelector('.hs-summary').textContent.includes('Client cert')"),
      true,
      'request settings show the matching client certificate',
    );
    await run('execute(current())');
    assert.equal(
      await run("JSON.parse(current().response.body||'{}').client||current().response.error"),
      'workbench-client',
      'requests present the vault copy, with the original file gone',
    );
    await run("responseTab='Certificate';responseMode='Pretty';render()");
    assert.equal(
      await run(
        "document.querySelector('.certificate-inspector').textContent.includes('Mutual TLS: presented a client certificate')",
      ),
      true,
      'the certificate inspector reports the presented client certificate',
    );
    await capture('response-client-certificate.png');
    await run('openCredentialsPage()');
    await run("document.querySelector('[data-certificate-enabled]').click()");
    assert.equal(
      await run(
        "clientCertificates()[0].enabled===false&&document.querySelector('.credential-table').textContent.includes('Off')",
      ),
      true,
      'certificates can be turned off from Credentials',
    );
    // A failed send runs only the captures that read a failure, and History keeps the failure.
    await run(
      "window.capturesBeforeFailure=structuredClone(current().captures||[]);current().captures=[{enabled:true,key:'fail_reason',value:'error'},{enabled:true,key:'fail_id',value:'$.id'}];view='Collections';execute(current())",
    );
    assert.ok(
      await run('Boolean(current().response.error)'),
      'turned-off certificates are not presented',
    );
    assert.deepEqual(
      await run(
        "(()=>{const variables=state.environments[state.environment].variables;const reason=variables.find(item=>item.key==='fail_reason');const entry=state.history[0];return [reason?.value===current().response.error,variables.some(item=>item.key==='fail_id'),entry.failure?.error===current().response.error,entry.console.map(line=>line.kind).includes('failed')];})()",
      ),
      [true, false, true, true],
      'a failed send captures its error, skips response captures, and keeps the failure in History',
    );
    await run(
      "current().captures=window.capturesBeforeFailure;(environment=>{environment.variables=environment.variables.filter(item=>item.key!=='fail_reason');})(state.environments[state.environment]);render()",
    );
    // NTLM, WSSE, EdgeGrid, and Hawk profiles ask for their own fields.
    await run('openCredential();render()');
    const credentialFields = async (kind: string) =>
      run(
        `(async()=>{const select=document.querySelector('#credential-kind');select.value=${JSON.stringify(kind)};select.dispatchEvent(new Event('change'));await new Promise(resolve=>WorkbenchShell.afterUpdate(resolve));return [...document.querySelectorAll('#credential-form [name]')].map(field=>field.name).filter(name=>!['name','kind','allowedOrigin','secretSource'].includes(name)&&!name.startsWith('provider')).join(',');})()`,
      );
    assert.equal(
      await credentialFields('ntlm'),
      'username,secret,ntlmDomain,ntlmWorkstation',
      'NTLM profiles ask for the account, domain, and workstation',
    );
    assert.equal(
      await credentialFields('wsse'),
      'username,secret',
      'WSSE profiles ask for a login',
    );
    assert.equal(
      await credentialFields('edgegrid'),
      'username,secret,extraSecret,edgegridMaxBody,edgegridHeadersToSign',
      'EdgeGrid profiles ask for the tokens, client secret, and what to sign',
    );
    assert.equal(
      await credentialFields('hawk'),
      'username,secret,hawkAlgorithm,hawkExt,hawkApp,hawkDlg,hawkPayloadHash',
      'Hawk profiles ask for credentials, algorithm, and optional fields',
    );
    await capture('credential-hawk.png');
    // Adding a PEM certificate: the passphrase and pair are checked before saving.
    await run(
      "document.querySelector('#credential-kind').value='client-certificate';document.querySelector('#credential-kind').dispatchEvent(new Event('change'))",
    );
    // The system file picker answers with the fixture's files, in the order they are chosen.
    const pickedFiles: string[] = [];
    const originalOpenDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [pickedFiles.shift()!],
    })) as typeof dialog.showOpenDialog;
    const choose = async (kind: string, file: string) => {
      pickedFiles.push(file);
      await run(`document.querySelector('[data-cert-choose=${kind}]').click()`);
      await pause(150);
    };
    await run(
      `(()=>{const form=document.querySelector('#credential-form');form.elements.name.value='Partner PEM';form.elements.certificateHost.value='127.0.0.1';form.elements.certificatePort.value='${port}';})()`,
    );
    await choose('cert', mtlsFixture.clientCertPath);
    await choose('key', mtlsFixture.serverKeyPath);
    assert.equal(
      await run("document.querySelector('[data-cert-choose=cert]').textContent.trim()"),
      'client.pem',
      'chosen files are shown by name',
    );
    await capture('credential-client-certificate.png');
    await run("document.querySelector('#credential-form').requestSubmit()");
    await pause(300);
    assert.match(
      await run("document.querySelector('#credential-form .form-error')?.textContent||''"),
      /does not match/,
      'a key that does not match its certificate is caught when saving',
    );
    await choose('key', mtlsFixture.clientKeyPath);
    dialog.showOpenDialog = originalOpenDialog;
    await run("document.querySelector('#credential-form').requestSubmit()");
    for (let attempt = 0; attempt < 30 && (await run('Boolean(credentialDraft)')); attempt++)
      await pause(100);
    assert.equal(
      await run(
        "clientCertificates().length===2&&clientCertificates().every(entry=>entry.credentialId&&!entry.certPath&&!entry.keyPath)&&credentials.filter(credential=>credential.kind==='client-certificate').length===2",
      ),
      true,
      'new certificates are saved to the vault and indexed for host matching',
    );
    assert.equal(
      await run(
        "JSON.stringify(state).includes('PRIVATE KEY')||JSON.stringify(state).includes(" +
          JSON.stringify(mtlsFixture.clientKeyPath) +
          ')',
      ),
      false,
      'the workspace holds no key material or file paths',
    );
    await run('openCredentialsPage()');
    await pause(200);
    await capture('credentials-client-certificates.png');
    await run(
      '(async()=>{for(const credential of credentials)await window.workbench.credentials.delete(credential.id);await loadCredentials();})()',
    );
    assert.equal(
      await run('clientCertificates().length'),
      0,
      'deleting a vault certificate removes it from host matching',
    );
    assert.equal(
      await run(
        "(()=>{state.clientCertificates=[{id:'x',host:'api.example.com',enabled:true,type:'pfx',pfxPath:'/x.p12',passphrase:'SECRET'}];return backupWorkspace().clientCertificates[0].passphrase===undefined;})()",
      ),
      true,
      'exports exclude certificate passphrases',
    );
  } finally {
    safeStorage.isAsyncEncryptionAvailable = originalSecretStorage.available;
    safeStorage.encryptStringAsync = originalSecretStorage.encrypt;
    safeStorage.decryptStringAsync = originalSecretStorage.decrypt;
    mtlsServer.closeAllConnections();
    await new Promise<void>((resolve) => mtlsServer.close(() => resolve()));
    await mtlsFixture.dispose();
    await run(
      "state=window.mtlsOriginal;credentialDraft=null;settingsSection='General';requestTab='Params';responseTab='Body';view='Collections';render()",
    );
  }
  let compareCalls = 0;
  const compareServer = createServer((_request, response) => {
    compareCalls++;
    const users = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      name: `User ${index + 1}`,
    }));
    if (compareCalls >= 2) users[5].name = 'Renamed user';
    const body =
      compareCalls === 1
        ? { total: 12, users, version: 1 }
        : { version: compareCalls, users, total: 12 };
    response.statusCode = compareCalls === 3 ? 202 : 200;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('ETag', `"v${compareCalls}"`);
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => compareServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = compareServer.address() as { port: number };
    await run(
      `window.compareOriginal=structuredClone(current());Object.assign(current(),{protocol:'http',url:'http://127.0.0.1:${port}/users',method:'GET',auth:'None',bodyType:'none',params:[],headers:[],captures:[],httpSettings:{}});responseSnapshots.delete(current().id);compareUI.pinned.clear();compareUI.baseline.clear();compareUI.sortKeys=true;compareUI.changesOnly=true;view='Collections';execute(current())`,
    );
    await run("responseTab='Compare';responseMode='Pretty';render()");
    assert.equal(
      await run(
        "document.querySelector('.response-empty').textContent.includes('Nothing to compare yet')",
      ),
      true,
      'compare explains it needs a second response',
    );
    await run('execute(current())');
    await run('render()');
    assert.equal(
      await run("document.querySelector('[data-response-tab=Compare] .count').textContent"),
      '2',
      'the Compare tab counts recorded responses',
    );
    assert.equal(
      await run(
        "[...document.querySelectorAll('.compare-chip')].map(chip=>chip.textContent).join('|').includes('Body+2 −2 lines')",
      ),
      true,
      'the summary counts changed body lines with keys sorted',
    );
    assert.equal(
      await run("document.querySelector('.compare-row.is-change mark')?.textContent"),
      'User 6',
      'changed lines highlight the differing part',
    );
    assert.equal(
      await run(
        "document.querySelectorAll('.compare-fold').length>0&&document.querySelector('.compare-headers').textContent.includes('etag')",
      ),
      true,
      'unchanged lines fold and header changes are listed',
    );
    await run('requestPanels.request=false;render()');
    await capture('response-compare.png');
    await run('requestPanels.request=true;render()');
    await run("document.querySelector('#compare-sort-keys').click()");
    assert.equal(
      await run(
        "Number(/\\+(\\d+)/.exec([...document.querySelectorAll('.compare-chip')].find(chip=>chip.textContent.includes('Body')).textContent)[1])>2",
      ),
      true,
      'without sorting, key order differences show up',
    );
    await run(
      "document.querySelector('#compare-sort-keys').click();document.querySelector('[data-compare-pin]').click()",
    );
    assert.equal(
      await run('compareUI.pinned.get(current().id)===comparePair(current()).current.id'),
      true,
      'the current response can be pinned as baseline',
    );
    await run('execute(current())');
    await run('render()');
    assert.equal(
      await run(
        "comparePair(current()).baseline.id===compareUI.pinned.get(current().id)&&[...document.querySelectorAll('.compare-chip')][0].textContent.includes('200 → 202')",
      ),
      true,
      'later responses compare against the pinned baseline',
    );
    await run(
      "const select=document.querySelector('#compare-baseline');select.value=select.options[select.options.length-1].value;select.dispatchEvent(new Event('change'))",
    );
    assert.equal(
      await run(
        'comparePair(current()).baseline.sequence===responseSnapshots.get(current().id)[0].sequence',
      ),
      true,
      'any recorded response can be chosen as baseline',
    );
    await run("document.querySelector('[data-mode=Raw]').click()");
    assert.match(
      await run('responseSourceEditor.getValue()'),
      /^--- baseline #\d+ · 200 OK[\s\S]*\n\+\+\+ current #\d+ · 202 Accepted[\s\S]*\n-\s+"name": "User 6"/,
      'Raw shows a unified diff',
    );
  } finally {
    compareServer.closeAllConnections();
    await new Promise<void>((resolve) => compareServer.close(() => resolve()));
    await run(
      "Object.assign(current(),window.compareOriginal);responseTab='Body';responseMode='Pretty';render()",
    );
  }
  const certificateFixture = await createTLSFixture();
  const certificateServer = createHTTPSServer(
    { key: certificateFixture.key, cert: certificateFixture.cert + certificateFixture.ca },
    (_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"secure":true}');
    },
  );
  await new Promise<void>((resolve) => certificateServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = certificateServer.address() as { port: number };
    const secureResponse = await run(
      `window.workbench.send({id:'certificate-ui',url:'https://127.0.0.1:${port}/secure',method:'GET',headers:{},body:'',httpSettings:{caCertificates:${JSON.stringify(certificateFixture.ca)}}})`,
    );
    assert.equal(secureResponse.status, 200);
    assert.ok(secureResponse.tls?.authorized);
    await run(
      `window.certificateOriginal=structuredClone(current());window.certificateResponse=${JSON.stringify(secureResponse)};current().url=${JSON.stringify(secureResponse.url)};current().response=window.certificateResponse;view='Collections';responseTab='Body';responseMode='Pretty';render();document.querySelector('[data-response-tab=Certificate]').click()`,
    );
    assert.equal(
      await run("document.querySelectorAll('.certificate-card').length"),
      2,
      'certificate inspector renders the real server chain',
    );
    assert.equal(
      await run(
        "document.querySelector('.certificate-inspector').textContent.includes('Verified at connection')&&document.querySelector('.certificate-inspector').textContent.includes('localhost')&&document.querySelector('.certificate-inspector').textContent.includes('SHA-256 fingerprint')",
      ),
      true,
      'pretty certificate shows identity, verification and fingerprints',
    );
    await run(
      'window.certificateDownloads=[];window.captureDownload(()=>document.querySelector(\'[data-certificate-download="0"]\').click()).then(file=>{window.certificateDownloads.push([file.name,file.text,file.mime]);})',
    );
    assert.equal(
      await run(
        "window.certificateDownloads[0][0].endsWith('.pem')&&window.certificateDownloads[0][1].includes('BEGIN CERTIFICATE')&&!window.certificateDownloads[0][1].includes('PRIVATE KEY')",
      ),
      true,
      'PEM export contains only a public certificate',
    );
    await run("document.querySelector('[data-mode=Raw]').click()");
    assert.equal(
      await run(
        'JSON.parse(responseSourceEditor.getValue()).chain[0].fingerprint256===window.certificateResponse.tls.chain[0].fingerprint256',
      ),
      true,
      'Raw certificate uses read-only JSON editor',
    );
    await run(
      "window.captureDownload(()=>action('download')).then(file=>{window.certificateDownloads.push([file.name,file.text,file.mime]);})",
    );
    assert.equal(
      await run(
        "window.certificateDownloads[1][0]==='response-certificate.json'&&window.certificateDownloads[1][2]==='application/json'",
      ),
      true,
      'response certificate exports as JSON',
    );
    await run(
      "current().response={error:'Response interrupted',tls:window.certificateResponse.tls};responseMode='Pretty';render()",
    );
    assert.equal(
      await run("Boolean(document.querySelector('.certificate-inspector'))"),
      true,
      'captured certificates remain inspectable after a response error',
    );
    await run('current().response={...window.certificateResponse,tls:undefined};render()');
    assert.equal(
      await run(
        "document.querySelector('#response-panel').textContent.includes('Certificate unavailable')",
      ),
      true,
      'old HTTPS responses without TLS metadata explain unavailable certificate',
    );
    await run(
      "current().response={...window.certificateResponse,url:'http://example.com/plain',tls:undefined};render()",
    );
    assert.equal(
      await run("!document.querySelector('[data-response-tab=Certificate]')&&responseTab==='Body'"),
      true,
      'HTTP hides certificate tab and resets stale selection',
    );
    await run("current().response=null;current().url='https://example.com';render()");
    assert.equal(
      await run("Boolean(document.querySelector('[data-response-tab=Certificate]'))"),
      true,
      'unsent HTTPS requests offer certificate tab',
    );
  } finally {
    certificateServer.closeAllConnections();
    await new Promise<void>((resolve) => certificateServer.close(() => resolve()));
    await certificateFixture.dispose();
    await run(
      "Object.assign(current(),window.certificateOriginal);responseTab='Body';responseMode='Pretty';render()",
    );
  }
}

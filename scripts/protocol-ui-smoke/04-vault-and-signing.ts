import assert from 'node:assert/strict';
import { type ProtocolContext, proto } from './harness';

/** Protocol UI checks, part 4: vault and signing. */
export default async function vaultAndSigning(context: ProtocolContext) {
  const { run, wait, base, port, authentication, select, url, message, connect, done } = context;
  // The gRPC schema, as the gRPC part leaves it on this request.
  await run(
    `if(!current().grpc?.proto){current().grpc={proto:${JSON.stringify(proto)},method:'',tls:false};persist()}`,
  );
  await run(`(async () => {
  await window.workbench.credentials.list();
  window.liveSaved = await window.workbench.credentials.save({name:'Live bearer',kind:'bearer',allowedOrigin:${JSON.stringify(base)},secret:'TEST-SAVED'});
  window.grpcSaved = await window.workbench.credentials.save({name:'gRPC bearer',kind:'bearer',allowedOrigin:'http://127.0.0.1:${port}',secret:'TEST-GRPC'});
  window.liveOAuth = await window.workbench.credentials.save({name:'Live OAuth',kind:'oauth2',allowedOrigin:${JSON.stringify(base)},oauth:{...defaultOAuth(),grantType:'client_credentials',clientId:'test',clientSecret:'test-secret',clientAuth:'basic',tokenUrl:${JSON.stringify(base + '/token')}}});
  await window.workbench.oauth.authorize(window.liveOAuth.id);
  credentials = await window.workbench.credentials.list(); credentialsLoaded=true;
})()`);
  for (const protocol of ['websocket', 'sse', 'ndjson', 'grpc']) {
    await select(protocol);
    await url(
      protocol === 'grpc'
        ? `127.0.0.1:${port}`
        : protocol === 'websocket'
          ? base.replace('http:', 'ws:')
          : protocol === 'ndjson'
            ? `${base}/ndjson`
            : base,
    );
    if (protocol === 'grpc')
      await run(
        "document.querySelector('#grpc-method').value='/ui.Echo/Unary';document.querySelector('#grpc-method').dispatchEvent(new Event('input'))",
      );
    await run("document.querySelector('[data-protocol-tab=Auth]').click()");
    await run(
      "document.querySelector('#auth').value='Saved credential';document.querySelector('#auth').dispatchEvent(new Event('input'))",
    );
    await run(
      `document.querySelector('#request-credential').value=${protocol === 'grpc' ? 'window.grpcSaved.id' : 'window.liveSaved.id'};document.querySelector('#request-credential').dispatchEvent(new Event('change'))`,
    );
    await connect();
    if (protocol === 'websocket') {
      await wait("liveProtocols.get(current().id)?.phase==='open'");
      await connect();
    }
    await done();
    assert.equal(
      authentication.filter((entry) => entry.protocol === protocol).at(-1)?.authorization,
      protocol === 'grpc' ? 'Bearer TEST-GRPC' : 'Bearer TEST-SAVED',
      `${protocol} sends saved credentials`,
    );
    assert.equal(
      await run(
        "JSON.stringify(liveProtocols.get(current().id).events).includes('TEST-SAVED') || JSON.stringify(liveProtocols.get(current().id).events).includes('TEST-GRPC')",
      ),
      false,
      'resolved credentials stay out of the transcript',
    );
  }
  await select('sse');
  await url(base);
  await run("document.querySelector('[data-protocol-tab=Auth]').click()");
  await run(
    "document.querySelector('#auth').value='Saved credential';document.querySelector('#auth').dispatchEvent(new Event('input'))",
  );
  await run(
    "document.querySelector('#request-credential').value=window.liveOAuth.id;document.querySelector('#request-credential').dispatchEvent(new Event('change'))",
  );
  await connect();
  await done();
  assert.equal(
    authentication.filter((entry) => entry.protocol === 'sse').at(-1)?.authorization,
    'Bearer TEST-OAUTH',
    'connected OAuth profile authenticates the stream',
  );
  await run(`(async()=>{
  window.liveAws = await window.workbench.credentials.save({name:'Live AWS',kind:'aws',allowedOrigin:${JSON.stringify(base)},username:'AKIDLIVE',secret:'LIVE-AWS-SECRET',options:{awsRegion:'us-east-1',awsService:'execute-api'}});
  window.grpcAws = await window.workbench.credentials.save({name:'gRPC AWS',kind:'aws',allowedOrigin:'http://127.0.0.1:${port}',username:'AKIDLIVE',secret:'LIVE-AWS-SECRET',options:{awsRegion:'us-east-1',awsService:'appmesh'}});
  credentials = await window.workbench.credentials.list();
})()`);
  for (const protocol of ['websocket', 'sse', 'grpc']) {
    await select(protocol);
    await url(
      protocol === 'grpc'
        ? `127.0.0.1:${port}`
        : protocol === 'websocket'
          ? base.replace('http:', 'ws:')
          : base,
    );
    if (protocol === 'grpc')
      await run(
        "document.querySelector('#grpc-method').value='/ui.Echo/Unary';document.querySelector('#grpc-method').dispatchEvent(new Event('input'))",
      );
    await run("document.querySelector('[data-protocol-tab=Auth]').click()");
    await run(
      "document.querySelector('#auth').value='Saved credential';document.querySelector('#auth').dispatchEvent(new Event('input'))",
    );
    await run(
      `document.querySelector('#request-credential').value=${protocol === 'grpc' ? 'window.grpcAws.id' : 'window.liveAws.id'};document.querySelector('#request-credential').dispatchEvent(new Event('change'))`,
    );
    await connect();
    if (protocol === 'websocket') {
      await wait("liveProtocols.get(current().id)?.phase==='open'");
      await connect();
    }
    await done();
    assert.match(
      authentication.filter((entry) => entry.protocol === protocol).at(-1)?.authorization || '',
      /^AWS4-HMAC-SHA256 Credential=AKIDLIVE\/\d{8}\/us-east-1\/(execute-api|appmesh)\/aws4_request, SignedHeaders=host;/,
      `${protocol} connections are signed with vault AWS credentials`,
    );
    assert.equal(
      await run(
        "JSON.stringify(liveProtocols.get(current().id).events).includes('LIVE-AWS-SECRET')",
      ),
      false,
      'signing secrets stay out of the transcript',
    );
    assert.equal(
      await run(
        "liveProtocols.get(current().id).events.some(event=>event.type==='status'&&event.data.startsWith('Authentication: AWS Signature'))",
      ),
      true,
      `${protocol} timeline names the signing method`,
    );
  }
  await select('sse');
  await url(base);
  await run(
    "document.querySelector('[data-protocol-tab=Auth]').click();current().auth='JWT bearer';current().password='ui-jwt-secret';current().authOptions={jwtAlgorithm:'HS256',jwtPayload:'{\"sub\":\"protocol-ui\"}'};render()",
  );
  await connect();
  await done();
  assert.match(
    authentication.filter((entry) => entry.protocol === 'sse').at(-1)?.authorization || '',
    /^Bearer eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/,
    'inline JWT bearer signs live streams',
  );
  await select('grpc');
  await run("document.querySelector('[data-protocol-tab=Auth]').click()");
  await run(
    "document.querySelector('#auth').value='None';document.querySelector('#auth').dispatchEvent(new Event('input'))",
  );
  assert.equal(
    await run('liveProtocols.get(current().id)?.events.length || 0'),
    0,
    'changing protocols clears the previous protocol response',
  );
  await url(`127.0.0.1:${port}`);
  await run("document.querySelector('[data-protocol-tab=Message]').click()");
  await message('{"text":"final response"}');
  await connect();
  await done();
  assert.equal(
    await run('JSON.parse(protocolResponseEditor.getValue()).text'),
    'final response',
    'gRPC renders its decoded body in the common response editor',
  );
}

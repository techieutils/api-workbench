import fs from 'node:fs';
import assert from 'node:assert/strict';
import { type ProtocolContext, pause } from './harness';

/** Protocol UI checks, part 1: layout and websocket. */
export default async function layoutAndWebsocket(context: ProtocolContext) {
  const { window, run, wait, base, select, url, message, connect, rightClick, chooseType } =
    context;
  assert.equal(await run("document.querySelectorAll('#request-protocol option').length"), 15);
  // Every request type shares the HTTP layout: the URL starts at the same place, after a
  // method-style box with an icon; tabs have icons; and variables report whether they resolve.
  await wait("Boolean(document.querySelector('#url'))");
  const urlLeft = () =>
    run(
      "Math.round(document.querySelector('#url').getBoundingClientRect().left)",
    ) as Promise<number>;
  const httpLeft = await urlLeft();
  for (const protocol of ['websocket', 'sse', 'ndjson', 'grpc', 'socketio', 'mqtt']) {
    await chooseType(protocol);
    await wait(
      `current().protocol===${JSON.stringify(protocol)}&&Boolean(document.querySelector('[data-protocol-connect]'))`,
    );
    assert.ok(Math.abs((await urlLeft()) - httpLeft) <= 1, `${protocol} URL lines up with HTTP's`);
    assert.equal(
      await run(
        "Boolean(document.querySelector('.request-type-select .ui-select-value-icon'))&&[...document.querySelectorAll('[data-protocol-tab]')].every(tab=>tab.querySelector('.mdi-icon'))&&Boolean(document.querySelector('.protocol-composer #composer-variables'))",
      ),
      true,
      `${protocol} uses the HTTP tab icons, protocol box, and variable status`,
    );
  }
  await chooseType('http');
  await wait("current().protocol==='http'");
  await select('websocket');
  assert.equal(
    await run(
      "document.querySelector('#request-protocol').value===document.querySelector('[data-request-type]').dataset.requestType&&document.querySelector('#request-protocol').value",
    ),
    'websocket',
    'the type select shows the chosen type',
  );
  assert.equal(
    await run("Boolean(document.querySelector('#protocol-message-editor .cm-editor'))"),
    true,
    'live messages use the shared source editor',
  );
  await run("document.querySelector('[data-protocol-tab=Headers]').click()");
  assert.equal(
    await run("Boolean(document.querySelector('.kv-table'))"),
    true,
    'headers use the shared table',
  );
  await run("document.querySelector('[data-protocol-tab=Message]').click()");
  // Code generation for live connections: each protocol lists its own languages.
  await url(base.replace('http:', 'ws:') + '/codegen');
  await message('{"subscribe":"orders"}');
  await run("document.querySelector('[data-action=code]').click()");
  await wait('codeDialog?.result?.code');
  assert.equal(
    await run('codeDialog.targets.map(target=>target.id).sort().join()'),
    'go,javascript,node,python,shell',
    'WebSocket code offers its own languages',
  );
  assert.match(
    (await run('codeDialog.result.code')) as string,
    /\| websocat [\s\S]*\/codegen'/,
    'WebSocket code pipes the message to websocat at the request URL',
  );
  await run(
    "(()=>{const select=document.querySelector('#code-language');select.value='node';select.dispatchEvent(new Event('change'));})()",
  );
  await wait('codeDialog?.result?.code?.includes("import WebSocket from \'ws\'")');
  assert.match(
    (await run('codeDialog.result.code')) as string,
    /"subscribe": "orders"/,
    'the message is in the generated code',
  );
  if (process.argv.includes('--screenshots')) {
    await pause(150);
    fs.mkdirSync('artifacts', { recursive: true });
    fs.writeFileSync(
      'artifacts/websocket-code.png',
      (await window.webContents.capturePage()).toPNG(),
    );
  }
  await chooseType('sse');
  await wait("current().protocol==='sse'");
  await wait("codeDialog?.result?.code?.includes('text/event-stream')");
  assert.equal(
    await run(
      "codeDialog.targets.some(target=>target.clients.some(client=>client.id==='eventsource'))&&codeDialog.target==='node'",
    ),
    true,
    'switching protocol reloads the languages and keeps a valid choice',
  );
  await chooseType('websocket');
  await wait("current().protocol==='websocket'");
  await run('closeCodeGenerator()');
  await url(base.replace('http:', 'ws:'));
  await connect();
  await wait("liveProtocols.get(current().id)?.phase==='open'");
  await message('hello-ui');
  await run("document.querySelector('[data-protocol-send]').click()");
  await wait(
    "liveProtocols.get(current().id).events.some(event=>event.type==='message'&&event.data==='hello-ui')",
  );
  await message('AAH/');
  await run(
    "document.querySelector('#protocol-binary').checked=true;document.querySelector('#protocol-binary').dispatchEvent(new Event('change'));document.querySelector('[data-protocol-send]').click()",
  );
  await wait(
    "liveProtocols.get(current().id).events.some(event=>event.type==='message'&&event.binary&&event.data==='AAH/')",
  );
  assert.match(await run('protocolResponseEditor.getValue()'), /AAH\//);
  assert.equal(
    await run("editorView('#protocol-response-source-editor').state.readOnly"),
    true,
    'all live response bodies use the shared read-only editor',
  );
  await run("document.querySelector('[data-protocol-inspector=Timeline]').click()");
  assert.match(
    await run("document.querySelector('#protocol-response-panel').textContent"),
    /binary/,
  );
  // Timeline events have a context menu; a real right-click presses and releases the button.
  const sentRow = (await run(
    "[...document.querySelectorAll('[data-timeline-row]')].find(row=>row.querySelector('.protocol-timeline-kind.sent')).dataset.timelineRow",
  )) as string;
  await rightClick(`[data-timeline-row="${sentRow}"]`);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-timeline-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
    ),
    'copy,json-,event,details,compose,resend',
    'right-clicking a sent WebSocket message lists its actions',
  );
  await run("document.querySelector('[data-timeline-menu] [data-menu-item=resend]').click()");
  await wait(
    "liveProtocols.get(current().id).events.filter(event=>event.type==='message'&&event.data==='hello-ui').length===2",
  );
  await rightClick(`[data-timeline-row="${sentRow}"]`);
  await run("document.querySelector('[data-timeline-menu] [data-menu-item=compose]').click()");
  assert.equal(
    await run("current().body==='hello-ui'&&!protocolUIState(current()).binary"),
    true,
    'Use as next message loads the message into the composer as text',
  );
  await run("document.querySelector('[data-protocol-inspector=Body]').click()");
  await run('window.protocolRequestId=current().id;openRequest(window.originalProtocolRequest)');
  assert.equal(
    await run('liveProtocols.get(window.protocolRequestId).phase'),
    'open',
    'switching tabs preserves the live connection',
  );
  await run('openRequest(window.protocolRequestId);closeRequestTabs([window.protocolRequestId])');
  await wait("liveProtocols.get(window.protocolRequestId).phase==='closed'");
  await run('openRequest(window.protocolRequestId)');
}

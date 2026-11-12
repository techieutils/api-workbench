import assert from 'node:assert/strict';
import { pause, proto, type ProtocolContext } from './harness';

/** Protocol UI checks, part 3: grpc. */
export default async function grpc(context: ProtocolContext) {
  const { run, wait, port, select, url, message, connect, done, rightClick, tabsReachable } =
    context;
  await select('grpc');
  await url(`127.0.0.1:${port}`);
  // The .proto schema editor has the editor menu, without Format.
  await run("protocolUIState(current()).tab='Schema';render()");
  await wait("Boolean(document.querySelector('#protocol-schema-editor .cm-editor'))");
  // Squeezed, the schema tools scroll with arrows.
  await run(
    "document.querySelector('.protocol-schema-actions').closest('.ui-tabs-frame').style.width='120px'",
  );
  await pause(80);
  assert.equal(
    await tabsReachable('.protocol-schema-actions'),
    true,
    'schema tools that do not fit are reachable with the arrows',
  );
  await run(
    "document.querySelector('.protocol-schema-actions').closest('.ui-tabs-frame').style.width=''",
  );
  await rightClick('#protocol-schema-editor .cm-content');
  assert.equal(
    await run(
      "[...document.querySelectorAll('#protocol-schema-editor [data-editor-menu] [data-menu-item]')].map(item=>item.dataset.menuItem).join()",
    ),
    'undo,redo,cut,copy,paste,select-all,find,fold,unfold',
    'right-clicking the proto schema opens the editor menu',
  );
  await run(
    "document.querySelector('#protocol-schema-editor [data-editor-menu]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  await run(
    `document.querySelector('#grpc-proto').value=${JSON.stringify(proto)};document.querySelector('#grpc-proto').dispatchEvent(new Event('input'));document.querySelector('[data-protocol-discover]').click()`,
  );
  await wait("document.querySelectorAll('#grpc-methods option').length===4");
  for (const method of ['Unary', 'Watch', 'Collect', 'Chat']) {
    await run(
      `document.querySelector('#grpc-method').value='/ui.Echo/${method}';document.querySelector('#grpc-method').dispatchEvent(new Event('input'))`,
    );
    await message('{"text":"one"}');
    await connect();
    if (method === 'Collect' || method === 'Chat') {
      await wait("!document.querySelector('[data-protocol-send]').disabled");
      await message('{"text":"two"}');
      await run("document.querySelector('[data-protocol-send]').click()");
      await wait(
        "liveProtocols.get(current().id).events.filter(event=>event.type==='sent').length===2",
      );
      await run("document.querySelector('[data-protocol-finish]').click()");
    }
    await done();
    assert.equal(
      await run("liveProtocols.get(current().id).events.some(event=>event.type==='error')"),
      false,
      method,
    );
    const messages = await run(
      "liveProtocols.get(current().id).events.filter(event=>event.type==='message').map(event=>JSON.parse(event.data).text)",
    );
    assert.deepEqual(
      messages,
      method === 'Unary'
        ? ['one']
        : method === 'Watch'
          ? ['stream-one', 'stream-two']
          : method === 'Collect'
            ? ['one,two']
            : ['one', 'two'],
    );
  }
  // gRPC messages: JSON can be copied formatted and reused as the next message; a finished
  // call takes no more messages.
  await run("document.querySelector('[data-protocol-inspector=Timeline]').click()");
  const grpcReceived = (await run(
    "[...document.querySelectorAll('[data-timeline-row]')].find(row=>row.querySelector('.protocol-timeline-kind.message')).dataset.timelineRow",
  )) as string;
  await rightClick(`[data-timeline-row="${grpcReceived}"]`);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-timeline-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
    ),
    'copy,json,event,details,compose,resend-',
    'right-clicking a gRPC message lists its actions',
  );
  await run("document.querySelector('[data-timeline-menu] [data-menu-item=json]').click()");
  await wait('window.timelineCopied===\'{\\n  "text": "one"\\n}\'');
  await rightClick(`[data-timeline-row="${grpcReceived}"]`);
  await run("document.querySelector('[data-timeline-menu] [data-menu-item=compose]').click()");
  assert.equal(
    await run('JSON.parse(current().body).text'),
    'one',
    'Use as next message loads a gRPC message into the composer',
  );
  await run("document.querySelector('[data-protocol-inspector=Body]').click()");
}

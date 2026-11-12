import assert from 'node:assert/strict';
import { pause, type ProtocolContext } from './harness';

/** Protocol UI checks, part 2: sse and ndjson. */
export default async function sseAndNdjson(context: ProtocolContext) {
  const { run, wait, base, select, url, connect, done, rightClick, tabsReachable } = context;
  await select('sse');
  await url(base);
  await connect();
  await wait(
    "liveProtocols.get(current().id)?.events.some(event=>event.type==='message'&&event.data==='first')",
  );
  assert.equal(
    await run('liveProtocols.get(current().id).phase'),
    'open',
    'first SSE event appears before the response closes',
  );
  await run("document.querySelector('[data-protocol-inspector=Timeline]').click()");
  await run("document.querySelector('details[data-timeline-event]').open=true");
  assert.equal(
    await run("document.querySelectorAll('.protocol-session-timeline .timing-row').length>=3"),
    true,
    'live timeline uses shared timing rows and activity tracks',
  );
  await url(`${base}/edited-after-connect`);

  await done();
  assert.equal(
    await run("Boolean(document.querySelector('details[data-timeline-event][open]'))"),
    true,
    'expanded event details stay open during live updates',
  );
  await run("document.querySelector('[data-protocol-inspector=Body]').click()");
  assert.equal(
    await run('protocolResponseEditor.getValue()'),
    'first\nsecond',
    'SSE appends message bodies live',
  );
  await run("document.querySelector('[data-protocol-inspector=Timeline]').click()");
  assert.match(await run("document.querySelector('#protocol-response-panel').textContent"), /ID 2/);
  // SSE events: the timeline menu copies them as written on the wire, or just their ID.
  await run(
    "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.timelineCopied=value;}}})",
  );
  const lastReceived = (await run(
    "[...document.querySelectorAll('[data-timeline-row]')].filter(row=>row.querySelector('.protocol-timeline-kind.message')).at(-1).dataset.timelineRow",
  )) as string;
  await rightClick(`[data-timeline-row="${lastReceived}"]`);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-timeline-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
    ),
    'copy,json-,event,event-id,sse,details',
    'right-clicking an SSE event lists its actions, with no composer or resend',
  );
  await run("document.querySelector('[data-timeline-menu] [data-menu-item=sse]').click()");
  await wait("window.timelineCopied==='event: update\\nid: 2\\ndata: second\\n'");
  await rightClick(`[data-timeline-row="${lastReceived}"]`);
  await run("document.querySelector('[data-timeline-menu] [data-menu-item=event-id]').click()");
  await wait("window.timelineCopied==='2'");
  await run("document.querySelector('[data-protocol-view=Raw]').click()");
  assert.equal(
    await run('JSON.parse(protocolResponseEditor.getValue()).receivedMessages'),
    2,
    'Raw timeline includes measured message statistics',
  );
  assert.equal(
    await run('JSON.parse(protocolResponseEditor.getValue()).request.url'),
    base,
    'timeline keeps the connected destination after URL edits',
  );
  await run("document.querySelector('[data-protocol-view=Pretty]').click()");

  await run("document.querySelector('[data-protocol-inspector=Body]').click()");
  await select('ndjson');
  await url(`${base}/ndjson`);
  await connect();
  await done();
  assert.equal(
    await run(
      "liveProtocols.get(current().id).events.filter(event=>event.type==='message').length",
    ),
    2,
  );
  assert.deepEqual(
    await run('JSON.parse(protocolResponseEditor.getValue())'),
    [{ value: 1 }, { value: 2 }],
    'Pretty formats streamed JSON as an array',
  );
  assert.equal(
    await run(
      "Boolean(document.querySelector('.protocol-response .response-body .code-toolbar')) && Boolean(document.querySelector('#protocol-response-language'))",
    ),
    true,
    'live responses use HTTP response layout and language controls',
  );
  // Squeezed, the response toolbar scrolls with arrows.
  await run(
    "document.querySelector('.protocol-response .code-toolbar').closest('.ui-tabs-frame').style.width='160px'",
  );
  await pause(80);
  assert.equal(
    await tabsReachable('.protocol-response .code-toolbar'),
    true,
    'response toolbar controls that do not fit are reachable with the arrows',
  );
  await run(
    "document.querySelector('.protocol-response .code-toolbar').closest('.ui-tabs-frame').style.width=''",
  );
  // NDJSON messages: copy one as a compact line, or the whole stream as NDJSON.
  await run("document.querySelector('[data-protocol-inspector=Timeline]').click()");
  const ndjsonRow = (await run(
    "[...document.querySelectorAll('[data-timeline-row]')].find(row=>row.querySelector('.protocol-timeline-kind.message')).dataset.timelineRow",
  )) as string;
  await rightClick(`[data-timeline-row="${ndjsonRow}"]`);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-timeline-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
    ),
    'copy,json,event,ndjson-line,ndjson-all,details',
    'right-clicking an NDJSON message lists its actions',
  );
  await run("document.querySelector('[data-timeline-menu] [data-menu-item=ndjson-all]').click()");
  await wait('window.timelineCopied===\'{"value":1}\\n{"value":2}\\n\'');
  await rightClick(`[data-timeline-row="${ndjsonRow}"]`);
  await run("document.querySelector('[data-timeline-menu] [data-menu-item=ndjson-line]').click()");
  await wait('window.timelineCopied===\'{"value":1}\'');
  await run("document.querySelector('[data-protocol-inspector=Body]').click()");
  await run(
    "window.originalProtocolClipboard=navigator.clipboard.writeText;navigator.clipboard.writeText=async text=>{window.copiedProtocolResponse=text};document.querySelector('[data-protocol-copy]').click()",
  );
  await wait('Boolean(window.copiedProtocolResponse)');
  assert.deepEqual(
    await run('JSON.parse(window.copiedProtocolResponse)'),
    [{ value: 1 }, { value: 2 }],
    'Copy uses the selected formatted response',
  );
  await run(
    "navigator.clipboard.writeText=window.originalProtocolClipboard;window.captureDownload(()=>document.querySelector('[data-protocol-export]').click()).then(file=>{window.downloadedProtocolResponse=file&&{name:file.name,body:file.text,mime:file.mime};})",
  );
  await wait('Boolean(window.downloadedProtocolResponse)');
  assert.equal(await run('window.downloadedProtocolResponse.name'), 'response-body.json');
  assert.deepEqual(await run('JSON.parse(window.downloadedProtocolResponse.body)'), [
    { value: 1 },
    { value: 2 },
  ]);

  await run("document.querySelector('[data-protocol-view=Raw]').click()");
  assert.equal(
    await run('protocolResponseEditor.getValue()'),
    '{"value":1}\n{"value":2}',
    'Raw preserves message text',
  );
  await run("document.querySelector('[data-protocol-inspector=Headers]').click()");
  assert.match(await run('protocolResponseEditor.getValue()'), /content-type/);
  await run("document.querySelector('[data-protocol-view=Pretty]').click()");
  assert.equal(
    await run(
      "Boolean(document.querySelector('#protocol-response-panel .response-headers-table'))",
    ),
    true,
    'headers use the shared HTTP table',
  );
  await run("document.querySelector('[data-protocol-inspector=Body]').click()");
}

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { type ProtocolContext, pause, proto } from './harness';

/** Protocol UI checks, part 5: persistence and layout. */
export default async function persistenceAndLayout(context: ProtocolContext) {
  const { window, run, base, tabsReachable, chooseType } = context;
  // A gRPC request with its schema, as the earlier parts leave it.
  await run(
    `if(!current().grpc?.proto){current().protocol='grpc';current().grpc={proto:${JSON.stringify(proto)},method:'',tls:false};persist();render()}`,
  );
  await run('flushCurrentWorkspace()');
  assert.equal(
    await run(
      'window.workbench.load(workspaceUI.id).then(saved=>saved.requests.find(request=>request.id===current().id).grpc.proto===current().grpc.proto)',
    ),
    true,
    'proto schema persists',
  );
  const imported = {
    requests: [
      {
        name: 'Imported stream',
        protocol: 'sse',
        method: 'GET',
        url: base,
        params: [],
        headers: [],
        body: '',
        auth: 'None',
        tests: '',
      },
    ],
  };
  await run(`importCollection(${JSON.stringify(imported)})`);
  assert.equal(
    await run("state.requests.find(request=>request.name==='Imported stream').protocol"),
    'sse',
    'collection import retains protocol',
  );
  await run("openRequest(window.protocolRequestId);requestPanels.layout='side';render()");
  assert.equal(
    await run(
      "(()=>{const bar=document.querySelector('.urlbar');return bar.firstElementChild.matches('.request-type-select')&&bar.getBoundingClientRect().right<=document.querySelector('.request-pane').getBoundingClientRect().right;})()",
    ),
    true,
    'the URL bar, led by the request type, stays within the side pane',
  );
  // Overflowing by only a control's padding, every item is in view and no arrow shows (here the
  // HTTP settings levels, a segmented control with padding and a border).
  await chooseType('http');
  await run("requestTab='Settings';render()");
  await pause(150);
  assert.deepEqual(
    await run(
      "(async()=>{const row=document.querySelector('.hs-scope');const frame=row.closest('.ui-tabs-frame');const arrows=async width=>{frame.style.width=width+'px';await new Promise(done=>setTimeout(done,120));return [...frame.querySelectorAll('[data-tabs-arrow]')].map(arrow=>arrow.dataset.tabsArrow).join();};frame.style.width='';const full=row.offsetWidth;const result=[await arrows(full-2),await arrows(full-16)];frame.style.width='';return result;})()",
    ),
    ['', 'next'],
    'a segmented row shows an arrow only when an item is cut off',
  );
  await run("requestTab='Params';render()");
  window.setSize(1200, 820);
  // Tabs that fit show no arrows; tabs that do not fit show a next arrow, which scrolls until
  // the last tab is in view and a previous arrow appears.
  await run('requestPanels.share=30;render()');
  await pause(150);
  for (const protocol of ['http', 'websocket', 'sse', 'ndjson', 'grpc', 'socketio', 'mqtt']) {
    await chooseType(protocol);
    await pause(100);
    assert.equal(
      await run(
        "(()=>{const pane=document.querySelector('.request-pane').getBoundingClientRect();const items=[...document.querySelectorAll('.urlbar > *')].map(item=>item.getBoundingClientRect()).filter(box=>box.width);return document.querySelector('.urlbar').firstElementChild.matches('.request-type-select')&&new Set(items.map(box=>Math.round(box.top+box.height/2))).size===1&&items.every(box=>box.right<=pane.right+1)&&true;})()",
      ),
      true,
      `in a narrow request pane the URL bar, led by the method or protocol, stays on one row (${protocol})`,
    );
    if (protocol === 'websocket') {
      await run("document.querySelector('[data-protocol-tab=Message]').click()");
      await pause(100);
      await run(
        "document.querySelector('.protocol-message-options').closest('.ui-tabs-frame').style.width='140px'",
      );
      await pause(80);
      assert.equal(
        await tabsReachable('.protocol-message-options'),
        true,
        'message tools that do not fit are reachable with the arrows',
      );
      await run(
        "document.querySelector('.protocol-message-options').closest('.ui-tabs-frame').style.width=''",
      );
    }
    await chooseType(protocol);
    await pause(100);
    assert.equal(
      await run(
        "(()=>{const pane=document.querySelector('.request-pane').getBoundingClientRect();const items=[...document.querySelectorAll('.request-heading > .actions > *')].map(item=>item.getBoundingClientRect()).filter(box=>box.width);return new Set(items.map(box=>Math.round(box.top+box.height/2))).size===1&&items.every(box=>box.right<=pane.right)})()",
      ),
      true,
      `request actions stay on one row within a narrow request pane (${protocol})`,
    );
    assert.equal(
      await tabsReachable('.request-tabs'),
      true,
      `request tabs that do not fit are reachable with the arrows (${protocol})`,
    );
  }
  await run('requestPanels.share=72;render()');
  await pause(150);
  for (const protocol of ['http', 'grpc']) {
    await chooseType(protocol);
    await pause(100);
    assert.equal(
      await run(
        "(()=>{const top=document.querySelector('.response-top').getBoundingClientRect();const expand=document.querySelector('.response-maximize').getBoundingClientRect();const tabs=document.querySelector('.response-tabs').getBoundingClientRect();return expand.top-top.top<24&&expand.right<=top.right&&tabs.right<=document.querySelector('.response-navigation').getBoundingClientRect().right})()",
      ),
      true,
      `narrow response keeps the expand button on the header row and the tabs inside (${protocol})`,
    );
    assert.equal(
      await tabsReachable('.response-tabs'),
      true,
      `response tabs that do not fit are reachable with the arrows (${protocol})`,
    );
  }
  await run('requestPanels.share=55;render()');
  if (process.argv.includes('--screenshots')) {
    await run('clearToasts()');
    await pause(100);
    fs.mkdirSync(path.join(process.cwd(), 'artifacts'), { recursive: true });
    fs.writeFileSync(
      path.join(process.cwd(), 'artifacts/protocol-grpc.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    await run("document.querySelector('[data-protocol-inspector=Timeline]').click()");
    await pause(100);
    fs.writeFileSync(
      path.join(process.cwd(), 'artifacts/protocol-grpc-timeline.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
  }
}

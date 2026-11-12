import { createTLSFixture } from '@techieutils/api-workbench-electron/testing/tls-fixture';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { parse } from 'protobufjs';
import { io as socketIO } from 'socket.io-client';
import mqtt from 'mqtt';
import { BrowserWindow, WebContentsView } from 'electron';
import { createHarness, pause, type SmokeContext } from './harness';

/** A port nothing is listening on right now. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
const ORDERS_PROTO = `syntax = "proto3";
package shop;
service Orders {
  rpc Get (OrderRequest) returns (Order);
  rpc Watch (OrderRequest) returns (stream Order);
}
message OrderRequest { string id = 1; }
message Order { string id = 1; string status = 2; }`;

/** UI smoke checks, part 14: specs and mocks. */
export default async function specsAndMocks(context: SmokeContext) {
  const { window, run, capture } = context;
  // API specifications: create, validate, jump to problems, and generate a collection.
  await run("window.specsOriginal=structuredClone(state);view='APIs';render()");
  await pause(100);
  assert.equal(
    await run("Boolean(document.querySelector('.api-specs-page .empty-state'))"),
    true,
    'the APIs view starts empty',
  );
  await run("document.querySelector('[data-spec-new]').click()");
  await pause(200);
  assert.equal(
    await run(
      "state.specs.length===1&&document.querySelector('[data-spec-status]').textContent.includes('Valid')&&document.querySelector('[data-spec-tab=Endpoints]').textContent.includes('2')",
    ),
    true,
    'a new specification is valid and lists its endpoints',
  );
  const specEditor = "editorView('#spec-source-editor')";
  await run(`window.specText=${specEditor}.state.doc.toString()`);
  await run(
    "setEditorText('#spec-source-editor','openapi: 3.0.3\\ninfo:\\n  version: 1\\npaths: {}\\n')",
  );
  await pause(100);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-spec-problem]')].map(item=>item.textContent).join('|').includes('info.title is required')&&document.querySelector('[data-spec-select] .badge.danger')!==null",
    ),
    true,
    'problems are listed as the specification is edited',
  );
  await run("document.querySelector('[data-spec-problem]').click()");
  await pause(100);
  assert.equal(
    await run(`${specEditor}.state.doc.lineAt(${specEditor}.state.selection.main.head).number`),
    2,
    'choosing a problem moves the cursor to its line',
  );
  // Format tidies the YAML; the editor and the saved text follow.
  await run(
    "setEditorText('#spec-source-editor','openapi:   3.0.3\\ninfo:\\n    title: Tidy\\n    version: 1.0.0\\npaths:   {}\\n')",
  );
  await pause(100);
  await run("document.querySelector('[data-spec-format]').click()");
  await pause(500);
  assert.deepEqual(
    await run(
      `[state.specs[0].content,${specEditor}.state.doc.toString()===state.specs[0].content,!/\\berror/.test(document.querySelector('[data-spec-status]').textContent)]`,
    ),
    ['openapi: 3.0.3\ninfo:\n  title: Tidy\n  version: 1.0.0\npaths: {}\n', true, true],
    'Format tidies the specification in its editor',
  );
  await run("setEditorText('#spec-source-editor',window.specText)");
  await pause(500);
  assert.equal(
    await run('state.specs[0].content===window.specText'),
    true,
    'edits are kept once typing pauses',
  );
  await run("document.querySelector('[data-spec-collection]').click()");
  await pause(300);
  assert.equal(
    await run(
      "state.specs[0].collection==='New API'&&state.requests.filter(request=>request.folder==='New API/Items').map(request=>request.method+' '+request.url).join()==='GET http://localhost:4010/items,GET http://localhost:4010/items/{{id}}'",
    ),
    true,
    'a specification generates a collection, with tags as folders',
  );
  await run("document.querySelector('[data-spec-collection]').click()");
  await pause(150);
  assert.equal(
    await run("Boolean(document.querySelector('[data-confirm-dialog]'))"),
    true,
    'refreshing the collection asks first',
  );
  await run("document.querySelector('[data-confirm-accept]').click()");
  await pause(300);
  assert.equal(
    await run("state.requests.filter(request=>request.folder.startsWith('New API')).length"),
    2,
    'refreshing replaces the collection’s requests instead of adding to them',
  );
  // Mock servers: from a specification, live edits, the request log, and stopping.
  await run("document.querySelector('[data-spec-mock]').click()");
  const mockStarted = async () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await run("view==='Mocks'&&mocksStore.running.size===1")) return true;
      await pause(50);
    }
    return false;
  };
  assert.equal(await mockStarted(), true, 'a specification starts a mock server');
  const mockURL = (await run('mocksStore.url(state.mocks[0])')) as string;
  /** Calls the mock from the test and hands the statuses to the page, for assertions mixed with its state. */
  const sendStatuses = async (calls: [string, RequestInit][]) => {
    const statuses = await Promise.all(
      calls.map(async ([url, init]) => (await fetch(url, init)).status),
    );
    await run(`window.mockStatuses=${JSON.stringify(statuses)}`);
  };
  assert.deepEqual(
    await fetch(`${mockURL}/items/7`).then(async (r) => [r.status, await r.json()]),
    [200, { id: 1, name: 'First item' }],
    'the mock answers with the specification’s example',
  );
  await run("document.querySelectorAll('[data-mock-route]')[1].click()");
  await pause(100);
  await run(
    "(()=>{const input=document.querySelector('#mock-route-status');input.value='418';input.dispatchEvent(new Event('input'));})()",
  );
  await pause(600);
  assert.equal(
    (await fetch(`${mockURL}/items/7`)).status,
    418,
    'a running mock takes route edits at once',
  );
  // Response headers use the request headers table: typing in the last row adds a header.
  const mockHeaderCells = (field: string) =>
    `[...document.querySelectorAll('[data-mock-route-editor] [data-type=headers][data-field=${field}]')]`;
  assert.equal(
    await run(`${mockHeaderCells('key')}.length`),
    2,
    'the response headers table lists the route’s header and a new row',
  );
  await run(
    `(()=>{const key=${mockHeaderCells('key')}.at(-1);key.value='X-Mock';key.dispatchEvent(new Event('input'));})()`,
  );
  await pause(100);
  await run(
    `(()=>{const value=${mockHeaderCells('value')}.at(-2);value.value='yes';value.dispatchEvent(new Event('input'));})()`,
  );
  await pause(600);
  assert.equal(
    (await fetch(`${mockURL}/items/7`)).headers.get('x-mock'),
    'yes',
    'a header added in the table is sent by the running mock',
  );
  // Its suggestions are response headers, without variables, which a mock sends as written.
  const suggestionsFor = async (field: string, index: number) => {
    await run(
      `${mockHeaderCells(field)}.at(${index}).closest('td').scrollIntoView({block:'center'})`,
    );
    // The cell, since its input is hidden until editing; let the scroll settle, as scrolling
    // closes an open suggestion list.
    await pause(150);
    await run(
      `${mockHeaderCells(field)}.at(${index}).parentElement.querySelector('.kv-field-label').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`,
    );
    await pause(100);
    const options = (await run(
      "Array.from(document.querySelectorAll('#kv-suggestion-list strong'),option=>option.textContent)",
    )) as string[];
    await run(
      `${mockHeaderCells(field)}.at(${index}).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
    );
    await pause(50);
    return options;
  };
  const names = await suggestionsFor('key', -1);
  assert.ok(
    ['Set-Cookie', 'Location', 'Retry-After', 'Access-Control-Allow-Origin'].every((name) =>
      names.includes(name),
    ) &&
      !names.includes('User-Agent') &&
      !names.some((name) => name.includes('{{')),
    `mock header names suggest response headers: ${names.join(', ')}`,
  );
  const values = await suggestionsFor('value', 0);
  assert.ok(
    values.includes('application/problem+json') &&
      values.includes('{{$uuid}}') &&
      values.includes('{{params.id}}') &&
      !values.some((value) => value.startsWith('{{#repeat')),
    `mock header values follow the header name, and offer templates: ${values.join(', ')}`,
  );
  assert.equal(
    (await fetch(`${mockURL}/missing`)).status,
    404,
    'requests without a route get a 404',
  );
  await run("document.querySelector('[data-mock-tab=Log]').click()");
  await pause(150);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-mock-log-row]')].map(row=>row.textContent.replace(/\\s+/g,' ')).join('|').includes('404')&&document.querySelectorAll('[data-mock-log-row]').length===4",
    ),
    true,
    'the log lists every request the mock answered',
  );
  // Each entry explains its answer: the 404 names why nothing matched.
  await run('document.querySelector(\'[data-mock-log-filter="No match"]\').click()');
  await pause(50);
  assert.equal(
    await run("document.querySelectorAll('[data-mock-log-row]').length"),
    1,
    'the No match filter shows only requests no route answered',
  );
  await run("document.querySelector('[data-mock-log-row]').click()");
  await pause(100);
  assert.deepEqual(
    await run(
      "[...document.querySelectorAll('[data-mock-log-notes] li')].map(note=>note.textContent.trim())",
    ),
    ['No route has the path /missing.'],
    'a miss explains why no route answered',
  );
  await run("document.querySelector('[data-mock-log-filter=All]').click()");
  await pause(50);
  await run(
    "[...document.querySelectorAll('[data-mock-log-row]')].find(row=>row.textContent.includes('/items/7')).click()",
  );
  await pause(100);
  assert.deepEqual(
    await run(
      "[document.querySelector('[data-mock-log-notes] li').textContent.trim(),document.querySelector('.mock-log-params').textContent.replace(/\\s+/g,'')]",
    ),
    ['Route GET /items/:id (Get an item) answered.', ':id7'],
    'an answer names its route and the path values it took',
  );
  await run("document.querySelector('[data-mock-tab=Response]').click()");
  await pause(100);
  assert.equal(
    await run(
      "editorView('#mock-log-body')?.state.doc.length>0&&document.querySelector('[data-mock-log-headers]').textContent.toLowerCase().includes('content-type')",
    ),
    true,
    'the Response tab shows the headers and body that were sent',
  );
  await run(
    "window.clipboardBefore=navigator.clipboard;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.curlCopied=value;}}});document.querySelector('[data-mock-log-curl]').click()",
  );
  await pause(50);
  assert.match(
    (await run('window.curlCopied')) as string,
    /^curl -X GET 'http:\/\/localhost:\d+\/items\/7'/,
    'Copy as cURL copies the request',
  );
  await run(
    "Object.defineProperty(navigator,'clipboard',{configurable:true,value:window.clipboardBefore});document.querySelector('[data-mock-log-close]').click()",
  );
  // HTTPS: without OS encryption the CA cannot be used, so the mock keeps serving HTTP and says
  // to choose certificate files; with files, it serves HTTPS.
  await run("document.querySelector('[data-mock-tab=Routes]').click()");
  await pause(50);
  await run("document.querySelector('[data-mock-https-settings]').click()");
  await pause(50);
  await run("clearToasts();document.querySelector('[data-mock-https]').click()");
  await pause(800);
  const port = Number(new URL(mockURL).port);
  /** The status an HTTPS request gets, trusting `ca`, or any certificate without one. */
  const secureStatus = (ca?: string) =>
    new Promise<number>((resolve, reject) => {
      const request = httpsRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/items/7',
          servername: 'localhost',
          ...(ca ? { ca } : { rejectUnauthorized: false }),
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.on('error', reject);
      request.end();
    });
  // The CA needs OS encryption: here it may be unavailable (the mock stays on HTTP and says to
  // choose files), or already made by an earlier part (the mock serves HTTPS with it).
  if (
    await run(
      "[...document.querySelectorAll('.toast')].some(toast=>toast.textContent.includes('Choose your own certificate and key files'))",
    )
  )
    assert.equal(
      (await fetch(`${mockURL}/items/7`)).status,
      418,
      'HTTPS without the CA explains what to do, and the mock keeps serving HTTP',
    );
  else assert.equal(await secureStatus(), 418, 'with the CA available the mock serves HTTPS');
  const tls = await createTLSFixture();
  try {
    const certFile = path.join(path.dirname(tls.serverKeyPath), 'server.pem');
    await run(
      `state.mocks[0].https={enabled:true,certFile:${JSON.stringify(certFile)},keyFile:${JSON.stringify(tls.serverKeyPath)}};mocksStore.touch(state.mocks[0].id)`,
    );
    await pause(800);
    const secure = await secureStatus(tls.ca);
    assert.deepEqual(
      [
        secure,
        await run("document.querySelector('.mock-composer-origin').textContent.trim()"),
        await run(
          "document.querySelector('[data-mock-https-settings] [data-mock-setting-status]').textContent.trim()",
        ),
      ],
      [418, `https://localhost:${port}`, 'On'],
      'with certificate files the mock serves HTTPS at an https address',
    );
    await run("document.querySelector('[data-mock-https]').click()");
    await pause(800);
    assert.equal(
      (await fetch(`${mockURL}/items/7`)).status,
      418,
      'turning HTTPS off serves HTTP again',
    );
    await run('delete state.mocks[0].https;mocksStore.touch(state.mocks[0].id)');
  } finally {
    await tls.dispose();
  }
  await run("document.querySelector('[data-mock-https-settings]').click()");
  // Default headers: new mocks send the security headers on every answer.
  await run("document.querySelector('[data-mock-tab=Routes]').click()");
  await pause(50);
  await run("document.querySelector('[data-mock-defaults-settings]').click()");
  await pause(50);
  const defaultsCount = () =>
    run("document.querySelector('[data-mock-defaults-settings]').dataset.mockSettingCount");
  assert.equal(await defaultsCount(), '7', 'a new mock starts with the security headers');
  const secured = await fetch(`${mockURL}/missing`);
  assert.deepEqual(
    [secured.headers.get('x-content-type-options'), secured.headers.get('x-frame-options')],
    ['nosniff', 'DENY'],
    'default headers go out even on a 404',
  );
  await run('document.querySelector(\'[data-mock-defaults-panel] [data-delete="0"]\').click()');
  await pause(100);
  assert.deepEqual(
    [
      await defaultsCount(),
      await run("document.querySelector('[data-mock-add-security]').disabled"),
    ],
    ['6', false],
    'removing a security header lets it be added back',
  );
  await run("document.querySelector('[data-mock-add-security]').click()");
  await pause(400);
  assert.deepEqual(
    [
      await defaultsCount(),
      await run("document.querySelector('[data-mock-add-security]').disabled"),
      (await fetch(`${mockURL}/missing`)).headers.get('x-content-type-options'),
    ],
    ['7', true, 'nosniff'],
    'Add security headers adds what is missing, and the running mock sends it',
  );
  await run("document.querySelector('[data-mock-defaults-settings]').click()");
  // CORS settings: only listed origins get CORS headers, echoed with credentials.
  await run("document.querySelector('[data-mock-tab=Routes]').click()");
  await pause(50);
  await run("document.querySelector('[data-mock-cors-settings]').click()");
  await pause(80);
  await run(
    "clearToasts();document.querySelector('[data-mock-settings]').scrollIntoView({block:'start'});document.documentElement.scrollTop=0",
  );
  await capture('mock-settings-cors.png');
  // Each setting is a tile with its state in words; one panel is open at a time, under the tiles.
  assert.deepEqual(
    await run(
      "[...document.querySelectorAll('[data-mock-setting]')].map(tile=>[tile.dataset.mockSetting,tile.dataset.mockSettingTone,tile.querySelector('[data-mock-setting-status]').textContent.trim(),tile.getAttribute('aria-expanded')].join(' '))",
    ),
    [
      'cors on On true',
      'https off Off false',
      'defaults on On false',
      'grpc off Off false',
      'mqtt off Off false',
    ],
    'the settings show as tiles with their state, CORS open',
  );
  await run("document.querySelector('[data-mock-defaults-settings]').click()");
  await pause(50);
  assert.deepEqual(
    await run(
      "[document.querySelector('[data-mock-cors-settings]').getAttribute('aria-expanded'),getComputedStyle(document.querySelector('[data-mock-cors-panel]')).display,getComputedStyle(document.querySelector('[data-mock-defaults-panel]')).display,document.querySelector('.mock-setting-panel-title strong').textContent]",
    ),
    ['false', 'none', 'block', 'Default headers'],
    'opening another setting closes the first',
  );
  // A missing security header needs attention: the tile, the card's header, and the panel say so.
  await run(
    '(()=>{const mock=mocksStore.current();window.savedDefaults=structuredClone(mock.defaultHeaders);mock.defaultHeaders.shift();mocksStore.touch(mock.id);})()',
  );
  await pause(100);
  assert.deepEqual(
    await run(
      "[document.querySelector('[data-mock-defaults-settings]').dataset.mockSettingTone,document.querySelector('[data-mock-defaults-settings] [data-mock-setting-status]').textContent.trim(),[...document.querySelectorAll('[data-mock-settings-health] > span')].map(item=>item.textContent.replace(/\\s+/g,' ').trim()).join('|'),Boolean(document.querySelector('[data-mock-security-missing]'))]",
    ),
    ['warning', '1 missing', '2 of 5 on|1 needs attention', true],
    'a missing security header is flagged in words, not colour alone',
  );
  await run(
    '(()=>{const mock=mocksStore.current();mock.defaultHeaders=window.savedDefaults;mocksStore.touch(mock.id);})()',
  );
  await pause(50);
  // Escape closes the panel and returns focus to its tile.
  await run(
    "document.querySelector('[data-mock-defaults-settings]').focus();document.querySelector('[data-mock-settings]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  await pause(80);
  assert.deepEqual(
    await run(
      "[getComputedStyle(document.querySelector('.mock-setting-panel')).display,document.activeElement?.dataset.mockSetting]",
    ),
    ['none', 'defaults'],
    'Escape closes the open setting and keeps focus on its tile',
  );
  // Narrow, the tiles wrap rather than overflow; in the light theme the open panel still reads.
  await run(
    "document.querySelector('[data-mock-settings]').style.width='380px';document.querySelector('[data-mock-https-settings]').click()",
  );
  await pause(100);
  assert.deepEqual(
    await run(
      "(()=>{const tiles=document.querySelector('.mock-settings-tiles');const section=document.querySelector('[data-mock-settings]');return [tiles.scrollWidth<=tiles.clientWidth,section.scrollWidth<=section.clientWidth+1];})()",
    ),
    [true, true],
    'at a narrow width the settings wrap without scrolling sideways',
  );
  await run(
    "document.querySelector('[data-mock-settings]').style.width='';state.settings.theme='light';applyTheme();render()",
  );
  await pause(200);
  await run(
    "clearToasts();document.querySelector('[data-mock-settings]').scrollIntoView({block:'start'})",
  );
  await capture('mock-settings-https-light.png');
  await run("state.settings.theme='dark';applyTheme();render()");
  await pause(100);
  await run("document.querySelector('[data-mock-https-settings]').click()");
  await pause(50);
  await run("document.querySelector('[data-mock-cors-settings]').click()");
  await pause(50);
  await pause(50);
  await run(
    "(()=>{const origins=document.querySelector('[data-mock-cors-field=origins]');origins.value='http://app.test';origins.dispatchEvent(new Event('input'));const credentials=document.querySelector('[data-mock-cors-field=credentials]');credentials.checked=true;credentials.dispatchEvent(new Event('change'));})()",
  );
  await pause(600);
  const corsFor = async (origin: string) => {
    const answer = await fetch(`${mockURL}/items/7`, { headers: { Origin: origin } });
    return [
      answer.headers.get('access-control-allow-origin'),
      answer.headers.get('access-control-allow-credentials'),
    ];
  };
  assert.deepEqual(
    [await corsFor('http://app.test'), await corsFor('http://other.test')],
    [
      ['http://app.test', 'true'],
      [null, null],
    ],
    'CORS settings allow only listed origins, echoing them with credentials',
  );
  await run("document.querySelector('[data-mock-cors-reset]').click()");
  await pause(600);
  assert.deepEqual(
    await corsFor('http://other.test'),
    ['*', null],
    'resetting CORS makes the mock permissive again',
  );
  // The switch is inside CORS settings: off, the mock sends no CORS headers at all.
  await run(
    "(()=>{const toggle=document.querySelector('[data-mock-cors]');toggle.checked=false;toggle.dispatchEvent(new Event('change'));})()",
  );
  await pause(400);
  assert.deepEqual(
    [
      await corsFor('http://other.test'),
      await run(
        "document.querySelector('[data-mock-cors-settings] [data-mock-setting-status]').textContent.trim()+'|'+document.querySelector('[data-mock-cors-field=origins]').disabled",
      ),
    ],
    [[null, null], 'Off|true'],
    'turning CORS off inside its settings removes the headers and disables the settings',
  );
  await run(
    "(()=>{const toggle=document.querySelector('[data-mock-cors]');toggle.checked=true;toggle.dispatchEvent(new Event('change'));document.querySelector('[data-mock-cors-settings]').click();})()",
  );
  await pause(400);
  // The body's content type sets the Content-Type header, or turns it off.
  await run("document.querySelector('[data-mock-tab=Routes]').click()");
  await pause(100);
  const chooseMockType = async (value: string) => {
    await run(
      `(()=>{const select=document.querySelector('#mock-content-type');select.value='${value}';select.dispatchEvent(new Event('change'));})()`,
    );
    await pause(600);
  };
  await chooseMockType('text/plain');
  assert.deepEqual(
    await run(`${mockHeaderCells('value')}[0].value`).then(async (cell) => [
      (await fetch(`${mockURL}/items/7`)).headers.get('content-type'),
      cell,
    ]),
    ['text/plain', 'text/plain'],
    'the content type picker updates the Content-Type header row',
  );
  await chooseMockType('none');
  assert.deepEqual(
    await run(
      "document.querySelector('[data-mock-body-format]').textContent.includes('No Content-Type')",
    ).then(async (note) => [(await fetch(`${mockURL}/items/7`)).headers.get('content-type'), note]),
    [null, true],
    'None sends no Content-Type header',
  );
  await chooseMockType('custom');
  assert.equal(
    await run("Boolean(document.querySelector('#mock-custom-content-type'))"),
    true,
    'Custom offers a field for any content type',
  );
  await chooseMockType('application/json');
  // Format tidies the body in its content type's language.
  await run(`setEditorText('#mock-body-editor','{"id":"{{params.id}}","tags":["a","b"]}')`);
  await pause(100);
  await run("document.querySelector('[data-mock-format]').click()");
  await pause(700);
  assert.equal(
    await (await fetch(`${mockURL}/items/7`)).text(),
    '{\n  "id": "7",\n  "tags": [\n    "a",\n    "b"\n  ]\n}\n',
    'Format pretty-prints the body, and the running mock serves it',
  );
  // Templates: fake data and repeated blocks, inserted from the picker and previewed.
  const mockBody = "editorView('#mock-body-editor')";
  await run(
    `setEditorText('#mock-body-editor','{"id":"{{params.id}}","people":[{{#repeat 2}}{"n":{{@index}},"name":"')`,
  );
  await run(
    "(()=>{const select=document.querySelector('select[data-mock-template]');select.value='{{$randomFullName}}';select.dispatchEvent(new Event('change'));})()",
  );
  await pause(50);
  await run(
    `(view=>view.dispatch({changes:{from:view.state.doc.length,insert:'"}{{/repeat}}]}'}}))(${mockBody})`,
  );
  await pause(600);
  const templated = (await (await fetch(`${mockURL}/items/9`)).json()) as {
    id: string;
    people: { n: number; name: string }[];
  };
  assert.ok(
    templated.id === '9' &&
      templated.people.length === 2 &&
      templated.people.every(
        (person, index) => person.n === index && /^\S+ \S+$/.test(person.name),
      ),
    `the body fills in request values, fake data, and repeated blocks: ${JSON.stringify(templated)}`,
  );
  await run("document.querySelector('[data-mock-preview]').click()");
  await pause(150);
  assert.equal(
    await run(
      "(()=>{const preview=JSON.parse(editorView('#mock-body-preview').state.doc.toString());return preview.id==='id'&&preview.people.length===2;})()",
    ),
    true,
    'Preview shows a sample answer, with path parameters by name',
  );
  await run("document.querySelector('[data-mock-preview]').click()");
  await run(`setEditorText('#mock-body-editor','[{"id":1,"name":"First item"}]')`);
  // Typing {{ suggests templates; Enter takes one, closing braces and all.
  await run(`setEditorText('#mock-body-editor','');${mockBody}.focus()`);
  // The braces are typed (the editor closes them); the rest goes in as typing would.
  for (const key of '{{') {
    window.webContents.sendInputEvent({ type: 'char', keyCode: key });
    await pause(15);
  }
  // CodeMirror opens the completion list shortly after typing stops.
  await pause(300);
  assert.ok(
    ((await run("document.querySelectorAll('.cm-tooltip-autocomplete li').length")) as number) > 40,
    'typing {{ lists every template',
  );
  await run(
    `(view=>view.dispatch(view.state.replaceSelection('$randomFull'),{userEvent:'input.type'}))(${mockBody})`,
  );
  await pause(300);
  assert.deepEqual(
    await run(
      "[...document.querySelectorAll('.cm-tooltip-autocomplete li .cm-completionLabel')].map(label=>label.textContent).slice(0,1)",
    ),
    ['{{$randomFullName}}'],
    'typing {{ suggests matching templates',
  );
  await capture('editor-completions.png');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await pause(100);
  assert.equal(
    await run(`${mockBody}.state.doc.toString()`),
    '{{$randomFullName}}',
    'choosing a suggestion inserts the whole template',
  );
  await run(`setEditorText('#mock-body-editor','[{"id":1,"name":"First item"}]')`);
  await pause(600);
  // Request rules, in a table like the headers table: typing in the last row adds a rule.
  await run(
    'mocksStore.duplicateRoute(state.mocks[0].id,mocksStore.currentRoute(state.mocks[0]).id)',
  );
  await pause(100);
  const routeRules = '[data-rules-kind=route]';
  await run(
    `(()=>{const operator=document.querySelector('${routeRules} select[data-mock-rule-operator="0"]');operator.value='exists';operator.dispatchEvent(new Event('change'));const name=document.querySelector('${routeRules} [data-mock-rule-name="0"]');name.value='debug';name.dispatchEvent(new Event('input'));const status=document.querySelector('#mock-route-status');status.value='202';status.dispatchEvent(new Event('input'));})()`,
  );
  await pause(600);
  // The mock is called from the test: the desktop page itself cannot open connections.
  await sendStatuses([
    [`${mockURL}/items/7?debug=1`, {}],
    [`${mockURL}/items/7`, {}],
  ]);
  assert.deepEqual(
    await run(
      `Promise.all([window.mockStatuses[0],window.mockStatuses[1],document.querySelectorAll('.mock-route-rules').length,document.querySelectorAll('${routeRules} tbody tr').length,mocksStore.currentRoute(state.mocks[0]).rules[0].operator])`,
    ),
    [202, 418, 1, 2, 'exists'],
    'a route with rules answers only requests that meet them',
  );
  // A rule can read a cookie the request sent, and compare it in any case.
  await run(
    `(()=>{const rule=document.querySelector('${routeRules} select[data-mock-rule-target="0"]');rule.value='cookie';rule.dispatchEvent(new Event('change'));const operator=document.querySelector('${routeRules} select[data-mock-rule-operator="0"]');operator.value='equals-ignore-case';operator.dispatchEvent(new Event('change'));const name=document.querySelector('${routeRules} [data-mock-rule-name="0"]');name.value='plan';name.dispatchEvent(new Event('input'));})()`,
  );
  await pause(50);
  await run(
    `(()=>{const value=document.querySelector('${routeRules} [data-mock-rule-value="0"]');value.value='pro';value.dispatchEvent(new Event('input'));})()`,
  );
  await pause(600);
  await sendStatuses([
    [`${mockURL}/items/7`, { headers: { cookie: 'session=1; plan=PRO' } }],
    [`${mockURL}/items/7`, { headers: { cookie: 'plan=free' } }],
  ]);
  assert.deepEqual(
    await run('Promise.all([window.mockStatuses[0],window.mockStatuses[1]])'),
    [202, 418],
    'a cookie rule matches the cookie, ignoring case',
  );
  await run(
    `(()=>{const operator=document.querySelector('${routeRules} select[data-mock-rule-operator="0"]');operator.value='matches';operator.dispatchEvent(new Event('change'));})()`,
  );
  await pause(50);
  await run(
    `(()=>{const value=document.querySelector('${routeRules} [data-mock-rule-value="0"]');value.value='(';value.dispatchEvent(new Event('input'));})()`,
  );
  await pause(100);
  assert.equal(
    await run(
      "[...document.querySelectorAll('.mock-rule-problem')].some(problem=>problem.textContent.includes('Invalid regular expression'))",
    ),
    true,
    'an invalid pattern is explained',
  );
  await run(`document.querySelector('${routeRules} [data-mock-remove-rule="0"]').click()`);
  await pause(50);
  assert.equal(
    await run('mocksStore.currentRoute(state.mocks[0]).rules.length'),
    0,
    'removing the rule leaves the route unconditional',
  );
  // Responses: another answer for the route, given when its own rules pass. The copy goes, so
  // the original /items/:id route (answering 418) is the one edited.
  await run(
    "mocksStore.removeRoute(state.mocks[0].id,mocksStore.currentRoute(state.mocks[0]).id);document.querySelectorAll('[data-mock-route]')[1].click()",
  );
  await pause(100);
  await run("document.querySelector('[data-mock-add-response]').click()");
  await pause(100);
  const responseRules = '[data-rules-kind=response]';
  await run(
    `(()=>{const target=document.querySelector('${responseRules} select[data-mock-rule-target="0"]');target.value='header';target.dispatchEvent(new Event('change'));const name=document.querySelector('${responseRules} [data-mock-rule-name="0"]');name.value='X-Variant';name.dispatchEvent(new Event('input'));})()`,
  );
  await pause(100);
  await run(
    `(()=>{const value=document.querySelector('${responseRules} [data-mock-rule-value="0"]');value.value='b';value.dispatchEvent(new Event('input'));const status=document.querySelector('#mock-route-status');status.value='207';status.dispatchEvent(new Event('input'));const name=document.querySelector('#mock-response-name');name.value='Variant B';name.dispatchEvent(new Event('change'));})()`,
  );
  await pause(600);
  // The mock is called from the test: the desktop page itself cannot open connections.
  await sendStatuses([
    [`${mockURL}/items/7`, { headers: { 'X-Variant': 'b' } }],
    [`${mockURL}/items/7`, {}],
  ]);
  assert.deepEqual(
    await run(
      `Promise.all([window.mockStatuses[0],window.mockStatuses[1],document.querySelector('[data-mock-response="0"]').textContent.replace(/\\s+/g,' ').trim()])`,
    ),
    [207, 418, 'Variant B · 207'],
    'a response answers when its rules pass, and the default otherwise',
  );
  await run("document.querySelector('[data-mock-tab=Log]').click()");
  await pause(100);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-mock-log-row]')].some(row=>row.textContent.includes('Variant B'))",
    ),
    true,
    'the log names the response that answered',
  );
  await run("document.querySelector('[data-mock-tab=Routes]').click()");
  await pause(100);
  await run('document.querySelector(\'[data-mock-response="0"]\').click()');
  await pause(50);
  await run("document.querySelector('[data-mock-remove-response]').click()");
  await pause(600);
  // The mock is called from the test: the desktop page itself cannot open connections.
  await sendStatuses([[`${mockURL}/items/7`, { headers: { 'X-Variant': 'b' } }]]);
  assert.deepEqual(
    await run(
      `Promise.all([window.mockStatuses[0],mocksStore.currentRoute(state.mocks[0]).responses])`,
    ),
    [418, undefined],
    'removing the response leaves the default answer',
  );
  await chooseMockType('text/plain');
  assert.equal(
    await run("document.querySelector('[data-mock-format]').disabled"),
    true,
    'Format is unavailable for plain text',
  );
  await chooseMockType('application/json');
  await run("document.querySelector('[data-mock-stop]').click()");
  await pause(300);
  assert.equal(
    await fetch(`${mockURL}/items/7`).then(
      () => 'answered',
      () => 'stopped',
    ),
    'stopped',
    'a stopped mock no longer answers',
  );
  // Collections become mocks and specifications from their menus.
  await run("mocksStore.createFromCollection('Getting started')");
  await pause(150);
  assert.equal(
    await run(
      "state.mocks.length===2&&state.mocks[1].source.kind==='collection'&&state.mocks[1].routes.length===mocksStore.mocks()[1].routes.length&&state.mocks[1].routes.every(route=>route.path.startsWith('/'))&&state.mocks[1].routes.length>=3",
    ),
    true,
    'a collection becomes a mock with a route per request',
  );
  await run("specsStore.createFromCollection('Getting started')");
  await pause(150);
  assert.equal(
    await run(
      "state.specs.length===2&&specsStore.analysis(state.specs[1]).problems.filter(problem=>problem.severity==='error').length===0&&specsStore.analysis(state.specs[1]).endpoints.length>=3",
    ),
    true,
    'a collection becomes a valid specification',
  );
  // The documentation page starts a mock for its collection, reusing one made from it.
  await run("view='Documentation';documentationState.collection='Getting started';render()");
  await pause(150);
  await run("document.querySelector('[data-docs-mock]').click()");
  let docsMock = false;
  for (let attempt = 0; attempt < 60 && !docsMock; attempt++) {
    docsMock = (await run(
      "view==='Mocks'&&mocksStore.running.has(state.mocks[1].id)&&state.mocks.length===2&&mocksStore.current().id===state.mocks[1].id",
    )) as boolean;
    if (!docsMock) await pause(50);
  }
  assert.equal(docsMock, true, 'the documentation page starts its collection’s mock');
  // Methods say what they are for, and the mock and route explain themselves.
  await run(
    "document.querySelector('#mock-route-method').closest('.ui-select').querySelector('.ui-select-trigger').click()",
  );
  await pause(150);
  assert.deepEqual(
    await run(
      "[...document.querySelectorAll('.ui-select-menu:popover-open [data-method]')].slice(0,3).map(option=>option.querySelector('.ui-select-option-text small')?.textContent.trim())",
    ),
    ['Every method', 'Read a resource', 'Create or submit'],
    'route methods have descriptions, as in the request method box',
  );
  await run('clearToasts()');
  await capture('mock-route-methods.png');
  await run(
    "document.querySelector('#mock-route-method').closest('.ui-select').querySelector('.ui-select-menu').hidePopover()",
  );
  assert.deepEqual(
    await run(
      "(()=>({stats:[...document.querySelectorAll('[data-mock-stat]')].map(item=>item.dataset.mockStat),protocols:document.querySelector('[data-mock-stat=protocols] dd').textContent.trim(),sections:[...document.querySelectorAll('[data-mock-section] .ui-expansion-heading strong')].map(item=>item.textContent.trim()),match:document.querySelector('[data-mock-section=match] .ui-expansion-heading small').textContent.trim()===(r=>`${r.method} ${r.path}, every time`)(mocksStore.currentRoute(mocksStore.current())),item:[...document.querySelectorAll('[data-mock-select].is-active [data-mock-item-protocol]')].map(item=>item.textContent.trim()),name:document.querySelector('[data-mock-route].is-active .mock-route-name')?.textContent.trim()===mocksStore.currentRoute(mocksStore.current()).name}))()",
    ),
    {
      stats: ['routes', 'protocols', 'requests', 'errors', 'latency', 'last'],
      protocols: 'HTTP',
      sections: ['Match', 'Validate', 'Respond'],
      match: true,
      item: ['HTTP 5'],
      name: true,
    },
    'the mock shows its figures, its protocols, and the route in Match and Respond steps',
  );
  // Match and Respond fold away and open again, keeping their summaries in view.
  const sectionState = () =>
    run(
      "['match','respond'].map(key=>[(document.querySelector(`[data-mock-section=${key}]`).open?'true':'false'),document.querySelector(`[data-mock-section=${key}]`).open,Boolean(document.querySelector(`[data-mock-section=${key}] .ui-expansion-heading small`).textContent.trim())])",
    );
  await run("document.querySelector('[data-mock-section=match] > summary').click()");
  await pause(50);
  assert.deepEqual(
    await sectionState(),
    [
      ['false', false, true],
      ['true', true, true],
    ],
    'the Match section folds away and keeps its summary',
  );
  await run("document.querySelector('[data-mock-sections-all]').click()");
  await pause(50);
  assert.deepEqual(
    [
      await sectionState(),
      await run("document.querySelector('[data-mock-sections-all]').textContent.trim()"),
    ],
    [
      [
        ['false', false, true],
        ['false', false, true],
      ],
      'Expand all',
    ],
    'Collapse all folds both sections',
  );
  await run("clearToasts();document.querySelectorAll('[data-mock-route]')[1].click()");
  await pause(80);
  assert.equal(
    await run("document.querySelector('[data-mock-section=respond]').open?'true':'false'"),
    'false',
    'folded sections stay folded on another route',
  );
  await capture('mock-sections-collapsed.png');
  await run("document.querySelector('[data-mock-sections-all]').click()");
  await pause(50);
  assert.deepEqual(
    await sectionState(),
    [
      ['true', true, true],
      ['true', true, true],
    ],
    'Expand all opens both sections',
  );
  await run("document.querySelectorAll('[data-mock-route]')[0].click()");
  await pause(50);
  // The route list filters, and the route toolbar duplicates and switches routes off.
  const routeCount = () => run("document.querySelectorAll('[data-mock-route]').length");
  const allRoutes = (await routeCount()) as number;
  await run(
    "(()=>{const search=document.querySelector('[data-mock-route-search]');search.value='zz-none';search.dispatchEvent(new Event('input'));})()",
  );
  await pause(50);
  assert.deepEqual(
    [await routeCount(), await run("Boolean(document.querySelector('.mock-route-none'))")],
    [0, true],
    'a filter that matches nothing says so',
  );
  await run(
    "(()=>{const search=document.querySelector('[data-mock-route-search]');search.value='';search.dispatchEvent(new Event('input'));})()",
  );
  await pause(50);
  await run("document.querySelector('[data-mock-route-duplicate]').click()");
  await pause(100);
  assert.equal(await routeCount(), allRoutes + 1, 'the toolbar duplicates the route');
  await run("document.querySelector('#mock-route-enabled').click()");
  await pause(80);
  assert.deepEqual(
    await run(
      "[mocksStore.currentRoute(mocksStore.current()).enabled,document.querySelector('[data-mock-route].is-active').classList.contains('disabled')]",
    ),
    [false, true],
    'the switch turns the route off',
  );
  await run(
    'mocksStore.removeRoute(mocksStore.current().id,mocksStore.currentRoute(mocksStore.current()).id)',
  );
  await pause(150);
  await run('clearToasts()');
  await capture('mock-servers.png');
  await validationChecks(context);
  await streamingMocks(context);
  await pubSubMocks(context);
  await run(
    "for(const mock of state.mocks)void mocksStore.stop(mock.id);state=window.specsOriginal;view='Collections';render()",
  );
  await pause(200);
}

/** WebSocket, SSE, NDJSON, and gRPC routes, set up on the Mocks screen and called by real clients. */
async function streamingMocks({ window, run, capture }: SmokeContext) {
  const [port, grpcPort] = [await freePort(), await freePort()];
  await run(
    `mocksStore.create();const mock=state.mocks.at(-1);mock.port=${port};mock.routes=[];mocksStore.select(mock.id);mocksStore.touch(mock.id)`,
  );
  await pause(100);
  /** Adds a route on the screen with this protocol and path. */
  const addRoute = async (kind: string, routePath: string) => {
    await run("document.querySelector('[data-mock-add-route]').click()");
    await pause(80);
    await run(
      `(()=>{const select=document.querySelector('#mock-route-method');select.value=${JSON.stringify(kind)};select.dispatchEvent(new Event('change'));})()`,
    );
    await pause(80);
    await run(
      `(()=>{const input=document.querySelector('#mock-route-path');input.value=${JSON.stringify(routePath)};input.dispatchEvent(new Event('input'));})()`,
    );
    await pause(80);
  };
  /** Sets the selected route's message at `index` as if typed. */
  const typeMessage = (index: number, text: string) =>
    run(
      `(()=>{const field=document.querySelector('[data-mock-message="${index}"]');field.value=${JSON.stringify(text)};field.dispatchEvent(new Event('input'));})()`,
    );
  await addRoute('ndjson', '/jobs');
  await typeMessage(0, '{"job": "{{query.id}}", "status": "queued"}');
  await typeMessage(1, '{"job": "{{query.id}}", "status": "running"}');
  await typeMessage(2, '{"job": "{{query.id}}", "status": "done"}');
  await run(
    "document.querySelector('#mock-stream-interval').value='20';document.querySelector('#mock-stream-interval').dispatchEvent(new Event('input'))",
  );
  await addRoute('websocket', '/live');
  await addRoute('sse', '/prices');
  assert.deepEqual(
    await run(
      "(()=>{const route=mocksStore.currentRoute(mocksStore.current());return [route.kind,route.stream.messages.length,route.stream.repeat===true,document.querySelector('[data-mock-route-kind]').dataset.mockRouteKind,document.querySelectorAll('[data-mock-message-event]').length,document.querySelector('.mock-composer-origin').textContent.trim().startsWith('http://')];})()",
    ),
    ['sse', 2, true, 'sse', 2, true],
    'choosing SSE gives the route repeating sample events with event names',
  );
  await run(
    "clearToasts();(element=>{let box=element.parentElement;while(box&&!(box.scrollHeight>box.clientHeight&&/auto|scroll/.test(getComputedStyle(box).overflowY)))box=box.parentElement;if(box)box.scrollTop+=element.getBoundingClientRect().top-box.getBoundingClientRect().top-12;})(document.querySelector('[data-mock-stream]'))",
  );
  await pause(100);
  await capture('mock-stream-sse.png');
  // gRPC: choosing it opens the schema panel; the schema's methods can each get a route.
  await addRoute('grpc', '/shop.Orders/Watch');
  assert.equal(
    await run(
      "Boolean(document.querySelector('[data-mock-grpc-panel]'))&&Boolean(document.querySelector('.mock-grpc-missing'))&&document.querySelector('.mock-composer-origin').textContent.includes('grpc://')",
    ),
    true,
    'a gRPC route opens the schema panel and asks for the schema',
  );
  await run(
    "document.querySelector('[data-mock-setting-close]').click();document.querySelector('[data-mock-open-grpc-settings]').click()",
  );
  await pause(80);
  assert.deepEqual(
    await run(
      "[document.querySelector('[data-mock-grpc-settings]').getAttribute('aria-expanded'),document.querySelector('[data-mock-grpc-settings]').dataset.mockSettingTone,document.querySelector('[data-mock-grpc-settings] [data-mock-setting-status]').textContent.trim()]",
    ),
    ['true', 'warning', 'Needs schema'],
    'the route’s missing-schema notice opens gRPC settings, whose tile says it needs a schema',
  );
  await run(
    `setEditorText('#mock-grpc-proto',${JSON.stringify(ORDERS_PROTO)});(()=>{const input=document.querySelector('#mock-grpc-port');input.value='${grpcPort}';input.dispatchEvent(new Event('change'));})()`,
  );
  let methods = 0;
  for (let attempt = 0; attempt < 40 && methods < 2; attempt++) {
    await pause(50);
    methods = (await run("document.querySelectorAll('.mock-grpc-methods li').length")) as number;
  }
  assert.equal(methods, 2, 'the schema’s methods are listed');
  await typeMessage(0, '{"id": "{{body.id}}", "status": "packed"}');
  await run("document.querySelector('[data-mock-add-message]').click()");
  await pause(50);
  await typeMessage(1, '{"id": "{{body.id}}", "status": "shipped"}');
  await run(
    "document.querySelector('#mock-stream-interval').value='20';document.querySelector('#mock-stream-interval').dispatchEvent(new Event('input'))",
  );
  await run("document.querySelector('[data-mock-grpc-add-routes]').click()");
  await pause(100);
  await typeMessage(0, '{"id": "{{body.id}}", "status": "paid"}');
  assert.deepEqual(
    await run('state.mocks.at(-1).routes.map(route=>`${route.kind} ${route.path}`)'),
    [
      'ndjson /jobs',
      'websocket /live',
      'sse /prices',
      'grpc /shop.Orders/Watch',
      'grpc /shop.Orders/Get',
    ],
    'routes for each protocol, with one added per missing schema method',
  );
  // Each protocol is labelled: endpoints, route groups, the route card, and its rules' words.
  assert.deepEqual(
    await run(
      "(()=>({endpoints:[...document.querySelectorAll('[data-mock-endpoint]')].map(item=>item.dataset.mockEndpoint+' '+item.querySelector('code').textContent.trim()),groups:[...document.querySelectorAll('[data-mock-route-group-toggle]')].map(item=>item.textContent.replace(/\\s+/g,' ').trim()),card:document.querySelector('[data-mock-protocol-card]').dataset.mockProtocolCard,title:document.querySelector('.mock-protocol-copy strong').textContent.trim(),flow:[...document.querySelectorAll('.mock-protocol-flow li')].map(item=>item.textContent.trim()),tryIt:document.querySelector('[data-mock-try]').textContent.trim(),rules:document.querySelector('[data-mock-rules-title]').textContent.trim(),targets:[...document.querySelectorAll('[data-mock-rule-target=\"0\"]')[0].closest('.ui-select').querySelectorAll('[role=option]')].map(item=>item.textContent.trim())}))()",
    ),
    {
      endpoints: [
        `http http://localhost:${port}`,
        `websocket ws://localhost:${port}`,
        `grpc localhost:${grpcPort}`,
      ],
      groups: ['WebSocket1', 'SSE1', 'NDJSON1', 'gRPC2'],
      card: 'grpc',
      title: 'gRPC methodUnary',
      flow: ['Client calls (unary)', 'answers with message 1', 'ends with status 0'],
      tryIt: `grpcurl -plaintext -proto schema.proto -d '{}' localhost:${grpcPort} shop.Orders/Get`,
      rules: 'Call rules',
      targets: ['Metadata', 'Message field'],
    },
    'a gRPC route explains itself: its endpoint, group, kind, flow, a command to try, and call rules',
  );
  // "Run in terminal" shows the Terminal tab with the command at a new terminal's prompt, not
  // run: the main process stages it in the terminal's own view, and this window never types.
  const tryCommand = await run("document.querySelector('[data-mock-try]').textContent.trim()");
  // Tall enough that the terminal shows every row the command wraps onto.
  await run('devTools.height=420;render()');
  await run("document.querySelector('[data-mock-try-terminal]').click()");
  const terminalView = await (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = window.contentView.children.find(
        (child): child is WebContentsView =>
          child instanceof WebContentsView && child.webContents.getURL().includes('terminal.html'),
      );
      if (found && !found.webContents.isLoading()) return found;
      await pause(100);
    }
    throw new Error('Run in terminal did not show the terminal.');
  })();
  // The harness hides the app's window, and the view with it; it keeps drawing anyway.
  terminalView.webContents.setBackgroundThrottling(false);
  const term = createHarness({ webContents: terminalView.webContents } as unknown as BrowserWindow);
  let typed = '';
  for (let attempt = 0; attempt < 100 && !typed.includes(tryCommand); attempt++) {
    await pause(100);
    typed = await term.run(
      "document.querySelector('.terminal-host.active .xterm-rows')?.textContent ?? ''",
    );
  }
  await pause(800);
  assert.deepEqual(
    {
      ...(await term.run(
        `(()=>{const text=document.querySelector('.terminal-host.active .xterm-rows').textContent;return {atPrompt:text.includes(${JSON.stringify(tryCommand)}),once:text.split(${JSON.stringify(tryCommand)}).length===2,ran:/not found|No such file|Failed to dial|error/i.test(text)}})()`,
      )),
      ...(await run('({open:devTools.open,tab:devTools.tab})')),
    },
    { atPrompt: true, once: true, ran: false, open: true, tab: 'Terminal' },
    'Run in terminal puts the command at a new terminal’s prompt, on the Terminal tab, without running it',
  );
  await capture('mock-try-terminal.png');
  await run("document.querySelector('[data-dev-tools-close]')?.click()");
  await pause(200);
  // Route groups fold like folders in the explorer.
  await run("document.querySelector('[data-mock-route-group-toggle=sse]').click()");
  await pause(50);
  assert.deepEqual(
    await run(
      "[document.querySelector('[data-mock-route-group-toggle=sse]').getAttribute('aria-expanded'),getComputedStyle(document.querySelector('[data-mock-route-group=sse] .mock-route-items')).display]",
    ),
    ['false', 'none'],
    'a route group folds away',
  );
  await run("document.querySelector('[data-mock-route-group-toggle=sse]').click()");
  await pause(50);
  await run(
    "document.querySelector('[data-mock-route-group=websocket] [data-mock-route]').click()",
  );
  await pause(100);
  assert.deepEqual(
    await run(
      "[[...document.querySelectorAll('.mock-protocol-flow li')].map(item=>item.textContent.trim()).join(' → '),document.querySelector('[data-mock-try]').textContent.trim(),document.querySelector('[data-mock-rules-title]').textContent.trim(),[...document.querySelectorAll('[data-mock-rule-target=\"0\"]')[0].closest('.ui-select').querySelectorAll('[role=option]')].map(item=>item.textContent.trim()).join(),document.querySelector('.mock-stream .table-label strong').textContent.trim()]",
    ),
    [
      'Client connects → sends 1 message → replies to each client message',
      `npx wscat -c 'ws://localhost:${port}/live'`,
      'Handshake rules',
      'Query,Header,Cookie,Path',
      'Messages sent',
    ],
    'a WebSocket route explains its connection, and its handshake has no body to check',
  );
  await capture('mock-protocol-websocket.png');
  // The add-route menu makes a route for a protocol straight away.
  await run("document.querySelector('[data-mock-add-route-kind]').click()");
  await pause(100);
  await run(
    "[...document.querySelectorAll('.action-menu:popover-open [role=menuitem]')].find(item=>item.textContent.includes('NDJSON')).click()",
  );
  await pause(150);
  assert.deepEqual(
    await run(
      "(()=>{const route=mocksStore.currentRoute(mocksStore.current());return [route.kind,route.path,route.headers.some(row=>row.key.toLowerCase()==='content-type'),document.querySelector('.mock-stream .table-label strong').textContent.trim()];})()",
    ),
    ['ndjson', '/stream', false, 'Lines'],
    'the add-route menu creates a stream route of the chosen protocol',
  );
  await run(
    'mocksStore.removeRoute(state.mocks.at(-1).id,mocksStore.currentRoute(state.mocks.at(-1)).id)',
  );
  await pause(100);
  await run("document.querySelector('[data-mock-route-group=grpc] [data-mock-route]').click()");
  await pause(100);
  await run(
    "clearToasts();(element=>{let box=element.parentElement;while(box&&!(box.scrollHeight>box.clientHeight&&/auto|scroll/.test(getComputedStyle(box).overflowY)))box=box.parentElement;if(box)box.scrollTop+=element.getBoundingClientRect().top-box.getBoundingClientRect().top-12;})(document.querySelector('[data-mock-grpc-panel]'))",
  );
  await pause(100);
  await capture('mock-grpc.png');
  await run("document.querySelector('[data-mock-start]').click()");
  let running = false;
  for (let attempt = 0; attempt < 60 && !running; attempt++) {
    await pause(50);
    running = (await run('mocksStore.running.has(state.mocks.at(-1).id)')) as boolean;
  }
  assert.equal(running, true, 'the mock starts with its streaming and gRPC routes');
  const base = `http://127.0.0.1:${port}`;
  assert.equal(
    await (await fetch(`${base}/jobs?id=7`)).text(),
    '{"job":"7","status":"queued"}\n{"job":"7","status":"running"}\n{"job":"7","status":"done"}\n',
    'the NDJSON route streams its lines',
  );
  const prices = await fetch(`${base}/prices`);
  assert.equal(
    prices.headers.get('content-type'),
    'text/event-stream; charset=utf-8',
    'the SSE route is sent as an event stream',
  );
  const reader = prices.body!.getReader();
  let events = '';
  while ((events.match(/\n\n/g) ?? []).length < 3)
    events += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.match(
    events,
    /^event: price\nid: 1\ndata: \{"price": \d+\}\n\nevent: price\nid: 2\n.*\n\nevent: price\nid: 3\n/s,
    'the SSE route repeats its events',
  );
  const socket = new WebSocket(`ws://127.0.0.1:${port}/live`);
  const said: string[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.on('error', reject);
    socket.on('message', (data) => {
      said.push(data.toString());
      if (said.length === 1) socket.send('{"hi": 1}');
      else resolve();
    });
  });
  socket.close();
  assert.match(
    said[0],
    /^\{"type": "welcome", "at": "\d{4}-/,
    'the WebSocket route greets the client',
  );
  assert.equal(said[1], '{"echo": {"hi": 1}}', 'and echoes each message back');
  const definition = loader.fromJSON(parse(ORDERS_PROTO, { keepCase: true }).root.toJSON(), {
    keepCase: true,
  });
  const shop = grpc.loadPackageDefinition(definition).shop as unknown as {
    Orders: new (
      address: string,
      credentials: grpc.ChannelCredentials,
    ) => grpc.Client & Record<string, (...args: unknown[]) => unknown>;
  };
  const client = new shop.Orders(`127.0.0.1:${grpcPort}`, grpc.credentials.createInsecure());
  try {
    const order = await new Promise<{ id: string; status: string }>((resolve, reject) =>
      client.Get({ id: 'A1' }, (error: Error | null, value: { id: string; status: string }) =>
        error ? reject(error) : resolve(value),
      ),
    );
    assert.deepEqual(order, { id: 'A1', status: 'paid' }, 'the unary gRPC route answers');
    const updates: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const call = client.Watch({ id: 'A1' }) as grpc.ClientReadableStream<{ status: string }>;
      call.on('data', (update) => updates.push(update.status));
      call.on('end', resolve);
      call.on('error', reject);
    });
    assert.deepEqual(updates, ['packed', 'shipped'], 'the server-streaming gRPC route streams');
  } finally {
    client.close();
  }
  await run("document.querySelector('[data-mock-tab=Log]').click()");
  await pause(150);
  assert.deepEqual(
    await run(
      "[...document.querySelectorAll('[data-mock-log-row] .method')].map(badge=>badge.textContent.trim()).sort()",
    ),
    ['NDJSON', 'SSE', 'WS', 'gRPC', 'gRPC'],
    'the log shows each exchange with its protocol',
  );
  await run("document.querySelector('[data-mock-log-row]').click()");
  await pause(100);
  assert.deepEqual(
    await run(
      "['requests','errors','protocols'].map(key=>document.querySelector(`[data-mock-stat=${key}] dd`).textContent.trim())",
    ),
    ['5', '0 (0%)', 'WebSocket · SSE · NDJSON · gRPC'],
    'the figures count the requests the streams and calls served',
  );
  await run('clearToasts()');
  await capture('mock-stream-log.png');
  await run(
    "document.querySelector('[data-mock-tab=Routes]').click();void mocksStore.stop(state.mocks.at(-1).id)",
  );
  await pause(200);
}

/**
 * TRACE and CONNECT in the request's and route's method boxes, and Socket.IO and MQTT routes set
 * up on the Mocks screen and reached by real clients.
 */
async function pubSubMocks({ run, capture }: SmokeContext) {
  const options = (selector: string) =>
    run(
      `[...document.querySelector(${JSON.stringify(selector)}).closest('.ui-select').querySelectorAll('[role=option]')].map(item=>item.dataset.value??item.getAttribute('data-value')??item.textContent.trim())`,
    ) as Promise<string[]>;
  const [port, brokerPort] = [await freePort(), await freePort()];
  await run(
    `(()=>{mocksStore.create();const mock=state.mocks.at(-1);mock.port=${port};mock.routes=[];mocksStore.select(mock.id);mocksStore.touch(mock.id);})()`,
  );
  await pause(100);
  const addRoute = async (kind: string, routePath: string) => {
    await run("document.querySelector('[data-mock-add-route]').click()");
    await pause(80);
    await run(
      `(()=>{const select=document.querySelector('#mock-route-method');select.value=${JSON.stringify(kind)};select.dispatchEvent(new Event('change'));})()`,
    );
    await pause(80);
    await run(
      `(()=>{const input=document.querySelector('#mock-route-path');input.value=${JSON.stringify(routePath)};input.dispatchEvent(new Event('input'));})()`,
    );
    await pause(80);
  };
  const type = (selector: string, value: string) =>
    run(
      `(()=>{const field=document.querySelector(${JSON.stringify(selector)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input'));})()`,
    );
  await addRoute('CONNECT', '/api.example.test:443');
  const routeMethods = (await options('#mock-route-method')).join(' ');
  assert.match(routeMethods, /TRACE/, 'routes can answer TRACE');
  assert.match(routeMethods, /CONNECT/, 'and CONNECT');
  assert.match(routeMethods, /socketio/, 'and serve Socket.IO');
  assert.match(routeMethods, /mqtt/, 'and MQTT');

  await addRoute('socketio', '/orders');
  assert.deepEqual(
    await run(
      "[mocksStore.currentRoute(mocksStore.current()).kind,document.querySelectorAll('[data-mock-message-event]').length,document.querySelector('#mock-route-path').getAttribute('aria-label'),document.querySelector('.mock-stream .table-label strong').textContent.trim()]",
    ),
    ['socketio', 1, 'Socket.IO namespace', 'Events emitted'],
    'a Socket.IO route has named events and a namespace',
  );
  await type('[data-mock-message-event="0"]', 'order');
  await type('[data-mock-message="0"]', '{"id": "A1", "team": "{{headers.x-team}}"}');
  await run(
    "(()=>{const field=document.querySelector('#mock-stream-reply');field.value='{\"got\": {{body}}}';field.dispatchEvent(new Event('input'));})()",
  );
  await addRoute('mqtt', 'devices/:id/status');
  await run(
    `(()=>{const input=document.querySelector('#mock-mqtt-port');input.value='${brokerPort}';input.dispatchEvent(new Event('change'));})()`,
  );
  await type('[data-mock-message="0"]', '{"device": "{{params.id}}", "online": true}');
  await run(
    "(()=>{const field=document.querySelector('#mock-stream-reply');field.value='{\"ack\": {{body}}}';field.dispatchEvent(new Event('input'));})()",
  );
  await pause(100);
  assert.deepEqual(
    await run(
      "(()=>({endpoints:[...document.querySelectorAll('[data-mock-endpoint]')].map(item=>item.dataset.mockEndpoint+' '+item.querySelector('code').textContent.trim()),card:document.querySelector('[data-mock-protocol-card]').dataset.mockProtocolCard,flow:[...document.querySelectorAll('.mock-protocol-flow li')].map(item=>item.textContent.trim()),tryIt:document.querySelector('[data-mock-try]').textContent.trim(),rules:document.querySelector('[data-mock-rules-title]').textContent.trim(),validate:Boolean(document.querySelector('[data-mock-section=validate]')),origin:document.querySelector('.mock-composer-origin').textContent.trim()}))()",
    ),
    {
      endpoints: [
        `http http://localhost:${port}`,
        `socketio http://localhost:${port}`,
        `mqtt mqtt://localhost:${brokerPort}`,
        `mqtt ws://localhost:${port}/mqtt`,
      ],
      card: 'mqtt',
      flow: [
        'Client subscribes',
        'sends 1 message',
        'repeats until the client leaves',
        'replies on /reply to each message',
      ],
      tryIt: `mosquitto_sub -h 127.0.0.1 -p ${brokerPort} -v -t 'devices/example/status'`,
      rules: 'Message rules',
      validate: false,
      origin: `mqtt://127.0.0.1:${brokerPort}/`,
    },
    'an MQTT route explains its broker, flow, and a command to try',
  );
  await run(
    "clearToasts();document.querySelector('[data-mock-protocol-card]').scrollIntoView({block:'start'})",
  );
  await pause(100);
  await capture('mock-protocol-mqtt.png');

  await run("document.querySelector('[data-mock-start]').click()");
  let running = false;
  for (let attempt = 0; attempt < 80 && !running; attempt++) {
    await pause(50);
    running = (await run('mocksStore.running.has(state.mocks.at(-1).id)')) as boolean;
  }
  assert.equal(running, true, 'the mock starts with its Socket.IO and MQTT routes');
  const client = socketIO(`http://127.0.0.1:${port}/orders`, {
    transports: ['websocket'],
    extraHeaders: { 'X-Team': 'payments' },
  });
  const device = await mqtt.connectAsync(`mqtt://127.0.0.1:${brokerPort}`);
  try {
    const order = await new Promise((resolve) => client.once('order', resolve));
    assert.deepEqual(order, { id: 'A1', team: 'payments' }, 'the Socket.IO route emits its event');
    assert.deepEqual(
      await client.emitWithAck('pay', { total: 5 }),
      { got: { total: 5 } },
      'and answers an event’s acknowledgement',
    );
    const received: string[] = [];
    // The broker also hands the client its own message back, as brokers do; that one is skipped.
    device.on('message', (topic, payload) => {
      if (String(payload) !== '{"ping": 1}') received.push(`${topic} ${payload}`);
    });
    await device.subscribeAsync(['devices/42/status', 'devices/42/status/reply']);
    await device.publishAsync('devices/42/status', '{"ping": 1}');
    for (let attempt = 0; attempt < 100 && received.length < 2; attempt++) await pause(30);
    assert.deepEqual(
      received.sort(),
      [
        'devices/42/status {"device": "42", "online": true}',
        'devices/42/status/reply {"ack": {"ping": 1}}',
      ].sort(),
      'the MQTT route publishes to the subscriber and replies to its message',
    );
  } finally {
    client.close();
    await device.endAsync(true);
  }
  await run("document.querySelector('[data-mock-tab=Log]').click()");
  await pause(200);
  assert.deepEqual(
    await run(
      "[...new Set([...document.querySelectorAll('[data-mock-log-row] .method')].map(badge=>badge.textContent.trim()))].sort()",
    ),
    ['MQTT', 'SIO'],
    'the log shows Socket.IO and MQTT exchanges',
  );
  await run(
    "document.querySelector('[data-mock-tab=Routes]').click();void mocksStore.stop(state.mocks.at(-1).id)",
  );
  await pause(200);

  // The request's method box offers TRACE and CONNECT beside the other methods.
  await run("view='Collections';render()");
  await pause(150);
  const requestMethods = (await run(
    "[...document.querySelectorAll('[data-http-method]')].map(item=>item.dataset.httpMethod)",
  )) as string[];
  assert.ok(
    requestMethods.includes('TRACE') && requestMethods.includes('CONNECT'),
    `requests can be TRACE or CONNECT (${requestMethods.join(', ')})`,
  );
  await run("view='Mocks';render()");
  await pause(100);
}

/** Request validation, set up on the screen and answered by the running mock. */
async function validationChecks({ run, capture }: SmokeContext) {
  await run(
    "(()=>{const mock=mocksStore.current();const route=mocksStore.addRoute(mock.id);mocksStore.updateRoute(mock.id,route.id,{method:'POST',path:'/validated',status:201,body:'{\"ok\":true}'});})()",
  );
  await pause(100);
  await run("document.querySelector('#mock-validate-enabled').click()");
  await pause(80);
  // A required header, typed into the checks table's last row.
  await run(
    "(()=>{const table='[data-rules-kind=validation]';const target=document.querySelector(`${table} [data-mock-rule-target=\"0\"]`);target.value='header';target.dispatchEvent(new Event('change'));const name=document.querySelector(`${table} [data-mock-rule-name=\"0\"]`);name.value='X-Api-Key';name.dispatchEvent(new Event('input'));const operator=document.querySelector(`${table} [data-mock-rule-operator=\"0\"]`);operator.value='exists';operator.dispatchEvent(new Event('change'));})()",
  );
  await pause(80);
  // A schema made from a sample, then tightened.
  await run(
    `(()=>{const sample=document.querySelector('#mock-validate-sample');sample.value=${JSON.stringify('{"sku": "A-1", "quantity": 2}')};sample.dispatchEvent(new Event('input'));})()`,
  );
  await pause(50);
  await run("document.querySelector('[data-mock-schema-infer]').click()");
  await pause(100);
  assert.deepEqual(
    JSON.parse(
      (await run('mocksStore.currentRoute(mocksStore.current()).validation.schema')) as string,
    ),
    {
      type: 'object',
      required: ['sku', 'quantity'],
      properties: { sku: { type: 'string' }, quantity: { type: 'integer' } },
    },
    'a schema is made from the sample body',
  );
  await run(
    `setEditorText('#mock-validate-schema',${JSON.stringify(
      JSON.stringify(
        {
          type: 'object',
          required: ['sku', 'quantity'],
          properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } },
        },
        null,
        2,
      ),
    )})`,
  );
  await run(
    `(()=>{const sample=document.querySelector('#mock-validate-sample');sample.value=${JSON.stringify('{"quantity": 0}')};sample.dispatchEvent(new Event('input'));})()`,
  );
  await pause(500);
  assert.deepEqual(
    await run(
      "[document.querySelector('[data-mock-section=validate] .ui-expansion-heading small').textContent.trim(),document.querySelector('[data-mock-section=validate] .ui-expansion-badge').textContent.trim(),[...document.querySelectorAll('[data-mock-validate-result] li')].map(item=>item.textContent.trim())]",
    ),
    [
      '1 check and a body schema; failures get 422',
      '1 check · schema',
      ['body sku is required', 'body quantity must be at least 1'],
    ],
    'the Validate step sums up its checks and tests a body without sending it',
  );
  await run(
    "clearToasts();document.querySelector('[data-mock-section=validate]').scrollIntoView({block:'start'});document.documentElement.scrollTop=0",
  );
  await capture('mock-validation.png');
  const url = (await run('mocksStore.url(mocksStore.current())')) as string;
  const failed = await fetch(`${url}/validated`, { method: 'POST', body: '{"quantity":0}' });
  assert.deepEqual(
    [failed.status, await failed.json()],
    [
      422,
      {
        error: 'Request validation failed',
        problems: [
          { in: 'header', name: 'X-Api-Key', message: 'header X-Api-Key must be present' },
          { in: 'body', name: 'sku', message: 'body sku is required' },
          { in: 'body', name: 'quantity', message: 'body quantity must be at least 1' },
        ],
      },
    ],
    'a request that fails validation gets 422 and the problems',
  );
  const passed = await fetch(`${url}/validated`, {
    method: 'POST',
    headers: { 'X-Api-Key': 'k' },
    body: '{"sku":"A-1","quantity":2}',
  });
  assert.equal(passed.status, 201, 'a request that passes gets the route’s answer');
  // Number comparisons: a query check that limit is at most 100, chosen from the grouped menu.
  await run(
    "document.querySelector('[data-rules-kind=validation] [data-mock-rule-operator=\"1\"]').closest('.ui-select').querySelector('.ui-select-trigger').click()",
  );
  await pause(120);
  assert.deepEqual(
    await run(
      "[...new Set([...document.querySelectorAll('.ui-select-menu:popover-open .ui-select-group')].map(item=>item.textContent.trim()))].filter(Boolean)",
    ),
    ['Text', 'Pattern', 'List', 'Number', 'Length', 'Date', 'Kind of value', 'Presence'],
    'comparisons are grouped by what they compare',
  );
  await run('clearToasts()');
  await capture('mock-rule-operators.png');
  await run(
    "document.querySelector('[data-rules-kind=validation] [data-mock-rule-operator=\"1\"]').closest('.ui-select').querySelector('.ui-select-menu').hidePopover()",
  );
  await run(
    "(()=>{const table='[data-rules-kind=validation]';const operator=document.querySelector(`${table} [data-mock-rule-operator=\"1\"]`);operator.value='lte';operator.dispatchEvent(new Event('change'));const value=document.querySelector(`${table} [data-mock-rule-value=\"1\"]`);value.value='100';value.dispatchEvent(new Event('input'));const name=document.querySelector(`${table} [data-mock-rule-name=\"1\"]`);name.value='limit';name.dispatchEvent(new Event('input'));})()",
  );
  await pause(500);
  const tooMany = await fetch(`${url}/validated?limit=500`, {
    method: 'POST',
    headers: { 'X-Api-Key': 'k' },
    body: '{"sku":"A-1","quantity":2}',
  });
  assert.deepEqual(
    [
      tooMany.status,
      (await tooMany.json()).problems.map((problem: { message: string }) => problem.message),
    ],
    [422, ['query parameter limit must be at most 100']],
    'a number comparison fails a request whose value is too large',
  );
  await run("document.querySelector('[data-mock-tab=Log]').click()");
  await pause(150);
  await run(
    "[...document.querySelectorAll('[data-mock-log-row]')].find(row=>row.textContent.includes('422')).click()",
  );
  await pause(100);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-mock-log-detail] li')].some(item=>item.textContent.includes('Validation failed, so it got 422'))",
    ),
    true,
    'the log explains why the request failed validation',
  );
  await run("document.querySelector('[data-mock-tab=Routes]').click()");
  await pause(50);
  await pathParamChecks(run, capture, url);
  await requestChecksAndExport(run, capture, url);
}

/** Request-level validation, regex rules, the API docs tab, and exporting the mock as a collection. */
async function requestChecksAndExport(
  run: SmokeContext['run'],
  capture: SmokeContext['capture'],
  url: string,
) {
  await run(
    "mocksStore.selectRoute(mocksStore.current().routes.find(route=>route.path==='/validated').id)",
  );
  await pause(100);
  await run(
    "(()=>{const types=document.querySelector('#mock-validate-content-types');types.value='application/json';types.dispatchEvent(new Event('input'));document.querySelector('#mock-validate-strict-query').click();})()",
  );
  await pause(500);
  const valid = { 'X-Api-Key': 'k', 'Content-Type': 'application/json' };
  const wrongType = await fetch(`${url}/validated?limit=5&debug=1`, {
    method: 'POST',
    headers: { ...valid, 'Content-Type': 'text/plain' },
    body: '{"sku":"A-1","quantity":2}',
  });
  assert.deepEqual(
    [
      wrongType.status,
      (await wrongType.json()).problems.map((problem: { message: string }) => problem.message),
    ],
    [
      422,
      [
        'header Content-Type must be application/json, not text/plain',
        'query parameter debug is not allowed',
      ],
    ],
    'validation refuses another content type and unknown query parameters',
  );
  // A regular expression check, written as a literal with a flag.
  await run(
    "(()=>{const route=mocksStore.currentRoute(mocksStore.current());route.validation.checks.push({enabled:true,target:'body',name:'sku',operator:'matches',value:'/^a-\\\\d+$/i'});mocksStore.touch(mocksStore.current().id);})()",
  );
  await pause(500);
  const send = (sku: string) =>
    fetch(`${url}/validated?limit=5`, {
      method: 'POST',
      headers: valid,
      body: JSON.stringify({ sku, quantity: 2 }),
    });
  assert.deepEqual(
    [(await send('A-1')).status, (await send('B-1')).status],
    [201, 422],
    'a regex check with the i flag passes A-1 and refuses B-1',
  );
  // The API docs tab documents the routes, in each format.
  await run(`document.querySelector('[data-mock-tab="API docs"]').click()`);
  await pause(150);
  assert.equal(
    await run("document.querySelectorAll('[data-mock-docs-operation]').length>0"),
    true,
    'the API docs tab lists the operations',
  );
  await run(`document.querySelector('[data-mock-docs-format="OpenAPI JSON"]').click()`);
  await pause(150);
  const openapi = JSON.parse(
    (await run("editorView('#mock-docs-source').state.doc.toString()")) as string,
  );
  assert.deepEqual(
    [
      openapi.openapi,
      Object.keys(openapi.paths['/validated'].post.requestBody.content),
      openapi.paths['/validated'].post.parameters.map((item: { name: string }) => item.name),
    ],
    ['3.0.3', ['application/json'], ['X-Api-Key', 'limit']],
    'the OpenAPI document carries the route’s validation',
  );
  await capture('mock-api-docs.png');
  // The same document becomes an API specification, opened in APIs.
  const specCount = (await run('specsStore.specs().length')) as number;
  await run("document.querySelector('[data-mock-docs-spec]').click()");
  await pause(150);
  assert.deepEqual(
    await run(
      `[specsStore.specs().length-${specCount},view,specsStore.current().name.startsWith(mocksStore.current().name),Boolean(specsStore.analysis(specsStore.current()).document?.paths?.['/validated']?.post),specsStore.errors(specsStore.current())]`,
    ),
    [1, 'APIs', true, true, 0],
    'the mock’s routes become an OpenAPI specification without errors',
  );
  await run(
    "state.specs.splice(state.specs.indexOf(specsStore.current()),1);view='Mocks';persist();render()",
  );
  await pause(100);
  await run("document.querySelector('[data-mock-tab=Routes]').click()");
  await pause(50);
  // Export: a new workspace collection, and a file in any export format.
  const before = (await run('state.requests.length')) as number;
  const routes = (await run('mocksStore.current().routes.length')) as number;
  await run('mocksStore.exportToCollection(mocksStore.current().id)');
  await pause(150);
  assert.deepEqual(
    await run(
      `[state.requests.length-${before},view,state.requests.find(request=>request.id===state.active).folder.startsWith(mocksStore.current().name)]`,
    ),
    [routes, 'Collections', true],
    'the mock’s routes become a collection, opened in the API client',
  );
  await run("view='Mocks';render()");
  await pause(100);
  await run('mocksStore.exportFile(mocksStore.current().id)');
  await pause(150);
  await run(
    "document.querySelector('#transfer-format').value='postman';document.querySelector('#transfer-format').dispatchEvent(new Event('change'));const archive=document.querySelector('#transfer-archive');if(archive.checked)archive.click();void 0",
  );
  await pause(150);
  assert.deepEqual(
    await run(
      "[Boolean(document.querySelector('[data-transfer-source]')),transferUI.exported.name.endsWith('.json'),JSON.parse(new TextDecoder().decode(transferUI.exported.data)).item.length>0]",
    ),
    [true, true, true],
    'the export dialog exports the mock’s routes as a Postman collection',
  );
  await capture('mock-export.png');
  await run(
    "document.querySelector('.collection-transfer').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  await pause(100);
  await run(
    '(()=>{const validation=mocksStore.currentRoute(mocksStore.current()).validation;validation.contentTypes=undefined;validation.strictQuery=undefined;validation.checks.pop();mocksStore.touch(mocksStore.current().id);})()',
  );
  await pause(300);
}

/** Path parameters: listed from the path, typed, tried with an example, and checked. */
async function pathParamChecks(
  run: SmokeContext['run'],
  capture: SmokeContext['capture'],
  url: string,
) {
  await run(
    "(()=>{const mock=mocksStore.current();const route=mocksStore.addRoute(mock.id);mocksStore.updateRoute(mock.id,route.id,{path:'/orders',body:'{\"id\":{{params.id}}}'});})()",
  );
  await pause(100);
  // Parameters are added to the path from the table, renamed, and removed.
  const addParam = async (name: string) => {
    await run(
      `(()=>{const input=document.querySelector('[data-mock-path-param-new]');input.value=${JSON.stringify(name)};input.dispatchEvent(new Event('input'));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`,
    );
    await pause(80);
  };
  const routePath = () => run('mocksStore.currentRoute(mocksStore.current()).path');
  await addParam('id');
  await addParam('size');
  await addParam('extra');
  assert.equal(
    await routePath(),
    '/orders/:id/:size/:extra',
    'the table adds parameters to the path',
  );
  await addParam('id');
  assert.equal(
    await run("document.querySelector('.mock-path-param-help')?.textContent.trim()"),
    'The path already has :id.',
    'a name the path already has is refused',
  );
  await run(
    "(()=>{const input=document.querySelector('[data-mock-path-param-new]');input.value='';input.dispatchEvent(new Event('input'));const name=document.querySelector('[data-mock-path-param-name=\"extra\"]');name.value='more';name.dispatchEvent(new Event('change'));})()",
  );
  await pause(80);
  assert.equal(
    await routePath(),
    '/orders/:id/:size/:more',
    'renaming a parameter renames it in the path',
  );
  await run('document.querySelector(\'[data-mock-path-param-remove="more"]\').click()');
  await pause(80);
  assert.equal(
    await routePath(),
    '/orders/:id/:size',
    'removing a parameter takes it out of the path',
  );
  assert.deepEqual(
    await run(
      "[...document.querySelectorAll('[data-mock-path-param]')].map(row=>row.dataset.mockPathParam)",
    ),
    ['id', 'size'],
    'the path parameters are listed from the path',
  );
  await run(
    "(()=>{const type=document.querySelector('[data-mock-path-param-type=\"id\"]');type.value='integer';type.dispatchEvent(new Event('change'));})()",
  );
  await pause(80);
  assert.equal(
    await run('mocksStore.currentRoute(mocksStore.current()).validation?.enabled===true'),
    true,
    'typing a path parameter turns validation on',
  );
  await run(
    "(()=>{const example=document.querySelector('[data-mock-path-param-example=\"id\"]');example.value='7';example.dispatchEvent(new Event('input'));const type=document.querySelector('[data-mock-path-param-type=\"size\"]');type.value='enum';type.dispatchEvent(new Event('change'));})()",
  );
  await pause(80);
  await run(
    "(()=>{const values=document.querySelector('[data-mock-path-param-values=\"size\"]');values.value='S, M, L';values.dispatchEvent(new Event('input'));const example=document.querySelector('[data-mock-path-param-example=\"size\"]');example.value='M';example.dispatchEvent(new Event('input'));})()",
  );
  await pause(500);
  assert.deepEqual(
    await run(
      "[document.querySelector('[data-mock-try]').textContent.trim(),document.querySelector('[data-mock-section=validate] .ui-expansion-heading small').textContent.trim()]",
    ),
    [`curl -i '${url}/orders/7/M'`, '2 path parameters; failures get 422'],
    'examples fill the try-it command, and validation counts the typed parameters',
  );
  await run(
    "clearToasts();document.querySelector('[data-mock-path-params]').scrollIntoView({block:'center'});document.documentElement.scrollTop=0",
  );
  await capture('mock-path-params.png');
  const good = await fetch(`${url}/orders/7/M`);
  assert.deepEqual(
    [good.status, await good.json()],
    [200, { id: 7 }],
    'fitting path parameters are answered',
  );
  const bad = await fetch(`${url}/orders/seven/XL`);
  assert.deepEqual(
    [
      bad.status,
      (await bad.json()).problems.map((problem: { message: string }) => problem.message),
    ],
    [422, ['path parameter id must be an integer', 'path parameter size must be one of S, M, L']],
    'path parameters that do not fit get 422 and say why',
  );
}

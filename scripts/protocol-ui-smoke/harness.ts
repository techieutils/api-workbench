import type { BrowserWindow } from 'electron';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTCPServer } from 'node:net';
import { Server as SocketIOServer } from 'socket.io';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { parse } from 'protobufjs';

/**
 * What every part of the protocol UI checks shares: disposable app data, the local servers the
 * live protocols connect to, and helpers that drive the window.
 */
export const temporary = mkdtempSync(path.join(os.tmpdir(), 'workbench-protocol-ui-'));
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const proto = `syntax = "proto3"; package ui;
service Echo {
 rpc Unary (Message) returns (Message);
 rpc Watch (Message) returns (stream Message);
 rpc Collect (stream Message) returns (Message);
 rpc Chat (stream Message) returns (stream Message);
}
message Message { string text = 1; }`;

/**
 * HTTP (SSE, NDJSON, and an OAuth token endpoint), WebSocket, gRPC, Socket.IO, and MQTT servers on
 * local ports.
 * `authentication` records the authorization each connection arrived with.
 */
export async function startServers() {
  const authentication: { protocol: string; authorization?: string }[] = [];
  const http = createServer((request, response) => {
    if (request.url === '/token') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"access_token":"TEST-OAUTH","token_type":"Bearer","expires_in":3600}');
      return;
    }
    authentication.push({
      protocol: request.url === '/ndjson' ? 'ndjson' : 'sse',
      authorization: request.headers.authorization,
    });
    if (request.url === '/ndjson') {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end('{"value":1}\n{"value":2}\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('id: 1\nevent: update\ndata: first\n\n');
    const timer = setTimeout(() => response.end('id: 2\nevent: update\ndata: second\n\n'), 250);
    response.on('close', () => clearTimeout(timer));
  });
  const sockets = new WebSocketServer({ server: http });
  sockets.on('connection', (socket, request) => {
    authentication.push({ protocol: 'websocket', authorization: request.headers.authorization });
    socket.on('message', (data, binary) => socket.send(data, { binary }));
  });
  const rpc = new grpc.Server();
  rpc.addService(loader.fromJSON(parse(proto).root.toJSON())['ui.Echo'] as grpc.ServiceDefinition, {
    unary: (call: grpc.ServerUnaryCall<object, object>, reply: grpc.sendUnaryData<object>) => {
      authentication.push({
        protocol: 'grpc',
        authorization: String(call.metadata.get('authorization')[0] || ''),
      });
      reply(null, call.request);
    },
    watch: (call: grpc.ServerWritableStream<object, object>) => {
      call.write({ text: 'stream-one' });
      call.write({ text: 'stream-two' });
      call.end();
    },
    collect: (
      call: grpc.ServerReadableStream<{ text: string }, object>,
      reply: grpc.sendUnaryData<object>,
    ) => {
      const values: string[] = [];
      call.on('data', (value) => values.push(value.text));
      call.on('end', () => reply(null, { text: values.join(',') }));
    },
    chat: (call: grpc.ServerDuplexStream<object, object>) => {
      call.on('data', (value) => call.write(value));
      call.on('end', () => call.end());
    },
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  // Socket.IO answers its own upgrades, so it has a server of its own beside the WebSocket one.
  const ioHTTP = createServer();
  const io = new SocketIOServer(ioHTTP);
  io.on('connection', (socket) => {
    authentication.push({
      protocol: 'socketio',
      authorization: socket.handshake.headers.authorization,
    });
    socket.emit('welcome', 'hello');
    socket.on('echo', (value: unknown, ack?: (reply: unknown) => void) => {
      socket.emit('echo', value);
      if (typeof ack === 'function') ack({ received: value });
    });
  });
  ioHTTP.listen(0, '127.0.0.1');
  await once(ioHTTP, 'listening');
  const socketIOBase = `http://127.0.0.1:${(ioHTTP.address() as { port: number }).port}`;
  const { Aedes } = await import('aedes');
  const broker = await Aedes.createBroker();
  broker.authenticate = (_client, username, password, done) => {
    authentication.push({
      protocol: 'mqtt',
      authorization: username ? `${username}:${password?.toString() ?? ''}` : undefined,
    });
    done(null, true);
  };
  const mqttServer = createTCPServer((stream) => broker.handle(stream));
  mqttServer.listen(0, '127.0.0.1');
  await once(mqttServer, 'listening');
  const mqttURL = `mqtt://127.0.0.1:${(mqttServer.address() as { port: number }).port}`;
  const port = await new Promise<number>((resolve, reject) =>
    rpc.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  );
  return {
    authentication,
    base,
    port,
    socketIOBase,
    mqttURL,
    async close() {
      await io.close();
      await new Promise<void>((resolve) => broker.close(() => resolve()));
      mqttServer.close();
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      rpc.forceShutdown();
    },
  };
}
type Servers = Awaited<ReturnType<typeof startServers>>;

export function createHarness(window: BrowserWindow, servers: Servers) {
  const run = (code: string) =>
    window.webContents.executeJavaScript(code).catch((error) => {
      throw new Error(`Protocol UI evaluation failed: ${code.slice(0, 160)}`, { cause: error });
    });
  const wait = async (code: string) => {
    const deadline = Date.now() + 8000;
    while (!(await run(code))) {
      if (Date.now() > deadline)
        throw new Error(
          `Protocol UI timed out: ${code}\n${await run("document.querySelector('#protocol-response-panel')?.textContent || document.body.textContent.slice(0,500)")}`,
        );
      await pause(15);
    }
  };
  /** Picks a request type in the URL bar's type select, as a person choosing from it would. */
  const chooseType = async (protocol: string) => {
    await run(
      `(()=>{const select=document.querySelector('#request-protocol');select.value=${JSON.stringify(protocol)}==='http'?'http:'+(current().method||'GET'):${JSON.stringify(protocol)};select.dispatchEvent(new Event('change'));})()`,
    );
    await wait(
      `current().protocol===${JSON.stringify(protocol)}||(${JSON.stringify(protocol)}==='http'&&!current().protocol)`,
    );
  };
  /** Switches the request type, checking that it uses the full HTTP Auth template. */
  const select = async (protocol: string) => {
    await run(
      `(()=>{const select=document.querySelector('#request-protocol');select.value=${JSON.stringify(protocol)}==='http'?'http:'+(current().method||'GET'):${JSON.stringify(protocol)};select.dispatchEvent(new Event('change'));})()`,
    );
    await wait(
      `current().protocol===${JSON.stringify(protocol)} && Boolean(document.querySelector('[data-protocol-connect]'))`,
    );
    const tab = await run('protocolUIState(current()).tab');
    await run("document.querySelector('[data-protocol-tab=Auth]').click()");
    assert.equal(
      await run(
        "Boolean(document.querySelector('.authentication-layout')) && document.querySelectorAll('#auth option').length===15",
      ),
      true,
      `${protocol} uses the full HTTP Auth template`,
    );
    await run(`document.querySelector('[data-protocol-tab="${tab}"]').click()`);
  };
  const url = async (value: string) =>
    run(
      `document.querySelector('#url').value=${JSON.stringify(value)};document.querySelector('#url').dispatchEvent(new Event('input'))`,
    );
  const message = async (value: string) =>
    run(
      `document.querySelector('#protocol-message').value=${JSON.stringify(value)};document.querySelector('#protocol-message').dispatchEvent(new Event('input'))`,
    );
  const connect = async () => run("document.querySelector('[data-protocol-connect]').click()");
  const done = async () => wait("liveProtocols.get(current().id)?.phase==='closed'");
  // A real right-click: the button goes down and comes back up, as with a mouse.
  const rightClick = async (selector: string) => {
    const { x, y } = (await run(
      `(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'center'});const box=element.getBoundingClientRect();return {x:Math.round(box.left+20),y:Math.round(box.top+box.height/2)}})()`,
    )) as { x: number; y: number };
    window!.webContents.sendInputEvent({
      type: 'mouseDown',
      x,
      y,
      button: 'right',
      clickCount: 1,
    });
    await pause(30);
    window!.webContents.sendInputEvent({
      type: 'mouseUp',
      x,
      y,
      button: 'right',
      clickCount: 1,
    });
    await pause(150);
  };
  // Tabs that fit show no arrows; tabs that do not fit show a next arrow, which scrolls until
  // the last tab is in view and a previous arrow appears.
  const tabsReachable = (selector: string) =>
    run(
      `(async()=>{const strip=document.querySelector(${JSON.stringify(selector)});const frame=strip.closest('.ui-tabs-frame');const arrow=side=>frame.querySelector('[data-tabs-arrow='+side+']');if(strip.scrollWidth<=strip.clientWidth+1)return !arrow('prev')&&!arrow('next');strip.scrollLeft=0;await new Promise(done=>setTimeout(done,50));if(!arrow('next')){const shown=[...strip.children].filter(item=>item.getClientRects().length).at(-1);return Boolean(shown)&&shown.getBoundingClientRect().right<=strip.getBoundingClientRect().right-strip.clientLeft+1;}for(let step=0;step<12&&arrow('next');step++){arrow('next').click();await new Promise(done=>setTimeout(done,350));}const last=[...strip.children].filter(item=>item.getClientRects().length).at(-1).getBoundingClientRect();return last.right<=strip.getBoundingClientRect().right+1&&Boolean(arrow('prev'));})()`,
    );
  /**
   * Waits for the app, installs the page helpers, and opens a new "Live UI sample" request for
   * the checks to work on, so any part can run first.
   */
  async function prepare(): Promise<void> {
    // Copies land in window.timelineCopied, so they can be checked.
    await run(
      "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.timelineCopied=value;}}})",
    );
    await wait("Boolean(document.querySelector('#request-protocol'))");
    // Runs a trigger and resolves with the file the app saved through a temporary object URL.
    await run(
      "window.captureDownload=trigger=>{const create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;let blob,name;URL.createObjectURL=value=>{blob=value;return 'blob:capture';};HTMLAnchorElement.prototype.click=function(){name=this.download;};try{trigger();}finally{URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;}return blob?blob.text().then(text=>({name,text,mime:blob.type})):Promise.resolve(undefined);};void 0",
    );
    await run(
      "window.originalProtocolRequest=current().id;const request=makeRequest('Live UI sample','GET','https://');state.requests.push(request);openRequest(request.id);window.protocolRequestId=request.id",
    );
  }
  return {
    window,
    run,
    wait,
    prepare,
    base: servers.base,
    port: servers.port,
    socketIOBase: servers.socketIOBase,
    mqttURL: servers.mqttURL,
    authentication: servers.authentication,
    chooseType,
    select,
    url,
    message,
    connect,
    done,
    rightClick,
    tabsReachable,
  };
}
export type ProtocolContext = ReturnType<typeof createHarness>;

import type { Page } from '@playwright/test';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { expect, test } from './fixtures';

/**
 * One local server for the live protocols: WebSocket echoes each message back, /events streams
 * two server-sent events a moment apart, and /ndjson answers two JSON lines.
 */
let server: Server;
let base: string;
const handshakes: IncomingHttpHeaders[] = [];
test.beforeAll(async () => {
  server = createServer((request, response) => {
    handshakes.push(request.headers);
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
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, request) => {
    handshakes.push(request.headers);
    socket.on('message', (data, binary) => socket.send(data, { binary }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Turns the open request into a new one of `type`, as the method box offers. */
async function chooseType(window: Page, type: string) {
  await window
    .locator('.ui-select', { has: window.locator('#request-protocol') })
    .getByRole('combobox')
    .click();
  await window.locator(`[role=option][data-value="${type}"]`).click();
  await expect(window.locator('[data-protocol-connect]')).toBeVisible();
}
const connectButton = (window: Page) => window.locator('[data-protocol-connect]');
const responses = (window: Page) => window.locator('#protocol-response-panel');
/** Types into the first row of the Headers table, opening the cell with a double-click. */
async function editCell(window: Page, field: 'key' | 'value', text: string) {
  const panel = window.locator('#protocol-config-panel');
  await panel.getByRole('button', { name: `Edit row 1 ${field}`, exact: true }).dblclick();
  const input = panel.getByLabel(`Row 1 ${field}`, { exact: true });
  await input.fill(text);
  await input.press('Enter');
}
/** Types `text` as the outgoing message. */
async function compose(window: Page, text: string) {
  await window.locator('#protocol-message-editor .cm-content').click();
  await window.keyboard.press('ControlOrMeta+A');
  await window.keyboard.insertText(text);
}

test.describe('WebSocket', () => {
  test('connects, sends a message, receives its echo, and disconnects', async ({ window }) => {
    await chooseType(window, 'websocket');
    await window.locator('#url').fill(`ws://${base}/chat`);
    await connectButton(window).click();
    await expect(connectButton(window)).toHaveText(/Disconnect/);

    await compose(window, 'hello from e2e');
    await window.locator('[data-protocol-send]').click();
    await window.locator('[data-protocol-inspector=Timeline]').click();
    // Sent, then the echo received.
    await expect(
      responses(window).locator('[data-timeline-row]', { hasText: 'hello from e2e' }),
    ).toHaveCount(2);

    await connectButton(window).click();
    await expect(connectButton(window)).toHaveText(/Connect/);
  });

  test('headers set on the request are sent with the handshake', async ({ window }) => {
    await chooseType(window, 'websocket');
    await window.locator('#url').fill(`ws://${base}/with-headers`);
    await window.locator('[data-protocol-tab=Headers]').click();
    await editCell(window, 'key', 'X-Client');
    await editCell(window, 'value', 'workbench-e2e');
    await connectButton(window).click();
    await expect(connectButton(window)).toHaveText(/Disconnect/);
    expect(handshakes.at(-1)?.['x-client']).toBe('workbench-e2e');
    await connectButton(window).click();
  });

  test('a server that refuses the connection is reported', async ({ window }) => {
    await chooseType(window, 'websocket');
    await window.locator('#url').fill('ws://127.0.0.1:9/refused');
    await connectButton(window).click();
    await expect(connectButton(window)).toHaveText(/Connect/);
    await window.locator('[data-protocol-inspector=Timeline]').click();
    await expect(responses(window)).toContainText(/error|closed|failed/i);
  });
});

test.describe('server-sent events', () => {
  test('each event in the stream is listed as it arrives', async ({ window }) => {
    await chooseType(window, 'sse');
    await window.locator('#url').fill(`http://${base}/events`);
    await connectButton(window).click();
    await window.locator('[data-protocol-inspector=Timeline]').click();
    await expect(responses(window)).toContainText('first');
    await expect(responses(window)).toContainText('second');
    // The server ends the stream after its second event.
    await expect(connectButton(window)).toHaveText(/Connect/);
    expect(handshakes.at(-1)?.accept).toContain('text/event-stream');
  });
});

test.describe('NDJSON', () => {
  test('each line of the stream is listed as a message', async ({ window }) => {
    await chooseType(window, 'ndjson');
    await window.locator('#url').fill(`http://${base}/ndjson`);
    await connectButton(window).click();
    await window.locator('[data-protocol-inspector=Timeline]').click();
    await expect(responses(window)).toContainText('"value":1');
    await expect(responses(window)).toContainText('"value":2');
  });
});

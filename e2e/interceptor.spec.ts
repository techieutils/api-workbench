import { request as httpRequest } from 'node:http';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { freePort, startServer, type TestServer } from './server';

let api: TestServer;
test.beforeAll(async () => {
  api = await startServer();
});
test.afterAll(async () => {
  await api.close();
});

/**
 * Opens the Interceptor and starts it on a free port with HTTPS decryption off, since the test
 * app has no OS credential store to protect a certificate's key. Returns the proxy's port.
 */
async function startInterceptor(window: Page): Promise<number> {
  await window.locator('.rail [data-view="Interceptor"]').click();
  const state = window.locator('[data-interceptor-state]');
  await expect(state).toContainText('Stopped');
  await window.locator('[data-interceptor-decrypt]').setChecked(false);
  const port = await freePort();
  const input = window.locator('[data-interceptor-port]');
  await input.fill(String(port));
  await input.press('Tab');
  await window.locator('[data-interceptor-start]').click();
  await expect(state).toContainText(`Listening on 127.0.0.1:${port}`);
  return port;
}

interface Proxied {
  status: number;
  body: string;
}
/** Sends a request through the proxy the way an app configured to use it would. */
function viaProxy(
  proxyPort: number,
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<Proxied> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port: proxyPort, method, path: url, headers: options.headers },
      (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });
}
/** Opens a CONNECT tunnel through the proxy to the test API and sends one request inside it. */
function viaTunnel(proxyPort: number): Promise<string> {
  const target = new URL(api.url).host;
  return new Promise((resolve, reject) => {
    const connect = httpRequest({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: target,
    });
    connect.on('connect', (_response, socket) => {
      let text = '';
      socket.on('data', (chunk) => (text += chunk));
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
      socket.write(`GET /users/tunnelled HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
    });
    connect.on('error', reject);
    connect.end();
  });
}
const rows = (window: Page) => window.locator('[data-capture]');

test.describe('Interceptor', () => {
  test('starts, forwards and records traffic, and stops', async ({ window }) => {
    const port = await startInterceptor(window);
    await expect(window.getByText('Waiting for traffic')).toBeVisible();
    const proxied = await viaProxy(port, 'POST', `${api.url}/orders?page=2`, {
      headers: { 'content-type': 'application/json', 'x-trace': 'e2e-trace' },
      body: '{"item":"book"}',
    });
    expect(proxied.status).toBe(200);
    expect(JSON.parse(proxied.body)).toMatchObject({ method: 'POST', url: '/orders?page=2' });
    expect(api.received.at(-1)).toMatchObject({ body: '{"item":"book"}' });

    await expect(rows(window)).toHaveCount(1);
    await expect(rows(window).first()).toContainText('POST');
    await expect(rows(window).first()).toContainText('/orders?page=2');
    await expect(rows(window).first()).toContainText('200');

    await window.locator('[data-interceptor-stop]').click();
    await expect(window.locator('[data-interceptor-state]')).toContainText('Stopped');
    // The captures stay for inspection; the port no longer accepts connections.
    await expect(rows(window)).toHaveCount(1);
    await expect(viaProxy(port, 'GET', `${api.url}/users`)).rejects.toThrow(/ECONNREFUSED/);
  });

  test('the details show the request and response, headers and bodies', async ({ window }) => {
    const port = await startInterceptor(window);
    await viaProxy(port, 'POST', `${api.url}/orders`, {
      headers: { 'content-type': 'application/json', 'x-trace': 'e2e-trace' },
      body: '{"item":"book"}',
    });
    await rows(window).first().click();
    const detail = window.locator('[data-interceptor-detail]');
    await expect(detail).toContainText(`${api.url}/orders`);
    await window.locator('[data-interceptor-tab=Request]').click();
    await expect(detail).toContainText('x-trace');
    await expect(detail).toContainText('e2e-trace');
    await expect(detail.locator('.interceptor-body')).toContainText('"item": "book"');
    await window.locator('[data-interceptor-tab=Response]').click();
    await expect(detail).toContainText('set-cookie');
    await expect(window.locator('[data-interceptor-response-body]')).toContainText(
      '"method": "POST"',
    );
    await detail.getByRole('button', { name: 'Close details' }).click();
    await expect(detail).toHaveCount(0);
  });

  test('search, kind filters, and the row menu narrow the list', async ({ window }) => {
    const port = await startInterceptor(window);
    await viaProxy(port, 'GET', `${api.url}/users`);
    await viaProxy(port, 'DELETE', `${api.url}/missing`);
    // Nothing listens on this port, so the proxy records an error.
    const closed = await freePort();
    const failed = await viaProxy(port, 'GET', `http://127.0.0.1:${closed}/down`);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    await expect(rows(window)).toHaveCount(3);

    await expect(window.locator('[data-interceptor-filter=HTTP] .history-count')).toHaveText('2');
    await expect(window.locator('[data-interceptor-filter=Errors] .history-count')).toHaveText('1');
    await window.locator('[data-interceptor-filter=Errors]').click();
    await expect(rows(window)).toHaveCount(1);
    await expect(rows(window).first()).toContainText('/down');
    await window.locator('[data-interceptor-filter=All]').click();

    await window.locator('[data-interceptor-search]').fill('404');
    await expect(rows(window)).toHaveCount(1);
    await expect(rows(window).first()).toContainText('/missing');
    await window.locator('[data-interceptor-search]').fill('nothing-like-this');
    await expect(window.getByText('No matching traffic')).toBeVisible();
    await window.locator('[data-interceptor-search]').fill('');

    await rows(window).filter({ hasText: 'DELETE' }).click({ button: 'right' });
    const menu = window.locator('[data-capture-menu]');
    await expect(menu.locator('[data-menu-item=method]')).toContainText('DELETE');
    await menu.locator('[data-menu-item=method]').click();
    await expect(rows(window)).toHaveCount(1);
    await expect(rows(window).first()).toContainText('DELETE');

    await window.locator('[data-interceptor-clear]').click();
    await expect(rows(window)).toHaveCount(0);
    await expect(window.getByText('Waiting for traffic')).toBeVisible();
  });

  test('a capture saves as a request in the Intercepted folder', async ({ window }) => {
    const port = await startInterceptor(window);
    await viaProxy(port, 'PUT', `${api.url}/users/7?notify=yes`, {
      headers: { 'content-type': 'application/json', 'x-trace': 'saved' },
      body: '{"name":"Grace"}',
    });
    await rows(window).first().click();
    await window.locator('[data-interceptor-save]').click();
    await expect(window.getByText('Saved 1 request to Intercepted')).toBeVisible();

    // The saved request opens in the editor, ready to send again.
    await expect(window.locator('#url')).toHaveValue(`${api.url}/users/7?notify=yes`);
    await window.locator('[data-action=send]').click();
    await expect(window.locator('.response-meta')).toContainText('200');
    expect(api.received.at(-1)).toMatchObject({
      method: 'PUT',
      url: '/users/7?notify=yes',
      body: '{"name":"Grace"}',
    });
    expect(api.received.at(-1)?.headers['x-trace']).toBe('saved');
  });

  test('with Record off, traffic is forwarded but not listed', async ({ window }) => {
    const port = await startInterceptor(window);
    const record = window.locator('[data-interceptor-recording]');
    await record.setChecked(false);
    await expect(window.locator('[data-interceptor-state]')).toContainText('recording paused');
    const unrecorded = await viaProxy(port, 'GET', `${api.url}/users/unrecorded`);
    expect(unrecorded.status).toBe(200);
    expect(api.received.at(-1)?.url).toBe('/users/unrecorded');
    await expect(rows(window)).toHaveCount(0);

    await record.setChecked(true);
    await expect(window.locator('[data-interceptor-state]')).not.toContainText('paused');
    await viaProxy(port, 'GET', `${api.url}/users/recorded`);
    await expect(rows(window)).toHaveCount(1);
    await expect(rows(window).first()).toContainText('/users/recorded');
  });

  test('decrypting HTTPS needs the domains to decrypt', async ({ window }) => {
    await window.locator('.rail [data-view="Interceptor"]').click();
    await window.locator('[data-interceptor-decrypt]').setChecked(true);
    const domains = window.locator('[data-interceptor-domains]');
    const start = window.locator('[data-interceptor-start]');
    await domains.fill('');
    await expect(start).toBeDisabled();
    await expect(domains).toHaveAttribute('aria-invalid', 'true');
    await expect(window.locator('#interceptor-domains-help')).toContainText(
      'Required to decrypt HTTPS',
    );
    await domains.fill('example.com, api.test');
    await expect(start).toBeEnabled();
    await expect(domains).toHaveAttribute('aria-invalid', 'false');
    // Decryption off needs no domains.
    await domains.fill('');
    await window.locator('[data-interceptor-decrypt]').setChecked(false);
    await expect(start).toBeEnabled();
  });

  test('without decryption, a CONNECT tunnel is listed as a tunnel only', async ({ window }) => {
    const port = await startInterceptor(window);
    const answer = await viaTunnel(port);
    expect(answer).toContain('200 OK');
    expect(api.received.at(-1)?.url).toBe('/users/tunnelled');

    await window.locator('[data-interceptor-filter=Tunnels]').click();
    await expect(rows(window)).toHaveCount(1);
    await rows(window).first().click();
    await expect(window.locator('[data-interceptor-detail]')).toContainText(
      'HTTPS passed through without decryption',
    );
    // A tunnel carries no request the app could read, so it cannot be saved.
    await rows(window).first().click({ button: 'right' });
    await expect(window.locator('[data-capture-menu] [data-menu-item=save]')).toBeDisabled();
  });
});

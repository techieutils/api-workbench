import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';

/** A local API for the tests to call: what it received, and its address. */
export interface TestServer {
  url: string;
  received: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[];
  close(): Promise<void>;
}

/**
 * Starts a small JSON API on 127.0.0.1: /users answers a list, /missing a 404, /cookies/set sets
 * more cookies with attributes, /redirect sends a 302 to /users, /slow answers after a second,
 * and others echo. Every response sets `session=e2e`.
 */
export async function startServer(): Promise<TestServer> {
  const received: TestServer['received'] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });
      const json = (status: number, value: unknown, cookies: string[] = []) => {
        response.writeHead(status, {
          'content-type': 'application/json',
          'set-cookie': ['session=e2e; Path=/', ...cookies],
        });
        response.end(JSON.stringify(value));
      };
      if (request.url?.startsWith('/users')) json(200, { users: [{ id: 1, name: 'Ada' }] });
      else if (request.url?.startsWith('/missing')) json(404, { error: 'Not found' });
      else if (request.url?.startsWith('/redirect')) {
        response.writeHead(302, { location: '/users' });
        response.end();
      } else if (request.url?.startsWith('/slow'))
        setTimeout(() => {
          if (!response.destroyed) json(200, { slow: true });
        }, 1000);
      else if (request.url?.startsWith('/cookies/set'))
        json(200, { set: true }, [
          'theme=dark; Path=/; Max-Age=3600; HttpOnly',
          'scoped=yes; Path=/cookies; SameSite=Lax',
        ]);
      else json(200, { method: request.method, url: request.url, body });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A port nothing is listening on, for a mock server to take. */
export async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

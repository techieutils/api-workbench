import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WorkspaceStore } from '@techieutils/api-workbench-electron/workspaces';
import type { ApiRequest, WorkspaceState } from '@techieutils/api-workbench-common/types';
import { main } from './cli';

/** request send --binary-file and --form-file: files sent with a request, read for that send. */

test('a file body and a form’s file fields are sent from the files given', async (t) => {
  // A server that answers with what it received: its type and its bytes.
  const server = createServer(async (incoming, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    reply.setHeader('content-type', 'application/json');
    reply.end(
      JSON.stringify({
        type: incoming.headers['content-type'] ?? '',
        body: Buffer.concat(chunks).toString('base64'),
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-cli-uploads-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const request = (id: string, extra: Partial<ApiRequest>): ApiRequest =>
    ({
      id,
      name: id,
      method: 'POST',
      url: `${base}/${id}`,
      folder: 'Files',
      params: [],
      headers: [],
      body: '',
      auth: 'None',
      token: '',
      username: '',
      password: '',
      tests: '',
      ...extra,
    }) as ApiRequest;
  const data = path.join(root, 'data');
  const store = new WorkspaceStore(data);
  await store.list();
  await store.save(
    {
      requests: [
        request('upload', { bodyType: 'raw', body: '' }),
        request('profile', {
          bodyType: 'form-data',
          bodyFields: [
            { enabled: true, key: 'name', value: 'Ada', kind: 'text' },
            { enabled: true, key: 'avatar', value: '', kind: 'file', fileName: 'old.png' },
          ],
        }),
      ],
      tabs: [],
      active: 'upload',
      environments: [{ name: 'Local', variables: [] }],
      environment: 0,
      history: [],
    } as unknown as WorkspaceState,
    'default',
  );
  store.close();
  const photo = path.join(root, 'photo.png');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
  await fs.writeFile(photo, bytes);
  const run = async (args: string[], stdin = '') => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      args,
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      { API_WORKBENCH_DATA_DIR: data },
      false,
      undefined,
      { stdin: async () => stdin },
    );
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  // A file body, named in the request; sending it without the file says how to give one.
  assert.equal(
    (
      await run([
        'request',
        'update',
        'upload',
        '--body-type',
        'binary',
        '--binary-name',
        'photo.png',
      ])
    ).code,
    0,
  );
  const shown = JSON.parse((await run(['request', 'show', 'upload', '--json'])).out);
  assert.equal(shown.bodyType, 'binary');
  assert.equal(shown.binaryName, 'photo.png');
  const missing = JSON.parse((await run(['request', 'send', 'upload', '--json'])).out);
  assert.match(missing.error, /--binary-file <path>/);
  const sent = await run(['request', 'send', 'upload', '--binary-file', photo, '--json']);
  assert.equal(sent.code, 0, sent.err);
  const echoed = JSON.parse(JSON.parse(sent.out).body);
  assert.equal(echoed.type, 'image/png');
  assert.deepEqual(Buffer.from(echoed.body, 'base64'), bytes, 'the bytes go as they are');

  // A form's file field, by its name, with the text fields beside it.
  assert.match(
    JSON.parse((await run(['request', 'send', 'profile', '--json'])).out).error,
    /--form-file avatar=<path>/,
  );
  const form = await run([
    'request',
    'send',
    'profile',
    '--form-file',
    `avatar=${photo}`,
    '--json',
  ]);
  assert.equal(form.code, 0, form.err);
  const multipart = JSON.parse(JSON.parse(form.out).body);
  assert.match(multipart.type, /^multipart\/form-data; boundary=/);
  const text = Buffer.from(multipart.body, 'base64').toString('latin1');
  assert.match(text, /name="name"\r\n\r\nAda/);
  assert.match(text, /name="avatar"; filename="photo.png"\r\nContent-Type: image\/png/);
  assert.ok(text.includes(bytes.toString('latin1')));

  // The whole form, file fields included, is saved from a list that gives each field's kind.
  assert.equal(
    (
      await run(
        ['request', 'update', 'profile', '--form-fields', '-'],
        JSON.stringify([
          { key: 'avatar', value: '', enabled: true, kind: 'file', fileName: 'photo.png' },
          { key: 'cv', value: '', enabled: false, kind: 'file' },
          { key: 'name', value: 'Grace', enabled: true, kind: 'text' },
        ]),
      )
    ).code,
    0,
  );
  const fields = JSON.parse((await run(['request', 'show', 'profile', '--json'])).out).formFields;
  assert.deepEqual(
    fields.map((field: { key: string; kind: string; fileName?: string }) => [
      field.key,
      field.kind,
      field.fileName,
    ]),
    [
      ['avatar', 'file', 'photo.png'],
      ['cv', 'file', undefined],
      ['name', 'text', undefined],
    ],
  );
  // Text fields alone keep the file fields, as before.
  await run(
    ['request', 'update', 'profile', '--form-fields', '-'],
    JSON.stringify([{ key: 'name', value: 'Ada', enabled: true }]),
  );
  assert.equal(
    JSON.parse((await run(['request', 'show', 'profile', '--json'])).out).formFields.length,
    3,
  );

  // A run sends each request's files from a JSON file, paths beside it; without one they fail.
  const report = path.join(root, 'report.json');
  const failed = await run(['run', '-w', 'default', '--report-json', report]);
  assert.equal(failed.code, 1);
  assert.match(
    JSON.parse(await fs.readFile(report, 'utf8')).results[0].error,
    /run --uploads <file>/,
  );
  await fs.writeFile(
    path.join(root, 'uploads.json'),
    JSON.stringify({ upload: 'photo.png', profile: { avatar: 'photo.png', cv: 'photo.png' } }),
  );
  const ran = await run([
    'run',
    '-w',
    'default',
    '--uploads',
    path.join(root, 'uploads.json'),
    '--report-json',
    report,
  ]);
  assert.equal(ran.code, 0, ran.out + ran.err);
  const results = JSON.parse(await fs.readFile(report, 'utf8')).results;
  assert.deepEqual(
    results.map((result: { status: number }) => result.status),
    [200, 200],
  );
  assert.match(
    (await run(['run', '-w', 'default', '--uploads', path.join(root, 'none.json')])).err,
    /no such file/,
  );
  await fs.writeFile(path.join(root, 'bad.json'), JSON.stringify({ Nope: 'photo.png' }));
  assert.match(
    (await run(['run', '-w', 'default', '--uploads', path.join(root, 'bad.json')])).err,
    /names no request “Nope”/,
  );

  // Bad paths and forms are refused before anything is sent.
  assert.match(
    (await run(['request', 'send', 'upload', '--binary-file', path.join(root, 'none.bin')])).err,
    /No file/,
  );
  assert.match(
    (await run(['request', 'send', 'profile', '--form-file', photo])).err,
    /<field>=<path>/,
  );
});

test('a .http file’s `< ./path` bodies and multipart files are read beside it, when sent', async (t) => {
  const server = createServer(async (incoming, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    reply.setHeader('content-type', 'application/json');
    reply.end(
      JSON.stringify({
        type: incoming.headers['content-type'] ?? '',
        body: Buffer.concat(chunks).toString('base64'),
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-cli-http-uploads-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'files'));
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xfe]);
  await fs.writeFile(path.join(root, 'files', 'report.pdf'), bytes);
  const file = path.join(root, 'uploads.http');
  await fs.writeFile(
    file,
    [
      `POST ${base}/import`,
      '',
      '< ./files/report.pdf',
      '',
      '###',
      `POST ${base}/avatar`,
      'Content-Type: multipart/form-data; boundary=XYZ',
      '',
      '--XYZ',
      'Content-Disposition: form-data; name="title"',
      '',
      'Quarterly',
      '--XYZ',
      'Content-Disposition: form-data; name="doc"; filename="q3.pdf"',
      'Content-Type: application/pdf',
      '',
      '< files/report.pdf',
      '--XYZ--',
      '',
      '###',
      `POST ${base}/missing`,
      '',
      '< ./files/nowhere.bin',
    ].join('\n'),
  );
  const run = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    // From another folder: paths are relative to the .http file, not to where it is run.
    const code = await main(
      args,
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      {},
      false,
    );
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const binary = await run(['request', 'send', '1', '--file', file, '--json']);
  assert.equal(binary.code, 0, binary.err);
  const echoed = JSON.parse(JSON.parse(binary.out).body);
  assert.equal(echoed.type, 'application/pdf');
  assert.deepEqual(Buffer.from(echoed.body, 'base64'), bytes);

  const form = await run(['request', 'send', '2', '--file', file, '--json']);
  assert.equal(form.code, 0, form.err);
  const multipart = JSON.parse(JSON.parse(form.out).body);
  assert.match(multipart.type, /^multipart\/form-data; boundary=/);
  const text = Buffer.from(multipart.body, 'base64').toString('latin1');
  assert.match(text, /name="title"\r\n\r\nQuarterly/);
  assert.match(text, /name="doc"; filename="q3.pdf"\r\nContent-Type: application\/pdf/);
  assert.ok(text.includes(bytes.toString('latin1')));

  // What it names is shown by name; a missing file fails that request alone, saying which.
  const shown = JSON.parse((await run(['request', 'show', '2', '--file', file, '--json'])).out);
  assert.deepEqual(shown.fileUploads, { fields: { doc: 'report.pdf' } });
  assert.match(
    JSON.parse((await run(['request', 'send', '3', '--file', file, '--json'])).out).error,
    /No file .*nowhere\.bin/,
  );
  const report = path.join(root, 'report.json');
  assert.equal((await run(['run', file, '--report-json', report])).code, 1);
  assert.deepEqual(
    JSON.parse(await fs.readFile(report, 'utf8')).results.map(
      (result: { status?: number; error?: string }) => result.status ?? 'error',
    ),
    [200, 200, 'error'],
  );
  // A file given with the send is used instead of the one the .http file names.
  const other = path.join(root, 'other.bin');
  await fs.writeFile(other, 'other');
  const given = await run([
    'request',
    'send',
    '3',
    '--file',
    file,
    '--binary-file',
    other,
    '--json',
  ]);
  assert.equal(
    Buffer.from(JSON.parse(JSON.parse(given.out).body).body, 'base64').toString(),
    'other',
  );
});

test('a .http file can send files from its repository, never from outside it', async (t) => {
  const received: string[] = [];
  const server = createServer(async (incoming, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    received.push(Buffer.concat(chunks).toString());
    reply.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-cli-confined-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // A repository with the .http file in a subfolder, and a secret beside the repository.
  const repo = path.join(root, 'repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.mkdir(path.join(repo, 'api'));
  await fs.mkdir(path.join(repo, 'fixtures'));
  await fs.writeFile(path.join(repo, 'fixtures', 'ok.json'), 'shared fixture');
  const secret = path.join(root, 'id_rsa');
  await fs.writeFile(secret, 'PRIVATE KEY');
  await fs.symlink(secret, path.join(repo, 'fixtures', 'linked.txt'));
  const file = path.join(repo, 'api', 'requests.http');
  await fs.writeFile(
    file,
    ['< ../fixtures/ok.json', '< ../../id_rsa', `< ${secret}`, '< ../fixtures/linked.txt']
      .map((body, index) => `${index ? '###\n' : ''}POST ${base}/${index}\n\n${body}\n`)
      .join('\n'),
  );
  const send = async (id: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      ['request', 'send', id, '--file', file, '--json'],
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      {},
      false,
    );
    return { code, text: [...out, ...err].join('\n') };
  };
  // Up into the repository is fine, as in REST Client's own examples.
  assert.equal((await send('1')).code, 0);
  assert.deepEqual(received, ['shared fixture']);
  // Above it, an absolute path elsewhere, or a link out of it is refused, and nothing is sent.
  for (const id of ['2', '3', '4']) {
    const result = await send(id);
    assert.match(result.text, /outside .*must be in its project/, id);
  }
  assert.deepEqual(received, ['shared fixture']);
});

test('a .http file’s upload paths, and `<@` files’ text, have their {{variables}} filled', async (t) => {
  const server = createServer(async (incoming, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    reply.end(Buffer.concat(chunks));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-cli-upload-variables-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'staging'));
  await fs.mkdir(path.join(root, 'live'));
  await fs.writeFile(path.join(root, 'staging', 'data.csv'), 'staging rows');
  await fs.writeFile(path.join(root, 'live', 'data.csv'), 'live rows');
  await fs.writeFile(path.join(root, 'order.json'), '{"customer": "{{customer}}"}');
  const file = path.join(root, 'variables.http');
  await fs.writeFile(
    file,
    [
      '@stage = staging',
      '@customer = Ada',
      '',
      `POST ${base}/import`,
      '',
      '< ./{{stage}}/data.csv',
      '',
      '###',
      `POST ${base}/order`,
      '',
      '<@ ./order.json',
      '',
      '###',
      `POST ${base}/raw`,
      '',
      '< ./order.json',
      '',
      '###',
      `POST ${base}/unset`,
      '',
      '< ./{{nowhere}}/data.csv',
    ].join('\n'),
  );
  const run = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      args,
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      {},
      false,
    );
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const body = async (id: string, ...more: string[]) =>
    JSON.parse((await run(['request', 'send', id, '--file', file, '--json', ...more])).out);

  // The file's own variables, and -v over them, choose the file.
  assert.equal((await body('1')).body, 'staging rows');
  assert.equal((await body('1', '-v', 'stage=live')).body, 'live rows');
  // `<@` fills the file's text; `<` sends it as it is.
  assert.equal((await body('2')).body, '{"customer": "Ada"}');
  assert.equal((await body('2', '-v', 'customer=Grace')).body, '{"customer": "Grace"}');
  assert.equal((await body('3')).body, '{"customer": "{{customer}}"}');
  // A variable nothing sets is named, rather than a file of that name looked for.
  assert.match((await body('4')).error, /\{\{nowhere\}\}, which no environment/);
});

test('a .http file’s {{variables}} come from a workspace’s environment, under its own', async (t) => {
  const server = createServer((incoming, reply) =>
    reply.end(JSON.stringify({ path: incoming.url, auth: incoming.headers.authorization ?? '' })),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-cli-http-environments-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const store = new WorkspaceStore(data);
  await store.list();
  await store.save(
    {
      requests: [
        {
          id: 'ping',
          name: 'Ping',
          method: 'GET',
          url: '{{base_url}}/ping',
          folder: 'Ops',
          params: [],
          headers: [],
          body: '',
          auth: 'None',
          token: '',
          username: '',
          password: '',
          tests: '',
        },
      ],
      tabs: [],
      active: 'ping',
      environments: [
        {
          name: 'Staging',
          variables: [
            { enabled: true, key: 'base_url', value: base },
            { enabled: true, key: 'token', value: 'staging-secret' },
            { enabled: true, key: 'tenant', value: 'staging' },
            { enabled: false, key: 'off', value: 'never' },
          ],
        },
        {
          name: 'Live',
          variables: [
            { enabled: true, key: 'base_url', value: base },
            { enabled: true, key: 'token', value: 'live-secret' },
            { enabled: true, key: 'tenant', value: 'live' },
          ],
        },
      ],
      environment: 0,
      history: [],
    } as unknown as WorkspaceState,
    'default',
  );
  store.close();
  const file = path.join(root, 'requests.http');
  await fs.writeFile(
    file,
    [
      '@tenant = from-file',
      '',
      'GET {{base_url}}/{{tenant}}/orders?off=%7B%7Boff%7D%7D',
      'Authorization: Bearer {{token}}',
    ].join('\n'),
  );
  const send = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      ['request', 'send', '1', '--file', file, '--json', ...args],
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      { API_WORKBENCH_DATA_DIR: data },
      false,
    );
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const answer = async (...args: string[]) => {
    const result = await send(...args);
    assert.equal(result.code, 0, result.err);
    return JSON.parse(JSON.parse(result.out).body);
  };

  // The workspace's environment in use, under the file's own @tenant; a switched-off one is unset.
  assert.deepEqual(await answer('-w', 'default'), {
    path: '/from-file/orders?off=%7B%7Boff%7D%7D',
    auth: 'Bearer staging-secret',
  });
  // Another environment by name, and -v over everything.
  assert.equal((await answer('-w', 'default', '-e', 'Live')).auth, 'Bearer live-secret');
  assert.equal(
    (await answer('-w', 'default', '-v', 'tenant=cli')).path,
    '/cli/orders?off=%7B%7Boff%7D%7D',
  );
  // The secret is sent, never printed.
  // (The test server echoes it in its body; nothing else printed holds it.)
  const { body: _echo, ...printed } = JSON.parse((await send('-w', 'default')).out);
  assert.ok(!JSON.stringify(printed).includes('staging-secret'));
  // Without a workspace, only the file's variables.
  assert.match(JSON.parse((await send()).out).error, /\{\{base_url\}\}|Invalid URL|URL/);
  assert.match((await send('-w', 'default', '-e', 'Prod')).err, /No environment “Prod”/);
  const show = await main(
    ['request', 'show', '1', '--file', file, '-w', 'default'],
    { out: () => {}, err: () => {} },
    { API_WORKBENCH_DATA_DIR: data },
    false,
  );
  assert.equal(show, 2, 'only send takes a workspace with --file');
});

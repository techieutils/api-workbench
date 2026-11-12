import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codegenTargets, generateCode } from './codegen';
import type { CodegenInput } from '@techieutils/api-workbench-common/types';
const input: CodegenInput = {
  url: 'https://api.example.com/items?tag=one&tag=two',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Trace-ID': 'trace-id' },
  body: '{"message":"request-payload"}',
  bodyType: 'raw',
  fields: [],
};
test('all registered language/library adapters generate request snippets', () => {
  const targets = codegenTargets();
  assert.ok(targets.length >= 25);
  assert.ok(targets.reduce((total, target) => total + target.clients.length, 0) >= 50);
  for (const target of targets)
    for (const client of target.clients) {
      const result = generateCode(input, target.id, client.id);
      assert.ok(result.code.length > 30, `${target.id}/${client.id} is not empty`);
      assert.ok(result.filename.startsWith('request.'));
      if (target.id !== 'cmd')
        assert.ok(
          result.code.includes('request-payload'),
          `${target.id}/${client.id} preserves the body`,
        );
    }
});
test('form encoding preserves duplicates and special characters in every adapter', () => {
  const request: CodegenInput = {
    ...input,
    bodyType: 'x-www-form-urlencoded',
    fields: [
      { name: 'tag', value: 'a & b' },
      { name: 'tag', value: 'two' },
    ],
  };
  for (const target of codegenTargets())
    for (const client of target.clients) {
      const result = generateCode(request, target.id, client.id);
      assert.ok(result.code.length > 30, `${target.id}/${client.id}`);
    }
  assert.match(generateCode(request, 'node', 'native-fetch').code, /tag=a\+%26\+b&tag=two/);
});
test('multipart and binary uploads have explicit placeholders; cURL uses file arguments', () => {
  const request: CodegenInput = {
    ...input,
    bodyType: 'form-data',
    fields: [
      { name: 'tag', value: 'one' },
      { name: 'tag', value: 'two' },
      { name: 'upload', value: '', fileName: 'file with spaces.txt' },
    ],
  };
  const curl = generateCode(request, 'shell', 'curl');
  assert.match(curl.code, /--form-string 'tag=one'/);
  assert.match(curl.code, /--form 'upload=@file with spaces.txt'/);
  assert.doesNotMatch(curl.code, /Content-Type:/i);
  for (const target of codegenTargets())
    for (const client of target.clients)
      assert.ok(generateCode(request, target.id, client.id).code.length > 30);
  const fetch = generateCode(request, 'node', 'native-fetch');
  assert.ok(fetch.code.includes('<FILE_CONTENTS:file with spaces.txt>'));
  assert.ok(fetch.notes.some((note) => note.includes('Replace')));
  const binary = generateCode(
    { ...input, bodyType: 'binary', binaryName: 'upload.bin' },
    'shell',
    'curl',
  );
  assert.match(binary.code, /--data-binary '@upload.bin'/);
});
test('Terraform exposes its HTTP method limit and escapes HCL interpolation', () => {
  assert.throws(
    () => generateCode({ ...input, method: 'DELETE' }, 'terraform', 'http'),
    /supports GET, HEAD, and POST/,
  );
  const result = generateCode({ ...input, body: '${danger} %{danger}' }, 'terraform', 'http');
  assert.ok(result.code.includes('$${danger} %%{danger}'));
  assert.ok(
    generateCode({ ...input, method: 'DELETE' }, 'terraform', 'curl').code.includes(
      'terraform_data',
    ),
  );
});
test('invalid target selections fail; GET and none omit stale request bodies', () => {
  assert.throws(() => generateCode(input, 'invalid', 'invalid'), /available language/);
  for (const request of [
    { ...input, bodyType: 'none' as const },
    { ...input, method: 'GET' },
  ]) {
    const result = generateCode(request, 'node', 'native-fetch');
    assert.ok(!result.code.includes('request-payload'));
  }
});
test('native JS snippets and Windows argument bridge handle quotes and multiline payloads', () => {
  const request = {
    ...input,
    body: 'quote \' " ` $HOME\nsecond line',
    headers: { 'X-Note': 'a "quote"' },
  };
  for (const client of ['native-fetch', 'got', 'undici']) {
    const source = generateCode(request, 'node', client).code.replace(/^import .*;\n/gm, '');
    assert.doesNotThrow(() => new Function(`return (async()=>{${source}})`));
  }
  const cmd = generateCode(request, 'cmd', 'curl').code;
  const script = Buffer.from(cmd.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1], 'base64').toString(
    'utf16le',
  );
  assert.ok(script.includes('& curl.exe @('));
  assert.ok(script.includes("quote ''"));
});

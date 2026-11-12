import test from 'node:test';
import assert from 'node:assert/strict';
import { httpFile, httpFileReferences } from './text-formats';

test('a .http file body of one `< ./path` line is a file body, named by the file', () => {
  const source = [
    'POST https://api.example.test/import',
    'Content-Type: text/csv',
    '',
    '< ./data/export.csv',
    '',
    '###',
    'POST https://api.example.test/raw',
    '',
    '<@ ./template.json',
    '',
    '###',
    'POST https://api.example.test/text',
    '',
    '<not a file> and more',
  ].join('\n');
  const [file, templated, text] = httpFile(source).requests;
  assert.equal(file.bodyType, 'binary');
  assert.equal(file.binaryName, 'export.csv');
  assert.equal(file.body, '');
  assert.equal(templated.bodyType, 'binary');
  assert.equal(text.bodyType, 'raw', 'text that only starts with < stays text');
  assert.deepEqual(httpFileReferences(source), [
    { binary: './data/export.csv', fields: {} },
    { binary: './template.json', fields: {}, templates: [''] },
    undefined,
  ]);
});

test('a multipart body is its form, with `< ./path` parts as file fields', () => {
  const source = [
    'POST https://api.example.test/avatar',
    'Content-Type: multipart/form-data; boundary=----Bound.ary+1',
    'Accept: application/json',
    '',
    '------Bound.ary+1',
    'Content-Disposition: form-data; name="title"',
    '',
    'Me, in 2026',
    '------Bound.ary+1',
    'Content-Disposition: form-data; name="photo"; filename="me.png"',
    'Content-Type: image/png',
    '',
    '< ../images/avatar.png',
    '------Bound.ary+1',
    'Content-Disposition: form-data; name="cv"',
    '',
    '< cv.pdf',
    '------Bound.ary+1--',
  ].join('\n');
  const [request] = httpFile(source).requests;
  assert.equal(request.bodyType, 'form-data');
  assert.deepEqual(request.bodyFields, [
    { enabled: true, key: 'title', value: 'Me, in 2026', kind: 'text' },
    { enabled: true, key: 'photo', value: '', kind: 'file', fileName: 'me.png' },
    { enabled: true, key: 'cv', value: '', kind: 'file', fileName: 'cv.pdf' },
  ]);
  // The boundary is chosen again when it is sent, so the given Content-Type goes.
  assert.deepEqual(
    request.headers!.map((header) => header.key),
    ['Accept'],
  );
  assert.deepEqual(httpFileReferences(source), [
    { fields: { photo: '../images/avatar.png', cv: 'cv.pdf' } },
  ]);
});

test('upload paths keep their {{variables}}, and `<@` parts are marked to have theirs filled', () => {
  const source = [
    'POST https://api.example.test/import',
    '',
    '< {{dataDir}}/export-{{$isoDate}}.csv',
    '',
    '###',
    'POST https://api.example.test/form',
    'Content-Type: multipart/form-data; boundary=B',
    '',
    '--B',
    'Content-Disposition: form-data; name="order"; filename="order.json"',
    '',
    '<@ ./order.json',
    '--B',
    'Content-Disposition: form-data; name="photo"',
    '',
    '< {{images}}/me.png',
    '--B--',
  ].join('\n');
  const [file, form] = httpFile(source).requests;
  assert.equal(file.binaryName, 'export-{{$isoDate}}.csv');
  assert.deepEqual(
    form.bodyFields?.map((field) => field.fileName),
    ['order.json', 'me.png'],
  );
  assert.deepEqual(httpFileReferences(source), [
    { binary: '{{dataDir}}/export-{{$isoDate}}.csv', fields: {} },
    { fields: { order: './order.json', photo: '{{images}}/me.png' }, templates: ['order'] },
  ]);
});

test('a request line with a stray carriage return or line separator is read, not a crash', () => {
  // Found by fuzzing: the line's pattern did not match across them, and the parser threw.
  for (const line of ['GET https://a.test/x\rY', 'GET https://a.test/ x']) {
    const [request] = httpFile(line).requests;
    assert.equal(request.method, 'GET', JSON.stringify(line));
    assert.ok(request.url!.startsWith('https://a.test/'));
    assert.equal(httpFileReferences(line).length, 1);
  }
});

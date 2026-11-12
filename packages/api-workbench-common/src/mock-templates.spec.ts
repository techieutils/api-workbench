import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOCK_TEMPLATE_HELPERS, renderMockTemplate } from './mock-templates';

/** A repeatable sequence of numbers in [0, 1). */
const seeded =
  (seed = 7) =>
  () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
const request = {
  params: { id: '42' },
  query: new URLSearchParams('page=2'),
  headers: { 'x-request-id': 'req-1' },
  body: '{"user":{"id":5,"tags":["a","b"]}}',
};
const options = { now: new Date('2026-01-15T00:00:00Z'), random: seeded(), uuid: () => 'uuid-1' };

test('request values fill in, and unknown names are left as written', () => {
  assert.equal(
    renderMockTemplate(
      '{{params.id}} {{query.page}} {{headers.X-Request-Id}} {{body.user.id}} {{body.user.tags}} {{query.none}}|{{$notAFaker}} {{id}}',
      request,
      options,
    ),
    '42 2 req-1 5 ["a","b"] |{{$notAFaker}} {{id}}',
  );
});

test('fake values are generated, with arguments', () => {
  const output = renderMockTemplate(
    '{{$uuid}}|{{$randomInt 1 6}}|{{$randomFloat 1 2 3}}|{{$pick red green}}|{{$randomFullName}}|{{$randomWords 4}}|{{$randomPrice 5 6}}|{{$randomDatePast}}|{{$isoDate}}|{{$randomHexColor}}',
    request,
    { ...options, random: seeded() },
  ).split('|');
  assert.equal(output[0], 'uuid-1');
  assert.ok(
    Number(output[1]) >= 1 && Number(output[1]) <= 6 && Number.isInteger(Number(output[1])),
  );
  assert.match(output[2], /^1\.\d{3}$/);
  assert.ok(['red', 'green'].includes(output[3]));
  assert.match(output[4], /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  assert.equal(output[5].split(' ').length, 4);
  assert.match(output[6], /^5\.\d{2}$/);
  assert.ok(new Date(output[7]) < options.now);
  assert.equal(output[8], '2026-01-15');
  assert.match(output[9], /^#[0-9a-f]{6}$/);
  assert.equal(
    renderMockTemplate('{{$randomInt}}', request, { random: () => 0.5 }),
    '500',
    'without arguments the existing dynamic variables behave as before',
  );
});

test('repeat blocks make lists, nest, and number their items', () => {
  const list = renderMockTemplate(
    '[{{#repeat 3}}{"id": {{@index}}, "tags": [{{#repeat 2}}"t{{@index}}"{{/repeat}}]}{{/repeat}}]',
    request,
    options,
  );
  assert.deepEqual(JSON.parse(list), [
    { id: 0, tags: ['t0', 't1'] },
    { id: 1, tags: ['t0', 't1'] },
    { id: 2, tags: ['t0', 't1'] },
  ]);
  const ranged = JSON.parse(
    renderMockTemplate('[{{#repeat 2 4}}{{$randomInt 1 9}}{{/repeat}}]', request, options),
  );
  assert.ok(ranged.length >= 2 && ranged.length <= 4);
  assert.equal(renderMockTemplate('[{{#repeat 0}}x{{/repeat}}]', request, options), '[]');
  assert.equal(
    renderMockTemplate('{{#repeat 2}}unclosed', request, options),
    '{{#repeat 2}}unclosed',
    'an unclosed block is left as written',
  );
  assert.throws(
    () =>
      renderMockTemplate(
        '{{#repeat 1000}}{{#repeat 1000}}0123456789{{/repeat}}{{/repeat}}',
        request,
        options,
      ),
    /larger than 5 MB/,
  );
});

test('every listed helper renders', () => {
  for (const helper of MOCK_TEMPLATE_HELPERS) {
    const output = renderMockTemplate(helper.template, request, { ...options, random: seeded(3) });
    assert.ok(!output.includes('{{$'), `${helper.template} renders`);
  }
  assert.ok(MOCK_TEMPLATE_HELPERS.length > 45);
});

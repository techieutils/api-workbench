import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MDI_ICON_NAMES } from '@techieutils/api-workbench-common/icon-names';
import { formatText, detectLanguage, canFormat, languages } from './formatting';
test('JSON formatting consistently expands objects/arrays and preserves numeric literals', async () => {
  const source = '{"small":[1,2],"nested":{"ok":true},"number":9007199254740993}';
  const formatted = await formatText(source, 'json');
  assert.ok(formatted.includes('"small": [\n    1,\n    2\n  ]'));
  assert.ok(formatted.includes('9007199254740993'));
  assert.equal(await formatText(formatted, 'json'), formatted);
  await assert.rejects(formatText('{unquoted:1}', 'json'));
  await assert.rejects(formatText('{"a":1,}', 'json'));
});
test('formatters cover JavaScript, TypeScript, HTML, XML, CSS, YAML, GraphQL and Markdown', async () => {
  const fixtures = [
    ['javascript', 'function test(){return {ok:true};}'],
    ['typescript', 'const value:number=1;'],
    ['html', '<div><p>hello</p><script>const x={a:1};</script></div>'],
    ['xml', '<root><item>one</item><item>two</item></root>'],
    ['css', 'body{color:red;margin:0}'],
    ['yaml', 'value: {a: 1,b: 2}'],
    ['graphql', 'query{user{id name}}'],
    ['markdown', '# Heading\n\n* item\n* other'],
  ];
  for (const [language, source] of fixtures) {
    const formatted = await formatText(source, language);
    assert.ok(formatted.endsWith('\n'), language);
    assert.equal(await formatText(formatted, language), formatted, `${language} is stable`);
  }
  await assert.rejects(formatText('function () {', 'javascript'));
  await assert.rejects(formatText('<root><broken></root>', 'xml'));
});
test('NDJSON keeps one record per line and MIME detection handles charset and vendor types', async () => {
  const output = await formatText('{"a":1}\n{"b":[1,2]}', 'ndjson');
  assert.equal(output.trim().split('\n').length, 2);
  output
    .trim()
    .split('\n')
    .forEach((line) => assert.doesNotThrow(() => JSON.parse(line)));
  await assert.rejects(formatText('{"a":1}\n\ninvalid', 'ndjson'), /line 3/);
  assert.equal(detectLanguage('Application/Problem+JSON; charset=UTF-8'), 'json');
  assert.equal(detectLanguage('application/soap+xml'), 'xml');
  assert.equal(detectLanguage('text/html; charset=utf-8'), 'html');
  assert.equal(detectLanguage('application/javascript'), 'javascript');
  assert.equal(detectLanguage('application/x-ndjson'), 'ndjson');
  assert.equal(detectLanguage('', '{"a":1}'), 'json');
  assert.equal(canFormat('python'), false);
});
test('a body without a useful Content-Type is recognised by how it starts', () => {
  const cases: [string, string, string][] = [
    ['', '{"a":1}\n{"a":2}\n', 'ndjson'],
    ['text/plain', '{\n  "a": 1\n}', 'json'],
    ['', '{"truncated": ', 'json'],
    ['application/octet-stream', '<!DOCTYPE html><p>x</p>', 'html'],
    ['', '<body><p>x</p></body>', 'html'],
    ['', '<?xml version="1.0"?><a/>', 'xml'],
    ['', '<feed xmlns="http://www.w3.org/2005/Atom"></feed>', 'xml'],
    ['text/plain', '---\nname: api\n', 'yaml'],
    ['', '#!/bin/sh\necho hi', 'shell'],
    ['', '# Release notes\n\n- fixed', 'markdown'],
    ['text/plain', 'plain words, nothing to detect', 'text'],
    ['', '', 'text'],
  ];
  for (const [mime, body, expected] of cases)
    assert.equal(detectLanguage(mime, body), expected, JSON.stringify(body));
});
test('a specific Content-Type wins over how the body looks', () => {
  assert.equal(detectLanguage('text/css', '{"a":1}'), 'css');
  assert.equal(detectLanguage('text/csv', '<a/>'), 'csv');
});
test('every editor language has an icon', () => {
  for (const language of languages)
    assert.ok((MDI_ICON_NAMES as readonly string[]).includes(language.icon), language.id);
});

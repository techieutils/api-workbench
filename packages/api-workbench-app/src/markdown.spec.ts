import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './markdown';

test('Markdown renders headings, lists, tables, and code', () => {
  const html = renderMarkdown(
    [
      '# Title',
      '',
      '- one',
      '- two',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '```',
      'x < y',
      '```',
    ].join('\n'),
  );
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
  assert.match(html, /<table>[\s\S]*<td>1<\/td>[\s\S]*<\/table>/);
  assert.match(html, /<pre><code>x &lt; y\n<\/code><\/pre>/);
});

test('embedded HTML shows as text, never as markup', () => {
  const html = renderMarkdown(
    '<script>alert(1)</script>\n\nText with <img src=x onerror=alert(1)> inline',
  );
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('links keep only web and mail targets', () => {
  assert.match(
    renderMarkdown('[docs](https://example.com/docs "Docs")'),
    /<a href="https:\/\/example\.com\/docs" title="Docs">docs<\/a>/,
  );
  assert.match(
    renderMarkdown('[mail](mailto:team@example.com)'),
    /href="mailto:team@example\.com"/,
  );
  const unsafe = renderMarkdown('[click](javascript:alert(1)) [data](data:text/html,x)');
  assert.doesNotMatch(unsafe, /<a\b|javascript:|data:/);
  assert.match(unsafe, /click/);
});

test('images show their alt text instead of loading', () => {
  const html = renderMarkdown('![Diagram of the flow](https://example.com/flow.png)');
  assert.doesNotMatch(html, /<img|example\.com/);
  assert.match(html, /<span class="markdown-image">Diagram of the flow<\/span>/);
});

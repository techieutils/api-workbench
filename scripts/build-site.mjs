// Builds the GitHub Pages site into dist/site: a landing page and a documentation portal in the
// style of Mintlify sites (tabs, grouped sidebar, search, callouts, cards, and an on-this-page list).
// Pages come from docs/ (plus the root CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, and LICENSE).
// Run with `npm run site:build`; preview with `npm run site:preview`. Everything is static.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { parse as parseYaml } from 'yaml';
import * as mdi from '@mdi/js';
import {
  ARCHITECTURES,
  CLI_ENTRY,
  SYSTEMS,
  changelogVersions,
  downloadCommands,
  downloadURL,
  fileName,
  releaseFiles,
} from './release-files.mjs';
import { StringStream } from '@codemirror/language';
import { javascript, json, typescript } from '@codemirror/legacy-modes/mode/javascript';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { python } from '@codemirror/legacy-modes/mode/python';
import { go } from '@codemirror/legacy-modes/mode/go';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { html as htmlMode, xml } from '@codemirror/legacy-modes/mode/xml';
import { http } from '@codemirror/legacy-modes/mode/http';
import { csharp, java } from '@codemirror/legacy-modes/mode/clike';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'site');
const REPO = 'https://github.com/techieutils/api-workbench';
const SITE = 'https://techieutils.github.io/api-workbench/';
/**
 * Every page loads only the site's own scripts, styles, images, and search index: no inline
 * script or style, no other origin, no plugins, forms, or <base>. GitHub Pages sets no headers,
 * so the policy is a <meta> tag, which is why frame-ancestors is left out (a meta tag ignores it).
 */
const CONTENT_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'upgrade-insecure-requests',
].join('; ');
/** The copyright holder named in LICENSE, shown in the footer and the pages' metadata. */
const OWNER = {
  '@type': 'Organization',
  name: 'techieutils',
  url: 'https://github.com/techieutils',
};
const COPYRIGHT = `© ${new Date().getFullYear()} ${OWNER.name} and API Workbench contributors`;
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const CHANGELOG = await readFile(path.join(root, 'docs', 'changelog.md'), 'utf8');
/** A dismissible notice above the header; bump `id` to show a new one to everyone again. */
const ANNOUNCEMENT = {
  id: 'open-source-2026',
  html: 'API Workbench is open source under the MIT License. <a href="{repo}" rel="noopener" target="_blank">Star it on GitHub</a>',
};

// Syntax highlighting at build time, with CodeMirror's stream tokenizers (the app's editor library).
const require = createRequire(import.meta.url);
/** The app's assertion language: a check keyword, then paths, operators, numbers, and strings. */
const assertions = {
  startState: () => ({ start: true }),
  token(stream, state) {
    if (stream.sol()) state.start = true;
    if (stream.eatSpace()) return null;
    if (stream.match(/^(\/\/|#).*/)) return 'comment';
    if (state.start && stream.match(/^[a-z][\w-]*/)) {
      state.start = false;
      return 'keyword';
    }
    state.start = false;
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string';
    if (stream.match(/^\$[\w.[\]*"-]*/)) return 'variable-2';
    if (stream.match(/^-?\d+(\.\d+)?/)) return 'number';
    if (stream.match(/^(==|!=|<=|>=|<|>)/)) return 'operator';
    const word = stream.match(/^[\w-]+/);
    if (word)
      return /^(equals|contains|between|in|true|false|null|array|object|string|number|boolean)$/.test(
        word[0],
      )
        ? 'atom'
        : null;
    stream.next();
    return null;
  },
};
const MODES = {
  js: javascript,
  javascript,
  mjs: javascript,
  ts: typescript,
  typescript,
  json,
  sh: shell,
  bash: shell,
  shell,
  python,
  py: python,
  go,
  yaml,
  yml: yaml,
  xml,
  html: htmlMode,
  http,
  java,
  csharp,
};
/**
 * The token classes the site's CSS styles (CodeMirror 5's names): the tokenizers now return
 * CodeMirror 6 tag names, such as `variableName.special`.
 */
const TOKEN_CLASSES = {
  'variableName.special': 'variable-2',
  'variableName.local': 'variable-2',
  'variableName.definition': 'def',
  'string.special': 'string-2',
  variableName: 'variable',
  propertyName: 'property',
  typeName: 'type',
  angleBracket: 'bracket',
  punctuation: 'bracket',
  invalid: 'error',
};
const tokenClass = (style) => {
  const name = style.split(' ')[0];
  return TOKEN_CLASSES[name] ?? name.split('.')[0];
};
/** Tokenizes `code` line by line, calling `emit` with each piece of text and its style. */
function runMode(code, parser, emit) {
  const state = parser.startState ? parser.startState(2) : {};
  code.split('\n').forEach((line, index) => {
    if (index) emit('\n', null);
    if (!line) parser.blankLine?.(state, 2);
    const stream = new StringStream(line, 4, 2);
    while (!stream.eol()) {
      const style = parser.token(stream, state);
      // A tokenizer that reads nothing would loop forever; take one character instead.
      if (stream.pos === stream.start) stream.next();
      emit(line.slice(stream.start, stream.pos), style);
      stream.start = stream.pos;
    }
  });
}
/** Text blocks that start like the app's test assertions. */
const isAssertions = (code, language) =>
  language === 'text' &&
  /^(\/\/.*\n)?\s*(status|json|header|body|response-|content-type)/.test(code);
/** Code as HTML spans classed by token type. */
function highlight(code, language) {
  const parser = MODES[language] ?? (isAssertions(code, language) ? assertions : undefined);
  if (!parser) return escape(code);
  let html = '';
  runMode(code, parser, (text, style) => {
    html += style ? `<span class="tok-${tokenClass(style)}">${escape(text)}</span>` : escape(text);
  });
  return html;
}
const LANGUAGE_NAMES = {
  sh: 'Shell',
  bash: 'Shell',
  shell: 'Shell',
  js: 'JavaScript',
  javascript: 'JavaScript',
  ts: 'TypeScript',
  json: 'JSON',
  python: 'Python',
  go: 'Go',
  yaml: 'YAML',
  text: 'Text',
  http: 'HTTP',
  xml: 'XML',
  html: 'HTML',
};

/** The date a file last changed in git, for "Last updated". */
function lastUpdated(source) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cs', '--', source], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

/** Navigation: tabs, then sidebar groups, then pages (source files). The first page opens the tab. */
const NAV = [
  {
    tab: 'Documentation',
    icon: 'book-open-variant',
    groups: [
      [
        'Getting started',
        ['docs/README.md', 'docs/getting-started.md', 'docs/installation.md', 'docs/interface.md'],
      ],
      [
        'Requests',
        [
          'docs/requests.md',
          'docs/responses.md',
          'docs/tests.md',
          'docs/scripts.md',
          'docs/code-snippets.md',
          'docs/history.md',
        ],
      ],
      [
        'Protocols',
        [
          'docs/rest-graphql.md',
          'docs/live-protocols.md',
          'docs/websocket.md',
          'docs/sse.md',
          'docs/ndjson.md',
          'docs/grpc.md',
          'docs/socketio.md',
          'docs/mqtt.md',
        ],
      ],
      [
        'Features',
        [
          'docs/collections.md',
          'docs/api-specs.md',
          'docs/mock-servers.md',
          'docs/environments.md',
          'docs/variables.md',
          'docs/cookies.md',
          'docs/authentication.md',
          'docs/credentials.md',
          'docs/client-certificates.md',
          'docs/runner.md',
          'docs/cli.md',
          'docs/vscode.md',
          'docs/interceptor.md',
          'docs/import-export.md',
          'docs/api-documentation.md',
          'docs/workspaces.md',
          'docs/team-workspaces.md',
          'docs/settings.md',
          'docs/updates.md',
          'docs/dev-tools.md',
          'docs/shortcuts.md',
        ],
      ],
      ['Reference', ['docs/reference.md']],
    ],
  },
  {
    tab: 'Guides',
    icon: 'compass-outline',
    groups: [
      [
        'Guides',
        [
          'docs/guides/README.md',
          'docs/guides/test-a-rest-api.md',
          'docs/guides/chain-requests.md',
          'docs/guides/load-test-an-api.md',
          'docs/guides/run-api-tests-in-ci.md',
          'docs/guides/capture-app-traffic.md',
          'docs/guides/oauth-with-discovery.md',
        ],
      ],
      [
        'Migrate',
        [
          'docs/guides/migrate.md',
          'docs/guides/migrate-from-postman.md',
          'docs/guides/migrate-from-insomnia.md',
          'docs/guides/migrate-from-bruno.md',
          'docs/guides/migrate-from-hoppscotch.md',
          'docs/guides/migrate-from-other-tools.md',
        ],
      ],
    ],
  },
  {
    tab: 'Support',
    icon: 'lifebuoy',
    groups: [
      ['Help', ['docs/support.md', 'docs/faq.md', 'docs/troubleshooting.md', 'docs/changelog.md']],
      ['Community', ['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'LICENSE']],
    ],
  },
];
/** The footer's link columns; paths are relative to the site root, URLs open in a new tab. */
const FOOTER_LINKS = [
  [
    'Product',
    [
      ['Download', `${REPO}/releases`],
      ['Installation', 'docs/installation.html'],
      ['Changelog', 'docs/changelog.html'],
      ['Keyboard shortcuts', 'docs/shortcuts.html'],
      ['Security', 'docs/security.html'],
    ],
  ],
  [
    'Documentation',
    [
      ['Getting started', 'docs/getting-started.html'],
      ['Guides', 'docs/guides/index.html'],
      ['Migrate to API Workbench', 'docs/guides/migrate.html'],
      ['Reference', 'docs/reference.html'],
      ['llms.txt', 'llms.txt'],
    ],
  ],
  [
    'Resources',
    [
      ['Support', 'docs/support.html'],
      ['FAQ', 'docs/faq.html'],
      ['Troubleshooting', 'docs/troubleshooting.html'],
      ['Report a bug', `${REPO}/issues/new?template=bug_report.yml`],
      ['Request a feature', `${REPO}/issues/new?template=feature_request.yml`],
    ],
  ],
  [
    'Community',
    [
      ['GitHub', REPO],
      ['Contributing', 'docs/contributing.html'],
      ['Code of conduct', 'docs/code-of-conduct.html'],
      ['License', 'docs/license.html'],
    ],
  ],
];
/** Root files have no front matter; these give them their description and icon. */
const ROOT_META = {
  'CONTRIBUTING.md': {
    description: 'Set up the project, follow its conventions, and send a pull request.',
    icon: 'source-pull',
  },
  'CODE_OF_CONDUCT.md': {
    description: 'How we expect everyone to behave in the API Workbench community.',
    icon: 'account-group-outline',
  },
  'SECURITY.md': {
    description:
      'Supported versions, how to report a vulnerability privately, and how secrets are protected.',
    icon: 'shield-check-outline',
  },
  LICENSE: {
    description: 'API Workbench is released under the MIT License.',
    icon: 'scale-balance',
    title: 'License',
  },
};
/** Where a source file is published: docs/x.md → docs/x.html, README → index, root files → docs/<name>.html. */
function outputFor(source) {
  if (!source.startsWith('docs/'))
    return `docs/${source.replace(/\.md$/, '').toLowerCase().replace(/_/g, '-')}.html`;
  return source.replace(/README\.md$/, 'index.md').replace(/\.md$/, '.html');
}
const pages = NAV.flatMap((tab) =>
  tab.groups.flatMap(([group, sources]) =>
    sources.map((source) => ({ source, output: outputFor(source), tab: tab.tab, group })),
  ),
);
const pageFor = new Map(pages.map((page) => [page.source, page]));

const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
/** An inline MDI icon by kebab-case name, such as `shield-lock-outline`. */
function icon(name, className = 'icon') {
  const key = 'mdi' + name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
  if (!mdi[key]) throw new Error(`Unknown icon "${name}"`);
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><path d="${mdi[key]}"/></svg>`;
}
/** GitHub-style heading anchors, so links such as #the-credential-vault keep working. */
function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/&[a-z]+;|&#\d+;/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };
}
const words = (text) => (text.match(/[\p{L}\p{N}]+/gu) || []).length;
const plain = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
/** A link from a page, rewritten for the site: other pages become pages, the rest goes to GitHub. */
function rewriteLink(href, source, output) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [file, anchor] = href.split('#');
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), file));
  const hash = anchor ? `#${anchor}` : '';
  const relative = (to) =>
    path.posix.relative(path.posix.dirname(output), to) || path.posix.basename(to);
  if (pageFor.has(target)) return relative(pageFor.get(target).output) + hash;
  if (target.startsWith('docs/images/')) return relative(target.replace(/^docs\//, ''));
  return `${REPO}/blob/main/${target}${hash}`;
}
/** Splits YAML front matter from the Markdown body. */
function frontMatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return match
    ? { meta: parseYaml(match[1]) ?? {}, body: text.slice(match[0].length) }
    : { meta: {}, body: text };
}

const CALLOUTS = {
  NOTE: ['information-outline', 'Note'],
  TIP: ['lightbulb-on-outline', 'Tip'],
  IMPORTANT: ['alert-circle-outline', 'Important'],
  WARNING: ['alert-outline', 'Warning'],
  CAUTION: ['alert-octagon-outline', 'Caution'],
};
function render(markdown, page) {
  const slug = slugger();
  const headings = [];
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const id = slug(html);
        if (depth === 2 || depth === 3) headings.push({ id, depth, text: plain(html) });
        const anchor =
          depth > 1
            ? `<a class="anchor" href="#${id}" aria-label="Link to this section">${icon('link-variant')}</a>`
            : '';
        return `<h${depth} id="${id}">${html}${anchor}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const url = rewriteLink(href, page.source, page.output);
        const external = /^https?:/.test(url) && !url.startsWith(SITE);
        const text = this.parser.parseInline(tokens);
        const mark =
          external && !/<img/.test(text)
            ? `${icon('open-in-new', 'icon external')}<span class="sr-only"> (opens in a new tab)</span>`
            : '';
        return `<a href="${escape(url)}"${title ? ` title="${escape(title)}"` : ''}${external ? ' rel="noopener" target="_blank"' : ''}>${text}${mark}</a>`;
      },
      image({ href, text }) {
        const light = lightTwin(href, page.source);
        return `<figure>${themedImage(
          rewriteLink(href, page.source, page.output),
          light && rewriteLink(light, page.source, page.output),
          text,
          'loading="lazy"',
        )}<figcaption>${escape(text)}</figcaption></figure>`;
      },
      code({ text, lang }) {
        // ```cards, or ```cards compact for a row of small cards.
        const [block, variant] = (lang || '').split(/\s+/);
        if (block === 'cards') return cards(parseYaml(text), page, variant);
        if (block === 'chips') return chips(parseYaml(text), page);
        if (block === 'links') return linkColumns(parseYaml(text), page);
        if (block === 'download') return downloadPicker(page);
        const language = (lang || 'text').split(/\s/)[0];
        // ```sh title="macOS" gives a titled block; consecutive titled blocks become tabs.
        const title = /title="([^"]+)"/.exec(lang || '')?.[1];
        const label =
          title ??
          (isAssertions(text, language) ? 'Assertions' : (LANGUAGE_NAMES[language] ?? language));
        return `<div class="code-block"${title ? ` data-title="${escape(title)}"` : ''}><div class="code-head"><span>${escape(label)}</span><button type="button" class="copy" aria-label="Copy code">${icon('content-copy')}<span>Copy</span></button></div><pre><code class="language-${escape(language)}">${highlight(text, language)}</code></pre></div>\n`;
      },
      blockquote({ tokens }) {
        const html = this.parser.parse(tokens);
        const alert = /^<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/.exec(html);
        if (!alert) return `<blockquote>${html}</blockquote>\n`;
        const [name, label] = CALLOUTS[alert[1]];
        return `<div class="callout callout-${alert[1].toLowerCase()}" role="note">${icon(name)}<div><span class="callout-title">${label}</span><p>${html.slice(alert[0].length)}</div></div>\n`;
      },
    },
  });
  const html = codeGroups(marked.parse(markdown))
    .replace(/<p>(<figure>[\s\S]*?<\/figure>)<\/p>/g, '$1')
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>');
  return { html, headings };
}
/** Adjacent titled code blocks become one block with a tab per title, such as macOS / Windows / Linux. */
let codeGroupCount = 0;
function codeGroups(html) {
  return html.replace(
    /(?:<div class="code-block" data-title="[^"]+">[\s\S]*?<\/code><\/pre><\/div>\s*){2,}/g,
    (group) => {
      const blocks = [
        ...group.matchAll(
          /<div class="code-block" data-title="([^"]+)">[\s\S]*?<pre>([\s\S]*?)<\/pre><\/div>/g,
        ),
      ];
      const id = `code-group-${++codeGroupCount}`;
      const tabs = blocks
        .map(
          ([, title], index) =>
            `<button type="button" role="tab" id="${id}-tab-${index}" aria-controls="${id}-panel-${index}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${title}</button>`,
        )
        .join('');
      const panels = blocks
        .map(
          ([, , pre], index) =>
            `<pre role="tabpanel" id="${id}-panel-${index}" aria-labelledby="${id}-tab-${index}"${index ? ' hidden' : ''}>${pre}</pre>`,
        )
        .join('');
      return `<div class="code-block code-group"><div class="code-head"><div role="tablist" aria-label="Variants">${tabs}</div><button type="button" class="copy" aria-label="Copy code">${icon('content-copy')}<span>Copy</span></button></div>${panels}</div>\n`;
    },
  );
}
/**
 * A screenshot in the reader's theme: with a light-theme twin, both images are in the page and
 * site.css shows the one that matches; without one, the image alone.
 */
function themedImage(src, lightSrc, alt, attributes = '') {
  const image = (url, className) =>
    `<img${className ? ` class="${className}"` : ''} src="${escape(url)}" alt="${escape(alt)}"${attributes ? ` ${attributes}` : ''}>`;
  return lightSrc ? image(src, 'shot-dark') + image(lightSrc, 'shot-light') : image(src);
}
/**
 * The looping demo on the home page, with its light-theme twin when there is one. Readers who
 * prefer reduced motion get the still screenshot of the same theme.
 */
function heroDemo() {
  const alt = 'API Workbench: sending a request, checking its tests, and running a load test';
  const take = (demo, still, className) =>
    `<picture><source media="(prefers-reduced-motion: reduce)" srcset="${still}"><img${className ? ` class="${className}"` : ''} src="${demo}" alt="${alt}" width="1280" height="800"></picture>`;
  const light = lightTwin('images/demo.webp', 'docs/README.md');
  if (!light) return take('images/demo.webp', 'images/request-response.png');
  const still = lightTwin('images/request-response.png', 'docs/README.md');
  return (
    take('images/demo.webp', 'images/request-response.png', 'shot-dark') +
    take(light, still ?? 'images/request-response.png', 'shot-light')
  );
}
/**
 * The light-theme twin of a docs image or animation (`x.png` → `x-light.png`, `demo.webp` →
 * `demo-light.webp`), when there is one.
 */
function lightTwin(href, source) {
  if (/^[a-z]+:/i.test(href) || !/\.(png|webp)$/i.test(href)) return undefined;
  const twin = href.replace(/\.(png|webp)$/i, '-light.$1');
  return existsSync(path.join(root, path.posix.dirname(source), twin)) ? twin : undefined;
}
/** A link to a page or URL from a block's YAML; URLs open in a new tab. */
function blockLink(href, page, className, content) {
  const url = rewriteLink(href, page.source, page.output);
  const external = /^https?:/.test(url);
  return `<a${className ? ` class="${className}"` : ''} href="${escape(url)}"${external ? ' rel="noopener" target="_blank"' : ''}>${content}</a>`;
}
function cards(list, page, variant) {
  return `<div class="cards${variant ? ` cards-${escape(variant)}` : ''}">${list
    .map((card) =>
      blockLink(
        card.href,
        page,
        'card',
        `${icon(card.icon || 'arrow-right', 'card-icon')}<strong>${escape(card.title)}</strong>${card.text ? `<span>${escape(card.text)}</span>` : ''}${icon('arrow-right', 'card-arrow')}`,
      ),
    )
    .join('')}</div>\n`;
}
/**
 * The download picker: system, architecture, format, and version, with the link, the commands to
 * download and check the file, and every file of the version. The page works without scripts: it
 * shows the link for the most common choice and the whole list; assets/download.mjs adds the
 * choices, starting from the reader's own system.
 */
function downloadPicker(page) {
  const files = [...releaseFiles(pkg.build), CLI_ENTRY];
  const versions = [...new Set([pkg.version, ...changelogVersions(CHANGELOG)])];
  const version = versions[0];
  const first = files.find((file) => file.os === 'mac' && file.arch === 'arm64');
  const up = '../'.repeat(page.output.split('/').length - 1);
  // A styled select: the browser's own list opens, with the field's icon and a chevron around it.
  const select = (name, label, glyph, extra = '') =>
    `<label class="download-field"><span class="download-label">${icon(glyph)}${label}</span><span class="download-select"><select name="${name}"></select>${icon('chevron-down', 'download-chevron')}</span>${extra}</label>`;
  // Every file of the version, grouped by system. The script changes only the version in each
  // link and marks the chosen file, so the rows are written once, here.
  const unique = files.filter(
    (file, index) => files.findIndex((other) => other.name === file.name) === index,
  );
  const groups = [
    ['mac', 'macOS', 'apple'],
    ['win', 'Windows', 'microsoft-windows'],
    ['linux', 'Linux', 'linux'],
    ['cli', 'Command line', 'console'],
  ];
  const fileLink = (name) =>
    `<a class="download-row-link" href="${escape(downloadURL(name, version))}">${icon('download')}<code>${escape(fileName(name, version))}</code></a>`;
  const row = (file) => {
    const arches = file.target === 'nsis' ? 'x64 arm64' : file.arch;
    const archLabel =
      file.os === 'cli' ? 'Any' : file.target === 'nsis' ? 'x64 and arm64' : file.arch;
    return `<tr data-os="${file.os}" data-arch="${arches}" data-target="${escape(file.target)}" data-name="${escape(file.name)}"><td><span class="download-format">${escape(file.label)}<span class="download-arch">${escape(archLabel)}</span></span></td><td>${fileLink(file.name)}</td></tr>`;
  };
  const body = groups
    .map(
      ([os, label, glyph]) =>
        `<tbody><tr class="download-group"><th colspan="2" scope="rowgroup">${icon(glyph)}${label}</th></tr>${unique
          .filter((file) => file.os === os)
          .map(row)
          .join('')}</tbody>`,
    )
    .join('');
  const sums = `<tbody><tr class="download-group"><th colspan="2" scope="rowgroup">${icon('shield-check-outline')}Verification</th></tr><tr data-name="SHA256SUMS"><td><span class="download-format">SHA-256 checksums of every file</span></td><td>${fileLink('SHA256SUMS')}</td></tr></tbody>`;
  return `<section class="download-picker" aria-label="Download API Workbench" data-files="${escape(JSON.stringify(files))}" data-versions="${escape(JSON.stringify(versions))}" data-architectures="${escape(JSON.stringify(ARCHITECTURES))}">
<div class="download-head"><strong>Download API Workbench</strong><p class="download-detected" aria-live="polite"></p></div>
<div class="download-fields" hidden>${select('os', 'System', 'monitor')}${select('arch', 'Architecture', 'chip')}${select('format', 'Format', 'package-variant-closed')}${select('version', 'Version', 'tag-outline', '<input name="custom-version" type="text" inputmode="decimal" placeholder="Version, such as 1.2.0" aria-label="Another version" spellcheck="false" hidden>')}</div>
<div class="download-result">
<a class="button primary download-link" href="${escape(downloadURL(first.name, version))}">${icon('download')}<span>Download <span class="download-file">${escape(fileName(first.name, version))}</span></span></a>
<p class="download-detail">${escape(`${SYSTEMS.mac}, ${first.arch} · ${first.label}. ${first.detail}`)}</p>
<p class="download-problem" role="alert" hidden></p>
<div class="code-block"><div class="code-head"><span>Download and check from a terminal</span><button type="button" class="copy" aria-label="Copy code">${icon('content-copy')}<span>Copy</span></button></div><pre><code class="download-commands">${escape(downloadCommands(first, version))}</code></pre></div>
</div>
<details class="download-all"><summary>${icon('chevron-down', 'download-all-chevron')}<span>Every file in version <span class="download-all-version">${escape(version)}</span></span><span class="download-count">${unique.length + 1} files</span></summary><div class="table-wrap"><table><thead><tr><th scope="col">Format and architecture</th><th scope="col">File</th></tr></thead>${body}${sums}</table></div></details>
<script type="module" src="${up}assets/download.mjs"></script>
</section>\n`;
}
/** A row of pill links, such as one per protocol. */
function chips(list, page) {
  return `<div class="chips">${list
    .map((chip) =>
      blockLink(
        chip.href,
        page,
        'chip',
        `${icon(chip.icon || 'arrow-right')}${escape(chip.title)}`,
      ),
    )
    .join('')}</div>\n`;
}
/** Columns of plain links under headings, such as popular topics. */
function linkColumns(list, page) {
  return `<div class="link-columns">${list
    .map(
      (column) =>
        `<div><strong>${icon(column.icon || 'file-document-outline')}${escape(column.title)}</strong><ul>${column.links
          .map((item) => `<li>${blockLink(item.href, page, '', escape(item.title))}</li>`)
          .join('')}</ul></div>`,
    )
    .join('')}</div>\n`;
}

/** The page shell. `depth` is how many folders below the site root the page is. */
function layout({
  title,
  description,
  body,
  depth = 0,
  current,
  landing = false,
  base,
  url = '',
  structured,
  robots,
}) {
  // The 404 page is served at any depth, so it links from the site's absolute base.
  const up = base ?? '../'.repeat(depth);
  const tabs = NAV.map((tab) => {
    const first = pageFor.get(tab.groups[0][1][0]);
    const active = current?.tab === tab.tab;
    return `<a href="${up}${first.output}"${active ? ' aria-current="page"' : ''}>${icon(tab.icon)}${tab.tab}</a>`;
  }).join('');
  return `<!doctype html>
<html lang="en" data-announcement="${ANNOUNCEMENT.id}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CONTENT_POLICY}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<meta name="copyright" content="${escape(COPYRIGHT)}">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
<meta property="og:type" content="${current ? 'article' : 'website'}">
<meta property="og:url" content="${SITE}${url}">
<meta property="og:site_name" content="API Workbench">
${robots ? `<meta name="robots" content="${robots}">` : `<link rel="canonical" href="${SITE}${url}">`}
${current ? `<link rel="alternate" type="text/markdown" href="${up}${current.output.replace(/\.html$/, '.md')}" title="This page as Markdown">` : ''}
<meta property="og:image" content="${SITE}images/request-response.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="color-scheme" content="dark light">
<link rel="icon" type="image/svg+xml" href="${up}assets/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="${up}assets/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="${up}assets/favicon-16.png">
<link rel="apple-touch-icon" href="${up}assets/apple-touch-icon.png">
<link rel="stylesheet" href="${up}assets/site.css">
<script src="${up}assets/theme.js"></script>
<script src="${up}assets/site.js" defer data-root="${up}"></script>
${structured ? `<script type="application/ld+json">${JSON.stringify(structured).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body class="${landing ? 'landing' : 'docs'}">
<a class="skip" href="#content">Skip to content</a>
<div class="announcement" role="region" aria-label="Announcement">${icon('star-outline')}<p>${ANNOUNCEMENT.html.replace('{repo}', REPO)}</p><button type="button" class="icon-link" aria-label="Dismiss">${icon('close')}</button></div>
<header class="site-header">
  <div class="header-row">
    ${landing ? '' : `<button type="button" class="menu-button icon-link" aria-label="Open navigation" aria-expanded="false" aria-controls="sidebar">${icon('menu')}</button>`}
    <a class="brand" href="${up}index.html" aria-label="API Workbench home">${brandLogo(up, 26)}<span>API <b>Workbench</b></span></a>
    <a class="version-chip" href="${up}docs/changelog.html" title="What's new in this version">v${escape(pkg.version)}</a>
    <button type="button" class="search-button" aria-label="Search documentation" aria-keyshortcuts="Meta+K Control+K">${icon('magnify')}<span>Search…</span><kbd>⌘K</kbd></button>
    <nav class="header-links" aria-label="Site">
      ${landing ? `<a class="text-link" href="${up}docs/index.html">Documentation</a>` : ''}
      <a class="icon-link" href="${REPO}" rel="noopener" target="_blank" aria-label="GitHub">${icon('github')}</a>
      <button type="button" class="icon-link theme-toggle" aria-label="Switch to the light theme" title="Switch theme">${icon('weather-night', 'icon moon')}${icon('white-balance-sunny', 'icon sun')}</button>
      <a class="button primary small" href="${up}docs/getting-started.html">Get started</a>
    </nav>
  </div>
  ${landing ? '' : `<nav class="tabs" aria-label="Sections">${tabs}</nav>`}
  ${landing ? '' : '<div class="reading-progress" aria-hidden="true"><span></span></div>'}
</header>
<div class="site-toast" role="status" aria-live="polite" hidden></div>
${body}
<div class="search-dialog" hidden>
  <div class="search-panel" role="dialog" aria-modal="true" aria-label="Search documentation">
    <label class="search-field">${icon('magnify')}<input type="search" placeholder="Search the docs…" aria-label="Search the docs" aria-controls="search-results" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></label>
    <ul class="search-results" id="search-results" role="listbox" aria-label="Results"></ul>
    <p class="search-hint"><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>↵</kbd> to open · <kbd>Esc</kbd> to close</p>
  </div>
</div>
<footer class="site-footer">
  <div class="footer-top">
    <div class="footer-brand">
      <a class="brand" href="${up}index.html">${brandLogo(up, 26)}<span>API <b>Workbench</b></span></a>
      <p>The open-source, local-first desktop client to build, test, debug, and automate APIs.</p>
      <div class="footer-actions">
        <a class="button primary small" href="${REPO}/releases" rel="noopener" target="_blank">${icon('download')}Download</a>
        <a class="button small" href="${REPO}" rel="noopener" target="_blank">${icon('star-outline')}Star on GitHub</a>
      </div>
      <p class="footer-platforms">${icon('apple')}macOS ${icon('microsoft-windows')}Windows ${icon('linux')}Linux</p>
    </div>
    <nav class="footer-links" aria-label="Footer">
      ${FOOTER_LINKS.map(
        ([title, links]) =>
          `<div><h2>${escape(title)}</h2><ul>${links
            .map(([label, href]) => {
              const external = /^https?:/.test(href);
              return `<li><a href="${external ? href : up + href}"${external ? ' rel="noopener" target="_blank"' : ''}>${escape(label)}${external ? icon('arrow-top-right', 'icon external') : ''}</a></li>`;
            })
            .join('')}</ul></div>`,
      ).join('\n      ')}
    </nav>
  </div>
  <div class="footer-bottom">
    <p class="copyright">${COPYRIGHT}. Released under the <a href="${up}docs/license.html">MIT License</a>.</p>
    <div class="footer-meta">
      <a class="footer-version" href="${up}docs/changelog.html" title="Changelog">v${escape(pkg.version)}</a>
      <div class="theme-switch" role="group" aria-label="Theme">
        <button type="button" data-theme-choice="system" aria-pressed="true" title="System">${icon('monitor')}<span class="visually-hidden">System</span></button>
        <button type="button" data-theme-choice="light" aria-pressed="false" title="Light">${icon('white-balance-sunny')}<span class="visually-hidden">Light</span></button>
        <button type="button" data-theme-choice="dark" aria-pressed="false" title="Dark">${icon('weather-night')}<span class="visually-hidden">Dark</span></button>
      </div>
      <a class="icon-link" href="${REPO}" rel="noopener" target="_blank" aria-label="API Workbench on GitHub">${icon('github')}</a>
      <a class="back-to-top" href="#top">${icon('arrow-up')}Back to top</a>
    </div>
  </div>
</footer>
</body>
</html>
`;
}

function docPage(page, { html, headings }) {
  const depth = page.output.split('/').length - 1;
  const link = (to) =>
    path.posix.relative(path.posix.dirname(page.output), to) || path.posix.basename(to);
  const tab = NAV.find((item) => item.tab === page.tab);
  const sidebar = tab.groups
    .map(
      ([group, sources]) =>
        `<div class="nav-group"><span>${escape(group)}</span>${sources
          .map((source) => {
            const target = pageFor.get(source);
            return `<a href="${link(target.output)}"${target === page ? ' aria-current="page"' : ''}>${icon(target.meta.icon || 'file-document-outline')}${escape(target.meta.navTitle)}</a>`;
          })
          .join('')}</div>`,
    )
    .join('');
  const siblings = pages.filter((item) => item.tab === page.tab);
  const index = siblings.indexOf(page);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  const toc =
    headings.filter((heading) => heading.depth === 2).length > 1
      ? `<aside class="toc" aria-label="On this page"><span>${icon('format-list-bulleted')}On this page</span>${headings
          .map(
            (heading) =>
              `<a href="#${heading.id}" class="depth-${heading.depth}">${escape(heading.text)}</a>`,
          )
          .join('')}</aside>`
      : '<aside class="toc" aria-hidden="true"></aside>';
  const editable = page.source !== 'LICENSE';
  const updated = lastUpdated(page.source);
  const minutes = Math.max(1, Math.round(words(plain(html)) / 220));
  const markdownUrl = path.posix.basename(page.output).replace(/\.html$/, '.md');
  const crumbs = [
    [page.tab, link(pageFor.get(tab.groups[0][1][0]).output)],
    ...(page.group !== page.tab ? [[page.group]] : []),
  ];
  const breadcrumbs = `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>${crumbs
    .map(
      ([label, href]) =>
        `<li>${href ? `<a href="${href}">${escape(label)}</a>` : `<span>${escape(label)}</span>`}${icon('chevron-right')}</li>`,
    )
    .join('')}<li><span aria-current="page">${escape(page.meta.navTitle)}</span></li></ol></nav>`;
  // `layout: home` in the front matter gives a landing hero and drops the article furniture.
  const home = page.meta.layout === 'home';
  const hero = `<header class="home-hero">
      <span class="eyebrow">${icon(page.meta.icon || 'book-open-variant')}Documentation · v${escape(pkg.version)}</span>
      <h1>${escape(page.title)}</h1>
      ${page.meta.description ? `<p class="lead">${escape(page.meta.description)}</p>` : ''}
      <button type="button" class="home-search" data-open-search aria-keyshortcuts="Meta+K Control+K">${icon('magnify')}<span>Search guides, settings, and reference…</span><kbd>⌘K</kbd></button>
      <div class="actions">${(page.meta.actions || [])
        .map((action) =>
          blockLink(
            action.href,
            page,
            `button${action.primary ? ' primary' : ''}`,
            `${action.icon ? icon(action.icon) : ''}${escape(action.title)}`,
          ),
        )
        .join('')}</div>
    </header>`;
  const body = `<div class="docs-shell${home ? ' docs-home' : ''}">
  <nav class="sidebar" id="sidebar" aria-label="${escape(page.tab)}">${sidebar}</nav>
  <div class="sidebar-backdrop" hidden></div>
  <main id="content" class="doc">
    ${
      home
        ? `${hero}\n    <article class="prose">${html}</article>`
        : `<header class="doc-header">
      ${breadcrumbs}
      <div class="title-row">
        <h1>${escape(page.title)}</h1>
        <div class="page-menu">
          <button type="button" class="button small copy-page" data-markdown="${markdownUrl}">${icon('content-copy')}<span>Copy page</span></button>
          <a class="button small icon-only" href="${markdownUrl}" aria-label="View as Markdown" title="View as Markdown">${icon('language-markdown-outline')}</a>
        </div>
      </div>
      ${page.meta.description ? `<p class="lead">${escape(page.meta.description)}</p>` : ''}
      <p class="page-meta">${icon('clock-outline')}${minutes} min read${updated ? `<span aria-hidden="true">·</span>Updated <time datetime="${updated}">${formatDate(updated)}</time>` : ''}</p>
    </header>
    <article class="prose">${html}</article>
    <section class="feedback" aria-labelledby="feedback-title">
      <h2 id="feedback-title">Was this page helpful?</h2>
      <div class="feedback-buttons">
        <button type="button" class="button small" data-helpful="yes">${icon('thumb-up-outline')}Yes</button>
        <button type="button" class="button small" data-helpful="no">${icon('thumb-down-outline')}No</button>
      </div>
      <p class="feedback-thanks" role="status" hidden>Thanks for the feedback. <a href="${REPO}/issues/new?labels=documentation&amp;title=${encodeURIComponent(`Docs feedback: ${page.title}`)}" rel="noopener" target="_blank">Tell us how to improve this page</a>.</p>
    </section>
    <div class="doc-actions">
      ${editable ? `<a href="${REPO}/edit/main/${page.source}" rel="noopener" target="_blank">${icon('pencil-outline')}Edit this page</a>` : ''}
      <a href="${REPO}/issues/new?title=${encodeURIComponent(`Docs: ${page.title}`)}" rel="noopener" target="_blank">${icon('alert-circle-outline')}Report an issue</a>
    </div>
    <nav class="pager" aria-label="Previous and next">
      ${previous ? `<a class="previous" href="${link(previous.output)}"><small>${icon('arrow-left')}Previous</small>${escape(previous.meta.navTitle)}</a>` : '<span></span>'}
      ${next ? `<a class="next" href="${link(next.output)}"><small>Next${icon('arrow-right')}</small>${escape(next.meta.navTitle)}</a>` : '<span></span>'}
    </nav>`
    }
  </main>
  ${home ? '' : toc}
</div>`;
  return layout({
    title: `${page.title} · API Workbench`,
    description: page.meta.description || `API Workbench documentation: ${page.title}.`,
    body,
    depth,
    current: page,
    url: page.output,
    structured: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'TechArticle',
          headline: page.title,
          description: page.meta.description || undefined,
          url: SITE + page.output,
          dateModified: updated || undefined,
          isPartOf: { '@type': 'WebSite', name: 'API Workbench', url: SITE },
          author: OWNER,
          copyrightHolder: OWNER,
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [...crumbs.map(([label]) => label), page.meta.navTitle].map(
            (name, position) => ({
              '@type': 'ListItem',
              position: position + 1,
              name,
            }),
          ),
        },
      ],
    },
  });
}
/** 2026-10-24 → Oct 24, 2026 */
const formatDate = (date) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

function landingPage() {
  const features = [
    [
      'send-outline',
      'Design and send requests',
      'HTTP and GraphQL with params, headers, JSON, XML, form, multipart, and binary bodies, environments, and generated code in 26 languages.',
      'docs/requests.html',
    ],
    [
      'check-circle-outline',
      'Test every response',
      'Plain-text or visual assertions on status, headers, timing, and JSON, run on every send and in collection runs.',
      'docs/tests.html',
    ],
    [
      'speedometer',
      'Benchmark and load test',
      'Collection runs, benchmarks, and performance tests with percentiles, confidence intervals, charts, and baselines.',
      'docs/runner.html',
    ],
    [
      'lightning-bolt-outline',
      'Realtime protocols',
      'WebSocket, Server-Sent Events, NDJSON streams, and gRPC with every kind of streaming, in the same editor.',
      'docs/live-protocols.html',
    ],
    [
      'radar',
      'Intercept app traffic',
      'A capture proxy records what browsers, simulators, and CLIs send — including decrypted HTTPS — and saves it as requests.',
      'docs/interceptor.html',
    ],
    [
      'shield-lock-outline',
      'Secrets stay safe',
      'An encrypted vault backed by your OS keychain, cloud secret providers, OAuth 2.0 with discovery, and client certificates.',
      'docs/credentials.html',
    ],
    [
      'swap-vertical',
      'Bring your collections',
      'Migrate from Postman, Insomnia, Bruno, or Hoppscotch, or import OpenAPI, HAR, cURL, and .http files.',
      'docs/guides/migrate.html',
    ],
    [
      'laptop',
      'Local first',
      'No account and no cloud sync. Workspaces, history, and secrets stay on your machine.',
      'docs/installation.html',
    ],
  ];
  const shots = [
    ['request-response.png', 'Compose requests and read formatted responses'],
    ['runner-charts.png', 'Measure throughput and latency over time'],
    ['interceptor.png', 'Capture traffic from other apps'],
    ['credentials.png', 'Keep secrets in an encrypted vault'],
  ];
  const body = `<main id="content">
  <section class="hero">
    <div class="hero-copy">
      <span class="eyebrow">Open source · MIT licensed · Local first</span>
      <h1>Build, test, debug, and automate APIs in one place.</h1>
      <p>API Workbench is a desktop API client for HTTP, GraphQL, WebSocket, SSE, NDJSON, and gRPC. Your requests, environments, and secrets stay on your machine.</p>
      <div class="actions">
        <a class="button primary" href="docs/getting-started.html">${icon('rocket-launch-outline')}Get started</a>
        <a class="button" href="docs/index.html">${icon('book-open-variant')}Read the docs</a>
        <a class="button" href="${REPO}" rel="noopener" target="_blank">${icon('github')}GitHub</a>
      </div>
      <p class="platforms">${icon('apple')} macOS · ${icon('microsoft-windows')} Windows · ${icon('linux')} Linux</p>
    </div>
    <figure class="hero-shot">${heroDemo()}</figure>
  </section>
  <section class="features" aria-labelledby="features-title">
    <h2 id="features-title">Everything an API needs, without the cloud</h2>
    <div class="cards cards-4">
      ${features.map(([name, title, text, href]) => `<a class="card" href="${href}">${icon(name, 'card-icon')}<strong>${title}</strong><span>${text}</span></a>`).join('\n      ')}
    </div>
  </section>
  <section class="gallery" aria-labelledby="gallery-title">
    <h2 id="gallery-title">See it in action</h2>
    <div class="shots">
      ${shots.map(([file, caption]) => `<figure>${themedImage(`images/${file}`, lightTwin(`images/${file}`, 'docs/README.md') && `images/${file.replace(/\.png$/, '-light.png')}`, caption, 'loading="lazy" width="1600" height="1000"')}<figcaption>${escape(caption)}</figcaption></figure>`).join('\n      ')}
    </div>
  </section>
  <section class="install" aria-labelledby="install-title">
    <div>
      <h2 id="install-title">Install</h2>
      <p>Download an installer from <a href="${REPO}/releases" rel="noopener" target="_blank">Releases</a>, or build it from source with Node.js 22.13 or later. See <a href="docs/installation.html">Installation</a>.</p>
    </div>
    <div class="code-block"><div class="code-head"><span>Shell</span><button type="button" class="copy" aria-label="Copy code">${icon('content-copy')}<span>Copy</span></button></div><pre><code>${highlight(`git clone ${REPO}.git\ncd api-workbench\nnpm install\nnpm start`, 'sh')}</code></pre></div>
  </section>
  <section class="open-source" aria-labelledby="oss-title">
    <h2 id="oss-title">Open source</h2>
    <div class="cards">
      <a class="card" href="docs/license.html">${icon('scale-balance', 'card-icon')}<strong>MIT License</strong><span>Use it, change it, and ship it, commercially or not.</span></a>
      <a class="card" href="docs/contributing.html">${icon('source-pull', 'card-icon')}<strong>Contribute</strong><span>Bug reports, fixes, features, and documentation are welcome.</span></a>
      <a class="card" href="docs/security.html">${icon('shield-check-outline', 'card-icon')}<strong>Security</strong><span>Secrets never leave the main process. Report vulnerabilities privately.</span></a>
    </div>
  </section>
</main>`;
  return layout({
    title: 'API Workbench — open-source, local-first API client',
    description: pkg.description,
    body,
    landing: true,
    structured: {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'API Workbench',
      description: pkg.description,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'macOS, Windows, Linux',
      softwareVersion: pkg.version,
      license: 'https://opensource.org/licenses/MIT',
      url: SITE,
      codeRepository: REPO,
      author: OWNER,
      copyrightHolder: OWNER,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
  });
}

// The logo has a light-theme and a dark-theme variant; site.css shows the one matching the theme.
function brandLogo(up, size) {
  return ['light', 'dark']
    .map(
      (theme) =>
        `<img class="logo-${theme}" src="${up}assets/app-icon-${theme}.svg" alt="" width="${size}" height="${size}">`,
    )
    .join('');
}

async function build() {
  await rm(out, { recursive: true, force: true });
  await mkdir(path.join(out, 'docs', 'guides'), { recursive: true });
  await mkdir(path.join(out, 'assets'), { recursive: true });
  await cp(path.join(root, 'docs', 'images'), path.join(out, 'images'), { recursive: true });
  for (const [from, to] of [
    [
      require.resolve('@techieutils/api-workbench-app/assets/branding/app-icon-light.svg'),
      'app-icon-light.svg',
    ],
    [
      require.resolve('@techieutils/api-workbench-app/assets/branding/app-icon-dark.svg'),
      'app-icon-dark.svg',
    ],
    // The favicon is the light-theme logo shown before "API Workbench" in the header. The PNGs
    // are rendered from it for browsers without SVG favicons (the touch icon on white).
    [
      require.resolve('@techieutils/api-workbench-app/assets/branding/app-icon-light.svg'),
      'favicon.svg',
    ],
    ['scripts/site/favicon-32.png', 'favicon-32.png'],
    ['scripts/site/favicon-16.png', 'favicon-16.png'],
    ['scripts/site/apple-touch-icon.png', 'apple-touch-icon.png'],
    ['scripts/site/site.css', 'site.css'],
    ['scripts/site/site.js', 'site.js'],
    ['scripts/site/theme.js', 'theme.js'],
    // The download picker, and the release file names it shares with this build.
    ['scripts/site/download.mjs', 'download.mjs'],
    ['scripts/release-files.mjs', 'release-files.mjs'],
  ])
    await cp(path.resolve(root, from), path.join(out, 'assets', to));
  // Read every page first, so the sidebar and pager know each page's title.
  for (const page of pages) {
    const raw = await readFile(path.join(root, page.source), 'utf8');
    const { meta, body } = frontMatter(raw);
    const rootMeta = ROOT_META[page.source] ?? {};
    page.meta = { ...rootMeta, ...meta };
    let markdown = page.source === 'LICENSE' ? `\`\`\`text\n${raw.trim()}\n\`\`\`\n` : body;
    const heading = /^#\s+(.+)$/m.exec(markdown);
    page.title = rootMeta.title || heading?.[1]?.trim() || page.source;
    if (heading) markdown = markdown.replace(heading[0], '').replace(/^\n+/, '');
    // The root pages list their sections for GitHub; the site has "On this page" for that.
    if (page.source in ROOT_META)
      markdown = markdown.replace(/^## Contents\n[\s\S]*?(?=^## )/m, '');
    page.markdown = markdown;
    page.meta.navTitle =
      page.meta.navTitle || (page.source === 'docs/README.md' ? 'Introduction' : page.title);
  }
  const search = [];
  for (const page of pages) {
    const rendered = render(page.markdown, page);
    await writeFile(path.join(out, page.output), docPage(page, rendered));
    // Each page as Markdown, for "View as Markdown", "Copy page", and AI tools.
    page.plainMarkdown = `# ${page.title}\n\n${page.meta.description ? `> ${page.meta.description}\n\n` : ''}${page.markdown.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (match, href) => `](${new URL(rewriteLink(href, page.source, page.output), SITE + page.output).href})`)}`;
    await writeFile(path.join(out, page.output.replace(/\.html$/, '.md')), page.plainMarkdown);
    // The search index: the page's opening, then each section with its text.
    for (const section of rendered.html.split(/(?=<h[23] id=")/)) {
      const heading = /^<h[23] id="([^"]+)">([\s\S]*?)<a class="anchor"/.exec(section);
      const text = plain(section).replace(/\s+/g, ' ').trim();
      if (!heading && !text) continue;
      search.push({
        title: page.title,
        group: page.group === page.tab ? page.tab : `${page.tab} · ${page.group}`,
        heading: heading ? plain(heading[2]) : '',
        url: page.output + (heading ? `#${heading[1]}` : ''),
        text: (heading ? text.slice(plain(heading[2]).length) : page.meta.description || text)
          .trim()
          .slice(0, 600),
      });
    }
  }
  await writeFile(path.join(out, 'assets', 'search.json'), JSON.stringify(search));
  await writeFile(path.join(out, 'index.html'), landingPage());
  // llms.txt (https://llmstxt.org): an index of the docs for language models, and the docs in one file.
  const llms = [`# API Workbench\n\n> ${pkg.description}\n`];
  for (const tab of NAV)
    for (const [group, sources] of tab.groups) {
      llms.push(`\n## ${group === tab.tab ? tab.tab : `${tab.tab}: ${group}`}\n`);
      for (const source of sources) {
        const page = pageFor.get(source);
        llms.push(
          `- [${page.title}](${SITE}${page.output.replace(/\.html$/, '.md')})${page.meta.description ? `: ${page.meta.description}` : ''}`,
        );
      }
    }
  await writeFile(path.join(out, 'llms.txt'), `${llms.join('\n')}\n`);
  await writeFile(
    path.join(out, 'llms-full.txt'),
    pages.map((page) => page.plainMarkdown.trim()).join('\n\n---\n\n') + '\n',
  );
  const urls = [
    { loc: SITE },
    ...pages.map((page) => ({ loc: SITE + page.output, lastmod: lastUpdated(page.source) })),
  ];
  await writeFile(
    path.join(out, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map(
        ({ loc, lastmod }) =>
          `  <url><loc>${escape(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`,
      )
      .join('\n')}\n</urlset>\n`,
  );
  await writeFile(
    path.join(out, 'robots.txt'),
    `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`,
  );
  await writeFile(
    path.join(out, '404.html'),
    layout({
      title: 'Page not found · API Workbench',
      description: 'This page does not exist.',
      landing: true,
      base: '/api-workbench/',
      robots: 'noindex',
      body: `<main id="content" class="not-found"><h1>Page not found</h1><p>That page has moved or never existed.</p><p class="actions"><a class="button primary" href="${SITE}">Home</a> <a class="button" href="${SITE}docs/index.html">Documentation</a></p></main>`,
    }),
  );
  // Serve files as they are; Pages would otherwise run them through Jekyll.
  await writeFile(path.join(out, '.nojekyll'), '');
  console.log(
    `Site built in ${path.relative(root, out)}: ${pages.length} pages, ${search.length} search entries.`,
  );
}

await build();

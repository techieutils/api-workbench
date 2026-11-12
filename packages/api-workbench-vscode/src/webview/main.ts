import {
  EDITABLE_AUTH,
  HIDDEN,
  METHODS,
  paramsOf,
  rowsFromText,
  rowsToText,
  urlTokens,
  withParams,
  type DocsView,
  type RequestDraft,
  type RunnerOptions,
  type RunnerView,
} from '../core/editing';
import {
  jsonTokens,
  type MockView,
  type NetworkView,
  type RequestView,
  type ResponseView,
} from '../core/views';
import type { LiveDraft, LiveView } from '../core/live';
import {
  ROUTE_METHODS,
  newRouteDraft,
  type MockDraft,
  type MockRouteDraft,
} from '../core/mock-edit';
import { AUTH_FORMS, fieldShows, optionValue } from '../core/auth';
import { REQUEST_TYPES, urlHint, type NewRequestView } from '../core/new-request';
import {
  HIDDEN_VALUE,
  SECRET_LOOKING,
  SENSITIVE_VARIABLE,
  type EnvironmentRow,
  type EnvironmentsView,
} from '../core/environments';
import type { TestResultRow, TestResultsView } from '../core/test-results';
import type { CertificatesView } from '../core/certificates';
import {
  CREDENTIAL_FORMS,
  CREDENTIAL_KINDS,
  credentialFieldShows,
  credentialStatus,
  credentialValue,
  secretSaved,
  type CredentialRow,
  type CredentialsView,
} from '../core/credentials';
import {
  graphqlCompletions,
  schemaEntries,
  type Completion,
  type GraphqlSchema,
} from '../core/graphql-schema';
import {
  GRAPHQL_STARTER,
  graphqlBody,
  graphqlErrors,
  graphqlOperations,
  graphqlParts,
  graphqlProblem,
  formatGraphql,
  graphqlTokens,
  variablesTokens,
} from '../core/graphql';

/**
 * The script of the extension's webviews: the request editor, a response, a mock server, the
 * runner, a specification's docs, and the panel's network log. It renders what the extension posts
 * with DOM calls and `textContent` only, so nothing a server or a workspace sent is ever read as
 * HTML, and asks the extension to act by posting the names of fixed actions, with plain data
 * (an edited request, the runner's settings) that the extension checks before using.
 * Bundled by scripts/build.mjs for the browser.
 */

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

/** What a response view shows on its own. */
interface ResponseOnly {
  view: 'response';
  response?: ResponseView;
  sending: boolean;
  error?: string;
  /** A `.http` file's request, whose captures the requests after it use. */
  fromFile?: boolean;
}
type View =
  | RequestView
  | ResponseOnly
  | MockView
  | NetworkView
  | RunnerView
  | DocsView
  | LiveView
  | NewRequestView
  | CredentialsView
  | EnvironmentsView
  | TestResultsView
  | CertificatesView;

/** What survives the webview being hidden and shown again: the view, and unsaved edits. */
interface Saved {
  view?: View;
  draft?: { key: string; value: RequestDraft };
  liveDraft?: { key: string; value: LiveDraft };
  runner?: { key: string; value: RunnerOptions };
  /** How the request editor splits the page between the request and the response. */
  layout?: { stacked: boolean; share: number };
  /** The mock page's unsaved settings. */
  mockDraft?: { key: string; value: MockDraft };
  /** The Environments page's unsaved variables. */
  environmentDraft?: { key: string; value: EnvironmentRow[] };
}

const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;
const saved = (vscode.getState() as Saved | undefined) ?? {};
let current: View | undefined = saved.view;
/** The tab chosen in each tab list, kept across renders. */
const chosenTabs: Record<string, string> = {};
/** Re-renders a tab list's chosen pane, such as Params after the URL changed. */
const refreshTabs: Record<string, () => void> = {};
let showRaw = false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const act = (action: string, value?: unknown) =>
  vscode.postMessage({ type: 'action', action, value });
/** Keeps the view and edits across hiding the tab, but never a token or password being typed. */
const persist = () => {
  const kept: Saved = { ...saved };
  // A schema can be large, and the extension sends it again when the tab is shown.
  if (kept.view?.view === 'request' && kept.view.graphqlSchema)
    kept.view = { ...kept.view, graphqlSchema: undefined };
  if (saved.draft)
    kept.draft = {
      ...saved.draft,
      value: {
        ...saved.draft.value,
        auth: { ...saved.draft.value.auth, secret: '', secrets: {} },
      },
    };
  if (saved.liveDraft)
    kept.liveDraft = {
      ...saved.liveDraft,
      value: {
        ...saved.liveDraft.value,
        auth: { ...saved.liveDraft.value.auth, secret: '', secrets: {} },
      },
    };
  // A value typed for a secret-looking variable is kept as hidden: it never reaches saved state.
  if (saved.environmentDraft)
    kept.environmentDraft = {
      ...saved.environmentDraft,
      value: saved.environmentDraft.value.map((row) =>
        SECRET_LOOKING.test(row.key) ? { ...row, value: HIDDEN_VALUE } : row,
      ),
    };
  vscode.setState(kept);
};

function button(
  label: string,
  action: string | (() => void),
  options: { primary?: boolean; title?: string; className?: string } = {},
) {
  const node = el(
    'button',
    [options.primary ? 'button primary' : 'button', options.className].filter(Boolean).join(' '),
    label,
  );
  node.type = 'button';
  if (options.title) node.title = options.title;
  node.addEventListener('click', () => (typeof action === 'string' ? act(action) : action()));
  return node;
}
/**
 * A link to the guide for what this page shows. The page names the guide; the extension opens
 * only the guides it knows (`GUIDES` in the common package), so nothing here chooses an address.
 */
const guideButton = (guide: string, topic: string) =>
  button('Guide', () => act('openGuide', guide), {
    title: `Open the ${topic} guide in your browser`,
    className: 'ghost',
  });
const methodClass = (method: string) => `method method-${method.toLowerCase()}`;

/** A text field that reports each change; `label` is what a screen reader hears. */
function input(
  value: string,
  label: string,
  onInput: (value: string) => void,
  options: { className?: string; placeholder?: string; readOnly?: boolean; type?: string } = {},
): HTMLInputElement {
  const node = el('input', options.className ?? 'input');
  node.type = options.type ?? 'text';
  node.value = value;
  node.spellcheck = false;
  node.setAttribute('aria-label', label);
  if (options.placeholder) node.placeholder = options.placeholder;
  node.readOnly = Boolean(options.readOnly);
  node.addEventListener('input', () => onInput(node.value));
  return node;
}

/** `{{name}}` in a URL stands out, as it does in the app. */
function templated(text: string): HTMLElement {
  const node = el('span', 'url-text');
  for (const part of text.split(/(\{\{[^{}]*\}\})/)) {
    if (!part) continue;
    node.append(/^\{\{/.test(part) ? el('span', 'variable', part) : document.createTextNode(part));
  }
  return node;
}

interface Pane {
  id: string;
  label: string;
  count?: number;
  render: () => Node;
}

/** A tab list whose tabs work with the arrow keys, as WAI-ARIA tabs do. */
function tabs(id: string, label: string, panes: Pane[] | (() => Pane[])): HTMLElement {
  const wrap = el('div', 'tabs');
  const list = el('div', 'tablist');
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', label);
  const body = el('div', 'tabpanel');
  body.setAttribute('role', 'tabpanel');
  body.tabIndex = 0;
  const panesNow = () => (typeof panes === 'function' ? panes() : panes);
  let buttons: HTMLButtonElement[] = [];
  const select = (paneId: string, focus: boolean) => {
    const all = panesNow();
    const pane = all.find((item) => item.id === paneId) ?? all[0];
    chosenTabs[id] = pane.id;
    buttons = all.map((item) => {
      const tab = el('button', 'tab', item.label);
      tab.type = 'button';
      tab.id = `tab-${id}-${item.id}`;
      tab.setAttribute('role', 'tab');
      if (item.count) tab.append(el('span', 'count', String(item.count)));
      const selected = item === pane;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.addEventListener('click', () => select(item.id, false));
      tab.addEventListener('keydown', (event) => {
        const at = all.indexOf(item);
        const next =
          event.key === 'ArrowRight'
            ? all[(at + 1) % all.length]
            : event.key === 'ArrowLeft'
              ? all[(at - 1 + all.length) % all.length]
              : event.key === 'Home'
                ? all[0]
                : event.key === 'End'
                  ? all[all.length - 1]
                  : undefined;
        if (next) {
          event.preventDefault();
          select(next.id, true);
        }
      });
      return tab;
    });
    list.replaceChildren(...buttons);
    const chosen = buttons[all.indexOf(pane)];
    if (focus) chosen.focus();
    body.setAttribute('aria-labelledby', chosen.id);
    body.replaceChildren(pane.render());
  };
  refreshTabs[id] = () => select(chosenTabs[id], false);
  wrap.append(list, body);
  select(chosenTabs[id], false);
  return wrap;
}

/** A table of rows of text, or a line saying it is empty. */
function table(heads: string[], rows: (string | Node)[][], empty: string): Node {
  if (!rows.length) return el('p', 'empty', empty);
  const wrap = el('div', 'table-wrap');
  const node = el('table');
  const head = el('tr');
  for (const text of heads) head.append(el('th', undefined, text));
  node.append(el('thead'), el('tbody'));
  node.tHead!.append(head);
  for (const row of rows) {
    const line = el('tr');
    for (const cell of row) {
      const td = el('td');
      td.append(cell);
      line.append(td);
    }
    node.tBodies[0].append(line);
  }
  wrap.append(node);
  return wrap;
}

/** Whether each kind of table (Header, Parameter, Field) is edited in bulk, as text. */
const bulkModes: Record<string, boolean> = {};
/** The secret-looking values revealed on this page, by name; forgotten when it closes. */
const revealed = new Set<string>();

/**
 * A table of names and values that can be added to and removed, as the app's Params and Headers
 * are: column headings, a switch per row where rows can be switched off (kept, not sent), and
 * Bulk edit, which shows them as `Name: value` lines. `onChange` runs on each keystroke.
 */
function editableRows(
  rows: { key: string; value: string; enabled?: boolean; kind?: 'file'; fileName?: string }[],
  options: {
    what: string;
    readOnly: boolean;
    onChange: () => void;
    /**
     * Rows can be files (multipart forms): each is Text or File, and a file row shows its file and
     * Choose file…, which `choose` asks the extension for. `chosen` says whether this session has it.
     */
    files?: { choose: (key: string) => void; chosen: (key: string) => boolean };
    hint?: (row: { key: string; value: string }) => string | undefined;
    /** Rows can be switched off. */
    toggles?: boolean;
    /** Names whose values are typed unseen, with a button to reveal one, as the app does. */
    masked?: RegExp;
  },
): Node {
  const wrap = el('div', 'kv');
  const separator = options.what === 'Parameter' ? '=' : ': ';
  const plural = `${options.what.toLowerCase()}s`;
  const draw = (focusLast = false) => {
    const bulk = bulkModes[options.what] === true && !options.readOnly;
    const nodes: Node[] = [];
    const bar = el('div', 'kv-bar');
    const on = rows.filter((row) => row.enabled !== false).length;
    bar.append(
      el(
        'span',
        'muted',
        rows.length
          ? options.toggles && on !== rows.length
            ? `${on} of ${rows.length} ${plural} sent`
            : `${rows.length} ${rows.length === 1 ? options.what.toLowerCase() : plural}`
          : `No ${plural}`,
      ),
      el('span', 'grow'),
    );
    // Lines of text cannot hold a file, so a form with file fields is edited as a table.
    if (!options.readOnly && !rows.some((row) => row.kind === 'file')) {
      const mode = button(
        bulk ? 'Table' : 'Bulk edit',
        () => {
          bulkModes[options.what] = !bulk;
          draw();
        },
        {
          className: 'ghost',
          title: bulk
            ? 'Edit as a table'
            : `Edit as lines of ${separator === '=' ? 'name=value' : 'Name: value'}`,
        },
      );
      mode.setAttribute('aria-pressed', String(bulk));
      bar.append(mode);
    }
    nodes.push(bar);
    if (bulk) {
      const area = el('textarea', 'textarea kv-bulk');
      area.value = rowsToText(rows, separator);
      area.spellcheck = false;
      area.setAttribute('aria-label', `${options.what}s, one a line`);
      area.placeholder =
        separator === '='
          ? 'limit=20\nstatus=active'
          : `Accept: application/json${options.toggles ? '\n# X-Debug: off, kept but not sent' : ''}`;
      area.addEventListener('input', () => {
        const parsed = rowsFromText(area.value, separator, Boolean(options.toggles));
        rows.splice(
          0,
          rows.length,
          ...parsed.map((row) => (options.toggles ? row : { key: row.key, value: row.value })),
        );
        options.onChange();
      });
      nodes.push(
        area,
        el(
          'p',
          'hint',
          `One a line, as ${separator === '=' ? 'name=value' : 'Name: value'}${options.toggles ? '; # before one keeps it without sending it' : ''}.`,
        ),
      );
      wrap.replaceChildren(...nodes);
      return;
    }
    const table = el('div', options.toggles ? 'kv-table toggles' : 'kv-table');
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', `${options.what}s`);
    if (rows.length) {
      const heads = el('div', 'kv-row kv-head');
      heads.setAttribute('role', 'row');
      for (const text of [
        ...(options.toggles ? ['On'] : []),
        options.what === 'Header' ? 'Name' : 'Key',
        'Value',
        '',
      ]) {
        const cell = el('span', undefined, text);
        cell.setAttribute('role', 'columnheader');
        heads.append(cell);
      }
      table.append(heads);
    }
    rows.forEach((row, index) => {
      const line = el('div', row.enabled === false ? 'kv-row off' : 'kv-row');
      line.setAttribute('role', 'row');
      const cell = (node: Node) => {
        const box = el('span', 'kv-cell');
        box.setAttribute('role', 'cell');
        box.append(node);
        line.append(box);
        return box;
      };
      if (options.toggles) {
        const box = el('input');
        box.type = 'checkbox';
        box.checked = row.enabled !== false;
        box.disabled = options.readOnly;
        box.setAttribute(
          'aria-label',
          `Send ${options.what.toLowerCase()} ${row.key || index + 1}`,
        );
        box.addEventListener('change', () => {
          row.enabled = box.checked;
          line.className = box.checked ? 'kv-row' : 'kv-row off';
          options.onChange();
          draw();
        });
        cell(box);
      }
      const key = input(
        row.key,
        `${options.what} ${index + 1} name`,
        (value) => {
          row.key = value;
          options.onChange();
        },
        { placeholder: options.what === 'Header' ? 'Name' : 'Key', readOnly: options.readOnly },
      );
      cell(key);
      let kindChoice: HTMLSelectElement | undefined;
      if (options.files) {
        const files = options.files;
        const kind = el('select', 'input kv-kind');
        kind.setAttribute('aria-label', `${options.what} ${row.key || index + 1} kind`);
        kind.disabled = options.readOnly;
        for (const [value, label] of [
          ['text', 'Text'],
          ['file', 'File'],
        ]) {
          const option = el('option', undefined, label);
          option.value = value;
          option.selected = (row.kind ?? 'text') === value;
          kind.append(option);
        }
        kind.addEventListener('change', () => {
          if (kind.value === 'file') {
            row.kind = 'file';
            row.value = '';
          } else {
            delete row.kind;
            delete row.fileName;
          }
          options.onChange();
          draw();
        });
        if (row.kind === 'file') {
          const box = el('span', 'kv-file');
          box.append(kind);
          const pick = button(row.fileName || 'Choose file…', () => files.choose(row.key), {
            className: 'ghost truncate',
            title: row.key
              ? `Choose the file sent as ${row.key}`
              : 'Name the field, then choose its file',
          });
          pick.disabled = options.readOnly || !row.key.trim();
          box.append(pick);
          // The file itself is chosen each session; the request keeps only its name.
          if (row.fileName && !files.chosen(row.key))
            box.append(el('span', 'text-small text-warning', 'choose again to send'));
          cell(box);
          if (!options.readOnly) {
            const remove = button('×', () => {
              rows.splice(index, 1);
              options.onChange();
              draw();
            });
            remove.className = 'icon-button';
            remove.title = `Remove ${row.key || options.what.toLowerCase()}`;
            remove.setAttribute('aria-label', `Remove ${options.what.toLowerCase()} ${row.key}`);
            cell(remove);
          } else cell(el('span'));
          table.append(line);
          return;
        }
        kindChoice = kind;
      }
      // A value the command line hid shows as empty, saying so; it stays hidden until replaced.
      const hidden = row.value === HIDDEN;
      const value = input(
        hidden ? '' : row.value,
        `${options.what} ${index + 1} value`,
        (text) => {
          row.value = hidden && !text ? HIDDEN : text;
          options.onChange();
        },
        {
          placeholder: hidden ? 'Hidden · type to replace' : 'Value',
          readOnly: options.readOnly,
        },
      );
      const hint = options.hint?.(row);
      const valueCell = cell(value);
      if (kindChoice) valueCell.prepend(kindChoice);
      // A secret-looking name's value is a password field, with Show to reveal it for a while.
      if (options.masked) {
        const reveal = button(
          'Show',
          () => {
            const shown = revealed.has(row.key);
            if (shown) revealed.delete(row.key);
            else revealed.add(row.key);
            mask();
            value.focus();
          },
          { className: 'ghost reveal' },
        );
        const mask = () => {
          const secret = options.masked!.test(row.key.trim());
          const shown = secret && revealed.has(row.key);
          value.type = secret && !shown ? 'password' : 'text';
          value.autocomplete = secret ? 'off' : 'on';
          reveal.hidden = !secret;
          reveal.textContent = shown ? 'Hide' : 'Show';
          reveal.setAttribute('aria-pressed', String(shown));
          reveal.setAttribute(
            'aria-label',
            `${shown ? 'Hide' : 'Show'} the value of ${row.key || 'this variable'}`,
          );
          valueCell.classList.toggle('masked', secret);
        };
        key.addEventListener('input', mask);
        valueCell.append(reveal);
        mask();
      }
      if (hint) value.title = hint;
      if (hidden) {
        valueCell.classList.add('secret-cell');
        const mark = el('span', 'secret-mark', '🔒︎ secret');
        mark.setAttribute('aria-hidden', 'true');
        valueCell.append(mark);
      }
      if (!options.readOnly) {
        const remove = button('×', () => {
          rows.splice(index, 1);
          options.onChange();
          draw();
        });
        remove.className = 'icon-button';
        remove.title = `Remove ${row.key || options.what.toLowerCase()}`;
        remove.setAttribute('aria-label', `Remove ${options.what.toLowerCase()} ${row.key}`);
        cell(remove);
      } else cell(el('span'));
      table.append(line);
      if (focusLast && index === rows.length - 1) queueMicrotask(() => key.focus());
    });
    nodes.push(table);
    if (!options.readOnly)
      nodes.push(
        button(
          `+ Add ${options.what.toLowerCase()}`,
          () => {
            rows.push(
              options.toggles ? { key: '', value: '', enabled: true } : { key: '', value: '' },
            );
            options.onChange();
            draw(true);
          },
          { className: 'ghost add-row' },
        ),
      );
    wrap.replaceChildren(...nodes);
  };
  draw();
  return wrap;
}

function bodyView(response: ResponseView): Node {
  const wrap = el('div', 'body-wrap');
  const tools = el('div', 'toolbar small');
  if (response.json || response.body !== response.rawBody) {
    const pretty = button('Pretty', () => setRaw(false));
    pretty.setAttribute('aria-pressed', String(!showRaw));
    const raw = button('Raw', () => setRaw(true));
    raw.setAttribute('aria-pressed', String(showRaw));
    tools.append(pretty, raw);
  }
  tools.append(el('span', 'grow'));
  if (response.body) tools.append(button('Copy', 'copyBody', { title: 'Copy the body' }));
  tools.append(
    button('Open as text', 'openText', {
      title: 'The whole response in an editor tab, to search or save',
    }),
  );
  wrap.append(tools);
  if (!response.body) {
    wrap.append(el('p', 'empty', 'The response has no body.'));
    return wrap;
  }
  const pre = el('pre', 'body');
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', 'Response body');
  if (showRaw) pre.textContent = response.rawBody;
  else if (response.json)
    for (const token of jsonTokens(response.body))
      pre.append(
        token.kind === 'punctuation'
          ? document.createTextNode(token.text)
          : el('span', `json-${token.kind}`, token.text),
      );
  else pre.textContent = response.body;
  wrap.append(pre);
  return wrap;
}
function setRaw(raw: boolean) {
  showRaw = raw;
  refreshTabs.response?.();
}

function resultLine(pass: boolean, text: string): HTMLElement {
  const line = el('li', pass ? 'pass' : 'fail');
  line.append(
    el('span', 'mark', pass ? '✓' : '✗'),
    el('span', 'visually-hidden', pass ? 'Passed: ' : 'Failed: '),
  );
  line.append(document.createTextNode(text));
  return line;
}

function responsePane(
  response: ResponseView | undefined,
  sending: boolean,
  error?: string,
  fromFile = false,
): HTMLElement {
  const section = el('section', 'card response');
  section.setAttribute('aria-label', 'Response');
  const status = el('div', 'status-row');
  status.setAttribute('role', 'status');
  section.append(status);
  if (sending) {
    status.append(el('span', 'spinner'), el('span', 'muted', 'Sending…'));
    return section;
  }
  if (error) {
    status.append(el('span', 'pill bad', 'Not sent'));
    section.append(el('p', 'error', error));
    return section;
  }
  if (!response) {
    status.append(el('span', 'muted', 'No response yet'));
    const empty = el('div', 'empty-state');
    const keys = /Mac/i.test(navigator.platform) ? ['⌘', 'Enter'] : ['Ctrl', 'Enter'];
    const hint = el('p', 'muted', 'Send the request with Send or ');
    keys.forEach((key, at) => {
      if (at) hint.append('+');
      hint.append(el('kbd', undefined, key));
    });
    hint.append(' to see its status, headers, body, and tests here.');
    empty.append(hint);
    section.append(empty);
    return section;
  }
  const heading = el('span', 'response-label');
  heading.append(el('span', response.ok ? 'dot' : 'dot bad'), 'Response');
  status.append(heading, el('span', 'grow'));
  status.append(el('span', response.ok ? 'pill good' : 'pill bad', response.status));
  // Time, size, and protocol, each with what it is for a screen reader and on hover.
  const labels = ['Time', 'Size', 'Protocol'];
  response.timing.forEach((part, index) => {
    const stat = el('span', 'stat');
    if (labels[index]) {
      stat.title = labels[index];
      stat.append(el('span', 'stat-label', labels[index]));
    }
    stat.append(el('span', 'stat-value', part));
    status.append(stat);
  });
  if (response.testSummary)
    status.append(
      el(
        'span',
        response.tests.every((test) => test.pass) ? 'good-text' : 'bad-text',
        `Tests ${response.testSummary}`,
      ),
    );
  if (response.error) section.append(el('p', 'error', response.error));
  // A GraphQL server reports a failed query in a 200 response; its status alone hides that.
  const failures = response.json ? graphqlErrors(response.rawBody || response.body) : [];
  if (failures.length) {
    const note = el('div', 'graphql-errors');
    note.setAttribute('role', 'status');
    note.append(
      el('span', 'pill bad', `${failures.length} GraphQL error${failures.length === 1 ? '' : 's'}`),
      el(
        'span',
        undefined,
        failures.length === 1 ? failures[0] : `${failures[0]} (and ${failures.length - 1} more)`,
      ),
    );
    section.append(note);
  }
  section.append(
    tabs('response', 'Response', [
      { id: 'body', label: 'Body', render: () => bodyView(response) },
      {
        id: 'headers',
        label: 'Headers',
        count: response.headers.length,
        render: () =>
          table(
            ['Name', 'Value'],
            response.headers.map((header) => [header.key, header.value]),
            'No headers.',
          ),
      },
      {
        id: 'cookies',
        label: 'Cookies',
        count: response.cookies.length,
        render: () =>
          table(
            ['Name', 'Value', 'Attributes'],
            response.cookies.map((cookie) => [cookie.name, cookie.value, cookie.attributes]),
            response.cookiesHidden
              ? 'The response sets cookies. Their values stay out of VS Code, as they are often sessions; the Cookies view lists their names.'
              : 'The response sets no cookies.',
          ),
      },
      {
        id: 'tests',
        label: 'Tests',
        count: response.tests.length + response.captures.length,
        render: () => {
          if (!response.tests.length && !response.captures.length)
            return el('p', 'empty', 'This request has no tests or captures.');
          const node = el('ul', 'lines results');
          for (const test of response.tests)
            node.append(
              resultLine(
                test.pass,
                `${test.label}${!test.pass && test.message ? ` — ${test.message}` : ''}`,
              ),
            );
          for (const capture of response.captures)
            node.append(resultLine(capture.ok, `${capture.name}: ${capture.message}`));
          return node;
        },
      },
      {
        id: 'timing',
        label: 'Timing',
        render: () =>
          response.network
            ? timingPanel(response.network)
            : el('p', 'empty', 'No timing was recorded for this response.'),
      },
      ...(response.certificate
        ? [
            {
              id: 'certificate',
              label: 'Certificate',
              render: () => certificatePanel(response.certificate!),
            },
          ]
        : []),
      {
        id: 'timeline',
        label: 'Timeline',
        render: () => {
          const node = el('dl', 'timeline');
          for (const row of response.timeline)
            node.append(el('dt', undefined, row.label), el('dd', undefined, row.value));
          return node;
        },
      },
    ]),
  );
  if (response.captured.length) {
    const card = el('div', 'captured');
    card.append(el('h2', 'card-title plain', 'Captured'));
    for (const value of response.captured) {
      const line = el('div', 'mono');
      line.append(el('span', 'variable', value.name), document.createTextNode(` = ${value.value}`));
      card.append(line);
    }
    card.append(
      el(
        'p',
        'muted',
        fromFile
          ? 'Used by the requests after it in this file.'
          : 'Saved into the environment in use.',
      ),
    );
    section.append(card);
  }
  return section;
}

/** A phase's name, its bar, and its duration, in the same columns on every row. */
const TIMING_COLUMNS = 'grid grid-cols-[minmax(110px,180px)_1fr_4.5rem] gap-3';

/** The Timing tab: each hop's phases on one axis, with their durations. */
function timingPanel(timing: NonNullable<ResponseView['network']>): HTMLElement {
  const node = el('div', 'flex flex-col gap-3 p-3');
  const head = el('div', 'flex items-baseline gap-2');
  head.append(
    el('strong', undefined, 'Network timing'),
    el('span', 'grow'),
    el('span', 'mono', timing.total),
  );
  node.append(head);
  // The axis above each hop's bars, in the same columns, so the ticks line up with them.
  const axis = () => {
    const row = el('div', `${TIMING_COLUMNS} text-caption text-muted`);
    const ticks = el('div', 'flex justify-between');
    ticks.append(...timing.axis.map((tick) => el('span', 'mono', tick)));
    row.append(el('span'), ticks, el('span'));
    row.setAttribute('aria-hidden', 'true');
    return row;
  };
  if (timing.preparation)
    node.append(el('p', 'm-0 text-muted', `Request preparation · ${timing.preparation}`));
  for (const hop of timing.hops) {
    const card = el('section', 'flex flex-col gap-1.5 px-3 py-2.5 rounded-card border border-line');
    const title = el('div', 'flex items-center gap-2 min-w-0');
    title.append(
      el('span', 'mono truncate min-w-0 flex-1', hop.title),
      el('span', `pill ${/^[23]/.test(hop.status) ? 'good' : 'bad'}`, hop.status),
      el('span', 'mono text-muted', hop.total),
    );
    card.append(title, axis());
    for (const phase of hop.phases) {
      const row = el('div', `${TIMING_COLUMNS} items-center`);
      const name = el('span', 'flex items-center gap-2 min-w-0');
      name.append(el('span', `swatch phase-${phase.id}`), el('span', 'truncate', phase.label));
      const track = el('span', 'timing-track');
      const bar = el('span', `phase phase-${phase.id}`);
      // Set through the DOM, which the content security policy allows, unlike style attributes.
      bar.style.left = `${phase.left}%`;
      bar.style.width = `${Math.min(phase.width, 100 - phase.left)}%`;
      track.append(bar);
      track.setAttribute('aria-hidden', 'true');
      row.append(name, track, el('span', 'mono text-right', phase.duration));
      card.append(row);
    }
    if (hop.note) card.append(el('p', 'm-0 text-small text-muted', hop.note));
    node.append(card);
  }
  return node;
}

/** The Certificate tab: the TLS connection, the client certificate sent, and the chain. */
function certificatePanel(tls: NonNullable<ResponseView['certificate']>): HTMLElement {
  const node = el('div', 'flex flex-col gap-3 p-3');
  const head = el('div', 'flex flex-wrap items-center gap-2');
  head.append(
    el('strong', undefined, tls.host),
    el('span', `pill ${tls.verified ? 'good' : 'bad'}`, tls.verified ? 'Verified' : 'Not verified'),
    el('span', 'chip', tls.protocol),
    ...(tls.alpn ? [el('span', 'chip', tls.alpn === 'h2' ? 'HTTP/2' : tls.alpn)] : []),
    ...(tls.resumed ? [el('span', 'chip', 'Session resumed')] : []),
  );
  node.append(head);
  if (tls.verifyError) node.append(el('p', 'error m-0', tls.verifyError));
  const facts = el('dl', 'timeline');
  const fact = (label: string, value: string) =>
    facts.append(el('dt', undefined, label), el('dd', 'mono', value));
  fact('Cipher', tls.cipher);
  if (tls.client)
    fact(
      'Client certificate',
      [tls.client.subject, tls.client.validTo ? `until ${tls.client.validTo.slice(0, 10)}` : '']
        .filter(Boolean)
        .join(' · '),
    );
  else fact('Client certificate', 'None presented');
  node.append(facts);
  tls.chain.forEach((certificate, index) => {
    const card = el('section', 'flex flex-col gap-2 px-3 py-2.5 rounded-card border border-line');
    card.setAttribute('aria-label', certificate.name);
    const title = el('div', 'flex flex-wrap items-center gap-2 min-w-0');
    title.append(
      el(
        'span',
        'text-caption font-semibold uppercase tracking-wider text-muted',
        index === 0 ? 'Server' : certificate.ca ? 'Authority' : 'Intermediate',
      ),
      el('strong', 'truncate min-w-0', certificate.name),
      el('span', 'grow'),
      el(
        'span',
        `pill ${certificate.expiryTone === 'good' ? 'good' : certificate.expiryTone === 'bad' ? 'bad' : 'warn'}`,
        certificate.expiry,
      ),
    );
    card.append(title);
    const rows = el('dl', 'timeline');
    const row = (label: string, value: string) => {
      if (value) rows.append(el('dt', undefined, label), el('dd', 'mono break-all', value));
    };
    row('Subject', certificate.subject);
    row('Issuer', certificate.issuer);
    row('Valid', `${certificate.validFrom} → ${certificate.validTo}`);
    row('Names', certificate.subjectAltName);
    row('Key', certificate.key);
    row('Serial', certificate.serialNumber);
    row('SHA-256', certificate.fingerprint256);
    card.append(rows);
    node.append(card);
  });
  return node;
}

// The request editor

/** A select box of fixed choices. */
function choice(
  label: string,
  choices: { value: string; label: string }[],
  value: string,
  disabled: boolean,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const node = el('select', 'input');
  node.setAttribute('aria-label', label);
  for (const item of choices) {
    const option = el('option', undefined, item.label);
    option.value = item.value;
    option.selected = item.value === value;
    node.append(option);
  }
  node.disabled = disabled;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

/**
 * The Scripts tab: each script's first lines, and a button that opens it in VS Code's own editor,
 * where it is edited with suggestions and saved with the request.
 */
function scriptsPane(view: RequestView, editable: boolean): Node {
  const wrap = el('div', 'body-wrap');
  for (const [phase, label, action, text] of [
    ['pre', 'Pre-request script', 'editPre', view.scripts.pre],
    ['post', 'Post-response script', 'editPost', view.scripts.post],
  ] as const) {
    const card = el('section', 'script-card');
    card.setAttribute('aria-label', label);
    const head = el('div', 'toolbar small');
    head.append(
      el('h3', 'script-title', label),
      el('span', 'grow'),
      button(text.trim() ? 'Edit in editor' : 'Add script', action, {
        title: `Open the ${phase === 'pre' ? 'pre-request' : 'post-response'} script beside the request`,
      }),
    );
    head.lastElementChild?.toggleAttribute('disabled', !editable);
    card.append(head);
    if (text.trim()) {
      const lines = text.split('\n');
      const pre = el('pre', 'body script-preview', lines.slice(0, 12).join('\n'));
      pre.tabIndex = 0;
      pre.setAttribute('aria-label', `${label}, first lines`);
      card.append(pre);
      if (lines.length > 12) card.append(el('p', 'muted', `… ${lines.length - 12} more lines`));
    } else
      card.append(
        el(
          'p',
          'muted',
          phase === 'pre'
            ? 'Runs before the request is sent: set headers, variables, or a signature with aw.'
            : 'Runs after the response: test it and save values with aw.',
        ),
      );
    wrap.append(card);
  }
  wrap.append(
    el(
      'p',
      'muted',
      'Scripts run in VS Code only as apiWorkbench.scripts allows. In the app, a script changed here waits for Allow scripts.',
    ),
  );
  return wrap;
}

/** What each auth type does, under its choice. */
const AUTH_ABOUT: Record<string, string> = {
  None: 'No auth is sent.',
  'Inherit from collection': 'It uses the auth of its collection or folder.',
  'Bearer token': 'Sends Authorization: Bearer and the token.',
  'Basic auth': 'Sends the username and password in an Authorization header.',
  'API key': 'Sends a key in a header or a query parameter.',
  'Digest auth': 'Answers the server’s digest challenge with the username and password.',
  'JWT bearer': 'Signs a JSON Web Token for each request and sends it as a bearer token.',
  'AWS Signature': 'Signs each request with AWS Signature Version 4.',
  'OAuth 1.0': 'Signs each request with OAuth 1.0a.',
  'OAuth 2.0 (request)':
    'Gets an access token from your identity provider and sends it as a bearer token.',
  NTLM: 'Answers the server’s NTLM challenge, for Windows servers.',
  WSSE: 'Sends a WSSE UsernameToken header with a fresh nonce for each request.',
  'Akamai EdgeGrid': 'Signs each request for Akamai’s APIs.',
  Hawk: 'Signs each request with Hawk.',
  'Saved credential': 'Uses a credential from the vault, sent only to the origin it is for.',
};

const when = (time: number) =>
  new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The Auth tab: every kind the app has, each with its fields. A saved token, password, or other
 * secret is never shown; a new one typed here replaces it when the request is saved.
 */
function authPane(
  view: Pick<RequestView, 'hasSecret' | 'credentials' | 'savedSecrets' | 'tokenExpiresAt'>,
  draft: Pick<RequestDraft, 'auth'>,
  editable: boolean,
  changed: () => void,
  /** Offer Get new access token, which needs a saved request. */
  tokens = false,
): Node {
  const wrap = el('div', 'body-wrap auth-pane');
  const auth = draft.auth;
  // A draft kept from before these fields existed.
  auth.options ??= {};
  auth.secrets ??= {};
  const settable = Object.keys(EDITABLE_AUTH);
  const choices = [
    ...settable.map((type) => ({ value: type, label: type })),
    ...(settable.includes(auth.type) ? [] : [{ value: auth.type, label: auth.type }]),
  ];
  const typeField = field(
    'Type',
    choice('Auth type', choices, auth.type, !editable, (value) => {
      auth.type = value;
      changed();
      refreshTabs.request?.();
      refreshTabs.live?.();
    }),
  );
  typeField.classList.add('auth-type');
  wrap.append(typeField);
  if (AUTH_ABOUT[auth.type]) wrap.append(el('p', 'hint auth-about', AUTH_ABOUT[auth.type]));
  const saved = new Set(view.savedSecrets ?? (view.hasSecret ? ['password', 'token'] : []));
  const grid = el('div', 'auth-grid');
  const secretInput = (
    label: string,
    value: string,
    isSaved: boolean,
    placeholder: string,
    onInput: (value: string) => void,
    multiline = false,
  ) => {
    const hint = isSaved ? 'Saved · type a new one to replace it' : placeholder;
    let node: HTMLInputElement | HTMLTextAreaElement;
    if (multiline) {
      node = el('textarea', 'textarea auth-multiline secret-text');
      node.value = value;
      node.placeholder = hint;
      node.readOnly = !editable;
      node.spellcheck = false;
      node.setAttribute('aria-label', label);
      node.addEventListener('input', () => onInput(node.value));
    } else {
      node = input(value, label, onInput, {
        type: 'password',
        readOnly: !editable,
        placeholder: hint,
      });
      node.autocomplete = 'off';
    }
    const wrapField = field(label, node);
    if (isSaved) {
      const mark = el('span', 'saved-mark', 'Saved');
      mark.title = 'A value is saved; it is never shown in VS Code.';
      wrapField.firstElementChild?.append(' ', mark);
    }
    return wrapField;
  };
  const secretField = (label: string, what: string) =>
    secretInput(label, auth.secret, view.hasSecret, `A ${what}, or {{variable}}`, (value) => {
      auth.secret = value;
      changed();
    });
  const username = (label: string, placeholder: string) =>
    field(
      label,
      input(
        auth.username,
        label,
        (value) => {
          auth.username = value;
          changed();
        },
        { readOnly: !editable, placeholder },
      ),
    );
  const form = Object.prototype.hasOwnProperty.call(AUTH_FORMS, auth.type)
    ? AUTH_FORMS[auth.type]
    : undefined;
  if (form) {
    const draw = () => {
      grid.replaceChildren();
      for (const item of form) {
        if (!fieldShows(auth.options, item, form)) continue;
        if (item.key === 'username') {
          grid.append(username(item.label, item.placeholder ?? `${item.label} or {{variable}}`));
          continue;
        }
        if (item.kind === 'secret' || item.kind === 'secretMultiline') {
          const node = secretInput(
            item.label,
            auth.secrets[item.key] ?? '',
            saved.has(item.key),
            item.placeholder ?? `${item.label} or {{variable}}`,
            (value) => {
              if (value) auth.secrets[item.key] = value;
              else delete auth.secrets[item.key];
              changed();
            },
            item.kind === 'secretMultiline',
          );
          if (item.kind === 'secretMultiline' || item.wide) node.classList.add('wide');
          grid.append(node);
          continue;
        }
        const value = optionValue(auth.options, item);
        const set = (next: string | boolean, redraw = false) => {
          auth.options[item.key] = next;
          changed();
          if (redraw) draw();
        };
        if (item.kind === 'choice') {
          grid.append(
            field(
              item.label,
              choice(item.label, [...(item.choices ?? [])], String(value), !editable, (next) =>
                // Another field may show or hide with it (a JWT's key, OAuth 2.0's grant).
                set(
                  next,
                  form.some((other) => other.when?.key === item.key),
                ),
              ),
            ),
          );
        } else if (item.kind === 'check') {
          const box = el('input');
          box.type = 'checkbox';
          box.checked = value === true;
          box.disabled = !editable;
          box.addEventListener('change', () => set(box.checked));
          const check = el('label', 'field check');
          check.append(box, el('span', undefined, item.label));
          grid.append(check);
        } else if (item.kind === 'multiline') {
          const area = el('textarea', 'textarea auth-multiline');
          area.value = String(value);
          area.placeholder = item.placeholder ?? '';
          area.readOnly = !editable;
          area.spellcheck = false;
          area.setAttribute('aria-label', item.label);
          area.addEventListener('input', () => set(area.value));
          const node = field(item.label, area);
          node.classList.add('wide');
          grid.append(node);
        } else {
          const node = field(
            item.label,
            input(String(value), item.label, (next) => set(next), {
              readOnly: !editable,
              placeholder: item.placeholder,
            }),
          );
          if (item.wide) node.classList.add('wide');
          grid.append(node);
        }
      }
    };
    draw();
    wrap.append(grid);
    if (auth.type === 'OAuth 2.0 (request)') wrap.append(tokenRow(view, draft, editable && tokens));
  } else if (auth.type === 'Bearer token') {
    grid.append(secretField('Token', 'token'));
    wrap.append(grid);
  } else if (auth.type === 'Basic auth' || auth.type === 'Digest auth') {
    grid.append(
      username('Username', 'Username or {{variable}}'),
      secretField('Password', 'password'),
    );
    wrap.append(grid);
  } else if (auth.type === 'API key') {
    grid.append(
      username('Key name', 'X-API-Key'),
      secretField('Value', 'key'),
      field(
        'Add to',
        choice(
          'Add to',
          [
            { value: 'header', label: 'Header' },
            { value: 'query', label: 'Query parameter' },
          ],
          auth.apiKeyIn,
          !editable,
          (value) => {
            auth.apiKeyIn = value === 'query' ? 'query' : 'header';
            changed();
          },
        ),
      ),
    );
    wrap.append(grid);
  } else if (auth.type === 'Saved credential') {
    if (view.credentials?.length)
      wrap.append(
        field(
          'Credential',
          choice(
            'Credential',
            [
              ...(auth.credentialId ? [] : [{ value: '', label: 'Choose a credential' }]),
              ...view.credentials.map((item) => ({ value: item.id, label: item.label })),
            ],
            auth.credentialId,
            !editable,
            (value) => {
              auth.credentialId = value;
              changed();
            },
          ),
        ),
      );
    else
      wrap.append(
        el(
          'p',
          'muted',
          'Unlock the credential vault in the Credentials view, then open the request again to choose one.',
        ),
      );
  }
  if (
    auth.type !== 'None' &&
    auth.type !== 'Inherit from collection' &&
    auth.type !== 'Saved credential'
  )
    wrap.append(
      el(
        'p',
        'muted auth-note',
        'Secrets go to the workspace only, never back into VS Code. A team folder keeps them only when the API Workbench app on this computer has it open; otherwise use a {{variable}}.',
      ),
    );
  return wrap;
}

/** OAuth 2.0's token: when it expires, and buttons to get a new one or refresh it. */
function tokenRow(
  view: Pick<RequestView, 'savedSecrets' | 'tokenExpiresAt'>,
  draft: Pick<RequestDraft, 'auth'>,
  enabled: boolean,
): Node {
  const row = el('div', 'token-row');
  const has = view.savedSecrets?.includes('token');
  const expired = view.tokenExpiresAt !== undefined && view.tokenExpiresAt <= Date.now();
  const status = el(
    'span',
    expired ? 'token-status warn-text' : 'token-status',
    !has
      ? 'No access token yet.'
      : view.tokenExpiresAt === undefined
        ? 'An access token is saved.'
        : expired
          ? `The access token expired ${when(view.tokenExpiresAt)}.`
          : `An access token is saved, until ${when(view.tokenExpiresAt)}.`,
  );
  status.setAttribute('role', 'status');
  row.append(status, el('span', 'grow'));
  if (enabled) {
    // Unsaved settings are saved first, so the token is got with what the editor shows.
    row.append(
      button('Get new access token', () => act('getToken', draft), { primary: !has || expired }),
    );
    if (view.savedSecrets?.includes('oauth2RefreshToken'))
      row.append(button('Refresh', () => act('refreshToken', draft)));
  }
  return row;
}

/**
 * The schema's state above the Query: Fetch schema (or Fetch again), how many types it has and
 * when it was fetched, or why it could not be; with a schema, Ctrl+Space suggests.
 */
function schemaBar(
  view: Pick<RequestView, 'graphqlSchema' | 'kind' | 'saved'>,
  draft: RequestDraft,
  editable: boolean,
): HTMLElement {
  const bar = el('div', 'schema-bar');
  const state = view.graphqlSchema;
  const info = el('span', 'muted');
  info.setAttribute('role', 'status');
  if (state?.status === 'loading') info.append(el('span', 'spinner'), ' Fetching the schema…');
  else if (state?.schema) {
    const roots = [state.schema.queryType, state.schema.mutationType, state.schema.subscriptionType]
      .filter(Boolean)
      .join(', ');
    const keys = /Mac/i.test(navigator.platform) ? '⌃Space' : 'Ctrl+Space';
    info.textContent = `Schema: ${state.schema.types.length} types (${roots}), fetched ${state.fetchedAt ?? ''}. Suggestions appear as you type, or with ${keys}.`;
  } else
    info.textContent =
      'Fetch the schema to get suggestions for fields, arguments, and values as you type.';
  bar.append(info, el('span', 'grow'));
  if (view.kind === 'saved' && editable) {
    const fetch = button(
      state?.schema ? 'Fetch again' : 'Fetch schema',
      // Unsaved changes are saved first, so the schema is asked of the URL and auth shown.
      () => act('fetchSchema', sameDraft(draft, view.saved) ? undefined : draft),
      {
        title:
          'Ask the endpoint for its schema with an introspection query, sent with this request’s headers and auth',
      },
    );
    fetch.disabled = state?.status === 'loading';
    bar.append(fetch);
  }
  const wrap = el('div', 'schema-head');
  wrap.append(bar);
  if (state?.status === 'error' && state.message) {
    const error = el('p', 'warn-text schema-error', state.message);
    error.setAttribute('role', 'alert');
    wrap.append(error);
  }
  return wrap;
}

/**
 * Colours a one-line input's text, as `highlighted` does a textarea's: a layer under it shows the
 * URL's pieces (its {{variables}} stand out), scrolled sideways with the input.
 */
function highlightedInput(field: HTMLInputElement): { layer: HTMLElement; paint: () => void } {
  const layer = el('div', 'url-layer');
  layer.setAttribute('aria-hidden', 'true');
  field.classList.add('code-input-line');
  const follow = () => {
    layer.scrollLeft = field.scrollLeft;
  };
  const paint = () => {
    layer.replaceChildren(
      ...urlTokens(field.value).map((token) =>
        token.kind
          ? el('span', `url-${token.kind}`, token.text)
          : document.createTextNode(token.text),
      ),
      // Room past the end, so the layer can scroll as far as the input.
      document.createTextNode('\u00a0'),
    );
    requestAnimationFrame(follow);
  };
  field.addEventListener('input', paint);
  for (const name of ['scroll', 'keyup', 'click', 'select', 'focus', 'blur'] as const)
    field.addEventListener(name, () => requestAnimationFrame(follow));
  paint();
  return { layer, paint };
}

/** Set while text is replaced for the person, so suggestions do not open for it. */
let replacingText = false;
/**
 * Replaces all of a textarea's text as an edit of its own, so Ctrl+Z (⌘Z) brings back what was,
 * and its input listeners run as for typing.
 */
function replaceText(area: HTMLTextAreaElement, text: string): void {
  area.focus();
  area.select();
  replacingText = true;
  // The only way to keep the browser's undo; where it is not there, the text is set as is.
  const done = document.execCommand('insertText', false, text);
  replacingText = false;
  if (!done || area.value !== text) {
    area.value = text;
    area.dispatchEvent(new Event('input'));
  }
}

/**
 * Colours a textarea's GraphQL, or the variables' JSON with `tokens`: the same text, coloured, drawn under it in a layer of the same
 * size and font, while the textarea's own text is transparent. Typing, selecting, and undo stay
 * the textarea's own. Pieces are rendered as text, never HTML.
 */
function highlighted(
  area: HTMLTextAreaElement,
  tokens: (text: string) => { text: string; kind?: string }[] = graphqlTokens,
): HTMLElement {
  const layer = el('pre', 'code-layer');
  layer.setAttribute('aria-hidden', 'true');
  area.classList.add('code-input');
  const paint = () => {
    const nodes: Node[] = tokens(area.value).map((token) =>
      token.kind
        ? el('span', `tok-${token.kind}`, token.text)
        : document.createTextNode(token.text),
    );
    // A last empty line still takes its height, so the layer scrolls as far as the textarea.
    nodes.push(document.createTextNode('\n'));
    layer.replaceChildren(...nodes);
    layer.scrollTop = area.scrollTop;
    layer.scrollLeft = area.scrollLeft;
  };
  area.addEventListener('input', paint);
  area.addEventListener('scroll', () => {
    layer.scrollTop = area.scrollTop;
    layer.scrollLeft = area.scrollLeft;
  });
  paint();
  return layer;
}

/** The schema's root fields and types, searchable, with their arguments and descriptions. */
function schemaList(schema: GraphqlSchema): Node {
  const details = el('details', 'schema-list');
  details.append(el('summary', undefined, `Schema · ${schema.types.length} types`));
  const search = input('', 'Search the schema', () => show(), {
    placeholder: 'A type or field, such as order or Customer.email',
  });
  const rows = el('ul', 'schema-rows');
  const show = () => {
    const entries = schemaEntries(schema, search.value);
    rows.replaceChildren(
      ...entries.map((entry) => {
        const row = el('li', entry.deprecated ? 'deprecated' : undefined);
        const head = el('div', 'schema-row-head');
        head.append(el('span', 'mono', entry.title), el('span', 'muted mono', entry.detail));
        row.append(head);
        if (entry.description || entry.deprecated)
          row.append(
            el(
              'p',
              'muted',
              [entry.description, entry.deprecated && `Deprecated: ${entry.deprecated}`]
                .filter(Boolean)
                .join(' · '),
            ),
          );
        return row;
      }),
    );
    if (!entries.length) rows.append(el('li', 'empty', 'Nothing matches.'));
  };
  details.append(search, rows);
  show();
  return details;
}

let completionCount = 0;
/**
 * Suggestions in a textarea from the schema, as a list under the cursor: they appear as a name is
 * typed, and with Ctrl+Space; ↑ ↓ choose, Enter or Tab inserts, Escape closes. The list is a
 * listbox the textarea points to, so a screen reader reads the suggestion chosen.
 */
function attachCompletions(area: HTMLTextAreaElement, box: HTMLElement, schema: GraphqlSchema) {
  const id = `completions-${++completionCount}`;
  const list = el('ul', 'completions');
  list.id = id;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Suggestions');
  list.hidden = true;
  const about = el('div', 'completion-about');
  const popup = el('div', 'completion-popup');
  popup.hidden = true;
  popup.append(list, about);
  box.append(popup);
  area.setAttribute('aria-autocomplete', 'list');
  area.setAttribute('aria-controls', id);
  area.setAttribute('aria-expanded', 'false');
  let items: Completion[] = [];
  let from = 0;
  let active = 0;
  const close = () => {
    popup.hidden = true;
    list.hidden = true;
    items = [];
    area.setAttribute('aria-expanded', 'false');
    area.removeAttribute('aria-activedescendant');
  };
  const choose = (index: number) => {
    active = index;
    for (const [at, node] of [...list.children].entries()) {
      node.setAttribute('aria-selected', String(at === index));
      if (at === index) (node as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
    area.setAttribute('aria-activedescendant', `${id}-${index}`);
    const item = items[index];
    about.replaceChildren();
    if (!item) return;
    const line = el('div', 'mono');
    line.append(el('span', 'strong', item.label), item.detail ? `: ${item.detail}` : '');
    about.append(line);
    if (item.description) about.append(el('p', undefined, item.description));
    if (item.deprecated) about.append(el('p', 'warn-text', `Deprecated: ${item.deprecated}`));
  };
  const accept = (index: number) => {
    const item = items[index];
    if (!item) return;
    const end = area.selectionStart;
    const text = item.insert ?? item.label;
    area.setRangeText(text, from, end, 'end');
    close();
    area.dispatchEvent(new Event('input'));
    area.focus();
  };
  const open = (explicit: boolean) => {
    if (area.selectionStart !== area.selectionEnd) return close();
    const offset = area.selectionStart;
    const result = graphqlCompletions(area.value, offset, schema);
    // Typing shows them once a name is begun, or right after `(`, `$`, or `: `; Ctrl+Space shows
    // them anywhere they apply. Not after `{`, where Enter is for the next line.
    const before = area.value.slice(0, offset);
    if (!explicit && result.from === offset && !/(?:[($]|:\s|\(\s*)$/.test(before)) return close();
    items = result.items.slice(0, 60);
    from = result.from;
    if (!items.length) return close();
    list.replaceChildren(
      ...items.map((item, index) => {
        const option = el('li', `completion completion-${item.kind}`);
        option.id = `${id}-${index}`;
        option.setAttribute('role', 'option');
        const kind = el('span', 'completion-kind', item.kind[0].toUpperCase());
        kind.setAttribute('aria-hidden', 'true');
        const label = el(
          'span',
          item.deprecated ? 'completion-label deprecated' : 'completion-label',
          item.label,
        );
        option.append(kind, label);
        if (item.detail) option.append(el('span', 'completion-detail', item.detail));
        // Mouse down, not click, so the textarea keeps its focus and cursor.
        option.addEventListener('mousedown', (event) => {
          event.preventDefault();
          accept(index);
        });
        return option;
      }),
    );
    const point = caretPoint(area);
    popup.style.left = `${Math.max(0, Math.min(point.left, area.clientWidth - 260))}px`;
    popup.style.top = `${point.top}px`;
    popup.hidden = false;
    list.hidden = false;
    area.setAttribute('aria-expanded', 'true');
    choose(0);
  };
  area.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === ' ') {
      event.preventDefault();
      open(true);
      return;
    }
    if (popup.hidden) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      choose((active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
    } else if (event.key === 'Tab' || (event.key === 'Enter' && from < area.selectionStart)) {
      // Enter inserts once a name is begun; before that it is a new line, as typed.
      event.preventDefault();
      accept(active);
    } else if (event.key === 'Enter') {
      close();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  area.addEventListener('input', (event) => {
    // An insertion of ours re-runs the editor's handler; it opens nothing new.
    if (!(event as InputEvent).inputType || replacingText) return;
    open(false);
  });
  area.addEventListener('blur', close);
  area.addEventListener('click', close);
}

/** Where the cursor is in a textarea, in pixels from its top left, just under the line. */
function caretPoint(area: HTMLTextAreaElement): { left: number; top: number } {
  const style = getComputedStyle(area);
  const mirror = el('div');
  for (const name of [
    'boxSizing',
    'width',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'tabSize',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
  ] as const)
    mirror.style[name] = style[name];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.textContent = area.value.slice(0, area.selectionStart);
  const mark = el('span', undefined, '\u200b');
  mirror.append(mark);
  document.body.append(mirror);
  const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
  const point = {
    left: mark.offsetLeft - area.scrollLeft,
    top: mark.offsetTop - area.scrollTop + line + 2,
  };
  mirror.remove();
  return point;
}

/** Whether a request's raw body was chosen to show as Raw or as GraphQL, by request. */
const bodyModes: Record<string, 'raw' | 'graphql'> = {};

/**
 * Makes a draft's body a GraphQL one: kept text becomes the query (a body that is JSON already
 * starts over), and it is sent as JSON, as GraphQL servers expect.
 */
function toGraphql(draft: RequestDraft): void {
  draft.bodyType = 'raw';
  if (!graphqlParts(draft.body)) {
    // Text that is not JSON — such as `{ me { id } }`, GraphQL's shorthand — becomes the query.
    let json = false;
    try {
      JSON.parse(draft.body);
      json = true;
    } catch {
      /* Not JSON: kept as the query. */
    }
    const made = graphqlBody({
      query: draft.body.trim() && !json ? draft.body : '',
      variables: '',
      operationName: '',
    });
    draft.body = draft.body.trim() && !json && 'body' in made ? made.body : GRAPHQL_STARTER.body;
  }
  const type = draft.headers.find((header) => header.key.trim().toLowerCase() === 'content-type');
  if (type) type.value = 'application/json';
  else draft.headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
}

/**
 * The GraphQL body: the query, which operation to run when it has several, and the variables.
 * Each change writes the body as JSON; while the variables are not JSON, the body keeps the last
 * that was, and says so.
 */
function graphqlEditor(
  view: Pick<RequestView, 'graphqlSchema' | 'kind' | 'saved'>,
  draft: RequestDraft,
  editable: boolean,
  changed: () => void,
): Node {
  const parts = graphqlParts(draft.body) ?? { query: '', variables: '', operationName: '' };
  const wrap = el('div', 'graphql');
  const status = el('p', 'hint graphql-status');
  status.setAttribute('role', 'status');
  const operation = el('div', 'graphql-operation');
  const write = () => {
    const made = graphqlBody(parts);
    const problem = 'error' in made ? made.error : graphqlProblem(parts.query, parts.operationName);
    if ('body' in made) {
      draft.body = made.body;
      changed();
    }
    status.className = problem ? 'hint graphql-status warn-text' : 'hint graphql-status';
    status.textContent = problem
      ? 'error' in made
        ? `${problem}. Until they are, the body keeps the last variables that were.`
        : problem
      : draft.method === 'POST'
        ? 'Sent as a POST with a JSON body of the query and its variables.'
        : `Sent with ${draft.method}: most GraphQL servers take a body only with POST.`;
  };
  const operations = () => {
    const found = graphqlOperations(parts.query);
    operation.replaceChildren();
    if (found.length > 1)
      operation.append(
        field(
          'Operation to run',
          choice(
            'Operation to run',
            [
              ...(found.some((item) => item.name === parts.operationName)
                ? []
                : [{ value: '', label: 'Choose one…' }]),
              ...found.map((item) => ({ value: item.name, label: `${item.kind} ${item.name}` })),
            ],
            parts.operationName,
            !editable,
            (value) => {
              parts.operationName = value;
              write();
            },
          ),
        ),
      );
    else if (found.length === 1)
      operation.append(el('p', 'muted', `Runs ${found[0].kind} ${found[0].name}.`));
  };
  const query = el('textarea', 'textarea graphql-query');
  query.value = parts.query;
  query.spellcheck = false;
  query.readOnly = !editable;
  query.placeholder = 'query Orders($first: Int) {\n  orders(first: $first) { id total }\n}';
  query.setAttribute('aria-label', 'GraphQL query');
  query.addEventListener('input', () => {
    parts.query = query.value;
    // A chosen operation that is gone is no longer sent.
    if (
      parts.operationName &&
      !graphqlOperations(parts.query).some((item) => item.name === parts.operationName)
    )
      parts.operationName = '';
    operations();
    write();
  });
  const variables = el('textarea', 'textarea graphql-variables');
  variables.value = parts.variables;
  variables.spellcheck = false;
  variables.readOnly = !editable;
  variables.placeholder = '{"first": 10, "token": "{{api_token}}"}';
  variables.setAttribute('aria-label', 'GraphQL variables');
  variables.addEventListener('input', () => {
    parts.variables = variables.value;
    write();
  });
  const state = view.graphqlSchema;
  const schema = state?.schema;
  const box = el('div', 'completion-box');
  box.append(highlighted(query), query);
  if (schema && editable) attachCompletions(query, box, schema);
  const queryField = field('Query', box);
  const variablesBox = el('div', 'completion-box');
  variablesBox.append(highlighted(variables, variablesTokens), variables);
  const variablesField = field('Variables (JSON)', variablesBox);
  const columns = el('div', 'graphql-columns');
  columns.append(queryField, variablesField);
  const head = schemaBar(view, draft, editable);
  if (editable) {
    /** Formats the query, and the variables when they are JSON; undo brings back what was. */
    const format = () => {
      const done = formatGraphql(query.value);
      if ('error' in done) {
        status.className = 'hint graphql-status warn-text';
        status.textContent = done.error;
        return;
      }
      // The page keeps one undo history, so the query goes last: the first undo brings it back,
      // the next the variables.
      try {
        const pretty = parts.variables.trim()
          ? JSON.stringify(JSON.parse(variables.value), null, 2)
          : variables.value;
        if (pretty !== variables.value) replaceText(variables, pretty);
      } catch {
        /* Variables that are not JSON are left as typed; the status says why. */
      }
      if (done.text !== query.value) replaceText(query, done.text);
      query.focus();
    };
    const keys = /Mac/i.test(navigator.platform) ? '⇧⌥F' : 'Shift+Alt+F';
    const formatButton = button('Format', format, {
      title: `Lay out the query and its variables (${keys})`,
    });
    head.querySelector('.schema-bar')?.append(formatButton);
    for (const area of [query, variables])
      area.addEventListener('keydown', (event) => {
        // Shift+Alt+F, as VS Code formats; the key's code, as Alt changes the character on a Mac.
        if (event.shiftKey && event.altKey && event.code === 'KeyF') {
          event.preventDefault();
          format();
        }
      });
  }
  wrap.append(head, columns, operation, status);
  if (schema) wrap.append(schemaList(schema));
  operations();
  // The status for the body as it is, without changing it.
  const made = graphqlBody(parts);
  const problem = 'error' in made ? made.error : graphqlProblem(parts.query, parts.operationName);
  status.className = problem ? 'hint graphql-status warn-text' : 'hint graphql-status';
  status.textContent =
    problem ??
    (draft.method === 'POST'
      ? 'Sent as a POST with a JSON body of the query and its variables.'
      : `Sent with ${draft.method}: most GraphQL servers take a body only with POST.`);
  return wrap;
}

const sameDraft = (a: RequestDraft, b: RequestDraft) => JSON.stringify(a) === JSON.stringify(b);

function renderRequest(view: RequestView): Node {
  // Edits survive renders (a response arriving) until the request is saved or reloaded.
  const key = `${view.kind}:${view.breadcrumb.join('/')}:${view.revision}`;
  if (saved.draft?.key !== key)
    saved.draft = { key, value: structuredClone(view.saved) as RequestDraft };
  const draft = saved.draft.value;
  const editable = view.kind === 'saved' && view.sendable;
  const params = paramsOf(draft.url);

  const page = el('div', 'page request-page');
  const mac = /Mac/i.test(navigator.platform);

  // Where it is, and what else can be done with it.
  const head = el('div', 'req-head');
  const crumbs = el('nav', 'breadcrumb');
  crumbs.setAttribute('aria-label', 'Collection');
  view.breadcrumb.slice(0, -1).forEach((part, index) => {
    if (index) crumbs.append(el('span', 'crumb-sep', '›'));
    crumbs.append(el('span', 'crumb', part));
  });
  const actions = el('div', 'req-actions');
  actions.setAttribute('role', 'toolbar');
  actions.setAttribute('aria-label', 'Request actions');
  if (view.sendable)
    actions.append(
      button('Code', 'code', { title: 'Generate code for this request', className: 'ghost' }),
    );
  if (view.sendable && view.kind === 'saved')
    actions.append(
      button('Copy as cURL', 'curl', { title: 'Copy a cURL command', className: 'ghost' }),
    );
  if (view.hasFile)
    actions.append(
      button('Open file', 'openFile', { title: 'Edit its YAML file', className: 'ghost' }),
    );
  if (view.kind === 'file')
    actions.append(
      button('Save to collection', 'saveToCollection', {
        title: 'Keep it in a workspace',
        className: 'ghost',
      }),
    );
  actions.append(guideButton('requests', 'requests'));
  head.append(crumbs, el('span', 'grow'), actions);

  // Its name and kind, whether it has unsaved changes, the environment, and Save.
  const title = el('div', 'req-title');
  const badge = el(
    'span',
    view.protocol === 'http' ? `method-badge ${methodClass(draft.method)}` : 'method-badge',
    view.protocol === 'http' ? draft.method : view.protocol.toUpperCase(),
  );
  badge.setAttribute('aria-hidden', 'true');
  const name = el('h1', 'req-name', view.name);
  const dirtyMark = el('span', 'dirty', 'Unsaved changes');
  dirtyMark.setAttribute('role', 'status');
  title.append(badge, name, dirtyMark, el('span', 'grow'));
  if (view.kind === 'saved') {
    const environment = button(view.environment ?? 'No environment', 'environment', {
      title: 'Choose the environment its {{variables}} come from',
      className: 'env-chip',
    });
    environment.prepend(el('span', view.environment ? 'dot' : 'dot off'));
    environment.setAttribute(
      'aria-label',
      `Environment: ${view.environment ?? 'none'}. Choose another`,
    );
    title.append(environment);
  }
  const save = button(view.saving ? 'Saving…' : 'Save', () => act('save', draft), {
    title: `Save the request (${mac ? '⌘S' : 'Ctrl+S'})`,
  });
  if (editable) title.append(save);
  page.append(head, title);
  // Its tags, its own and its collection's, under its name.
  if (view.tags.length) {
    const tagLine = el('div', 'tag-line');
    tagLine.setAttribute('aria-label', 'Tags');
    for (const tag of view.tags) tagLine.append(el('span', 'tag-chip', `#${tag}`));
    page.append(tagLine);
  }

  // The status strip: what the send uses, and the keys.
  const strip = el('div', 'req-strip');
  const stripInfo = el('span', 'strip-info');
  const keys = el('span', 'strip-keys');
  const shortcut = (label: string, ...parts: string[]) => {
    const item = el('span', 'strip-key');
    for (const part of parts) item.append(el('kbd', undefined, part));
    item.append(` ${label}`);
    return item;
  };
  if (editable) keys.append(shortcut('Save', mac ? '⌘' : 'Ctrl', 'S'));
  if (view.sendable) keys.append(shortcut('Send', mac ? '⌘' : 'Ctrl', 'Enter'));
  strip.append(stripInfo, el('span', 'grow'), keys);
  const refreshStrip = (dirty: boolean) => {
    const parts = [
      !view.sendable
        ? 'Live protocol requests are sent from their own editor.'
        : view.kind === 'file'
          ? 'From a .http file: edit it there, and send it from here.'
          : view.environment
            ? `Variables from ${view.environment}`
            : 'No environment: {{variables}} stay as typed',
      view.protocol === 'http' && draft.auth.type !== 'None' ? `Auth: ${draft.auth.type}` : '',
      dirty ? 'Unsaved changes are saved when you send' : '',
    ].filter(Boolean);
    stripInfo.replaceChildren();
    parts.forEach((part, index) => {
      if (index) stripInfo.append(el('span', 'strip-sep', '·'));
      stripInfo.append(el('span', undefined, part));
    });
  };

  const updateDirty = () => {
    const dirty = editable && !sameDraft(draft, view.saved);
    dirtyMark.hidden = !dirty;
    save.disabled = view.saving || !dirty;
    save.className = dirty ? 'button primary' : 'button';
    refreshStrip(dirty);
    persist();
  };

  // The address bar: method, URL with its {{variables}} coloured, and Send, as one control.
  const line = el('div', 'request-line address-bar');
  if (view.protocol === 'http') {
    const method = el('select', `${methodClass(draft.method)} method-box`);
    method.setAttribute('aria-label', 'Method');
    method.disabled = !editable;
    const choices: string[] = [...METHODS];
    if (!choices.includes(draft.method)) choices.push(draft.method);
    for (const choice of choices) {
      const option = el('option', undefined, choice);
      option.value = choice;
      option.selected = choice === draft.method;
      method.append(option);
    }
    method.addEventListener('change', () => {
      draft.method = method.value;
      method.className = `${methodClass(draft.method)} method-box`;
      badge.className = `method-badge ${methodClass(draft.method)}`;
      badge.textContent = draft.method;
      updateDirty();
    });
    line.append(method);
  } else line.append(el('span', 'method method-box', view.protocol.toUpperCase()));
  const url = input(
    draft.url,
    'URL',
    (value) => {
      draft.url = value;
      params.splice(0, params.length, ...paramsOf(value));
      refreshTabs.request?.();
      updateDirty();
    },
    {
      className: 'url-box',
      readOnly: !editable,
      placeholder: 'https://api.example.com/path or {{baseUrl}}/path',
    },
  );
  const urlField = el('div', 'url-field');
  const urlLayer = highlightedInput(url);
  urlField.append(urlLayer.layer, url);
  line.append(urlField);
  const send = button(view.sending ? 'Sending…' : 'Send', () =>
    act('send', editable && !sameDraft(draft, view.saved) ? draft : undefined),
  );
  send.className = 'button primary send';
  send.title = `Send (${mac ? '⌘Enter' : 'Ctrl+Enter'})`;
  send.disabled = view.sending || !view.sendable;
  if (!view.sendable) send.title = 'Live protocol requests are sent from their own editor.';
  line.append(send);
  // The address bar and what the send uses, as one card, as the app has them.
  const urlCard = el('div', 'url-card');
  urlCard.append(line, strip);
  page.append(urlCard);

  const split = el('div', 'split');
  const request = el('section', 'card');
  request.setAttribute('aria-label', 'Request');
  const paramsChanged = () => {
    draft.url = withParams(draft.url, params);
    url.value = draft.url;
    urlLayer.paint();
    updateDirty();
  };
  request.append(
    tabs('request', 'Request', () => [
      {
        id: 'params',
        label: 'Params',
        count: params.length,
        render: () =>
          editableRows(params, { what: 'Parameter', readOnly: !editable, onChange: paramsChanged }),
      },
      {
        id: 'headers',
        label: 'Headers',
        count: draft.headers.length,
        render: () =>
          editableRows(draft.headers, {
            what: 'Header',
            readOnly: !editable,
            toggles: true,
            onChange: () => {
              for (const header of draft.headers) header.enabled ??= true;
              updateDirty();
            },
            hint: (row) =>
              row.value === HIDDEN
                ? 'Hidden, as its name looks secret. Type a new value to replace it.'
                : undefined,
          }),
      },
      {
        id: 'body',
        label: 'Body',
        render: () => {
          if (!view.bodyEditable)
            return el('p', 'empty', 'This body is a file: choose it in the app.');
          const wrap = el('div', 'body-wrap');
          const kinds = [
            { value: 'none', label: 'None' },
            { value: 'raw', label: 'Raw (JSON, XML, text)' },
            { value: 'graphql', label: 'GraphQL (query and variables)' },
            { value: 'form-data', label: 'Form data (multipart)' },
            { value: 'x-www-form-urlencoded', label: 'URL-encoded form' },
            { value: 'binary', label: 'File (binary)' },
          ];
          // Files chosen in this session: their names go into the request, which saves only those.
          const chosen = view.uploads;
          let picked = false;
          if (editable && chosen?.binary && draft.binaryName !== chosen.binary) {
            draft.binaryName = chosen.binary;
            picked = true;
          }
          for (const row of draft.form) {
            const name = row.kind === 'file' ? chosen?.fields[row.key] : undefined;
            if (editable && name && row.fileName !== name) {
              row.fileName = name;
              picked = true;
            }
          }
          if (picked) queueMicrotask(updateDirty);
          const key = view.breadcrumb.join('/');
          const raw = draft.bodyType === 'none' && draft.body ? 'raw' : draft.bodyType;
          // A raw body that is a GraphQL query shows as one, unless Raw was chosen for it.
          const shown =
            raw === 'raw' && bodyModes[key] !== 'raw' && graphqlParts(draft.body) ? 'graphql' : raw;
          wrap.append(
            field(
              'Body type',
              choice('Body type', kinds, shown, !editable, (value) => {
                if (value === 'graphql') {
                  bodyModes[key] = 'graphql';
                  toGraphql(draft);
                } else {
                  if (value === 'raw') bodyModes[key] = 'raw';
                  draft.bodyType = value;
                }
                updateDirty();
                refreshTabs.request?.();
              }),
            ),
          );
          if (shown === 'graphql') wrap.append(graphqlEditor(view, draft, editable, updateDirty));
          else if (shown === 'raw') {
            const area = el('textarea', 'textarea');
            area.value = draft.body;
            area.spellcheck = false;
            area.readOnly = !editable;
            area.placeholder = editable ? 'A JSON, XML, or text body' : '';
            area.setAttribute('aria-label', 'Body');
            area.addEventListener('input', () => {
              draft.body = area.value;
              updateDirty();
            });
            wrap.append(area);
          } else if (shown === 'binary' && view.kind === 'file') {
            // A .http file names its file (`< ./path`); it is read beside the file when sent.
            const card = el(
              'div',
              'flex flex-col items-start gap-2 px-3 py-3 rounded-card border border-line',
            );
            const line = el('div', 'flex flex-wrap items-center gap-2');
            line.append(
              el('strong', 'mono', chosen?.binary || draft.binaryName || 'No file named'),
              el('span', 'chip', 'From the .http file'),
            );
            card.append(
              line,
              el(
                'p',
                'm-0 text-small text-muted',
                'Sent as the body, as it is, read from beside the .http file when you send. Change the < line in the file to send another.',
              ),
            );
            wrap.append(card);
          } else if (shown === 'binary') {
            // The file is chosen in VS Code's own dialog, read by the command line with each send.
            const card = el(
              'div',
              'flex flex-col items-start gap-2 px-3 py-3 rounded-card border border-line',
            );
            const line = el('div', 'flex flex-wrap items-center gap-2');
            line.append(
              el('strong', 'mono', draft.binaryName || 'No file chosen'),
              ...(draft.binaryName && !chosen?.binary
                ? [el('span', 'text-small text-warning', 'choose it again to send')]
                : chosen?.binary
                  ? [el('span', 'pill good', 'Ready to send')]
                  : []),
            );
            const pick = button(
              draft.binaryName ? 'Choose another file…' : 'Choose file…',
              () => act('chooseUpload', { field: null }),
              { title: 'The file sent as the body, 20 MB at most' },
            );
            pick.disabled = !editable;
            card.append(
              line,
              pick,
              el(
                'p',
                'm-0 text-small text-muted',
                'Sent as the body, as it is, with its type (image/png, application/pdf, …) as Content-Type. The request keeps only the file’s name: choose the file once a session, as in the app.',
              ),
            );
            wrap.append(card);
          } else if (shown === 'form-data' || shown === 'x-www-form-urlencoded') {
            wrap.append(
              editableRows(draft.form, {
                what: 'Field',
                readOnly: !editable,
                toggles: true,
                ...(shown === 'form-data'
                  ? {
                      files: {
                        choose: (field: string) => act('chooseUpload', { field }),
                        chosen: (field: string) => Boolean(chosen?.fields[field]),
                      },
                    }
                  : {}),
                onChange: () => {
                  for (const item of draft.form) item.enabled ??= true;
                  updateDirty();
                },
                hint: (row) =>
                  row.value === HIDDEN
                    ? 'Hidden, as its name looks secret. Type a new value to replace it.'
                    : undefined,
              }),
            );
            if (shown === 'x-www-form-urlencoded' && draft.form.some((row) => row.kind === 'file'))
              wrap.append(
                el('p', 'muted', 'File fields are sent only in a multipart form (Form data).'),
              );
          } else wrap.append(el('p', 'empty', 'This request sends no body.'));
          return wrap;
        },
      },
      {
        id: 'auth',
        label: 'Auth',
        render: () => authPane(view, draft, editable, updateDirty, view.kind === 'saved'),
      },
      ...(view.kind === 'saved'
        ? [
            {
              id: 'scripts',
              label: 'Scripts',
              count: [view.scripts.pre, view.scripts.post].filter((text) => text.trim()).length,
              render: () => scriptsPane(view, editable),
            },
          ]
        : []),
      {
        id: 'tests',
        label: 'Tests',
        count: draft.tests.split('\n').filter((line) => line.trim()).length,
        render: () => {
          const wrap = el('div', 'body-wrap');
          wrap.append(
            el(
              'p',
              'muted',
              'One assertion per line, such as status 200, body.id exists, or header content-type contains json.',
            ),
          );
          const area = el('textarea', 'textarea short');
          area.value = draft.tests;
          area.spellcheck = false;
          area.readOnly = !editable;
          area.placeholder = 'status 200';
          area.setAttribute('aria-label', 'Tests');
          area.addEventListener('input', () => {
            draft.tests = area.value;
            updateDirty();
          });
          wrap.append(area);
          return wrap;
        },
      },
      {
        id: 'vars',
        label: 'Vars',
        count: draft.captures.length,
        render: () => {
          const wrap = el('div', 'body-wrap');
          wrap.append(
            el(
              'p',
              'muted',
              'After a send, each variable gets its value from the response: body.id, header location, or status.',
            ),
          );
          wrap.append(
            editableRows(draft.captures, {
              what: 'Capture',
              readOnly: !editable,
              onChange: updateDirty,
            }),
          );
          return wrap;
        },
      },
      {
        id: 'tags',
        label: 'Tags',
        count: draft.tags.length + view.inheritedTags.length,
        render: () => {
          const wrap = el('div', 'body-wrap');
          const tags = input(
            draft.tags.join(', '),
            'Tags',
            (value) => {
              draft.tags = value
                .split(/[\s,]+/)
                .map((tag) => tag.replace(/^#/, ''))
                .filter(Boolean);
              updateDirty();
            },
            { readOnly: !editable, placeholder: 'smoke, orders' },
          );
          wrap.append(field('Its tags, separated by commas', tags));
          if (view.inheritedTags.length)
            wrap.append(el('p', 'muted', `Also: ${view.inheritedTags.join(', ')}`));
          return wrap;
        },
      },
    ]),
  );
  split.append(request, splitter(split), responsePane(view.response, view.sending, view.error));
  page.append(split);
  updateDirty();
  return page;
}

/** How the request and response share the page: stacked by default, as the app opens, or side by side. */
const layout = { stacked: true, share: 0.5, ...saved.layout };

/**
 * The divider between the request and its response: drag it, or focus it and use the arrow keys,
 * to give either more room; double-click, or Enter, switches between side by side and stacked.
 */
function splitter(split: HTMLElement): HTMLElement {
  const bar = el('div', 'splitter');
  bar.tabIndex = 0;
  bar.setAttribute('role', 'separator');
  bar.setAttribute('aria-label', 'Resize the request and response');
  const apply = () => {
    layout.share = Math.min(0.8, Math.max(0.2, layout.share));
    split.classList.toggle('stacked', layout.stacked);
    const share = `${Math.round(layout.share * 1000) / 10}%`;
    split.style.setProperty('--share', share);
    bar.setAttribute('aria-orientation', layout.stacked ? 'horizontal' : 'vertical');
    bar.setAttribute('aria-valuenow', String(Math.round(layout.share * 100)));
    bar.setAttribute('aria-valuemin', '20');
    bar.setAttribute('aria-valuemax', '80');
    bar.title = `Drag to resize; double-click to ${layout.stacked ? 'put them side by side' : 'stack them'}`;
    saved.layout = { ...layout };
  };
  bar.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    bar.setPointerCapture(event.pointerId);
    bar.classList.add('dragging');
    const box = split.getBoundingClientRect();
    const move = (moved: PointerEvent) => {
      layout.share = layout.stacked
        ? (moved.clientY - box.top) / box.height
        : (moved.clientX - box.left) / box.width;
      apply();
    };
    const up = () => {
      bar.classList.remove('dragging');
      bar.removeEventListener('pointermove', move);
      persist();
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up, { once: true });
  });
  bar.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 0.1 : 0.03;
    const back = layout.stacked ? 'ArrowUp' : 'ArrowLeft';
    const forward = layout.stacked ? 'ArrowDown' : 'ArrowRight';
    if (event.key === back) layout.share -= step;
    else if (event.key === forward) layout.share += step;
    else if (event.key === 'Home') layout.share = 0.2;
    else if (event.key === 'End') layout.share = 0.8;
    else if (event.key === 'Enter') layout.stacked = !layout.stacked;
    else return;
    event.preventDefault();
    apply();
    persist();
  });
  bar.addEventListener('dblclick', () => {
    layout.stacked = !layout.stacked;
    apply();
    persist();
  });
  apply();
  return bar;
}

function renderResponse(view: ResponseOnly): Node {
  const page = el('div', 'page');
  if (view.response) {
    page.append(
      ...pageHeader({
        crumbs: [view.fromFile ? '.http file' : 'Response'],
        title: view.response.title,
        badges: [
          el('span', `method-badge ${methodClass(view.response.method)}`, view.response.method),
        ],
      }),
    );
    const line = el('div', 'request-line address-bar');
    line.append(
      el('span', `${methodClass(view.response.method)} method-box`, view.response.method),
    );
    const url = el('div', 'url-box flex-1');
    url.append(templated(view.response.url));
    const again = button('Send again', 'send', { primary: true });
    again.classList.add('send');
    line.append(url, again);
    const card = el('div', 'url-card');
    card.append(line);
    page.append(card);
  }
  page.append(responsePane(view.response, view.sending, view.error, view.fromFile));
  return page;
}

// Mock servers

function renderMock(view: MockView): Node {
  const page = el('div', 'page mock-page');
  const mac = /Mac/i.test(navigator.platform);
  // Edits survive renders (a request logged) until they are saved or discarded.
  const draftKey = `${view.workspace}:${view.name}:${view.revision ?? 0}`;
  if (view.saved && saved.mockDraft?.key !== draftKey)
    saved.mockDraft = { key: draftKey, value: structuredClone(view.saved) };
  const draft = view.saved ? saved.mockDraft!.value : undefined;
  const origin = view.url ?? `http${view.https ? 's' : ''}://127.0.0.1:${view.port}`;

  // Where it is.
  const head = el('div', 'req-head');
  const crumbs = el('nav', 'breadcrumb');
  crumbs.setAttribute('aria-label', 'Workspace');
  crumbs.append(
    el('span', 'crumb', view.workspace),
    el('span', 'crumb-sep', '›'),
    el('span', 'crumb', 'Mock servers'),
  );
  head.append(crumbs, el('span', 'grow'), guideButton('mocks', 'mock servers'));
  page.append(head);

  // The server: its name, whether it runs, how many routes, what it was made from, and actions.
  const header = el('div', 'mock-header');
  const icon = el('span', view.running ? 'mock-icon on' : 'mock-icon', '⇄');
  icon.setAttribute('aria-hidden', 'true');
  const titles = el('div', 'mock-titles');
  const titleLine = el('div', 'mock-title-line');
  const dirtyMark = el('span', 'dirty', 'Unsaved changes');
  dirtyMark.setAttribute('role', 'status');
  titleLine.append(el('h1', 'req-name', view.name), dirtyMark);
  const meta = el('div', 'mock-meta');
  const state = el(
    'span',
    view.running ? 'run-state on' : 'run-state',
    view.running ? 'Running' : 'Stopped',
  );
  state.setAttribute('role', 'status');
  const routeCount = draft?.routes.length ?? view.routeList?.length ?? view.routes;
  meta.append(state, el('span', 'muted', `${routeCount} route${routeCount === 1 ? '' : 's'}`));
  if (view.fromCollection) {
    meta.append(el('span', 'muted', `From collection ${view.fromCollection}`));
    // Whether the two are in step, and Sync now when they are not.
    const sync = view.collectionSync;
    const gaps = sync
      ? [
          sync.missingRoutes
            ? `${sync.missingRoutes} request${sync.missingRoutes === 1 ? ' has' : 's have'} no route`
            : '',
          sync.missingRequests
            ? `${sync.missingRequests} route${sync.missingRequests === 1 ? ' has' : 's have'} no request`
            : '',
        ].filter(Boolean)
      : [];
    const state = el(
      'span',
      gaps.length ? 'sync-state warn' : 'sync-state',
      gaps.length ? `↻ ${gaps.join(' · ')}` : '✓ In step with it',
    );
    state.setAttribute('role', 'status');
    meta.append(state);
    if (gaps.length)
      meta.append(
        button('Sync now', 'syncMock', {
          className: 'ghost sync-now',
          title:
            'Add a route for each request without one, and a request for each route without one',
        }),
      );
  }

  titles.append(titleLine, meta);
  const actions = el('div', 'mock-actions');
  const save = button(view.saving ? 'Saving…' : 'Save', () => draft && act('saveMock', draft), {
    title: `Save its settings and routes (${mac ? '⌘S' : 'Ctrl+S'})`,
  });
  const discard = button(
    'Discard',
    () => {
      if (!view.saved) return;
      saved.mockDraft = { key: draftKey, value: structuredClone(view.saved) };
      persist();
      render(current);
    },
    { className: 'ghost', title: 'Go back to what is saved' },
  );
  if (draft) actions.append(discard, save);
  if (view.running) {
    if (view.restartNeeded)
      actions.append(
        button('Restart', 'restart', {
          primary: true,
          title: 'Stop and start it with what is saved',
        }),
      );
    actions.append(button('Stop', 'stop', { className: 'danger' }));
  } else actions.append(button('Start', 'start', { primary: true }));
  header.append(icon, titles, actions);
  page.append(header);

  // Where it answers.
  const endpoints = el('div', 'mock-endpoints');
  endpoints.append(el('span', 'stat-label', 'Endpoints'));
  const endpoint = (label: string, address: string) => {
    const item = el('span', 'mock-endpoint');
    item.append(el('span', 'endpoint-label', label), el('code', 'mono', address));
    return item;
  };
  endpoints.append(endpoint('HTTP', origin));
  if (draft?.settings.grpcPort)
    endpoints.append(endpoint('gRPC', `127.0.0.1:${draft.settings.grpcPort}`));
  if (draft?.settings.mqttPort)
    endpoints.append(endpoint('MQTT', `mqtt://127.0.0.1:${draft.settings.mqttPort}`));
  endpoints.append(el('span', 'grow'));
  if (view.running && view.url)
    endpoints.append(button('Copy URL', 'copyUrl', { className: 'ghost' }));
  page.append(endpoints);
  if (view.restartNeeded && view.running) {
    const note = el('div', 'banner');
    note.setAttribute('role', 'status');
    note.append(
      el('span', undefined, 'Saved. The running server keeps what it had until it restarts.'),
      el('span', 'grow'),
      button('Restart now', 'restart'),
    );
    page.append(note);
  }
  if (view.error) {
    const error = el('p', 'error', view.error);
    error.setAttribute('role', 'alert');
    page.append(error);
  }

  // At a glance, as the app's tiles.
  if (draft) {
    const stats = el('dl', 'mock-stats');
    stats.setAttribute('aria-label', 'At a glance');
    const on = draft.routes.filter((route) => route.enabled).length;
    for (const [label, value] of [
      ['Routes', `${on} of ${draft.routes.length} on`],
      ['Requests', String(view.log.length)],
      ['CORS', draft.settings.cors ? draft.settings.corsOptions.origins || '*' : 'Off'],
      [
        'Default headers',
        String(draft.settings.defaultHeaders.filter((row) => row.enabled).length),
      ],
      ['HTTPS', draft.settings.https.enabled ? 'On' : 'Off'],
    ]) {
      const tile = el('div', 'mock-stat');
      tile.append(el('dt', undefined, label), el('dd', undefined, value));
      stats.append(tile);
    }
    page.append(stats);
  }

  const updateDirty = () => {
    const dirty = Boolean(
      draft && view.saved && JSON.stringify(draft) !== JSON.stringify(view.saved),
    );
    dirtyMark.hidden = !dirty;
    save.disabled = Boolean(view.saving) || !dirty;
    save.className = dirty ? 'button primary' : 'button';
    discard.hidden = !dirty;
    persist();
  };

  const number = (
    label: string,
    value: number | undefined,
    onChange: (value: number) => void,
    options: { min: number; max: number; suffix?: string },
  ) => {
    const node = input(
      String(value ?? ''),
      label,
      (text) => {
        onChange(text.trim() === '' ? Number.NaN : Number(text));
        updateDirty();
      },
      { type: 'number' },
    );
    node.min = String(options.min);
    node.max = String(options.max);
    node.step = '1';
    node.classList.add('number-input');
    return field(options.suffix ? `${label} (${options.suffix})` : label, node);
  };
  const textField = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    placeholder?: string,
  ) =>
    field(
      label,
      input(
        value,
        label,
        (text) => {
          onChange(text);
          updateDirty();
        },
        { placeholder },
      ),
    );
  const check = (
    label: string,
    value: boolean,
    onChange: (value: boolean) => void,
    redraw = false,
  ) => {
    const box = el('input');
    box.type = 'checkbox';
    box.checked = value;
    box.addEventListener('change', () => {
      onChange(box.checked);
      updateDirty();
      if (redraw) refreshTabs.mock?.();
    });
    const wrap = el('label', 'field check');
    wrap.append(box, el('span', undefined, label));
    return wrap;
  };
  const section = (heading: string, about: string, ...nodes: Node[]) => {
    const box = el('section', 'settings-section');
    const intro = el('div', 'settings-intro');
    intro.append(el('h3', 'settings-heading', heading), el('p', 'muted', about));
    const body = el('div', 'settings-body');
    body.append(...nodes);
    box.append(intro, body);
    return box;
  };

  /** Redraws the route list, as a route's method, path, or switch changes in its editor. */
  let redrawRoutes = () => {};
  /** The routes: a list to choose from, and the chosen one's editor beside it. */
  const routesPane = (): Node => {
    if (!view.routeList || !draft) return el('p', 'empty', 'Loading its routes…');
    const wrap = el('div', 'mock-routes');
    const side = el('div', 'route-side');
    const editor = el('div', 'route-editor');
    const filter = input(
      routeFilter,
      'Filter routes',
      (value) => {
        routeFilter = value;
        drawList();
      },
      { placeholder: 'Filter routes', type: 'search' },
    );
    const add = button(
      '+ Add route',
      () => {
        const route = newRouteDraft(draft.routes);
        draft.routes.push(route);
        routeChoice[draftKey] = route.id;
        updateDirty();
        refreshTabs.mock?.();
        (document.querySelector('[aria-label="Route path"]') as HTMLInputElement | null)?.select();
      },
      { className: 'ghost add-row', title: 'A new route, as the app starts one' },
    );
    const list = el('div', 'route-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Routes');
    side.append(filter, list, add);
    const selected = () =>
      draft.routes.find((route) => route.id === routeChoice[draftKey]) ?? draft.routes[0];
    const drawList = () => {
      const wanted = routeFilter.trim().toLowerCase();
      const shown = draft.routes.filter(
        (route) =>
          !wanted || `${route.method} ${route.path} ${route.name}`.toLowerCase().includes(wanted),
      );
      list.replaceChildren(
        ...shown.map((route) => {
          const item = el('button', route.enabled ? 'route-item' : 'route-item off');
          item.type = 'button';
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', String(route === selected()));
          const label =
            route.kind === 'http'
              ? route.method
              : (({ websocket: 'WS', socketio: 'SIO', grpc: 'gRPC' } as Record<string, string>)[
                  route.kind
                ] ?? route.kind.toUpperCase());
          item.append(
            el('span', `route-method ${methodClass(label)}`, label === 'DELETE' ? 'DEL' : label),
            el('span', 'route-path mono', route.path),
            el(
              'span',
              route.status < 400 ? 'route-status good-text' : 'route-status warn-text',
              String(route.status),
            ),
          );
          if (route.name) item.append(el('span', 'route-name muted', route.name));
          if (route.id.startsWith('new:')) item.append(el('span', 'new-tag', 'New'));
          else if (!route.enabled) item.append(el('span', 'route-off', 'Off'));
          item.addEventListener('click', () => {
            routeChoice[draftKey] = route.id;
            refreshTabs.mock?.();
          });
          return item;
        }),
      );
      if (!shown.length)
        list.append(el('p', 'empty', draft.routes.length ? 'No route matches.' : 'No routes yet.'));
    };
    drawList();
    redrawRoutes = drawList;
    const route = selected();
    if (route) editor.append(routeEditor(route));
    else editor.append(el('p', 'empty', 'Add a route to answer requests.'));
    wrap.append(side, editor);
    return wrap;
  };

  /** One route: its method and path as a URL bar, its answer, headers, and body. */
  const routeEditor = (route: MockRouteDraft): Node => {
    const wrap = el('div', 'route-form');
    const bar = el('div', 'request-line address-bar route-bar');
    if (route.kind === 'http') {
      const method = choice(
        'Route method',
        ROUTE_METHODS.map((item) => ({ value: item, label: item })),
        route.method,
        false,
        (value) => {
          route.method = value;
          method.className = `input method-box ${methodClass(value)}`;
          updateDirty();
          redrawRoutes();
        },
      );
      method.className = `input method-box ${methodClass(route.method)}`;
      bar.append(method);
    } else
      bar.append(el('span', `method method-box protocol-${route.kind}`, route.kind.toUpperCase()));
    const pathField = el('div', 'url-field route-origin');
    pathField.append(el('span', 'origin-text mono', route.kind === 'http' ? origin : ''));
    const path = input(
      route.path,
      'Route path',
      (value) => {
        route.path = value;
        updateDirty();
        redrawRoutes();
      },
      { className: 'url-box', placeholder: '/orders/:id' },
    );
    pathField.append(path);
    bar.append(pathField);
    wrap.append(bar);
    wrap.append(
      el(
        'p',
        'hint',
        ':name matches one part of the path, * the rest; the route with the most fixed parts wins.',
      ),
    );

    const grid = el('div', 'settings-grid');
    grid.append(
      field(
        'Name',
        input(
          route.name,
          'Route name',
          (value) => {
            route.name = value;
            updateDirty();
            redrawRoutes();
          },
          { placeholder: 'What it answers (optional)' },
        ),
      ),
      number(
        'Status',
        route.status,
        (value) => {
          route.status = value;
          redrawRoutes();
        },
        { min: 100, max: 599 },
      ),
      number('Delay', route.delayMs, (value) => (route.delayMs = Number.isNaN(value) ? 0 : value), {
        min: 0,
        max: 60000,
        suffix: 'ms',
      }),
    );
    const onBox = check('Answers requests', route.enabled, (value) => (route.enabled = value));
    onBox.addEventListener('change', () => redrawRoutes());
    grid.append(onBox);
    wrap.append(grid);

    const notes = view.routeList?.find((item) => item.id === route.id)?.details;
    if (route.kind === 'http') {
      // The Content-Type header, chosen as the app's content type box does.
      const typeRow = () => route.headers.find((row) => row.key.toLowerCase() === 'content-type');
      const types = [
        { value: 'application/json', label: 'JSON' },
        { value: 'text/plain', label: 'Text' },
        { value: 'application/xml', label: 'XML' },
        { value: 'text/html', label: 'HTML' },
        { value: 'application/problem+json', label: 'Problem JSON' },
        { value: 'text/csv', label: 'CSV' },
        { value: '', label: 'None' },
      ];
      const currentType = typeRow()?.value ?? '';
      const typeChoices = types.some((item) => item.value === currentType)
        ? types
        : [{ value: currentType, label: currentType }, ...types];
      const headersBox = el('div');
      const drawHeaders = () =>
        headersBox.replaceChildren(
          editableRows(route.headers, {
            what: 'Header',
            readOnly: false,
            toggles: true,
            onChange: () => {
              for (const row of route.headers) row.enabled ??= true;
              updateDirty();
            },
            hint: (row) =>
              row.value === HIDDEN
                ? 'Hidden, as its name looks secret. Type a new value to replace it.'
                : undefined,
          }),
        );
      const type = choice('Content type', typeChoices, currentType, false, (value) => {
        const row = typeRow();
        if (!value) route.headers = route.headers.filter((item) => item !== row);
        else if (row) row.value = value;
        else route.headers.unshift({ key: 'Content-Type', value, enabled: true });
        updateDirty();
        drawHeaders();
      });
      drawHeaders();
      const body = el('textarea', 'textarea route-body');
      body.value = route.body;
      body.spellcheck = false;
      body.setAttribute('aria-label', 'Response body');
      body.placeholder = '{"id": "{{params.id}}"}';
      body.addEventListener('input', () => {
        route.body = body.value;
        updateDirty();
      });
      const format = button(
        'Format',
        () => {
          try {
            body.value = route.body = JSON.stringify(JSON.parse(route.body), null, 2);
            updateDirty();
          } catch {
            /* Not JSON, or a template: left as it is. */
          }
        },
        { className: 'ghost', title: 'Indent a JSON body' },
      );
      const bodyHead = el('div', 'kv-bar');
      bodyHead.append(
        el('h3', 'settings-heading', 'Body'),
        el('span', 'grow'),
        field('Content type', type),
        format,
      );
      const headersHead = el('h3', 'settings-heading', 'Response headers');
      wrap.append(
        bodyHead,
        body,
        el(
          'p',
          'hint',
          'Templates fill in what was asked: {{params.id}}, {{query.page}}, {{body.name}}, {{$uuid}}.',
        ),
        headersHead,
        headersBox,
      );
    } else wrap.append(el('p', 'muted', 'Its messages and how it streams are edited in the app.'));
    if (notes) wrap.append(el('p', 'muted route-notes', `Also: ${notes} — edited in the app.`));
    const footer = el('div', 'route-footer');
    footer.append(
      button(
        'Duplicate',
        () => {
          const copy = {
            ...structuredClone(route),
            ...newRouteDraft(draft!.routes),
            kind: route.kind,
            method: route.method,
            name: route.name,
            status: route.status,
            delayMs: route.delayMs,
            enabled: route.enabled,
            headers: structuredClone(route.headers),
            body: route.body,
          };
          copy.path = `${route.path.replace(/\/$/, '')}-copy`;
          draft!.routes.splice(draft!.routes.indexOf(route) + 1, 0, copy);
          routeChoice[draftKey] = copy.id;
          updateDirty();
          refreshTabs.mock?.();
        },
        { className: 'ghost' },
      ),
      el('span', 'grow'),
      button(
        'Delete route',
        () => {
          const at = draft!.routes.indexOf(route);
          draft!.routes.splice(at, 1);
          routeChoice[draftKey] = draft!.routes[Math.min(at, draft!.routes.length - 1)]?.id ?? '';
          updateDirty();
          refreshTabs.mock?.();
        },
        {
          className: 'danger',
          title: view.fromCollection ? 'Its request in the collection stays' : undefined,
        },
      ),
    );
    wrap.append(footer);
    return wrap;
  };

  const settingsPane = (): Node => {
    if (!draft) return el('p', 'empty', 'Loading its settings…');
    const settings = draft.settings;
    const wrap = el('div', 'settings');
    const general = el('div', 'settings-grid');
    general.append(
      textField('Name', settings.name, (value) => (settings.name = value)),
      number('Port', settings.port, (value) => (settings.port = value), { min: 1024, max: 65535 }),
    );
    if (settings.grpcPort !== undefined)
      general.append(
        number('gRPC port', settings.grpcPort, (value) => (settings.grpcPort = value), {
          min: 1024,
          max: 65535,
        }),
      );
    if (settings.mqttPort !== undefined)
      general.append(
        number('MQTT port', settings.mqttPort, (value) => (settings.mqttPort = value), {
          min: 1024,
          max: 65535,
        }),
      );
    wrap.append(
      section('General', 'Its name, and the ports it listens on, on 127.0.0.1.', general),
    );

    const cors = el('div', 'settings-stack');
    cors.append(
      check(
        'Answer cross-origin requests from browsers (CORS)',
        settings.cors,
        (value) => (settings.cors = value),
        true,
      ),
    );
    if (settings.cors) {
      const grid = el('div', 'settings-grid');
      const options = settings.corsOptions;
      grid.append(
        textField(
          'Allowed origins',
          options.origins,
          (value) => (options.origins = value),
          '* or http://localhost:5173',
        ),
        textField(
          'Allowed methods',
          options.methods,
          (value) => (options.methods = value),
          'GET, POST, PUT',
        ),
        textField(
          'Allowed headers',
          options.headers,
          (value) => (options.headers = value),
          '* or Content-Type, Authorization',
        ),
        textField(
          'Exposed headers',
          options.exposeHeaders,
          (value) => (options.exposeHeaders = value),
          'X-Request-Id',
        ),
        number('Max age', options.maxAge, (value) => (options.maxAge = value), {
          min: 0,
          max: 86400,
          suffix: 'seconds',
        }),
      );
      cors.append(
        grid,
        check(
          'Allow credentials (cookies and authorization)',
          options.credentials,
          (value) => (options.credentials = value),
        ),
      );
    }
    wrap.append(
      section(
        'CORS',
        'Which web pages may call it from a browser. Lists are separated by commas; * allows any.',
        cors,
      ),
    );

    wrap.append(
      section(
        'Default headers',
        'Sent with every answer, such as security headers; a route’s own header of the same name wins.',
        editableRows(settings.defaultHeaders, {
          what: 'Header',
          readOnly: false,
          toggles: true,
          onChange: () => {
            for (const header of settings.defaultHeaders) header.enabled ??= true;
            updateDirty();
          },
          hint: (row) =>
            row.value === HIDDEN
              ? 'Hidden, as its name looks secret. Type a new value to replace it.'
              : undefined,
        }),
      ),
    );

    const https = el('div', 'settings-stack');
    https.append(
      check(
        'Serve HTTPS',
        settings.https.enabled,
        (value) => (settings.https.enabled = value),
        true,
      ),
    );
    if (settings.https.enabled) {
      const grid = el('div', 'settings-grid');
      grid.append(
        textField(
          'Certificate file',
          settings.https.certFile,
          (value) => (settings.https.certFile = value),
          '/path/to/localhost.pem',
        ),
        textField(
          'Key file',
          settings.https.keyFile,
          (value) => (settings.https.keyFile = value),
          '/path/to/localhost-key.pem',
        ),
      );
      https.append(
        grid,
        el(
          'p',
          'hint',
          settings.https.certFile && settings.https.keyFile
            ? 'PEM files, such as mkcert makes; read when it starts.'
            : 'Without your own certificate and key, it uses the app’s certificate authority, and runs only in the app.',
        ),
      );
    }
    wrap.append(section('HTTPS', 'Serve it over TLS, with your own certificate files.', https));
    return wrap;
  };

  const logPane = (): Node =>
    table(
      ['Time', 'Method', 'Path', 'Status'],
      [...view.log]
        .reverse()
        .map((entry) => [
          entry.time,
          el('span', methodClass(entry.method), entry.method),
          entry.path,
          el(
            'span',
            entry.status.startsWith('2') || entry.status.startsWith('3') ? 'good-text' : 'bad-text',
            entry.status,
          ),
        ]),
      view.running
        ? 'No requests yet. Requests to the mock server appear here.'
        : 'Start the mock server to see its requests here.',
    );

  const card = el('section', 'card grow-card');
  card.setAttribute('aria-label', 'Mock server');
  card.append(
    tabs('mock', 'Mock server', () => [
      {
        id: 'routes',
        label: 'Routes',
        count: draft?.routes.length ?? view.routeList?.length ?? view.routes,
        render: routesPane,
      },
      { id: 'settings', label: 'Settings', render: settingsPane },
      { id: 'log', label: 'Request log', count: view.log.length, render: logPane },
    ]),
  );
  page.append(card);
  updateDirty();
  return page;
}

/** The route chosen on each mock's page, and the routes filter. */
const routeChoice: Record<string, string> = {};
let routeFilter = '';

// The panel: network log, console, performance

function renderNetwork(view: NetworkView): Node {
  const page = el('div', 'page network');
  const top = el('div', 'toolbar');
  top.append(
    el(
      'span',
      'muted',
      `${view.entries.length} ${view.entries.length === 1 ? 'request' : 'requests'} sent from VS Code`,
    ),
    el('span', 'grow'),
  );
  if (view.entries.length || view.console.length) top.append(button('Clear', 'clear'));
  page.append(
    tabs('panel', 'API Workbench', [
      {
        id: 'network',
        label: 'Network',
        count: view.entries.length,
        render: () =>
          !view.entries.length
            ? emptyState(
                'No requests yet',
                'Requests you send from VS Code — from the tree, a request page, or a .http file — appear here with their timing.',
              )
            : table(
                ['Name', 'Method', 'Status', 'Type', 'Size', 'Time', 'Waterfall'],
                view.entries.map((entry) => {
                  const name = el('span', undefined, entry.name);
                  name.title = entry.url;
                  const bar = el('span', 'waterfall');
                  const fill = el('span', entry.ok ? 'bar' : 'bar bad');
                  // Set through the DOM, which the content security policy allows, unlike style attributes.
                  fill.style.left = `${entry.left}%`;
                  fill.style.width = `${entry.width}%`;
                  bar.append(fill);
                  bar.setAttribute('aria-label', `${entry.time}`);
                  return [
                    name,
                    el('span', methodClass(entry.method), entry.method),
                    el('span', entry.ok ? 'good-text' : 'bad-text', entry.status),
                    entry.type,
                    entry.size,
                    entry.time,
                    bar,
                  ];
                }),
                'Requests you send from VS Code appear here.',
              ),
      },
      {
        id: 'console',
        label: 'Console',
        count: view.console.filter((entry) => entry.level === 'error').length,
        render: () => {
          if (!view.console.length)
            return el('p', 'empty', 'What API Workbench does in this window appears here.');
          const node = el('ol', 'lines console');
          for (const entry of [...view.console].reverse()) {
            const line = el('li', entry.level === 'error' ? 'bad-text' : undefined);
            line.append(
              el('span', 'muted', entry.time),
              el('span', 'visually-hidden', entry.level === 'error' ? 'Error: ' : ''),
              document.createTextNode(` ${entry.text}`),
            );
            node.append(line);
          }
          return node;
        },
      },
      {
        id: 'performance',
        label: 'Performance',
        render: () =>
          table(
            ['Request', 'Method', 'Sends', 'Errors', 'Average', 'Min', 'p95', 'Max'],
            view.performance.map((row) => [
              row.name,
              el('span', methodClass(row.method), row.method),
              String(row.count),
              el('span', row.errors ? 'bad-text' : 'muted', String(row.errors)),
              row.average,
              row.min,
              row.p95,
              row.max,
            ]),
            'Send requests to compare their response times here; load tests run in the runner.',
          ),
      },
    ]),
  );
  page.prepend(top);
  return page;
}

// Shared page pieces

/**
 * The header every page has, as the app's: where it is, its title with what it says, status
 * badges, and its actions on the right.
 */
function pageHeader(options: {
  crumbs: string[];
  title: string;
  subtitle?: string;
  badges?: Node[];
  actions?: Node[];
  /** The guide for this page, and what it is about, for a Guide button beside the crumbs. */
  guide?: [name: string, topic: string];
}): Node[] {
  const head = el('div', 'req-head');
  const crumbs = el('nav', 'breadcrumb');
  crumbs.setAttribute('aria-label', 'Where it is');
  options.crumbs.forEach((part, index) => {
    if (index) crumbs.append(el('span', 'crumb-sep', '›'));
    crumbs.append(el('span', 'crumb', part));
  });
  head.append(crumbs);
  if (options.guide) head.append(el('span', 'grow'), guideButton(...options.guide));
  const title = el('div', 'req-title');
  const titles = el('div', 'page-titles min-w-0');
  const line = el('div', 'flex flex-wrap items-center gap-2.5 min-w-0');
  line.append(el('h1', 'req-name page-name truncate', options.title), ...(options.badges ?? []));
  titles.append(line);
  if (options.subtitle) titles.append(el('p', 'muted', options.subtitle));
  title.append(titles, el('span', 'grow'), ...(options.actions ?? []));
  return [head, title];
}

/** Figures as tiles, as the app's summaries: a label, a large value, and its tone. */
function statTiles(items: { label: string; value: string; tone?: 'good' | 'bad' }[]): HTMLElement {
  const tiles = el('dl', 'grid gap-3 m-0 grid-cols-[repeat(auto-fit,minmax(130px,1fr))]');
  tiles.setAttribute('role', 'status');
  for (const item of items) {
    const box = el(
      'div',
      `px-4 py-3 rounded-card border bg-panel min-w-0 ${item.tone === 'bad' ? 'border-negative' : 'border-line'}`,
    );
    box.append(
      el('dt', 'text-caption font-semibold uppercase tracking-wider text-muted', item.label),
      el(
        'dd',
        `m-0 mt-1 text-[1.6em] leading-tight font-semibold truncate ${
          item.tone === 'good' ? 'text-positive' : item.tone === 'bad' ? 'text-negative' : ''
        }`,
        item.value,
      ),
    );
    tiles.append(box);
  }
  return tiles;
}

/** What a page or section will hold once there is something, and what to do to get it. */
function emptyState(title: string, text: string, ...actions: Node[]): HTMLElement {
  const box = el('div', 'flex flex-col items-center justify-center gap-2 text-center px-6 py-12');
  const mark = el(
    'div',
    'grid place-items-center size-12 rounded-full border border-dashed border-line text-muted text-[1.3em]',
    '○',
  );
  mark.setAttribute('aria-hidden', 'true');
  box.append(
    mark,
    el('p', 'm-0 font-semibold', title),
    el('p', 'm-0 text-muted max-w-[440px]', text),
  );
  if (actions.length) {
    const row = el('div', 'flex flex-wrap justify-center gap-2 mt-2');
    row.append(...actions);
    box.append(row);
  }
  return box;
}

// The runner

function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = el('label', 'field');
  wrap.append(el('span', 'field-label', label), control);
  return wrap;
}

function renderRunner(view: RunnerView): Node {
  const key = `${view.workspace}`;
  if (saved.runner?.key !== key) saved.runner = { key, value: { ...view.options } };
  const options = saved.runner.value;
  const page = el('div', 'page');
  const environment = button(view.environment ?? 'No environment', 'environment', {
    title: 'Choose the environment its {{variables}} come from',
    className: 'env-chip',
  });
  environment.prepend(el('span', view.environment ? 'dot' : 'dot off'));
  page.append(
    ...pageHeader({
      crumbs: [view.workspace, 'Runner'],
      guide: ['runner', 'runner'],
      title: 'Runner',
      subtitle:
        'Run a collection with its tests — several times, with a data file, or as a load test.',
      actions: [environment],
    }),
  );

  const form = el('section', 'card form');
  form.setAttribute('aria-label', 'Run settings');
  const grid = el('div', 'form-grid');
  const select = (
    label: string,
    choices: { value: string; label: string }[],
    value: string,
    onChange: (value: string) => void,
  ) => {
    const node = el('select', 'input');
    node.setAttribute('aria-label', label);
    for (const choice of choices) {
      const option = el('option', undefined, choice.label);
      option.value = choice.value;
      option.selected = choice.value === value;
      node.append(option);
    }
    node.disabled = view.running;
    node.addEventListener('change', () => {
      onChange(node.value);
      persist();
      draw();
    });
    return field(label, node);
  };
  const number = (
    label: string,
    value: number,
    onChange: (value: number) => void,
    min: number,
    max: number,
  ) => {
    const node = input(String(value), label, (text) => {
      onChange(Number(text));
      persist();
    });
    node.type = 'number';
    node.min = String(min);
    node.max = String(max);
    node.disabled = view.running;
    return field(label, node);
  };
  const draw = () => {
    const controls: HTMLElement[] = [
      select(
        'Requests',
        [
          { value: '', label: 'Every request' },
          ...view.collections.map((name) => ({ value: name, label: name })),
        ],
        options.collection,
        (value) => (options.collection = value),
      ),
      select(
        'Mode',
        [
          { value: 'collection', label: 'Collection run, with tests' },
          { value: 'benchmark', label: 'Benchmark: each request n times' },
          { value: 'performance', label: 'Performance: for a duration' },
        ],
        options.mode,
        (value) => (options.mode = value as RunnerOptions['mode']),
      ),
    ];
    if (options.mode !== 'performance')
      controls.push(
        number('Iterations', options.iterations, (value) => (options.iterations = value), 1, 10000),
      );
    if (options.mode === 'collection') {
      controls.push(
        number('Delay (ms)', options.delayMs, (value) => (options.delayMs = value), 0, 600000),
      );
      const bail = el('input');
      bail.type = 'checkbox';
      bail.checked = options.bail;
      bail.disabled = view.running;
      bail.addEventListener('change', () => {
        options.bail = bail.checked;
        persist();
      });
      const check = el('label', 'field check');
      check.append(bail, el('span', undefined, 'Stop at the first failure'));
      controls.push(check);
    } else {
      controls.push(
        number('Concurrency', options.concurrency, (value) => (options.concurrency = value), 1, 50),
      );
      if (options.mode === 'performance')
        controls.push(
          number(
            'Duration (s)',
            options.durationSeconds,
            (value) => (options.durationSeconds = value),
            1,
            3600,
          ),
        );
    }
    grid.replaceChildren(...controls);
    const data = el('div', 'toolbar small');
    if (options.mode === 'collection') {
      data.append(el('span', 'muted', view.data ? `Data: ${view.data}` : 'No data file'));
      data.append(
        button(view.data ? 'Change…' : 'Use a data file…', 'pickData', {
          title: 'Run once per row of a CSV, JSON, YAML, or XML file',
        }),
      );
      if (view.data) data.append(button('Remove', 'clearData'));
    }
    data.append(el('span', 'grow'));
    data.append(
      view.running
        ? button('Stop', 'cancel', { className: 'danger' })
        : button('Run', () => act('run', options), { primary: true }),
    );
    form.replaceChildren(grid, data);
  };
  draw();
  page.append(form);

  if (view.running) {
    const status = el('p', 'muted');
    status.setAttribute('role', 'status');
    status.append(el('span', 'spinner'), document.createTextNode(' Running…'));
    page.append(status);
  }
  if (view.error) page.append(el('p', 'error', view.error));
  if (view.summary)
    page.append(
      statTiles(
        view.summary.map((item) => ({
          label: item.label,
          value: item.value,
          tone: item.bad
            ? ('bad' as const)
            : item.label === 'Result'
              ? ('good' as const)
              : undefined,
        })),
      ),
    );
  if (view.thresholds.length) {
    const card = el('section', 'card');
    card.append(el('h2', 'card-title', 'Thresholds'));
    const node = el('ul', 'lines results');
    for (const check of view.thresholds)
      node.append(resultLine(check.passed, `${check.name}: ${check.value}`));
    card.append(node);
    page.append(card);
  }
  const card = el('section', 'card grow-card');
  card.setAttribute('aria-label', 'Results');
  if (view.results.length) {
    const iterations = new Set(view.results.map((row) => row.iteration)).size > 1;
    const failed = view.results.filter((row) => !row.ok).length;
    const titleLine = el('div', 'flex items-center gap-2 px-3 py-2 border-b border-line');
    titleLine.append(
      el('h2', 'card-title p-0 border-0', 'Results'),
      el('span', 'grow'),
      el(
        'span',
        'text-caption text-muted',
        `${view.results.length} sent${failed ? ` · ${failed} failed` : ''}`,
      ),
    );
    card.append(titleLine);
    card.append(
      table(
        [...(iterations ? ['#'] : []), 'Request', 'Status', 'Time', 'Tests'],
        view.results.map((row) => {
          // The request, and why it did not pass under it.
          const who = el('div', 'flex flex-col gap-0.5 min-w-0');
          const name = el('div', 'flex items-center gap-2 min-w-0');
          name.append(
            el('span', `${methodClass(row.method)} w-14 flex-none text-[0.85em]`, row.method),
            el('span', 'truncate font-sans', row.name),
          );
          who.append(name);
          for (const message of row.messages)
            who.append(el('span', 'text-negative text-small pl-16', `✗ ${message}`));
          return [
            ...(iterations ? [row.iteration] : []),
            who,
            el('span', `pill ${row.ok ? 'good' : 'bad'}`, row.status),
            row.time,
            el('span', row.tests ? (row.ok ? 'good-text' : 'bad-text') : 'muted', row.tests || '—'),
          ];
        }),
        'No requests were sent.',
      ),
    );
  } else if (!view.running)
    card.append(
      emptyState(
        'No run yet',
        'Choose the requests and how to run them above, then Run. Each request’s status, time, and tests appear here.',
      ),
    );
  page.append(card);
  return page;
}

// Live connections: WebSocket, gRPC, SSE, NDJSON

const LIVE_STATES: Record<LiveView['state'], string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  open: 'Connected',
  closed: 'Closed',
};
const LIVE_MARKS: Record<string, string> = {
  connecting: '…',
  open: '●',
  message: '↓',
  sent: '↑',
  metadata: '#',
  status: '=',
  error: '!',
  closed: '○',
};
const LIVE_LABELS: Record<string, string> = {
  message: 'Received',
  sent: 'Sent',
  metadata: 'Metadata',
  status: 'Status',
  error: 'Error',
  open: 'Opened',
  closed: 'Closed',
  connecting: 'Connecting',
};
let composer = '';
/** The Socket.IO event or MQTT topic being sent to, kept per request while the tab is open. */
let liveOptions: { key: string; value: Record<string, unknown> } | undefined;
const PROTOCOL_LABELS: Record<string, string> = {
  websocket: 'WebSocket',
  sse: 'SSE',
  ndjson: 'NDJSON',
  grpc: 'gRPC',
  socketio: 'Socket.IO',
  mqtt: 'MQTT',
};

/** The options each message is sent with, as the fields below the composer have them. */
function optionsNow(): Record<string, unknown> | undefined {
  return liveOptions?.value;
}

/**
 * The fields under the composer: a Socket.IO message's event and whether to wait for the server's
 * acknowledgement; an MQTT message's topic, QoS, and retain flag, with what it subscribes to.
 */
function optionFields(view: LiveView): HTMLElement[] {
  if (!view.sendOptions) return [];
  const key = view.breadcrumb.join('/');
  if (liveOptions?.key !== key) liveOptions = { key, value: { ...view.sendOptions } };
  const options = liveOptions.value;
  const check = (label: string, name: string) => {
    const box = el('input');
    box.type = 'checkbox';
    box.checked = options[name] === true;
    box.addEventListener('change', () => (options[name] = box.checked));
    const wrap = el('label', 'field check');
    wrap.append(box, el('span', undefined, label));
    return wrap;
  };
  const grid = el('div', 'form-grid');
  if (view.protocol === 'socketio')
    grid.append(
      field(
        'Event',
        input(String(options.event ?? ''), 'Event', (value) => (options.event = value), {
          placeholder: 'message',
        }),
      ),
      check('Wait for acknowledgement', 'ack'),
    );
  else if (view.protocol === 'mqtt') {
    grid.append(
      field(
        'Topic',
        input(String(options.topic ?? ''), 'Topic', (value) => (options.topic = value), {
          placeholder: 'devices/42/status',
        }),
      ),
      field(
        'QoS',
        choice(
          'QoS',
          [
            { value: '0', label: '0 · at most once' },
            { value: '1', label: '1 · at least once' },
            { value: '2', label: '2 · exactly once' },
          ],
          String(options.qos ?? 0),
          false,
          (value) => (options.qos = Number(value)),
        ),
      ),
      check('Retain', 'retain'),
    );
  }
  const fields: HTMLElement[] = [grid];
  if (view.subscriptions?.length)
    fields.push(
      el('p', 'muted', `Subscribed to ${view.subscriptions.join(', ')} when it connects.`),
    );
  return fields;
}

function renderLive(view: LiveView): Node {
  const page = el('div', 'page request-page live-page');
  const mac = /Mac/i.test(navigator.platform);
  const protocol = PROTOCOL_LABELS[view.protocol] ?? view.protocol.toUpperCase();

  // Edits survive renders (each message received) until the request is saved or reloaded.
  const key = `live:${view.breadcrumb.join('/')}:${view.revision}`;
  if (saved.liveDraft?.key !== key)
    saved.liveDraft = { key, value: structuredClone(view.saved) as LiveDraft };
  const draft = saved.liveDraft.value;

  // Where it is.
  const head = el('div', 'req-head');
  const crumbs = el('nav', 'breadcrumb');
  crumbs.setAttribute('aria-label', 'Collection');
  view.breadcrumb.slice(0, -1).forEach((part, index) => {
    if (index) crumbs.append(el('span', 'crumb-sep', '›'));
    crumbs.append(el('span', 'crumb', part));
  });
  head.append(
    crumbs,
    el('span', 'grow'),
    view.protocol === 'grpc'
      ? guideButton('grpc', 'gRPC')
      : guideButton('liveProtocols', 'live protocols'),
  );

  // Its name and protocol, the connection, the environment, and Save.
  const title = el('div', 'req-title');
  const badge = el('span', `method-badge protocol-${view.protocol}`, protocol);
  badge.setAttribute('aria-hidden', 'true');
  const state = el(
    'span',
    view.state === 'open'
      ? 'run-state on'
      : view.state === 'connecting'
        ? 'run-state busy'
        : 'run-state',
    LIVE_STATES[view.state],
  );
  state.setAttribute('role', 'status');
  const dirtyMark = el('span', 'dirty', 'Unsaved changes');
  dirtyMark.setAttribute('role', 'status');
  title.append(badge, el('h1', 'req-name', view.name), state, dirtyMark, el('span', 'grow'));
  const environment = button(view.environment ?? 'No environment', 'environment', {
    title: 'Choose the environment its {{variables}} come from',
    className: 'env-chip',
  });
  environment.prepend(el('span', view.environment ? 'dot' : 'dot off'));
  environment.setAttribute(
    'aria-label',
    `Environment: ${view.environment ?? 'none'}. Choose another`,
  );
  const save = button(view.saving ? 'Saving…' : 'Save', () => act('save', draft), {
    title: `Save the request (${mac ? '⌘S' : 'Ctrl+S'}); the next Connect uses it`,
  });
  title.append(environment, save);
  page.append(head, title);

  const live = view.state === 'open' || view.state === 'connecting';
  const strip = el('div', 'req-strip');
  const stripInfo = el('span', 'strip-info');
  const keys = el('span', 'strip-keys');
  const shortcut = (label: string, ...parts: string[]) => {
    const item = el('span', 'strip-key');
    for (const part of parts) item.append(el('kbd', undefined, part));
    item.append(` ${label}`);
    return item;
  };
  keys.append(shortcut('Save', mac ? '⌘' : 'Ctrl', 'S'));
  if (view.writable) keys.append(shortcut('Send message', mac ? '⌘' : 'Ctrl', 'Enter'));
  strip.append(stripInfo, el('span', 'grow'), keys);
  const changed = () => {
    const dirty = JSON.stringify(draft) !== JSON.stringify(view.saved);
    dirtyMark.hidden = !dirty;
    save.disabled = view.saving || !dirty;
    save.className = dirty ? 'button primary' : 'button';
    const parts = [
      !view.supported
        ? 'This kind of connection opens from the app.'
        : view.environment
          ? `Variables from ${view.environment}`
          : 'No environment: {{variables}} stay as typed',
      draft.auth.type !== 'None' ? `Auth: ${draft.auth.type}` : '',
      dirty && live ? 'Saved changes apply when you connect again' : '',
    ].filter(Boolean);
    stripInfo.replaceChildren();
    parts.forEach((part, index) => {
      if (index) stripInfo.append(el('span', 'strip-sep', '·'));
      stripInfo.append(el('span', undefined, part));
    });
    persist();
  };

  // The address bar: the protocol, its URL, and Connect or Disconnect.
  const line = el('div', 'request-line address-bar');
  line.append(el('span', `method method-box protocol-${view.protocol}`, protocol));
  const url = input(
    draft.url,
    'URL',
    (value) => {
      draft.url = value;
      changed();
    },
    {
      className: 'url-box',
      placeholder:
        view.protocol === 'grpc'
          ? 'localhost:50051'
          : view.protocol === 'mqtt'
            ? 'mqtt://broker.example.com:1883'
            : view.protocol === 'socketio'
              ? 'https://chat.example.com/'
              : view.protocol === 'sse' || view.protocol === 'ndjson'
                ? 'https://api.example.com/stream'
                : 'wss://example.com/socket',
    },
  );
  const urlField = el('div', 'url-field');
  urlField.append(highlightedInput(url).layer, url);
  line.append(urlField);
  const toggle = live
    ? button(view.state === 'connecting' ? 'Cancel' : 'Disconnect', 'disconnect', {
        className: 'send danger-solid',
      })
    : button('Connect', 'connect', { primary: true, className: 'send' });
  toggle.disabled = !view.supported;
  line.append(toggle);
  const urlCard = el('div', 'url-card');
  urlCard.append(line, strip);
  page.append(urlCard);
  if (view.error) {
    const error = el('p', 'error', view.error);
    error.setAttribute('role', 'alert');
    page.append(error);
  }

  const split = el('div', 'split');
  const left = el('section', 'card');
  left.setAttribute('aria-label', 'Request');
  const compose = el('div', 'body-wrap');
  const area = el('textarea', 'textarea short');
  area.value = composer;
  area.spellcheck = false;
  area.placeholder = view.protocol === 'grpc' ? '{ "text": "hello" }' : 'A text or JSON message';
  area.setAttribute('aria-label', 'Message');
  area.readOnly = !view.writable;
  area.addEventListener('input', () => (composer = area.value));
  area.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && view.writable) {
      event.preventDefault();
      act('sendMessage', { message: area.value, options: optionsNow() });
    }
  });
  const sendRow = el('div', 'toolbar small');
  const send = button(
    'Send',
    () => act('sendMessage', { message: area.value, options: optionsNow() }),
    { primary: true, title: 'Send (Ctrl+Enter)' },
  );
  send.disabled = !view.writable;
  sendRow.append(
    el(
      'span',
      'muted',
      view.writable
        ? 'Each message is sent as you type it.'
        : view.state === 'open'
          ? 'This call takes no more messages.'
          : 'Connect to send messages.',
    ),
    el('span', 'grow'),
  );
  if (view.finishable)
    sendRow.append(
      button('Finish', 'finish', { title: 'End the client stream; the server may still reply' }),
    );
  sendRow.append(send);
  compose.append(area, ...optionFields(view), sendRow);

  left.append(
    tabs('live', 'Live request', () => [
      { id: 'message', label: 'Message', render: () => compose },
      {
        id: 'connection',
        label: 'Headers & auth',
        count: draft.headers.length,
        render: () => {
          const wrap = el('div', 'body-wrap');
          wrap.append(el('h3', 'script-title', view.protocol === 'grpc' ? 'Metadata' : 'Headers'));
          wrap.append(
            editableRows(draft.headers, {
              what: view.protocol === 'grpc' ? 'Metadata entry' : 'Header',
              readOnly: false,
              toggles: true,
              onChange: () => {
                for (const header of draft.headers) header.enabled ??= true;
                changed();
              },
              hint: (row) =>
                row.value === HIDDEN
                  ? 'Hidden, as its name looks secret. Type a new value to replace it.'
                  : undefined,
            }),
            el('h3', 'script-title', 'Auth'),
            authPane(view, draft, true, changed),
          );
          return wrap;
        },
      },
      {
        id: 'settings',
        label: PROTOCOL_LABELS[view.protocol] ?? view.protocol.toUpperCase(),
        render: () => liveSettingsPane(view, draft, changed),
      },
    ]),
  );

  const log = el('section', 'card live-messages');
  log.setAttribute('aria-label', 'Messages');
  const sent = view.events.filter((event) => event.type === 'sent').length;
  const received = view.events.filter((event) => event.type === 'message').length;
  const head2 = el('div', 'live-head');
  const counts = el('div', 'live-counts');
  counts.append(el('h2', 'card-title plain', 'Messages'));
  for (const [label, count] of [
    ['Received', received],
    ['Sent', sent],
  ] as const) {
    const stat = el('span', 'stat');
    stat.append(el('span', 'stat-label', label), el('span', 'stat-value', String(count)));
    counts.append(stat);
  }
  head2.append(counts, el('span', 'grow'));
  const kinds = choice(
    'Show',
    [
      { value: 'all', label: 'All events' },
      { value: 'message', label: 'Received' },
      { value: 'sent', label: 'Sent' },
      { value: 'status', label: 'Connection and errors' },
    ],
    liveFilter.kind,
    false,
    (value) => {
      liveFilter.kind = value;
      draw();
    },
  );
  kinds.classList.add('compact-select');
  const search = input(
    liveFilter.text,
    'Search messages',
    (value) => {
      liveFilter.text = value;
      draw();
    },
    { placeholder: 'Search', type: 'search' },
  );
  search.classList.add('live-search');
  head2.append(kinds, search);
  if (view.events.length) head2.append(button('Clear', 'clear', { className: 'ghost' }));
  log.append(head2);
  const body = el('div', 'live-body');
  log.append(body);
  const draw = () => {
    const wanted = liveFilter.text.trim().toLowerCase();
    const shown = [...view.events]
      .reverse()
      .filter(
        (event) =>
          (liveFilter.kind === 'all' ||
            (liveFilter.kind === 'status'
              ? !['message', 'sent'].includes(event.type)
              : event.type === liveFilter.kind)) &&
          (!wanted || event.text.toLowerCase().includes(wanted)),
      );
    if (!view.events.length) {
      body.replaceChildren(
        el(
          'p',
          'empty pad',
          live
            ? 'Connected. What is sent and received appears here, newest first.'
            : 'Connect to see what is sent and received here, newest first.',
        ),
      );
      return;
    }
    if (!shown.length) {
      body.replaceChildren(el('p', 'empty pad', 'No event matches.'));
      return;
    }
    const list = el('ol', 'live-log');
    list.setAttribute('aria-live', 'polite');
    for (const event of shown) {
      const item = el('li', `live-event live-${event.type}`);
      const meta = el('div', 'live-meta');
      meta.append(
        el('span', 'live-mark', LIVE_MARKS[event.type] ?? '·'),
        el('span', 'strong', LIVE_LABELS[event.type] ?? event.type),
        el('span', 'muted', event.time),
        el('span', 'grow'),
        el('span', 'muted live-size', `${new TextEncoder().encode(event.text).length} B`),
      );
      const text = el('pre', 'body live-text');
      if (event.json)
        for (const token of jsonTokens(event.text))
          text.append(
            token.kind === 'punctuation'
              ? document.createTextNode(token.text)
              : el('span', `json-${token.kind}`, token.text),
          );
      else text.textContent = event.text;
      item.append(meta, text);
      list.append(item);
    }
    body.replaceChildren(list);
  };
  draw();
  split.append(left, splitter(split), log);
  page.append(split);
  changed();
  return page;
}

/** What the message log shows, kept across renders as messages arrive. */
const liveFilter = { kind: 'all', text: '' };

/**
 * A live request's own settings: a gRPC call's method, TLS, and schema; a Socket.IO connection's
 * path and default event; an MQTT connection's client, subscriptions, and default topic; and, for
 * each, the message it sends when it connects.
 */
function liveSettingsPane(view: LiveView, draft: LiveDraft, changed: () => void): Node {
  const wrap = el('div', 'body-wrap');
  const grid = el('div', 'form-grid');
  const text = (label: string, value: string, set: (value: string) => void, placeholder = '') =>
    field(
      label,
      input(value, label, (next) => (set(next), changed()), { placeholder }),
    );
  const check = (label: string, value: boolean, set: (value: boolean) => void) => {
    const box = el('input');
    box.type = 'checkbox';
    box.checked = value;
    box.addEventListener('change', () => (set(box.checked), changed()));
    const node = el('label', 'field check');
    node.append(box, el('span', undefined, label));
    return node;
  };
  const qosChoice = (label: string, value: number, set: (value: 0 | 1 | 2) => void) =>
    field(
      label,
      choice(
        label,
        [
          { value: '0', label: '0 · at most once' },
          { value: '1', label: '1 · at least once' },
          { value: '2', label: '2 · exactly once' },
        ],
        String(value),
        false,
        (next) => (set(Number(next) as 0 | 1 | 2), changed()),
      ),
    );
  const grpc = draft.settings.grpc;
  const io = draft.settings.socketio;
  const mqtt = draft.settings.mqtt;
  if (grpc) {
    const methods = view.methods ?? [];
    const choices = methods.map((method) => ({
      value: method.path,
      label: `${method.path} · ${method.kind}`,
    }));
    if (grpc.method && !methods.some((method) => method.path === grpc.method))
      choices.unshift({ value: grpc.method, label: grpc.method });
    grid.append(
      choices.length
        ? field(
            'Method',
            choice('Method', choices, grpc.method, false, (value) => {
              grpc.method = value;
              changed();
            }),
          )
        : text('Method', grpc.method, (value) => (grpc.method = value), '/shop.Orders/Watch'),
      check('TLS', grpc.tls, (value) => (grpc.tls = value)),
    );
    wrap.append(grid);
    const schema = el('textarea', 'textarea');
    schema.value = grpc.proto;
    schema.spellcheck = false;
    schema.placeholder = 'syntax = "proto3"; …';
    schema.setAttribute('aria-label', '.proto schema');
    schema.addEventListener('input', () => {
      grpc.proto = schema.value;
      changed();
    });
    wrap.append(
      field('.proto schema', schema),
      el(
        'p',
        'muted',
        'A self-contained schema, without imports. Save it to choose from its methods.',
      ),
    );
  } else if (io) {
    grid.append(
      text('Path', io.path, (value) => (io.path = value), '/socket.io'),
      text('Default event', io.event, (value) => (io.event = value), 'message'),
      check('Wait for acknowledgement', io.ack, (value) => (io.ack = value)),
    );
    wrap.append(grid, el('p', 'muted', 'The namespace is the URL’s path, such as /orders.'));
  } else if (mqtt) {
    grid.append(
      text('Client ID', mqtt.clientId, (value) => (mqtt.clientId = value), 'Generated when empty'),
      field(
        'Version',
        choice(
          'Version',
          [
            { value: '4', label: 'MQTT 3.1.1' },
            { value: '5', label: 'MQTT 5' },
          ],
          String(mqtt.version),
          false,
          (value) => ((mqtt.version = value === '5' ? 5 : 4), changed()),
        ),
      ),
      text(
        'Keep-alive (s)',
        String(mqtt.keepalive),
        (value) => (mqtt.keepalive = Number(value) || 0),
      ),
      check('Clean start', mqtt.cleanStart, (value) => (mqtt.cleanStart = value)),
    );
    wrap.append(grid, el('h3', 'script-title', 'Subscriptions'));
    const rows = el('div', 'rows');
    const draw = (focusLast = false) => {
      const lines: Node[] = mqtt.subscriptions.map((row, index) => {
        const node = el('div', 'row');
        node.append(
          input(
            row.topic,
            `Subscription ${index + 1} topic`,
            (value) => {
              row.topic = value;
              changed();
            },
            { placeholder: 'sensors/#' },
          ),
          choice(
            `Subscription ${index + 1} QoS`,
            [
              { value: '0', label: 'QoS 0' },
              { value: '1', label: 'QoS 1' },
              { value: '2', label: 'QoS 2' },
            ],
            String(row.qos),
            false,
            (value) => ((row.qos = Number(value) as 0 | 1 | 2), changed()),
          ),
        );
        const remove = button('×', () => {
          mqtt.subscriptions.splice(index, 1);
          changed();
          draw();
        });
        remove.className = 'icon-button';
        remove.setAttribute('aria-label', `Remove subscription ${row.topic}`);
        node.append(remove);
        // A new row's topic takes the focus, so what is typed next goes in it.
        if (focusLast && index === mqtt.subscriptions.length - 1)
          queueMicrotask(() => (node.firstElementChild as HTMLInputElement | null)?.focus());
        return node;
      });
      lines.push(
        button('Add subscription', () => {
          mqtt.subscriptions.push({ topic: '', qos: 0, enabled: true });
          changed();
          draw(true);
        }),
      );
      rows.replaceChildren(...lines);
    };
    draw();
    const publish = el('div', 'form-grid');
    publish.append(
      text('Default topic', mqtt.topic, (value) => (mqtt.topic = value), 'devices/42/status'),
      qosChoice('Default QoS', mqtt.qos, (value) => (mqtt.qos = value)),
      check('Retain', mqtt.retain, (value) => (mqtt.retain = value)),
    );
    wrap.append(rows, el('h3', 'script-title', 'Publishing'), publish);
  }
  const body = el('textarea', 'textarea short');
  body.value = draft.body;
  body.spellcheck = false;
  body.placeholder =
    view.protocol === 'grpc' ? 'The request message, as JSON' : 'Nothing: connect and send';
  body.setAttribute('aria-label', 'Sent when it connects');
  body.addEventListener('input', () => {
    draft.body = body.value;
    changed();
  });
  wrap.append(
    field(
      view.protocol === 'grpc'
        ? 'Request message (unary and server-streaming calls)'
        : 'Sent when it connects',
      body,
    ),
  );
  return wrap;
}

// A specification's docs

function renderDocs(view: DocsView): Node {
  const page = el('div', 'page');
  const validity = el(
    'span',
    `pill ${view.errors ? 'bad' : 'good'}`,
    view.errors
      ? `${view.errors} error${view.errors === 1 ? '' : 's'}`
      : view.warnings
        ? `Valid · ${view.warnings} warning${view.warnings === 1 ? '' : 's'}`
        : 'Valid',
  );
  page.append(
    ...pageHeader({
      crumbs: ['API specifications', view.name],
      guide: ['specs', 'API specifications'],
      title: view.title || view.name,
      subtitle: `${view.operations.length} operation${view.operations.length === 1 ? '' : 's'}${
        view.errors ? ' · the Problems view lists each error' : ''
      }`,
      badges: [...(view.version ? [el('span', 'chip', `v${view.version}`)] : []), validity],
      actions: [
        button('Generate collection', 'generate', { title: 'A request for each operation' }),
        button('Start mock', 'mockFromSpec', {
          primary: true,
          title: 'A mock server answering each operation',
        }),
      ],
    }),
  );
  const card = el('section', 'card grow-card');
  card.setAttribute('aria-label', 'Operations');
  if (!view.operations.length) {
    card.append(
      emptyState(
        'No operations',
        'Add paths to the specification, and they are listed here as you save it.',
      ),
    );
    page.append(card);
    return page;
  }
  const tools = el('div', 'flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line');
  const search = input(
    docsFilter,
    'Search operations',
    (value) => {
      docsFilter = value;
      draw();
    },
    { placeholder: 'Search by path, method, or summary', type: 'search' },
  );
  search.classList.add('w-72', 'max-w-full');
  tools.append(el('h2', 'card-title p-0 border-0', 'Operations'), el('span', 'grow'), search);
  const list = el('ul', 'm-0 p-0 list-none');
  const draw = () => {
    const wanted = docsFilter.trim().toLowerCase();
    const shown = view.operations.filter(
      (operation) =>
        !wanted ||
        `${operation.method} ${operation.path} ${operation.summary}`.toLowerCase().includes(wanted),
    );
    list.replaceChildren(
      ...shown.map((operation) => {
        const row = el(
          'li',
          'flex flex-wrap items-center gap-3 px-3 py-2.5 border-b border-line hover:bg-hover',
        );
        row.append(
          el(
            'span',
            `method-badge ${methodClass(operation.method)} w-16 text-center flex-none`,
            operation.method.toUpperCase(),
          ),
          el(
            'span',
            `font-mono min-w-0 break-all ${operation.deprecated ? 'line-through text-muted' : ''}`,
            operation.path,
          ),
          el('span', 'text-muted min-w-0 flex-1 truncate', operation.summary),
        );
        if (operation.deprecated) row.append(el('span', 'chip text-warning', 'Deprecated'));
        return row;
      }),
    );
    if (!shown.length) list.append(el('li', 'empty px-3', 'No operation matches.'));
  };
  draw();
  card.append(tools, list);
  page.append(card);
  return page;
}
/** The docs page's search, kept as the specification changes. */
let docsFilter = '';

// New request

/** The form as it is filled in, kept across renders (a failed create shows it again). */
let newForm:
  | {
      workspace: string;
      protocol: string;
      folder: string;
      newFolder: boolean;
      name: string;
      method: string;
      url: string;
      tags: string;
      named: boolean;
    }
  | undefined;
const NEW_COLLECTION = '\u0000new';

/**
 * The New Request page: a card for each kind of request with what it is for, then where it goes,
 * its name, and its URL, with a hint when the URL does not suit the kind chosen.
 */
function renderNewRequest(view: NewRequestView): Node {
  const first = view.targets.find((target) => target.key === view.workspace) ?? view.targets[0];
  newForm ??= {
    workspace: first?.key ?? '',
    protocol: view.protocol ?? 'http',
    folder: view.folder ?? first?.folders[0] ?? '',
    newFolder: !first?.folders.length,
    name: '',
    method: 'GET',
    url: '',
    tags: '',
    named: false,
  };
  const form = newForm;
  const page = el('div', 'page new-request');
  const top = el('div', 'toolbar');
  const heading = el('div', 'new-heading');
  heading.append(
    el('h1', 'title', 'New request'),
    el('p', 'muted', 'Choose the kind of request, then where it goes and where it is sent.'),
  );
  top.append(
    heading,
    el('span', 'grow'),
    button('From a cURL command…', 'fromCurl'),
    guideButton('requests', 'requests'),
  );
  page.append(top);
  if (!view.targets.length) {
    page.append(
      el(
        'p',
        'empty',
        'There is no workspace to add it to. Open a folder with a team workspace, or install the API Workbench app.',
      ),
    );
    return page;
  }

  // The kinds, as a radio group of cards: arrow keys move between them.
  const kinds = el('div', 'type-grid');
  kinds.setAttribute('role', 'radiogroup');
  kinds.setAttribute('aria-label', 'Kind of request');
  const about = el('div', 'type-about');
  about.setAttribute('aria-live', 'polite');
  const cards: HTMLButtonElement[] = [];
  const showAbout = () => {
    const type = REQUEST_TYPES.find((item) => item.protocol === form.protocol) ?? REQUEST_TYPES[0];
    const use = el('p');
    use.append(el('span', 'strong', 'Use it for: '), type.useFor);
    const next = el('p');
    next.append(el('span', 'strong', 'In VS Code: '), type.inVsCode);
    about.replaceChildren(use, next);
  };
  const choose = (protocol: string, focus = false) => {
    form.protocol = protocol;
    for (const card of cards) {
      const on = card.dataset.protocol === protocol;
      card.setAttribute('aria-checked', String(on));
      card.tabIndex = on ? 0 : -1;
      if (on && focus) card.focus();
    }
    showAbout();
    details();
  };
  for (const type of REQUEST_TYPES) {
    const card = el('button', 'type-card');
    card.type = 'button';
    card.dataset.protocol = type.protocol;
    card.setAttribute('role', 'radio');
    const badge = el('span', `type-badge type-${type.protocol}`, type.badge);
    badge.setAttribute('aria-hidden', 'true');
    card.append(
      badge,
      el('span', 'type-label', type.label),
      el('span', 'type-summary', type.summary),
    );
    card.addEventListener('click', () => choose(type.protocol));
    card.addEventListener('keydown', (event) => {
      const at = REQUEST_TYPES.indexOf(type);
      const step =
        event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? -1
            : 0;
      if (!step) return;
      event.preventDefault();
      const next = REQUEST_TYPES[(at + step + REQUEST_TYPES.length) % REQUEST_TYPES.length];
      choose(next.protocol, true);
    });
    cards.push(card);
    kinds.append(card);
  }
  const typeSection = el('section', 'card new-section');
  typeSection.append(el('h2', 'card-title', '1 · Kind'), kinds, about);

  const detailSection = el('section', 'card new-section');
  const body = el('div', 'new-details');
  detailSection.append(el('h2', 'card-title', '2 · Details'), body);
  const create = button(view.creating ? 'Creating…' : 'Create request', () => submit(), {
    primary: true,
  });
  create.disabled = view.creating;
  const submit = () => {
    if (view.creating) return;
    act('create', {
      workspace: form.workspace,
      protocol: form.protocol,
      folder: form.folder,
      name: form.name,
      method: form.method,
      url: form.url,
      tags: form.tags,
    });
  };

  // The name follows the URL until it is typed in: a path says what the request is.
  const suggestedName = () => {
    const type = REQUEST_TYPES.find((item) => item.protocol === form.protocol);
    // The path after the host, or after a leading {{variable}} that stands for it.
    const rest = form.url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const parts = rest.split(/[?#]/)[0].split('/');
    const path = (/^\{\{[^}]*\}\}$/.test(parts[0]) || parts.length > 1 ? parts.slice(1) : [])
      .filter(Boolean)
      .join('/');
    if (form.protocol === 'http') return path ? `${form.method} /${path}` : 'New request';
    if (form.protocol === 'graphql') return 'GraphQL query';
    return path ? `${type?.label ?? 'Live'} /${path}` : `New ${type?.label ?? 'request'}`;
  };

  function details() {
    const target = view.targets.find((item) => item.key === form.workspace) ?? view.targets[0];
    const type = REQUEST_TYPES.find((item) => item.protocol === form.protocol) ?? REQUEST_TYPES[0];
    if (!form.named) form.name = suggestedName();
    const where = el('div', 'new-grid');
    where.append(
      field(
        'Workspace',
        choice(
          'Workspace',
          view.targets.map((item) => ({
            value: item.key,
            label: `${item.label} — ${item.kind === 'team' ? 'team folder' : 'app workspace'}`,
          })),
          target.key,
          view.creating,
          (value) => {
            form.workspace = value;
            const next = view.targets.find((item) => item.key === value);
            form.folder = next?.folders[0] ?? '';
            form.newFolder = !next?.folders.length;
            details();
          },
        ),
      ),
    );
    const folderChoice = choice(
      'Collection or folder',
      [
        ...target.folders.map((path) => ({ value: path, label: path.split('/').join(' / ') })),
        { value: NEW_COLLECTION, label: 'New collection…' },
      ],
      form.newFolder ? NEW_COLLECTION : form.folder,
      view.creating,
      (value) => {
        form.newFolder = value === NEW_COLLECTION;
        form.folder = form.newFolder ? '' : value;
        details();
        if (form.newFolder)
          (body.querySelector('[aria-label="New collection name"]') as HTMLElement | null)?.focus();
      },
    );
    where.append(field('Collection or folder', folderChoice));
    if (form.newFolder)
      where.append(
        field(
          'New collection name',
          input(form.folder, 'New collection name', (value) => (form.folder = value), {
            placeholder: 'Orders, or Orders/Admin for a folder in it',
            readOnly: view.creating,
          }),
        ),
      );
    const line = el('div', 'request-line new-line');
    if (form.protocol === 'http') {
      const method = choice(
        'Method',
        METHODS.map((item) => ({ value: item, label: item })),
        form.method,
        view.creating,
        (value) => {
          form.method = value;
          method.className = `input method-box ${methodClass(value)}`;
          if (!form.named) nameInput.value = form.name = suggestedName();
        },
      );
      method.className = `input method-box ${methodClass(form.method)}`;
      line.append(method);
    } else line.append(el('span', `type-badge type-${type.protocol} line-badge`, type.badge));
    const hint = el('p', 'hint url-hint');
    hint.setAttribute('role', 'status');
    const showHint = () => {
      const problem = urlHint(form.protocol, form.url);
      hint.textContent = problem ?? '';
      hint.hidden = !problem;
      hint.className = problem ? 'hint url-hint warn-text' : 'hint url-hint';
    };
    const url = input(
      form.url,
      'URL',
      (value) => {
        form.url = value;
        showHint();
        if (!form.named) nameInput.value = form.name = suggestedName();
      },
      { className: 'url-box', placeholder: type.placeholder, readOnly: view.creating },
    );
    url.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    line.append(url);
    const nameInput = input(
      form.name,
      'Name',
      (value) => {
        form.name = value;
        form.named = Boolean(value.trim());
      },
      { placeholder: 'What the request does', readOnly: view.creating },
    );
    const tags = input(form.tags, 'Tags', (value) => (form.tags = value), {
      placeholder: 'smoke, orders (optional)',
      readOnly: view.creating,
    });
    showHint();
    const urlField = field('URL', line);
    urlField.classList.add('wide');
    body.replaceChildren(
      where,
      urlField,
      hint,
      el(
        'p',
        'hint',
        'Use {{variables}} from an environment, such as {{baseUrl}}/orders, so one request works against every server.',
      ),
      (() => {
        const grid = el('div', 'new-grid');
        grid.append(field('Name', nameInput), field('Tags', tags));
        return grid;
      })(),
    );
  }

  choose(form.protocol);
  page.append(typeSection, detailSection);
  if (view.error) {
    const error = el('p', 'error', view.error);
    error.setAttribute('role', 'alert');
    page.append(error);
  }
  const footer = el('div', 'toolbar new-footer');
  const keys = /Mac/i.test(navigator.platform) ? '⌘+Enter' : 'Ctrl+Enter';
  footer.append(
    el('span', 'muted', `It opens in its editor once made. ${keys} creates it too.`),
    el('span', 'grow'),
    button('Cancel', 'cancel'),
    create,
  );
  page.append(footer);
  page.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });
  return page;
}

// Credentials

/** The Credentials page's form as it is filled in, and the list's filter and search. */
let credentialForm:
  | {
      key: string;
      id: string;
      name: string;
      type: string;
      origin: string;
      values: Record<string, unknown>;
    }
  | undefined;
const credentialFilter = { kind: 'all', text: '' };
const kindLabel = (kind: string) =>
  CREDENTIAL_KINDS.find((item) => item.value === kind)?.label ??
  (kind === 'client-certificate' ? 'Client certificate' : kind);
const KIND_MARKS: Record<string, string> = {
  bearer: 'B',
  basic: 'U',
  'api-key': 'K',
  oauth2: 'O2',
  digest: 'D',
  jwt: 'JWT',
  aws: 'AWS',
  oauth1: 'O1',
  ntlm: 'N',
  wsse: 'W',
  edgegrid: 'EG',
  hawk: 'H',
  'client-certificate': 'C',
};

/**
 * The Credentials page, laid out as the app's: the vault and counts as cards, the credentials as
 * a table filtered by kind and searched by name or origin, and the form that adds or changes one.
 * A saved secret is never here: its field says it is saved, and what is typed replaces it.
 */
function renderCredentials(view: CredentialsView): Node {
  const page = el('div', 'page credentials-page');
  const head = el('div', 'req-head');
  const crumbs = el('nav', 'breadcrumb');
  crumbs.setAttribute('aria-label', 'Workspace');
  crumbs.append(
    el('span', 'crumb', view.workspace),
    el('span', 'crumb-sep', '›'),
    el('span', 'crumb', 'Security'),
  );
  head.append(crumbs, el('span', 'grow'), guideButton('credentials', 'credentials'));
  const title = el('div', 'req-title');
  const titles = el('div', 'page-titles');
  titles.append(
    el('h1', 'req-name page-name', 'Credentials'),
    el('p', 'muted', 'Saved in the API Workbench vault, and sent only to the origin each is for.'),
  );
  title.append(titles, el('span', 'grow'));
  if (view.vault === 'unlocked')
    title.append(button('+ Add credential', () => openForm('new'), { primary: true }));
  page.append(head, title);

  // The vault, how many there are, and OAuth connections, as the app's cards.
  const oauth = view.credentials.filter((row) => row.type === 'oauth2');
  const cards = el('div', 'summary-cards');
  for (const [label, value, note] of [
    ['Credential vault', view.vault === 'unlocked' ? 'Unlocked' : 'Locked', 'API Workbench vault'],
    [
      'Saved credentials',
      String(view.credentials.length).padStart(2, '0'),
      'Reusable across your requests',
    ],
    [
      'OAuth connections',
      String(oauth.filter((row) => row.connected).length).padStart(2, '0'),
      oauth.length
        ? `Of ${oauth.length} OAuth 2.0 credential${oauth.length === 1 ? '' : 's'}`
        : 'Active access tokens',
    ],
  ]) {
    const card = el('div', 'summary-card');
    card.append(
      el('span', 'summary-label', label),
      el('strong', 'summary-value', value),
      el('span', 'muted', note),
    );
    cards.append(card);
  }
  page.append(cards);

  if (view.error) {
    const error = el('p', 'error', view.error);
    error.setAttribute('role', 'alert');
    page.append(error);
  }
  if (view.vault === 'locked') {
    const banner = el('div', 'banner');
    banner.append(
      el(
        'span',
        undefined,
        'The vault is locked. Unlock it with its password to see and change credentials; the password goes to the command line only.',
      ),
      el('span', 'grow'),
      button('Unlock…', 'unlock', { primary: true }),
    );
    page.append(banner);
    return page;
  }

  // The form: adding, or changing the one chosen.
  const formKey = `${view.workspace}:${view.editing ?? ''}:${view.revision}`;
  const openForm = (id: string) => {
    const row = view.credentials.find((item) => item.id === id);
    const type = row?.type && CREDENTIAL_FORMS[row.type] ? row.type : 'bearer';
    credentialForm = {
      key: formKey,
      id,
      name: row?.name ?? '',
      type,
      origin: row?.origin ?? '',
      values: Object.fromEntries(
        (CREDENTIAL_FORMS[type] ?? []).map((field) => [field.key, credentialValue(row, field)]),
      ),
    };
    render(current);
    (document.querySelector('[aria-label="Credential name"]') as HTMLElement | null)?.focus();
  };
  if (view.editing && credentialForm?.key !== formKey) {
    const id = view.editing;
    const row = view.credentials.find((item) => item.id === id);
    const type = row?.type && CREDENTIAL_FORMS[row.type] ? row.type : 'bearer';
    credentialForm = {
      key: formKey,
      id,
      name: row?.name ?? '',
      type,
      origin: row?.origin ?? '',
      values: Object.fromEntries(
        (CREDENTIAL_FORMS[type] ?? []).map((field) => [field.key, credentialValue(row, field)]),
      ),
    };
  }
  if (!view.editing && credentialForm?.key.endsWith(`:${view.revision}`) === false)
    credentialForm = undefined;
  if (credentialForm) page.append(credentialEditor(view, credentialForm));

  // The table, filtered by kind and searched.
  const section = el('section', 'card credentials-card');
  section.setAttribute('aria-label', 'Credentials');
  const tools = el('div', 'credential-tools');
  const kinds = el('div', 'kind-chips');
  kinds.setAttribute('role', 'radiogroup');
  kinds.setAttribute('aria-label', 'Show');
  const present = [
    'all',
    ...CREDENTIAL_KINDS.map((item) => item.value).filter((kind) =>
      view.credentials.some((row) => row.type === kind),
    ),
  ];
  const body = el('div', 'credential-table-wrap');
  for (const kind of present) {
    const chip = el('button', 'kind-chip', kind === 'all' ? 'All' : kindLabel(kind));
    chip.type = 'button';
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', String(credentialFilter.kind === kind));
    chip.addEventListener('click', () => {
      credentialFilter.kind = kind;
      for (const other of kinds.children)
        other.setAttribute('aria-checked', String(other === chip));
      drawTable();
    });
    kinds.append(chip);
  }
  const search = input(
    credentialFilter.text,
    'Search credentials',
    (value) => {
      credentialFilter.text = value;
      drawTable();
    },
    { placeholder: 'Search by name or origin', type: 'search' },
  );
  search.classList.add('credential-search');
  tools.append(kinds, el('span', 'grow'), search);
  section.append(tools, body);
  const drawTable = () => {
    const wanted = credentialFilter.text.trim().toLowerCase();
    const rows = view.credentials.filter(
      (row) =>
        (credentialFilter.kind === 'all' || row.type === credentialFilter.kind) &&
        (!wanted || `${row.name} ${row.origin}`.toLowerCase().includes(wanted)),
    );
    if (!view.credentials.length) {
      body.replaceChildren(
        el(
          'p',
          'empty pad',
          'No credentials yet. Add one, then choose it in a request’s Auth tab as Saved credential.',
        ),
      );
      return;
    }
    if (!rows.length)
      return void body.replaceChildren(el('p', 'empty pad', 'No credential matches.'));
    const table = el('div', 'credential-table');
    table.setAttribute('role', 'table');
    const headRow = el('div', 'credential-row credential-head');
    headRow.setAttribute('role', 'row');
    for (const text of ['Credential', 'Secret source', 'Allowed origin', 'Status', 'Actions']) {
      const cell = el('span', undefined, text);
      cell.setAttribute('role', 'columnheader');
      headRow.append(cell);
    }
    table.append(headRow);
    for (const row of rows) table.append(credentialRow(row));
    body.replaceChildren(table);
  };
  const credentialRow = (row: CredentialRow): Node => {
    const line = el('div', 'credential-row');
    line.setAttribute('role', 'row');
    const cell = (...nodes: Node[]) => {
      const box = el('span', 'credential-cell');
      box.setAttribute('role', 'cell');
      box.append(...nodes);
      line.append(box);
    };
    const who = el('span', 'credential-who');
    const mark = el('span', 'credential-mark', KIND_MARKS[row.type] ?? '•');
    mark.setAttribute('aria-hidden', 'true');
    const names = el('span', 'credential-names');
    names.append(el('strong', undefined, row.name), el('span', 'muted', kindLabel(row.type)));
    who.append(mark, names);
    cell(who);
    cell(el('span', 'muted', row.external ? 'External provider' : '🔒︎ Local vault'));
    cell(el('code', 'mono', row.origin));
    const status = credentialStatus(row);
    cell(el('span', `status-pill ${status.tone}`, status.label));
    const actions = el('span', 'credential-actions');
    if (!row.external && !row.certificate && CREDENTIAL_FORMS[row.type]) {
      const edit = button('Edit', () => openForm(row.id), { className: 'ghost' });
      edit.setAttribute('aria-label', `Edit ${row.name}`);
      actions.append(edit);
    }
    const remove = button('Delete', () => act('deleteCredential', row.id), {
      className: 'ghost danger-text',
    });
    remove.setAttribute('aria-label', `Delete ${row.name}`);
    actions.append(remove);
    cell(actions);
    return line;
  };
  drawTable();
  page.append(section);
  page.append(
    el(
      'p',
      'hint credentials-foot',
      'Encrypted in the API Workbench vault · Never shown in VS Code · Sent only to its origin · Kept out of exports',
    ),
  );
  return page;
}

/** The form that adds a credential or changes one, with its kind's fields. */
function credentialEditor(view: CredentialsView, form: NonNullable<typeof credentialForm>): Node {
  const row = view.credentials.find((item) => item.id === form.id);
  const card = el('section', 'card credential-form');
  card.setAttribute('aria-label', row ? `Edit ${row.name}` : 'Add a credential');
  const headLine = el('div', 'kv-bar');
  headLine.append(
    el('h2', 'settings-heading', row ? `Edit “${row.name}”` : 'Add a credential'),
    el('span', 'grow'),
  );
  const close = button(
    'Cancel',
    () => {
      credentialForm = undefined;
      render(current);
    },
    { className: 'ghost' },
  );
  headLine.append(close);
  card.append(headLine);
  const grid = el('div', 'settings-grid');
  const name = input(form.name, 'Credential name', (value) => (form.name = value), {
    placeholder: 'Acme API token',
    readOnly: Boolean(row),
  });
  if (row) name.title = 'A credential keeps its name; add a new one for another.';
  const kind = choice(
    'Credential kind',
    CREDENTIAL_KINDS.map((item) => ({ ...item })),
    form.type,
    false,
    (value) => {
      form.type = value;
      form.values = Object.fromEntries(
        (CREDENTIAL_FORMS[value] ?? []).map((field) => [
          field.key,
          credentialValue(row?.type === value ? row : undefined, field),
        ]),
      );
      drawFields();
    },
  );
  const origin = input(form.origin, 'Allowed origin', (value) => (form.origin = value), {
    placeholder: 'https://api.example.com',
  });
  grid.append(field('Name', name), field('Kind', kind), field('Allowed origin', origin));
  card.append(grid, el('p', 'hint', 'It is sent only to this origin, whichever request uses it.'));
  const fields = el('div', 'settings-grid credential-fields');
  card.append(fields);
  const drawFields = () => {
    fields.replaceChildren();
    for (const item of CREDENTIAL_FORMS[form.type] ?? []) {
      if (!credentialFieldShows(form.values, item)) continue;
      const value = form.values[item.key];
      if (item.kind === 'check') {
        const box = el('input');
        box.type = 'checkbox';
        box.checked = value === true;
        box.addEventListener('change', () => (form.values[item.key] = box.checked));
        const label = el('label', 'field check');
        label.append(box, el('span', undefined, item.label));
        fields.append(label);
      } else if (item.kind === 'choice') {
        fields.append(
          field(
            item.label,
            choice(item.label, [...(item.choices ?? [])], String(value ?? ''), false, (next) => {
              form.values[item.key] = next;
              if ((CREDENTIAL_FORMS[form.type] ?? []).some((other) => other.when?.key === item.key))
                drawFields();
            }),
          ),
        );
      } else if (item.kind === 'multiline' || item.kind === 'secretMultiline') {
        const area = el('textarea', 'textarea auth-multiline');
        area.value = String(value ?? '');
        area.spellcheck = false;
        area.setAttribute('aria-label', item.label);
        area.placeholder =
          item.kind === 'secretMultiline' && secretSaved(row, item)
            ? 'Saved · type a new one to replace it'
            : (item.placeholder ?? '');
        area.addEventListener('input', () => (form.values[item.key] = area.value));
        const node = field(item.label, area);
        node.classList.add('wide');
        fields.append(node);
      } else {
        const secret = item.kind === 'secret';
        const node = input(
          String(value ?? ''),
          item.label,
          (next) => (form.values[item.key] = item.kind === 'number' ? Number(next) : next),
          {
            type: secret ? 'password' : item.kind === 'number' ? 'number' : 'text',
            placeholder:
              secret && secretSaved(row, item)
                ? 'Saved · type a new one to replace it'
                : item.placeholder,
          },
        );
        if (secret) node.autocomplete = 'off';
        const wrap = field(item.label, node);
        if (secret && secretSaved(row, item)) {
          const mark = el('span', 'saved-mark', 'Saved');
          wrap.firstElementChild?.append(' ', mark);
        }
        fields.append(wrap);
      }
    }
    if (form.type === 'oauth2')
      fields.append(
        el(
          'p',
          'hint wide',
          'Getting its access token (Connect) is done in the app; requests then use it here too.',
        ),
      );
  };
  drawFields();
  const footer = el('div', 'route-footer');
  const save = button(
    view.saving ? 'Saving…' : row ? 'Save changes' : 'Save credential',
    () =>
      act('saveCredential', {
        id: form.id,
        name: form.name,
        type: form.type,
        origin: form.origin,
        values: form.values,
      }),
    { primary: true },
  );
  save.disabled = Boolean(view.saving);
  footer.append(
    el('span', 'hint', 'Secrets go to the vault only. Leave one empty to keep what is saved.'),
    el('span', 'grow'),
    close.cloneNode(true) as HTMLElement,
    save,
  );
  footer.lastElementChild?.previousElementSibling?.addEventListener('click', () => {
    credentialForm = undefined;
    render(current);
  });
  card.append(footer);
  return card;
}

// Environments

/**
 * The Environments page, laid out as the app's: the environments on the left, each with how many
 * variables it has and which one requests use; the chosen one's variables on the right, as a
 * table to switch, change, add to, or edit in bulk, saved at once.
 */
function renderEnvironments(view: EnvironmentsView): Node {
  const page = el('div', 'page');
  const mac = /Mac/i.test(navigator.platform);
  const key = `${view.workspace}:${view.selected ?? ''}:${view.revision}`;
  if (saved.environmentDraft?.key !== key)
    saved.environmentDraft = { key, value: structuredClone(view.variables) };
  const rows = saved.environmentDraft.value;

  const head = el('div', 'req-head');
  const crumbs = el('nav', 'breadcrumb');
  crumbs.setAttribute('aria-label', 'Workspace');
  crumbs.append(
    el('span', 'crumb', view.workspace),
    el('span', 'crumb-sep', '›'),
    el('span', 'crumb', 'Environments'),
  );
  head.append(crumbs, el('span', 'grow'), guideButton('environments', 'environments'));
  const title = el('div', 'req-title');
  const titles = el('div', 'page-titles');
  titles.append(
    el('h1', 'req-name page-name', 'Environments'),
    el(
      'p',
      'muted',
      'Values for {{variables}}: the one in use fills them in every request, test, and run.',
    ),
  );
  title.append(
    titles,
    el('span', 'grow'),
    button('+ New environment', 'newEnvironment', { primary: true }),
  );
  page.append(head, title);
  if (view.error) {
    const error = el('p', 'error', view.error);
    error.setAttribute('role', 'alert');
    page.append(error);
  }

  const layout = el('div', 'grid gap-4 items-start grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)]');
  // The environments, as the app's list.
  const list = el('nav', 'card p-1.5 flex flex-col gap-0.5');
  list.setAttribute('aria-label', 'Environments');
  if (!view.environments.length) list.append(el('p', 'empty px-2', 'No environments yet.'));
  for (const item of view.environments) {
    const chosen = item.name === view.selected;
    const entry = el(
      'button',
      `flex items-center gap-2 w-full px-2.5 py-2 rounded-control border text-left cursor-pointer ${
        chosen
          ? 'bg-selected text-selected-ink border-focus'
          : 'bg-transparent text-ink border-transparent hover:bg-hover'
      }`,
    );
    entry.type = 'button';
    if (chosen) entry.setAttribute('aria-current', 'true');
    const dot = el(
      'span',
      `size-2 rounded-full flex-none ${item.inUse ? 'bg-positive' : 'border border-muted'}`,
    );
    dot.setAttribute('aria-hidden', 'true');
    const names = el('span', 'flex flex-col min-w-0 flex-1');
    names.append(
      el('span', 'font-semibold truncate', item.name),
      el(
        'span',
        'text-caption text-muted',
        `${item.variables} variable${item.variables === 1 ? '' : 's'}${item.inUse ? ' · in use' : ''}`,
      ),
    );
    entry.append(dot, names);
    entry.addEventListener('click', () => act('chooseEnvironment', item.name));
    list.append(entry);
  }
  layout.append(list);

  // The chosen environment's variables.
  const card = el('section', 'card');
  card.setAttribute('aria-label', view.selected ? `Variables of ${view.selected}` : 'Variables');
  if (!view.selected) {
    card.append(
      el(
        'p',
        'empty p-4',
        'Make an environment to hold the values your requests use, such as base_url.',
      ),
    );
  } else {
    const cardHead = el('div', 'flex flex-wrap items-center gap-2 px-4 py-3 border-b border-line');
    const current = view.environments.find((item) => item.name === view.selected);
    cardHead.append(el('h2', 'm-0 text-[1.15em] font-semibold', view.selected));
    if (current?.inUse) cardHead.append(el('span', 'pill good', 'In use'));
    const dirtyMark = el('span', 'dirty', 'Unsaved changes');
    dirtyMark.setAttribute('role', 'status');
    cardHead.append(dirtyMark, el('span', 'grow'));
    if (!current?.inUse)
      cardHead.append(
        button('Use for requests', 'useEnvironment', {
          title: 'Requests, tests, and runs here use it',
        }),
      );
    cardHead.append(
      button('Rename…', 'renameEnvironment', { className: 'ghost' }),
      button('Delete', 'deleteEnvironment', { className: 'ghost danger-text' }),
    );
    const discard = button(
      'Discard',
      () => {
        saved.environmentDraft = { key, value: structuredClone(view.variables) };
        persist();
        render(current_());
      },
      { className: 'ghost' },
    );
    const save = button(view.saving ? 'Saving…' : 'Save', () => act('saveVariables', rows), {
      title: `Save the variables (${mac ? '⌘S' : 'Ctrl+S'})`,
    });
    cardHead.append(discard, save);
    const updateDirty = () => {
      const dirty = JSON.stringify(rows) !== JSON.stringify(view.variables);
      dirtyMark.hidden = !dirty;
      discard.hidden = !dirty;
      save.disabled = Boolean(view.saving) || !dirty;
      save.className = dirty ? 'button primary' : 'button';
      persist();
    };
    const body = el('div', 'flex flex-col gap-3 p-4');
    body.append(
      editableRows(rows, {
        what: 'Variable',
        readOnly: false,
        toggles: true,
        masked: SENSITIVE_VARIABLE,
        onChange: () => {
          for (const row of rows) row.enabled ??= true;
          updateDirty();
        },
        hint: (row) =>
          row.value === HIDDEN_VALUE
            ? 'Hidden, as its name looks secret. Type a new value to replace it.'
            : undefined,
      }),
      el(
        'p',
        'hint m-0',
        view.team
          ? 'A team folder shares its variables, but never secret values: give a secret-looking one a {{variable}}, or set it in the app.'
          : 'Use them as {{name}} in URLs, headers, bodies, and auth. A value whose name looks secret stays hidden here.',
      ),
    );
    card.append(cardHead, body);
    updateDirty();
  }
  layout.append(card);
  page.append(layout);
  return page;
}
/** The view now shown, for a page that re-renders itself. */
const current_ = () => current;

// Test results

/** Which results the page shows, kept across runs. */
let resultFilter: 'all' | 'failed' | 'passed' = 'all';
const RESULT_MARKS: Record<TestResultRow['state'], string> = {
  passed: '✓',
  failed: '✗',
  errored: '!',
};

/**
 * The Test results page, opened when a run finishes: whether it passed, a summary as the app's
 * runner shows it, each request's outcome with its tests (failed ones open), and the run's output.
 */
/**
 * The Certificates page: client certificates presented to their hosts over mutual TLS, each
 * switched on or off here, and the CA certificates the workspace trusts. Files and passphrases are
 * chosen in VS Code's own dialogs, never on this page.
 */
function renderCertificates(view: CertificatesView): Node {
  const page = el('div', 'page');
  const add = button('Add certificate…', 'addCertificate', {
    primary: true,
    title: view.canAdd
      ? 'Choose a PEM certificate and key, or a PFX/P12 bundle'
      : 'This team folder keeps no vault: open it in the app to add certificates',
  });
  add.disabled = !view.canAdd || Boolean(view.busy);
  page.append(
    ...pageHeader({
      crumbs: [view.workspace, 'Certificates'],
      guide: ['certificates', 'client certificates'],
      title: 'Certificates',
      subtitle:
        'Client certificates for mutual TLS, and the CA certificates this workspace trusts.',
      badges: [
        el('span', 'chip', `${view.certificates.length} client · ${view.authorities.length} CA`),
      ],
      actions: [button('Refresh', 'refresh'), add],
    }),
  );
  if (view.error) {
    const note = el('p', 'error');
    note.setAttribute('role', 'alert');
    note.textContent = view.error;
    page.append(note);
  }

  // Client certificates
  const clients = el('section', 'card');
  clients.setAttribute('aria-label', 'Client certificates');
  const clientsHead = el(
    'div',
    'flex flex-wrap items-start gap-3 px-3 py-2.5 border-b border-line',
  );
  const clientsText = el('div', 'flex-1 min-w-[240px]');
  clientsText.append(
    el('h2', 'card-title p-0 border-0', 'Client certificates'),
    el(
      'p',
      'm-0 mt-1 text-muted',
      'Kept in the encrypted credential vault and presented to matching hosts when requests are sent or run over HTTPS. The most specific match wins: an exact host over a wildcard, a port over any port. Live connections (wss://, TLS gRPC) present them in the app.',
    ),
  );
  clientsHead.append(clientsText);
  clients.append(clientsHead);
  if (!view.certificates.length)
    clients.append(
      emptyState(
        'No client certificates',
        'Add one for a host that asks for a client certificate. Requests to it present the certificate on their own.',
        ...(view.canAdd ? [button('Add certificate…', 'addCertificate')] : []),
      ),
    );
  const list = el('ul', 'm-0 p-0 list-none');
  for (const certificate of view.certificates) {
    const row = el(
      'li',
      `flex flex-wrap items-center gap-3 px-3 py-2.5 border-b border-line ${certificate.enabled ? '' : 'opacity-60'}`,
    );
    const mark = el(
      'span',
      'grid place-items-center size-8 rounded-full border border-line text-muted flex-none',
      '⚿',
    );
    mark.setAttribute('aria-hidden', 'true');
    const who = el('div', 'flex flex-col gap-0.5 min-w-[200px] flex-1');
    who.append(
      el('strong', 'mono truncate', certificate.host),
      el(
        'span',
        'text-small text-muted truncate',
        [certificate.subject, certificate.issuer ? `issued by ${certificate.issuer}` : '']
          .filter(Boolean)
          .join(' · '),
      ),
      ...(certificate.legacy
        ? [
            el(
              'span',
              'text-small text-warning',
              'Saved by file path: open Credentials in the app to move it into the vault.',
            ),
          ]
        : []),
    );
    const on = el('label', 'flex items-center gap-1.5 cursor-pointer');
    const box = el('input');
    box.type = 'checkbox';
    box.setAttribute('role', 'switch');
    box.checked = certificate.enabled;
    box.disabled = Boolean(view.busy);
    box.setAttribute('aria-label', `Present the certificate to ${certificate.host}`);
    box.addEventListener('change', () =>
      act('toggleCertificate', { id: certificate.id, enabled: box.checked }),
    );
    on.append(box, el('span', 'text-small', certificate.enabled ? 'On' : 'Off'));
    const remove = button('Remove', () => act('removeCertificate', certificate.id), {
      title: `Remove the certificate for ${certificate.host} and its key`,
    });
    remove.disabled = Boolean(view.busy);
    row.append(
      mark,
      who,
      el('span', 'chip', certificate.type),
      el(
        'span',
        `pill ${certificate.expiryTone === 'good' ? 'good' : certificate.expiryTone === 'bad' ? 'bad' : 'warn'}`,
        certificate.expiry,
      ),
      on,
      remove,
    );
    list.append(row);
  }
  clients.append(list);
  page.append(clients);

  // Trusted CA certificates
  const cas = el('section', 'card');
  cas.setAttribute('aria-label', 'Trusted CA certificates');
  const casHead = el('div', 'flex flex-wrap items-start gap-3 px-3 py-2.5 border-b border-line');
  const casText = el('div', 'flex-1 min-w-[240px]');
  casText.append(
    el('h2', 'card-title p-0 border-0', 'Trusted CA certificates'),
    el(
      'p',
      'm-0 mt-1 text-muted',
      view.authorities.length
        ? 'Servers signed by these are trusted, as well as by the system’s certificate store.'
        : 'Only the system’s certificate store is trusted. Add a CA for servers signed by your own, such as a company’s or a local test CA.',
    ),
  );
  const trust = button('Add CA…', 'trustCertificates', {
    title: 'Choose a PEM file of CA certificates',
  });
  trust.disabled = Boolean(view.busy);
  casHead.append(casText, trust);
  if (view.authorities.length) {
    const untrust = button('Stop trusting', 'untrustCertificates', {
      title: 'Trust only the system’s certificate store again',
    });
    untrust.disabled = Boolean(view.busy);
    casHead.append(untrust);
  }
  cas.append(casHead);
  const authorities = el('ul', 'm-0 p-0 list-none');
  for (const authority of view.authorities) {
    const row = el('li', 'flex flex-wrap items-center gap-3 px-3 py-2.5 border-b border-line');
    const who = el('div', 'flex flex-col gap-0.5 min-w-[200px] flex-1');
    who.append(
      el('strong', 'truncate', authority.name),
      el(
        'span',
        'text-small text-muted truncate',
        `${authority.issuer === authority.name ? 'Self-signed' : `Issued by ${authority.issuer}`} · until ${authority.validTo}`,
      ),
    );
    row.append(
      who,
      el(
        'span',
        `pill ${authority.expiryTone === 'good' ? 'good' : authority.expiryTone === 'bad' ? 'bad' : 'warn'}`,
        authority.expiry,
      ),
    );
    authorities.append(row);
  }
  cas.append(authorities);
  page.append(cas);
  return page;
}

function renderTestResults(view: TestResultsView): Node {
  const page = el('div', 'page');
  const head = el('div', 'req-head');
  const crumbs = el('nav', 'breadcrumb');
  crumbs.setAttribute('aria-label', 'Workspace');
  crumbs.append(
    el('span', 'crumb', view.workspace),
    el('span', 'crumb-sep', '›'),
    el('span', 'crumb', 'Test results'),
  );
  head.append(crumbs, el('span', 'grow'), guideButton('tests', 'tests'));
  const title = el('div', 'req-title');
  const titles = el('div', 'page-titles');
  const line = el('div', 'flex flex-wrap items-center gap-2.5');
  line.append(el('h1', 'req-name page-name', 'Test results'));
  const verdict = el(
    'span',
    `pill ${view.passed ? 'good' : 'bad'}`,
    view.interrupted ? 'Stopped' : view.passed ? 'Passed' : 'Failed',
  );
  verdict.setAttribute('role', 'status');
  line.append(verdict);
  titles.append(
    line,
    el(
      'p',
      'muted',
      [
        view.scope,
        view.environment ? `environment ${view.environment}` : 'no environment',
        `finished ${view.finishedAt}`,
      ].join(' · '),
    ),
  );
  title.append(
    titles,
    el('span', 'grow'),
    button('Show output in Testing', 'showOutput', {
      className: 'ghost',
      title: 'VS Code’s own test output',
    }),
    button('Run again', 'rerun', { primary: true }),
  );
  page.append(head, title);

  // The summary, as tiles.
  const { summary } = view;
  page.append(
    statTiles([
      { label: 'Requests', value: String(summary.requests) },
      { label: 'Passed', value: String(summary.passed), tone: summary.passed ? 'good' : undefined },
      {
        label: 'Failed',
        value: String(summary.failed + summary.errored),
        tone: summary.failed + summary.errored ? 'bad' : undefined,
      },
      {
        label: 'Tests',
        value: `${summary.tests - summary.testsFailed}/${summary.tests}`,
        tone: summary.testsFailed ? 'bad' : undefined,
      },
      {
        label: 'Time',
        value:
          summary.durationMs < 1000
            ? `${Math.round(summary.durationMs)} ms`
            : `${(summary.durationMs / 1000).toFixed(2)} s`,
      },
    ]),
  );

  const resultsPane = (): Node => {
    const wrap = el('div', 'flex flex-col gap-3');
    const filters = el('div', 'kind-chips self-start');
    filters.setAttribute('role', 'radiogroup');
    filters.setAttribute('aria-label', 'Show');
    const list = el('ol', 'flex flex-col gap-2 m-0 p-0 list-none');
    for (const [value, label] of [
      ['all', `All ${view.results.length}`],
      ['failed', `Failed ${summary.failed + summary.errored}`],
      ['passed', `Passed ${summary.passed}`],
    ] as const) {
      const chip = el('button', 'kind-chip', label);
      chip.type = 'button';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(resultFilter === value));
      chip.addEventListener('click', () => {
        resultFilter = value;
        for (const other of filters.children)
          other.setAttribute('aria-checked', String(other === chip));
        draw();
      });
      filters.append(chip);
    }
    const draw = () => {
      const shown = view.results.filter((row) =>
        resultFilter === 'all'
          ? true
          : resultFilter === 'passed'
            ? row.state === 'passed'
            : row.state !== 'passed',
      );
      list.replaceChildren(...shown.map(resultRow));
      if (!shown.length)
        list.append(
          el('li', 'empty', view.results.length ? 'Nothing here.' : 'The run sent no requests.'),
        );
    };
    draw();
    wrap.append(filters, list);
    return wrap;
  };
  const outputPane = (): Node => {
    const pre = el(
      'pre',
      'body p-3 rounded-control border border-line bg-field max-h-[70vh] overflow-auto',
      view.output || 'The run printed nothing.',
    );
    pre.tabIndex = 0;
    return pre;
  };
  const card = el('section', 'card grow-card');
  card.setAttribute('aria-label', 'Results');
  card.append(
    tabs('results', 'Results', [
      { id: 'results', label: 'Results', count: view.results.length, render: resultsPane },
      { id: 'output', label: 'Output', render: outputPane },
    ]),
  );
  page.append(card);
  return page;
}

/** One request's outcome, its tests shown when it did not pass. */
function resultRow(row: TestResultRow): Node {
  const item = el(
    'li',
    `rounded-card border bg-panel ${row.state === 'passed' ? 'border-line' : 'border-negative'}`,
  );
  const details = el('details', 'group');
  if (row.state !== 'passed') details.open = true;
  const summary = el(
    'summary',
    'flex flex-wrap items-center gap-2.5 px-3 py-2.5 cursor-pointer list-none',
  );
  const mark = el(
    'span',
    `inline-grid place-items-center size-5 rounded-full text-[0.8em] font-bold flex-none ${
      row.state === 'passed' ? 'bg-positive text-canvas' : 'bg-negative text-canvas'
    }`,
    RESULT_MARKS[row.state],
  );
  mark.setAttribute('aria-hidden', 'true');
  const names = el('span', 'flex flex-col min-w-0 flex-1');
  names.append(
    el('span', 'font-semibold truncate', row.name),
    el('span', 'text-caption text-muted truncate', row.folder),
  );
  const passedTests = row.tests.filter((test) => test.pass).length;
  summary.append(
    mark,
    el('span', `method ${methodClass(row.method)} w-14 text-[0.85em]`, row.method),
    names,
    el('span', `pill ${row.state === 'passed' ? 'good' : 'bad'}`, row.status || row.state),
  );
  if (row.tests.length)
    summary.append(
      el(
        'span',
        `chip ${passedTests === row.tests.length ? 'good-text' : 'bad-text'}`,
        `${passedTests}/${row.tests.length} tests`,
      ),
    );
  if (row.durationMs !== undefined)
    summary.append(el('span', 'chip font-mono', `${Math.round(row.durationMs)} ms`));
  summary.setAttribute('aria-label', `${row.name}: ${row.state}`);
  details.append(summary);
  const body = el('div', 'flex flex-col gap-1.5 px-3 pb-3 pl-10');
  if (row.error) body.append(el('p', 'error m-0', row.error));
  for (const test of row.tests) {
    const line = el('div', 'flex items-baseline gap-2 font-mono text-small');
    line.append(
      el(
        'span',
        test.pass ? 'text-positive font-bold' : 'text-negative font-bold',
        test.pass ? '✓' : '✗',
      ),
      el('span', test.pass ? '' : 'font-semibold', test.label),
    );
    if (!test.pass && test.message) line.append(el('span', 'text-muted', `— ${test.message}`));
    body.append(line);
  }
  if (!row.tests.length && !row.error)
    body.append(el('p', 'muted m-0 text-small', 'No tests: it passes when its status is 200–399.'));
  const open = button('Open request', () => act('openRequest', row.id), {
    className: 'ghost self-start',
  });
  body.append(open);
  details.append(body);
  item.append(details);
  return item;
}

function render(view: View | undefined): void {
  if (!view) return void root.replaceChildren(el('p', 'empty', 'Loading…'));
  const node =
    view.view === 'request'
      ? renderRequest(view)
      : view.view === 'response'
        ? renderResponse(view)
        : view.view === 'mock'
          ? renderMock(view)
          : view.view === 'runner'
            ? renderRunner(view)
            : view.view === 'docs'
              ? renderDocs(view)
              : view.view === 'live'
                ? renderLive(view)
                : view.view === 'newRequest'
                  ? renderNewRequest(view)
                  : view.view === 'credentials'
                    ? renderCredentials(view)
                    : view.view === 'environments'
                      ? renderEnvironments(view)
                      : view.view === 'testResults'
                        ? renderTestResults(view)
                        : view.view === 'certificates'
                          ? renderCertificates(view)
                          : renderNetwork(view);
  // Keep the focused field focused across a render, such as a response arriving while typing.
  const focused = document.activeElement as HTMLElement | null;
  const label = focused?.getAttribute('aria-label');
  root.replaceChildren(node);
  if (label && (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement)) {
    const at = focused.selectionStart;
    const again = [...root.querySelectorAll('input, textarea')].find(
      (item) => item.getAttribute('aria-label') === label,
    ) as HTMLInputElement | HTMLTextAreaElement | undefined;
    again?.focus();
    if (again && at !== null && again.type !== 'number') again.setSelectionRange(at, at);
  }
}

document.addEventListener('keydown', (event) => {
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key === 's' &&
    current?.view === 'live' &&
    saved.liveDraft
  ) {
    event.preventDefault();
    if (JSON.stringify(saved.liveDraft.value) !== JSON.stringify(current.saved))
      act('save', saved.liveDraft.value);
    return;
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key === 's' &&
    current?.view === 'environments' &&
    saved.environmentDraft
  ) {
    event.preventDefault();
    if (JSON.stringify(saved.environmentDraft.value) !== JSON.stringify(current.variables))
      act('saveVariables', saved.environmentDraft.value);
    return;
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key === 's' &&
    current?.view === 'mock' &&
    current.saved &&
    saved.mockDraft
  ) {
    event.preventDefault();
    if (JSON.stringify(saved.mockDraft.value) !== JSON.stringify(current.saved))
      act('saveMock', saved.mockDraft.value);
    return;
  }
  if (!(event.ctrlKey || event.metaKey) || current?.view !== 'request') return;
  const draft = saved.draft?.value;
  if (event.key === 's') {
    event.preventDefault();
    if (current.kind === 'saved' && draft && !sameDraft(draft, current.saved)) act('save', draft);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (!current.sending && current.sendable)
      act(
        'send',
        current.kind === 'saved' && draft && !sameDraft(draft, current.saved) ? draft : undefined,
      );
  }
});

window.addEventListener('message', (event: MessageEvent<{ type?: string; view?: View }>) => {
  if (event.data?.type !== 'render' || !event.data.view) return;
  current = event.data.view;
  saved.view = current;
  persist();
  render(current);
});
render(current);
vscode.postMessage({ type: 'ready' });

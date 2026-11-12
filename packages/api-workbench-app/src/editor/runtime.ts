import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  redo,
  redoDepth,
  selectAll,
  undo,
  undoDepth,
} from '@codemirror/commands';
import {
  StreamLanguage,
  bracketMatching,
  foldAll,
  foldGutter,
  foldKeymap,
  foldService,
  indentOnInput,
  indentUnit,
  matchBrackets,
  syntaxHighlighting,
  syntaxTree,
  unfoldAll,
  type StreamParser,
} from '@codemirror/language';
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from '@codemirror/search';
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { classHighlighter } from '@lezer/highlight';
import { json } from '@codemirror/lang-json';
import { javascript, localCompletionSource } from '@codemirror/lang-javascript';
import { linter, lintGutter, nextDiagnostic, type Diagnostic } from '@codemirror/lint';
import {
  scriptSyntaxProblem,
  type ScriptSyntaxProblem,
} from '@techieutils/api-workbench-common/script-syntax';
import {
  scriptCompletions,
  type ScriptCompletionContext,
  type ScriptSuggestion,
} from '@techieutils/api-workbench-common/script-api';
import { xml } from '@codemirror/lang-xml';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { sass } from '@codemirror/lang-sass';
import { yaml } from '@codemirror/lang-yaml';
import { markdown } from '@codemirror/lang-markdown';
import { sql } from '@codemirror/lang-sql';
import { python } from '@codemirror/lang-python';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf';
export { languages, detectLanguage, canFormat, formatText } from './formatting';

/** GraphQL has no CodeMirror language package; this tokenizer covers what the body editor shows. */
const graphql: StreamParser<unknown> = {
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^#.*/)) return 'comment';
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string';
    if (stream.match(/^\$[\w]+/)) return 'variableName.special';
    if (stream.match(/^(query|mutation|subscription|fragment|on|true|false|null)\b/))
      return 'keyword';
    if (stream.match(/^-?\d+(?:\.\d+)?/)) return 'number';
    if (stream.match(/^[_a-zA-Z][_a-zA-Z0-9]*/)) return 'propertyName';
    stream.next();
    return null;
  },
};

/**
 * Folds the block a line opens with `{`, `[`, or `(`, for languages whose tokenizers have no
 * syntax tree to fold by.
 */
const braceFolding = foldService.of((state, lineStart, lineEnd) => {
  const text = state.sliceDoc(lineStart, lineEnd).trimEnd();
  if (!/[[{(]$/.test(text)) return null;
  const open = lineStart + text.length - 1;
  const match = matchBrackets(state, open, 1);
  if (!match?.matched || !match.end || match.end.from <= lineEnd) return null;
  return { from: open + 1, to: match.end.from };
});
const streamLanguage = (parser: StreamParser<unknown>) => [
  StreamLanguage.define(parser),
  braceFolding,
];

/** The editor support for each language id in `languages`; plain text and CSV have none. */
const LANGUAGE_SUPPORT: Record<string, () => Extension> = {
  json: () => json(),
  ndjson: () => json(),
  // JSON's grammar has no comments; JavaScript's reads JSON with comments.
  jsonc: () => javascript(),
  javascript: () => javascript(),
  typescript: () => javascript({ typescript: true }),
  xml: () => xml(),
  html: () => html(),
  css: () => css(),
  scss: () => sass(),
  yaml: () => yaml(),
  graphql: () => streamLanguage(graphql),
  markdown: () => markdown(),
  sql: () => sql(),
  python: () => python(),
  shell: () => streamLanguage(shell as StreamParser<unknown>),
  protobuf: () => streamLanguage(protobuf as StreamParser<unknown>),
};

/** A suggestion offered while typing a `{{template}}`. */
export interface EditorCompletion {
  /** What is inserted, such as `{{$randomFullName}}`. */
  text: string;
  description: string;
}
/**
 * Offers `completions` for the `{{…}}` being typed: after `{{`, or with Ctrl-Space inside one.
 * Choosing one replaces what was typed, with the closing braces the editor added.
 */
function templateCompletions(completions: (typed: string) => EditorCompletion[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const start = before.lastIndexOf('{{');
    if (start < 0 || before.slice(start).includes('}}')) return null;
    const typed = before.slice(start + 2);
    if (/\s{2}|[{}]/.test(typed)) return null;
    const after = line.text.slice(context.pos - line.from);
    const options = completions(typed).map((item) => ({
      label: item.text,
      detail: item.description,
    }));
    if (!options.length) return null;
    return {
      from: line.from + start,
      to: context.pos + (after.startsWith('}}') ? 2 : 0),
      options,
      // The list is already matched and ordered for what was typed.
      filter: false,
    };
  };
}

const SUGGESTION_TYPES: Record<ScriptSuggestion['kind'], string> = {
  namespace: 'namespace',
  property: 'property',
  function: 'method',
  variable: 'variable',
  text: 'text',
};
/** Inserts a function's name with its parentheses, the cursor between them, unless they follow. */
const applyCall: Completion['apply'] = (view, completion, from, to) => {
  const call = view.state.sliceDoc(to, to + 1) !== '(';
  const insert = completion.label + (call ? '()' : '');
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + completion.label.length + (call ? 1 : 0) },
    userEvent: 'input.complete',
  });
};
/** How far back the script is read for suggestions; scriptCompletions reads no further. */
const SCRIPT_LOOK_BACK = 20_000;
/**
 * Suggests the `aw` API in a request script (common `script-api.ts`): its members after a dot,
 * variable, module, and header names in a string argument, and its globals. `read` gives what
 * the editor knows now — the variables, the last response — each time suggestions open.
 */
function scriptCompletionSource(read: () => ScriptCompletionContext): CompletionSource {
  return (context) => {
    const node = syntaxTree(context.state).resolveInner(context.pos, -1);
    if (/Comment/.test(node.name)) return null;
    const start = Math.max(0, context.pos - SCRIPT_LOOK_BACK);
    const result = scriptCompletions(
      context.state.sliceDoc(start, context.pos),
      read(),
      context.explicit,
    );
    // Names in a string argument belong in strings; members and globals belong outside them.
    const inString = node.name === 'String' || node.name === 'TemplateString';
    if (!result || result.filtered !== inString) return null;
    return {
      from: start + result.from,
      options: result.options.map((option): Completion => ({
        label: option.label,
        type: SUGGESTION_TYPES[option.kind],
        detail: option.detail,
        info: option.doc,
        boost: option.boost,
        apply: option.call ? applyCall : undefined,
      })),
      filter: !result.filtered,
      validFor: result.filtered ? undefined : /^[\w$]*$/,
    };
  };
}

/**
 * Underlines the first syntax error in a script or library module (common `script-syntax.ts`),
 * after typing pauses, and reports it — or that there is none — for the editor's status line.
 */
function scriptSyntaxLinter(
  kind: 'script' | 'module',
  report?: (problem: ScriptSyntaxProblem | undefined) => void,
): Extension {
  return [
    lintGutter(),
    linter(
      (view): Diagnostic[] => {
        const problem = scriptSyntaxProblem(view.state.doc.toString(), kind);
        report?.(problem);
        return problem
          ? [
              {
                from: problem.from,
                to: problem.to,
                severity: 'error',
                source: 'Syntax',
                message: `${problem.message} (line ${problem.line}, column ${problem.column})`,
              },
            ]
          : [];
      },
      { delay: 400 },
    ),
  ];
}

export interface EditorHandle {
  getValue(): string;
  setValue(value: string): void;
  focus(): void;
  destroy(): void;
  refresh(): void;
  /** The selected text, or '' when nothing is selected. */
  selection(): string;
  /** The selection's offsets in the text; equal when nothing is selected. */
  selectionRange(): { from: number; to: number };
  /** The text offset at a point on screen, or the cursor's when there is no point or text there. */
  offsetAt(point?: { x: number; y: number }): number;
  /** Runs an editor command: selecting all, the find panel, or folding. */
  command(name: 'selectAll' | 'find' | 'foldAll' | 'unfoldAll' | 'undo' | 'redo'): void;
  /** Replaces the selection (or inserts at the cursor), as typing would; editable editors only. */
  replaceSelection(text: string): void;
  /** How many changes can be undone and redone. */
  history(): { undo: number; redo: number };
  /** Where the cursor is on screen, for a menu opened from the keyboard. */
  cursorPoint(): { x: number; y: number };
  /** Moves the cursor to the start of a 1-based line, scrolls it into view, and focuses. */
  goToLine(line: number): void;
}
export function mount(
  host: HTMLElement,
  options: {
    value: string;
    language: string;
    readOnly: boolean;
    wrap: boolean;
    label: string;
    onChange?: (value: string) => void;
    onFormat?: () => void;
    /** Suggestions for `{{templates}}`, offered while typing them. */
    completions?: (typed: string) => EditorCompletion[];
    /** Makes this a request script's editor, suggesting the `aw` API with what this gives. */
    scriptContext?: () => ScriptCompletionContext;
    /** Checks the text as a script or library module, underlining a syntax error. */
    syntax?: 'script' | 'module';
    /** Hears the syntax error found after each change, or undefined once there is none. */
    onSyntax?: (problem: ScriptSyntaxProblem | undefined) => void;
  },
): EditorHandle {
  const scripting = Boolean(options.scriptContext && !options.readOnly);
  const sources: CompletionSource[] = [
    ...(options.completions && !options.readOnly ? [templateCompletions(options.completions)] : []),
    ...(scripting ? [scriptCompletionSource(options.scriptContext!), localCompletionSource] : []),
  ];
  const completing = sources.length > 0;
  const extensions: Extension[] = [
    lineNumbers(),
    foldGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    syntaxHighlighting(classHighlighter),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorState.tabSize.of(2),
    indentUnit.of('  '),
    EditorState.readOnly.of(options.readOnly),
    EditorView.editorAttributes.of({ class: 'cm-workbench' }),
    EditorView.contentAttributes.of({ 'aria-label': options.label }),
    LANGUAGE_SUPPORT[options.language]?.() ?? [],
    options.wrap ? EditorView.lineWrapping : [],
    options.readOnly ? [] : closeBrackets(),
    completing ? autocompletion({ override: sources, icons: false }) : [],
    options.syntax && !options.readOnly ? scriptSyntaxLinter(options.syntax, options.onSyntax) : [],
    keymap.of([
      ...(completing ? completionKeymap : []),
      // Tab chooses a suggestion while the list is open, as in code editors; otherwise it indents.
      ...(completing ? [{ key: 'Tab', run: acceptCompletion }] : []),
      ...(options.readOnly ? [] : closeBracketsKeymap),
      {
        key: 'Shift-Alt-f',
        run: () => {
          options.onFormat?.();
          return true;
        },
      },
      {
        key: 'Tab',
        run: (view) => {
          if (view.state.readOnly) return false;
          if (!view.state.selection.main.empty) return indentMore(view);
          view.dispatch(view.state.replaceSelection('  '), { userEvent: 'input' });
          return true;
        },
        shift: indentLess,
      },
      ...searchKeymap,
      // F8 moves to the syntax error; the status line under the editor names it, so the lint
      // panel (Mod-Shift-m in lintKeymap) is not bound.
      ...(options.syntax ? [{ key: 'F8', run: nextDiagnostic }] : []),
      ...foldKeymap,
      ...historyKeymap,
      ...defaultKeymap,
      {
        key: 'Escape',
        run: (view) => {
          view.contentDOM.blur();
          return true;
        },
      },
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange?.(update.state.doc.toString());
    }),
  ];
  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: options.value, extensions }),
  });
  return {
    getValue: () => view.state.doc.toString(),
    setValue: (value) => {
      const state = view.state;
      if (state.doc.toString() === value) return;
      view.dispatch({
        changes: { from: 0, to: state.doc.length, insert: value },
        selection: { anchor: Math.min(state.selection.main.head, value.length) },
        userEvent: 'input.format',
      });
    },
    focus: () => view.focus(),
    refresh: () => view.requestMeasure(),
    selection: () => {
      const { from, to } = view.state.selection.main;
      return view.state.sliceDoc(from, to);
    },
    selectionRange: () => {
      const { from, to } = view.state.selection.main;
      return { from, to };
    },
    offsetAt: (point) => (point && view.posAtCoords(point)) ?? view.state.selection.main.head,
    command: (name) => {
      const run = {
        selectAll,
        find: openSearchPanel,
        foldAll,
        unfoldAll,
        undo,
        redo,
      }[name];
      run(view);
    },
    replaceSelection: (text) =>
      view.dispatch(view.state.replaceSelection(text), {
        userEvent: 'input.type',
        scrollIntoView: true,
      }),
    history: () => ({ undo: undoDepth(view.state), redo: redoDepth(view.state) }),
    cursorPoint: () => {
      const coords = view.coordsAtPos(view.state.selection.main.head);
      if (coords) return { x: coords.left, y: coords.bottom };
      const box = view.contentDOM.getBoundingClientRect();
      return { x: box.left, y: box.top };
    },
    goToLine: (line) => {
      const doc = view.state.doc;
      const target = doc.line(Math.min(Math.max(line, 1), doc.lines));
      view.dispatch({
        selection: { anchor: target.from },
        effects: EditorView.scrollIntoView(target.from, { y: 'nearest', yMargin: 60 }),
      });
      view.focus();
    },
    destroy: () => view.destroy(),
  };
}

/**
 * The CodeMirror view of an editor element, or of the editor inside a host element; for tests
 * and tooling that need CodeMirror's own API.
 */
export function viewOf(element: Element | null | undefined): EditorView | null {
  const dom = element?.closest('.cm-editor') ?? element?.querySelector('.cm-editor');
  return dom instanceof HTMLElement ? EditorView.findFromDOM(dom) : null;
}

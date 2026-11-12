import {
  scriptCompletions,
  type ScriptCompletionContext,
  type ScriptSuggestion,
} from '@techieutils/api-workbench-common/script-api';
import { scriptSyntaxProblem } from '@techieutils/api-workbench-common/script-syntax';

/**
 * A request's scripts as documents in VS Code's own editors: where each lives
 * (`apiworkbench-script:` URIs), the suggestions the app's script editor offers, and its syntax
 * check. Both only read the text — nothing here runs a script.
 */

export const SCRIPT_SCHEME = 'apiworkbench-script';
export type ScriptPhase = 'pre' | 'post';

/** Which script a document is: the source by key, the request by id, and the phase. */
export interface ScriptRef {
  source: string;
  request: string;
  phase: ScriptPhase;
}

const FILE_NAMES: Record<ScriptPhase, string> = {
  pre: 'pre-request.js',
  post: 'post-response.js',
};

/** The path of a script's document, ending in a name its editor tab shows: `List users · pre-request.js`. */
export function scriptPath(ref: ScriptRef, requestName: string): string {
  // Characters a file name cannot hold become dashes, so the tab shows the request's name.
  const name =
    [...requestName]
      .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? '-' : char))
      .join('')
      .slice(0, 80) || 'Request';
  return `/${encodeURIComponent(ref.source)}/${encodeURIComponent(ref.request)}/${ref.phase}/${name} · ${FILE_NAMES[ref.phase]}`;
}

/** The script a document path names, or undefined when it names none. */
export function scriptRef(path: string): ScriptRef | undefined {
  const [, source, request, phase] = path.split('/');
  if (!source || !request || (phase !== 'pre' && phase !== 'post')) return undefined;
  try {
    return { source: decodeURIComponent(source), request: decodeURIComponent(request), phase };
  } catch {
    return undefined;
  }
}

/** A suggestion as VS Code's completion list shows it. */
export interface ScriptCompletionItem {
  label: string;
  kind: ScriptSuggestion['kind'];
  detail?: string;
  doc?: string;
  /** Insert `label()` with the cursor between the parentheses. */
  call: boolean;
  /** Sorts members of the other phase last. */
  sortText: string;
}

/**
 * What to suggest at the end of `before` (the text up to the cursor), as the app's script editor
 * does, and where the replaced text starts in it.
 */
export function completionsAt(
  before: string,
  context: ScriptCompletionContext,
  explicit: boolean,
): { from: number; items: ScriptCompletionItem[] } | undefined {
  const result = scriptCompletions(before, context, explicit);
  if (!result) return undefined;
  return {
    from: result.from,
    items: result.options.map((option, index) => ({
      label: option.label,
      kind: option.kind,
      detail: option.detail,
      doc: option.doc,
      call: Boolean(option.call),
      sortText: `${String(1000 - (option.boost ?? 0)).padStart(5, '0')}${String(index).padStart(5, '0')}`,
    })),
  };
}

/** The script's first syntax error, as the app underlines it, from line 1. */
export const syntaxProblem = (text: string) => scriptSyntaxProblem(text, 'script');

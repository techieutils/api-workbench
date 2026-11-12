import type { ApiRequest } from '@techieutils/api-workbench-common/types';
import {
  betweenCaptureFor,
  captureVariableName,
  jsonPathAt,
} from '@techieutils/api-workbench-common/capture-suggestions';
import { useRequestTestsStore } from '../stores/request-tests';

/** What a body editor's Capture value does: `apply` it, or the `reason` it is unavailable. */
export type BodyCaptureOffer = { apply: () => void } | { reason: string };

/**
 * What Capture value saves for a click or selection in a body editor that shows `text` for
 * `body`: in JSON, the path of the value there; in other text, the selection, found by the
 * markers around it in the body. The capture goes to `request`, shown in its Vars tab; `opens`
 * says to open that request first (a capture made from History).
 */
export function bodyCapture(
  { text, from, to }: { text: string; from: number; to: number },
  body: string,
  request: ApiRequest,
  opens = false,
): BodyCaptureOffer {
  const tests = useRequestTestsStore();
  const requestId = opens ? request.id : undefined;
  const taken = (request.captures ?? []).map((row) => row.key.trim());
  let path: string | undefined;
  try {
    JSON.parse(body);
    path = jsonPathAt(text, from, to);
  } catch {
    path = undefined;
  }
  if (path) {
    const variable = captureVariableName(path, taken);
    return { apply: () => tests.addCapture(variable, path, path, requestId) };
  }
  if (from === to) return { reason: 'select the text to capture' };
  // The editor may show formatted text: find the selection in the body the capture reads.
  const selected = text.slice(from, to);
  const start = text === body ? from : body.indexOf(selected);
  if (start < 0 || (text !== body && body.indexOf(selected, start + 1) >= 0))
    return { reason: 'select text that appears once in the raw body' };
  const between = betweenCaptureFor(body, start, start + selected.length);
  if (!between) return { reason: 'no nearby text marks this selection' };
  const variable = captureVariableName(undefined, taken);
  return {
    apply: () => tests.addCapture(variable, between, 'the selected text', requestId),
  };
}

/**
 * What Capture value saves in raw header lines (`name: value`): the header under the cursor, or,
 * on a Set-Cookie line, the cookie under it (a combined line holds several).
 */
export function headerLineCapture(
  { text, from }: { text: string; from: number; to: number },
  request: ApiRequest,
  opens = false,
): BodyCaptureOffer {
  const tests = useRequestTestsStore();
  const requestId = opens ? request.id : undefined;
  const start = text.lastIndexOf('\n', from - 1) + 1;
  const end = text.indexOf('\n', from);
  const line = text.slice(start, end < 0 ? text.length : end);
  const colon = line.indexOf(':');
  const name = colon > 0 ? line.slice(0, colon).trim() : '';
  if (!name) return { reason: 'click a header line' };
  if (name.toLowerCase() !== 'set-cookie') {
    const taken = (request.captures ?? []).map((row) => row.key.trim());
    const variable = captureVariableName(undefined, taken, name);
    return { apply: () => tests.addCapture(variable, `header ${name}`, name, requestId) };
  }
  // The cookie whose part of the line holds the cursor: a new one starts at each `, name=`.
  const value = line.slice(colon + 1);
  const offset = from - start - colon - 1;
  let at = 0;
  for (const part of value.split(/,(?=\s*[^;,=\s]+=)/)) {
    if (offset <= at + part.length) {
      const cookie = part.trim().split(';')[0].split('=')[0].trim();
      if (!cookie) break;
      return { apply: () => tests.captureCookie(cookie, requestId) };
    }
    at += part.length + 1;
  }
  return { reason: 'click a cookie of this header' };
}

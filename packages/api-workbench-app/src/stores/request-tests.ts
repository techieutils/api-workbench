import { defineStore } from 'pinia';
import { markRaw, reactive, ref } from 'vue';
import { run } from '@techieutils/api-workbench-common/assertions';
import type {
  ApiRequest,
  HttpResponse,
  RequestResponse,
} from '@techieutils/api-workbench-common/types';
import * as variables from '@techieutils/api-workbench-common/variables';
import { captureVariableName } from '@techieutils/api-workbench-common/capture-suggestions';
import { render } from '../shell';
import { toast } from '../utils';
import { useRequestsStore } from './requests';
import { useUiStore } from './ui';
import { useWorkspaceStore } from './workspace';

/** The Tests tab's editor mode, example picker, and visual test case designer, and captures. */
export const useRequestTestsStore = defineStore('requestTests', () => {
  const workspace = useWorkspaceStore();
  const mode = ref<'Builder' | 'Text'>('Builder');
  const example = reactive({ group: 'All', selected: 0 });
  const designer = reactive({
    /** The request the designer belongs to; switching requests resets it. */
    requestId: '',
    /** The case being edited, or null when adding one. */
    editing: null as number | null,
    /** The tests source the edit started from; an outside change abandons the edit. */
    source: '',
    name: '',
    enabled: true,
    rule: undefined as TestRule | undefined,
    error: '',
  });
  /** Latest capture outcome per request; shown with assertions and not persisted. */
  const captureResults = markRaw(new Map<string, CaptureResult[]>());
  /** Writes captured response values into an environment, creating variables as needed. */
  function applyCaptures(
    request: ApiRequest,
    response: RequestResponse,
    environment = workspace.state.environments[workspace.state.environment],
  ): CaptureResult[] {
    // A failed request runs only the captures that read a failure: error, timing, certificate.
    const rows = (request.captures ?? []).filter(
      (row) => response.error === undefined || variables.readsFailures(row.value),
    );
    if (!rows.some((row) => row.enabled && row.key)) {
      captureResults.delete(request.id);
      return [];
    }
    const results = variables.captureAll(rows, response);
    for (const result of results) {
      if (result.value === undefined) continue;
      const existing = environment.variables.find((variable) => variable.key === result.variable);
      if (existing) {
        existing.value = result.value;
        existing.enabled = true;
      } else
        environment.variables.push({ enabled: true, key: result.variable, value: result.value });
    }
    captureResults.set(request.id, results);
    return results;
  }
  /**
   * Adds a capture to a request (the current one unless another is named) and shows it in that
   * request's Vars tab: the next response stores `source` in `{{variable}}`.
   */
  function addCapture(variable: string, source: string, what = source, requestId?: string): void {
    const request = requestId
      ? workspace.state.requests.find((item) => item.id === requestId)
      : workspace.current();
    if (!request) return toast('This request is no longer in the workspace', 'warning');
    (request.captures ??= []).push({ enabled: true, key: variable, value: source });
    workspace.persist();
    // A capture made elsewhere (History) opens its request, so the Vars tab shows it.
    if (requestId) useRequestsStore().openRequest(requestId);
    useUiStore().requestTab = 'Vars';
    render();
    toast(`The next response stores ${what} in {{${variable}}}`, 'success');
  }
  /** Adds a capture of a cookie the response sets, named after the cookie. */
  function captureCookie(name: string, requestId?: string): void {
    const request = requestId
      ? workspace.state.requests.find((item) => item.id === requestId)
      : workspace.current();
    const taken = (request?.captures ?? []).map((row) => row.key.trim());
    const source = /^[\w.!#$%&'*+^`|~-]+$/.test(name) ? name : JSON.stringify(name);
    addCapture(
      captureVariableName(undefined, taken, name),
      `cookie ${source}`,
      `the ${name} cookie`,
      requestId,
    );
  }
  const runTests = (request: ApiRequest, response: HttpResponse) => run(request.tests, response);
  return {
    mode,
    example,
    designer,
    captureResults,
    applyCaptures,
    addCapture,
    captureCookie,
    runTests,
  };
});

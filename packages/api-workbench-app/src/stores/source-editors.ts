import { defineStore } from 'pinia';
import type { ApiRequest } from '@techieutils/api-workbench-common/types';
import { errorMessage, toast } from '../utils';
import { useResponseStore } from './response';
import { useWorkspaceStore } from './workspace';

type EditorHandle = import('../editor/runtime').EditorHandle;
const MAX_FORMATTED = 10;

/**
 * The request body and HTTP response source editors, their languages, and formatting. Editors
 * come from the WorkbenchEditor runtime (CodeMirror, bundled by esbuild) and are registered by
 * RequestBody.vue and ResponseSource.vue while they are shown; the handles are not reactive.
 */
export const useSourceEditorsStore = defineStore('sourceEditors', () => {
  const workspace = useWorkspaceStore();
  const response = useResponseStore();
  let requestEditor: EditorHandle | undefined;
  let responseEditor: EditorHandle | undefined;
  /** Bumped per response editor, so formatting for one that was replaced is dropped. */
  let generation = 0;
  const formatCache = new Map<
    string,
    { body: string; language: string; text: string; error: string }
  >();

  function requestLanguage(request: ApiRequest): string {
    return (
      (request.editorLanguage && request.editorLanguage !== 'auto' ? request.editorLanguage : '') ||
      WorkbenchEditor.detectLanguage(
        request.headers.find(
          (header) => header.enabled && header.key.toLowerCase() === 'content-type',
        )?.value ||
          request.rawContentType ||
          'application/json',
        request.body,
      )
    );
  }
  /** The response body's language or view; Auto detect shows Raw when it cannot tell. */
  function responseLanguage(request: ApiRequest): string {
    if (response.language !== 'auto') return response.language;
    const detected = WorkbenchEditor.detectLanguage(
      Object.entries(request.response?.headers || {}).find(
        ([key]) => key.toLowerCase() === 'content-type',
      )?.[1],
      request.response?.body || '',
    );
    return detected === 'text' ? 'raw' : detected;
  }
  function setRequestEditor(editor: EditorHandle | undefined): void {
    requestEditor = editor;
  }
  /** A new response editor shows the raw source, so the filter or formatting is applied to it. */
  function setResponseEditor(editor: EditorHandle | undefined): void {
    responseEditor = editor;
    generation++;
    if (editor && !applyResponseFilter()) void formatResponse();
  }
  /** Shows the filtered body in the response editor; returns false when no filter applies. */
  function applyResponseFilter(): boolean {
    const filtered = response.filteredBody(workspace.current());
    const status = document.querySelector<HTMLElement>('#response-filter-status');
    document
      .querySelector('.response-filter')
      ?.classList.toggle('has-error', Boolean(filtered?.error && !filtered.text));
    if (status) {
      status.textContent = filtered?.error || '';
      status.hidden = !filtered?.error;
    }
    if (!filtered || !responseEditor) return false;
    if (filtered.text || !filtered.error) responseEditor.setValue(filtered.text);
    return true;
  }
  async function formatRequest(): Promise<void> {
    const request = workspace.current();
    const original = request.body;
    const language = requestLanguage(request);
    try {
      const formatted = await WorkbenchEditor.formatText(original, language);
      if (
        !workspace.state.requests.includes(request) ||
        request.body !== original ||
        requestLanguage(request) !== language
      )
        return toast(
          'The body changed while formatting. Format again to use the latest content.',
          'warning',
        );
      request.body = formatted;
      if (workspace.state.active === request.id) {
        const textarea = document.querySelector<HTMLTextAreaElement>('#body');
        if (textarea) textarea.value = formatted;
        requestEditor?.setValue(formatted);
      }
      workspace.persist();
    } catch (error) {
      toast(`Format failed: ${errorMessage(error)}`, 'error');
    }
  }
  async function formatResponse(force = false): Promise<void> {
    const editor = responseEditor;
    const request = workspace.current();
    const body = request.response?.body;
    const language = responseLanguage(request);
    if (
      !editor ||
      response.tab !== 'Body' ||
      body === undefined ||
      response.mode !== 'Pretty' ||
      !WorkbenchEditor.canFormat(language)
    )
      return;
    const started = generation;
    let cached = formatCache.get(request.id);
    if (force || !cached || cached.body !== body || cached.language !== language) {
      try {
        cached = {
          body,
          language,
          text: await WorkbenchEditor.formatText(body, language),
          error: '',
        };
      } catch (error) {
        cached = { body, language, text: body, error: errorMessage(error) };
      }
      if (started !== generation || request.response?.body !== body || response.mode !== 'Pretty')
        return;
      formatCache.set(request.id, cached);
      if (formatCache.size > MAX_FORMATTED) formatCache.delete(formatCache.keys().next().value!);
    }
    if (started !== generation) return;
    editor.setValue(cached.text);
    const status = document.querySelector<HTMLElement>('#response-format-status');
    if (status) {
      status.textContent = cached.error
        ? `Showing original body: ${cached.error.slice(0, 200)}`
        : '';
      status.hidden = !cached.error;
    }
  }
  return {
    requestLanguage,
    responseLanguage,
    setRequestEditor,
    setResponseEditor,
    applyResponseFilter,
    formatRequest,
    formatResponse,
    clearFormatCache: () => formatCache.clear(),
    requestEditor: () => requestEditor,
    responseEditor: () => responseEditor,
  };
});

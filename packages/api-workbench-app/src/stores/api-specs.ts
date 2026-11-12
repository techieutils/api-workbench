import { defineStore } from 'pinia';
import { reactive } from 'vue';
import type { ApiSpec } from '@techieutils/api-workbench-common/types';
import {
  analyzeSpec,
  blankSpec,
  requestsFromSpec,
  specFormat,
  specFromRequests,
  type SpecAnalysis,
} from '@techieutils/api-workbench-common/api-specs';
import { collectionOf, isWithin } from '@techieutils/api-workbench-common/folders';
import { mockDocOperations, mockDocumentation } from '@techieutils/api-workbench-common/mock-docs';
import { confirmAction } from '../confirm';
import { render } from '../shell';
import { download, errorMessage, toast } from '../utils';
import { useWorkspaceStore } from './workspace';
import { useMocksStore } from './mocks';
import { useProtocolsStore } from './protocols';

export type SpecTab = 'Editor' | 'Endpoints';

/** API specifications: OpenAPI 3 or Swagger 2 documents, each kept as its own file. */
export const useSpecsStore = defineStore('specs', () => {
  const workspace = useWorkspaceStore();
  const ui = reactive({ selected: '', tab: 'Editor' as SpecTab, filter: '' });
  // Read on every render: specs are edited in place, like requests.
  const specs = (): ApiSpec[] => workspace.state.specs ?? [];
  const current = (): ApiSpec | undefined =>
    specs().find((spec) => spec.id === ui.selected) ?? specs()[0];
  /** Analysis per text, so re-rendering does not parse the same document again. */
  let cached: { content: string; analysis: SpecAnalysis } | undefined;
  function analysis(spec: ApiSpec): SpecAnalysis {
    if (cached?.content !== spec.content)
      cached = { content: spec.content, analysis: analyzeSpec(spec.content) };
    return cached.analysis;
  }
  const errors = (spec: ApiSpec) =>
    analysis(spec).problems.filter((problem) => problem.severity === 'error').length;

  function freeName(base: string): string {
    const taken = new Set(specs().map((spec) => spec.name.toLowerCase()));
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base} ${n}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }
  function add(spec: Omit<ApiSpec, 'id'>): ApiSpec {
    const created = { id: crypto.randomUUID(), ...spec };
    (workspace.state.specs ??= []).push(created);
    ui.selected = created.id;
    ui.tab = 'Editor';
    workspace.persist();
    render();
    return created;
  }
  function create(): ApiSpec {
    const name = freeName('New API');
    return add({ name, format: 'yaml', content: blankSpec(name) });
  }
  /** A specification describing a collection's saved HTTP requests, linked to it. */
  function createFromCollection(collection: string): ApiSpec | undefined {
    const requests = workspace.state.requests.filter((request) =>
      isWithin(request.folder, collection),
    );
    if (!requests.some((request) => !request.protocol || request.protocol === 'http')) {
      toast(`${collection} has no HTTP requests to describe.`, 'warning');
      return undefined;
    }
    const spec = add({
      name: freeName(`${collection} API`),
      format: 'yaml',
      content: specFromRequests(collection, requests),
      collection,
    });
    toast(`Created a specification from ${collection}`, 'success');
    return spec;
  }
  /**
   * A specification describing what a mock server answers: its HTTP, SSE, and NDJSON routes, with
   * its address as the server. The mock is not linked, so later route edits leave the copy alone.
   */
  function createFromMock(id: string): ApiSpec | undefined {
    const mock = useMocksStore()
      .mocks()
      .find((item) => item.id === id);
    if (!mock) return undefined;
    if (!mockDocOperations(mock).length) {
      toast(`${mock.name} has no HTTP, SSE, or NDJSON routes to describe.`, 'warning');
      return undefined;
    }
    const spec = add({
      name: freeName(`${mock.name} API`),
      format: 'yaml',
      content: mockDocumentation(mock, 'OpenAPI YAML').text,
    });
    toast(`Created a specification from ${mock.name}`, 'success');
    return spec;
  }
  /** A specification from a file the person chose; YAML and JSON are kept as written. */
  async function createFromFile(file: File): Promise<void> {
    const content = await file.text();
    const name = freeName(file.name.replace(/\.(ya?ml|json)$/i, '') || 'Imported API');
    add({ name, format: specFormat(content), content });
    const problems = analysis(current()!).problems.filter((item) => item.severity === 'error');
    toast(
      problems.length
        ? `Opened ${name}; it has ${problems.length} problem${problems.length === 1 ? '' : 's'} to fix`
        : `Opened ${name}`,
      problems.length ? 'warning' : 'success',
    );
  }
  function select(id: string): void {
    ui.selected = id;
    render();
  }
  function rename(id: string, name: string): void {
    const spec = specs().find((item) => item.id === id);
    const next = name.trim().slice(0, 80);
    if (!spec || !next || next === spec.name) return;
    spec.name = next;
    workspace.persist();
    render();
  }
  let pendingSave: ReturnType<typeof setTimeout> | undefined;
  /** Keeps typing responsive: the text updates at once and is saved once typing pauses. */
  function setContent(id: string, content: string): void {
    const spec = specs().find((item) => item.id === id);
    if (!spec || spec.content === content) return;
    spec.content = content;
    workspace.refresh();
    clearTimeout(pendingSave);
    pendingSave = setTimeout(() => workspace.persist(), 400);
  }
  /**
   * Formats a specification as YAML or JSON, as it is written; one edited meanwhile is left as it
   * is. The text is saved at once, since the editor shows it straight away.
   */
  async function format(id: string): Promise<void> {
    const spec = specs().find((item) => item.id === id);
    if (!spec) return;
    const original = spec.content;
    try {
      const formatted = await WorkbenchEditor.formatText(original, spec.format);
      if (spec.content !== original)
        return toast(
          'The specification changed while formatting. Format again to use the latest text.',
          'warning',
        );
      if (formatted === original) return toast('Already formatted', 'info');
      spec.content = formatted;
      clearTimeout(pendingSave);
      workspace.persist();
      render();
    } catch (error) {
      toast(`Format failed: ${errorMessage(error)}`, 'error');
    }
  }
  function duplicate(id: string): void {
    const spec = specs().find((item) => item.id === id);
    if (!spec) return;
    add({ name: freeName(`${spec.name} copy`), format: spec.format, content: spec.content });
    toast(`Duplicated ${spec.name}`, 'success');
  }
  async function remove(id: string): Promise<void> {
    const spec = specs().find((item) => item.id === id);
    if (!spec) return;
    const confirmed = await confirmAction({
      title: `Delete the “${spec.name}” specification?`,
      message: 'Its file is removed from the workspace. Collections and mocks made from it stay.',
      confirmLabel: 'Delete specification',
      tone: 'danger',
    });
    if (!confirmed) return;
    workspace.state.specs = specs().filter((item) => item.id !== id);
    if (ui.selected === id) ui.selected = specs()[0]?.id ?? '';
    workspace.persist();
    render();
    toast(`Deleted ${spec.name}`, 'success');
  }
  function downloadSpec(id: string): void {
    const spec = specs().find((item) => item.id === id);
    if (!spec) return;
    download(
      `${spec.name.replace(/[\\/:*?"<>|]+/g, '-')}.${spec.format}`,
      spec.content,
      spec.format === 'json' ? 'application/json' : 'application/yaml',
    );
  }
  /**
   * Makes (or, the next time, refreshes) a collection of requests from the specification. A
   * refresh replaces the collection's requests after asking, since edits to them are lost.
   */
  async function generateCollection(id: string): Promise<void> {
    const spec = specs().find((item) => item.id === id);
    if (!spec) return;
    const { document } = analysis(spec);
    if (!document || errors(spec)) {
      toast('Fix the specification’s errors before generating a collection.', 'warning');
      return;
    }
    const state = workspace.state;
    const existing = spec.collection
      ? state.requests.filter((request) => collectionOf(request.folder) === spec.collection)
      : [];
    const collection = existing.length
      ? spec.collection!
      : (() => {
          const taken = new Set(state.requests.map((request) => collectionOf(request.folder)));
          const base = spec.name;
          for (let n = 1; ; n++) {
            const name = n === 1 ? base : `${base} ${n}`;
            if (!taken.has(name)) return name;
          }
        })();
    let requests;
    try {
      requests = requestsFromSpec(document, collection);
    } catch (error) {
      toast(errorMessage(error), 'error');
      return;
    }
    if (existing.length) {
      const confirmed = await confirmAction({
        title: `Refresh the “${collection}” collection?`,
        message: `Its ${existing.length} request${existing.length === 1 ? '' : 's'} are replaced by the ${requests.length} the specification describes. Edits made to them are lost.`,
        confirmLabel: 'Refresh collection',
        tone: 'danger',
      });
      if (!confirmed) return;
    }
    const ids = new Set(existing.map((request) => request.id));
    const protocols = useProtocolsStore();
    for (const requestId of ids) {
      protocols.live.delete(requestId);
      protocols.protocolUI.delete(requestId);
    }
    const before = state.requests.length - ids.size;
    try {
      await workspace.importCollection({ requests });
    } catch (error) {
      toast(errorMessage(error), 'error');
      return;
    }
    // Remove the old requests only once the new ones are in, so a failure changes nothing.
    state.requests = state.requests.filter((request) => !ids.has(request.id));
    state.tabs = state.tabs.filter((tab) => !ids.has(tab));
    state.recentTabs = state.recentTabs?.filter((tab) => !ids.has(tab));
    state.closedTabs = state.closedTabs?.filter((tab) => !ids.has(tab));
    if (!state.active || ids.has(state.active)) state.active = state.requests[before]?.id;
    if (state.active && !state.tabs.includes(state.active)) state.tabs.push(state.active);
    spec.collection = collection;
    workspace.persist();
    render();
    toast(
      `${existing.length ? 'Refreshed' : 'Created'} the ${collection} collection with ${requests.length} request${requests.length === 1 ? '' : 's'}`,
      'success',
    );
  }
  function startMock(id: string): void {
    const spec = specs().find((item) => item.id === id);
    if (!spec) return;
    const { document } = analysis(spec);
    if (!document || errors(spec)) {
      toast('Fix the specification’s errors before making a mock.', 'warning');
      return;
    }
    void useMocksStore().createFromSpec(spec.name, document);
  }
  return {
    ui,
    specs,
    current,
    analysis,
    errors,
    create,
    createFromCollection,
    createFromMock,
    createFromFile,
    select,
    rename,
    setContent,
    format,
    duplicate,
    remove,
    downloadSpec,
    generateCollection,
    startMock,
  };
});

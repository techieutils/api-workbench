import {
  effectiveTags,
  emptyTagFilter,
  matchesTags,
  type TagFilter,
} from '@techieutils/api-workbench-common/tags';
import { defineStore } from 'pinia';
import { isWithin } from '@techieutils/api-workbench-common/folders';
import { reactive } from 'vue';
import * as docs from '@techieutils/api-workbench-common/documentation';
import type { ApiRequest } from '@techieutils/api-workbench-common/types';
import { useWorkspaceStore } from './workspace';

type EditorHandle = import('../editor/runtime').EditorHandle;

/** View options for the History and Docs screens, and the generated documentation. */
export const useScreensStore = defineStore('screens', () => {
  const workspace = useWorkspaceStore();
  const history = reactive({
    query: '',
    status: 'All',
    /** Entries by their request's tags, as the explorer and Runner filter them. */
    tags: emptyTagFilter() as TagFilter,
    /** The entry whose response is shown, by its date and request id. */
    selected: '',
    tab: 'Body' as
      | 'Body'
      | 'Headers'
      | 'Cookies'
      | 'Timeline'
      | 'Certificate'
      | 'Compare'
      | 'Tests'
      | 'Console'
      | 'Preview',
    /** Headers as a table, or as raw `name: value` lines. */
    headersView: 'Table' as 'Table' | 'Raw',
  });
  const documentation = reactive({
    collection: '',
    mode: 'Swagger',
    /** Endpoints by their requests' tags; reset when the collection changes. */
    tags: emptyTagFilter() as TagFilter,
  });
  const documentationModes = ['Swagger', 'YAML', 'JSON', 'OpenAPI JSON', 'Swagger JSON'];
  /** The Docs screen's source editor, registered while it is shown; not reactive. */
  let documentationEditor: EditorHandle | undefined;

  /** A request's tags with its collection's and folders', as the docs list and export them. */
  const tagsOf = (request: ApiRequest) => effectiveTags(workspace.state, request);
  /** Every request in the chosen collection, before the tag filter. */
  const collectionRequestsAll = (): ApiRequest[] =>
    workspace.state.requests.filter((request) =>
      isWithin(request.folder, documentation.collection),
    );
  const documentationRequests = (): ApiRequest[] =>
    collectionRequestsAll().filter((request) => matchesTags(tagsOf(request), documentation.tags));
  function collectionTagsWithin(collection: string) {
    const tags = Object.fromEntries(
      Object.entries(workspace.state.collectionTags ?? {}).filter(([folder]) =>
        isWithin(folder, collection),
      ),
    );
    return Object.keys(tags).length ? { collectionTags: tags } : {};
  }
  function documentationOutput(): { text: string; extension: string; mime: string } {
    const requests = documentationRequests();
    const document = docs.buildDocument(documentation.collection, requests, { tagsOf });
    const yaml = documentation.mode === 'YAML';
    const value =
      documentation.mode === 'JSON'
        ? {
            info: { name: documentation.collection },
            requests: docs.collectionRequests(requests),
            // The collection's and its folders' tags, so an import keeps them.
            ...collectionTagsWithin(documentation.collection),
          }
        : documentation.mode === 'Swagger JSON'
          ? docs.swaggerDocument(document)
          : document;
    return {
      text: docs.serialize(value, yaml),
      extension: yaml ? 'yaml' : 'json',
      mime: yaml ? 'application/yaml' : 'application/json',
    };
  }
  function setDocumentationEditor(editor: EditorHandle | undefined): void {
    documentationEditor = editor;
  }
  return {
    history,
    documentation,
    documentationModes,
    documentationRequests,
    collectionRequestsAll,
    tagsOf,
    documentationOutput,
    setDocumentationEditor,
    documentationEditor: () => documentationEditor,
  };
});

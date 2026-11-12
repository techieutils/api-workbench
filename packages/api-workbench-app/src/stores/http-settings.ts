import { defineStore } from 'pinia';
import * as payload from '@techieutils/api-workbench-common/request-payload';
import {
  collectionOf,
  folderChain,
  isWithin,
  parentFolder,
} from '@techieutils/api-workbench-common/folders';
import { reactive, ref } from 'vue';
import * as http from '@techieutils/api-workbench-common/http-settings';
import type { HTTPSettings } from '@techieutils/api-workbench-common/http-settings';
import type { ApiRequest } from '@techieutils/api-workbench-common/types';
import { render } from '../shell';
import { useRequestsStore } from './requests';
import { useUiStore } from './ui';
import { useWorkspaceStore } from './workspace';

/**
 * HTTP settings layered from the workspace through the collection and each folder to the request,
 * and their editor: which scope is being edited, the row filter, and unsaved edits keyed by
 * workspace, scope, and target, so they survive switching tabs. Collection and folder overrides
 * share `collectionHttpSettings`, keyed by folder path (a collection's path is its name).
 */
export const useHTTPSettingsStore = defineStore('httpSettings', () => {
  const workspace = useWorkspaceStore();
  const scope = ref<'request' | 'collection'>('request');
  /**
   * The collection or folder the 'collection' scope edits; empty, or not above the open request,
   * means the request's collection.
   */
  const scopeFolder = ref('');
  /** The level the 'collection' scope edits for this request. */
  const scopeTarget = (request: ApiRequest): string =>
    scopeFolder.value && isWithin(request.folder, scopeFolder.value)
      ? scopeFolder.value
      : collectionOf(request.folder);
  const filter = reactive({ group: 'All', query: '' });
  const drafts = reactive(new Map<string, HTTPSettingsDraft>());
  /** True when this request, or a collection or folder above it, has unsaved settings edits. */
  function hasDraft(workspaceId: string, request: ApiRequest): boolean {
    const scopes = [
      `request|${request.id}|`,
      ...folderChain(request.folder).map((path) => `collection|folder:${path}|`),
    ];
    return [...drafts.keys()].some(
      (key) => key.startsWith(`${workspaceId}|`) && scopes.some((part) => key.includes(`|${part}`)),
    );
  }

  /** The overrides saved on exactly this collection or folder. */
  function folderSettings(folder: string): Partial<HTTPSettings> {
    const overrides = workspace.state.collectionHttpSettings;
    return overrides && Object.hasOwn(overrides, folder) ? overrides[folder] : {};
  }
  /** The overrides a folder passes on: its collection's, then each folder's down to this one. */
  const collectionSettings = (folder: string): Partial<HTTPSettings> =>
    payload.collectionHTTPSettings(workspace.state, folder);
  const workspaceDefaults = () => http.workspaceDefaults(workspace.settings());
  /** The settings a request sends with, after collection, folder, and request overrides. */
  const effectiveRequest = (request: ApiRequest): HTTPSettings =>
    payload.effectiveHTTPSettings({ ...workspace.state, settings: workspace.settings() }, request);
  /** The settings a scope inherits, shown as the defaults of its overrides. */
  function scopeParent(target: 'workspace' | 'collection' | 'request'): HTTPSettings {
    const request = workspace.current();
    if (target === 'request')
      return http.inherit(workspaceDefaults(), collectionSettings(request.folder));
    if (target === 'workspace') return { ...http.defaults };
    // A folder inherits from the levels above it; a collection from the workspace.
    const above = parentFolder(scopeTarget(request));
    return above === undefined
      ? workspaceDefaults()
      : http.inherit(workspaceDefaults(), collectionSettings(above));
  }
  /** Live protocols use the transport settings, but time out per connection instead. */
  function effectiveProtocol(request: ApiRequest): HTTPSettings {
    const transport = Object.fromEntries(
      Object.entries(request.httpSettings || {}).filter(([key]) => key !== 'timeoutMs'),
    );
    return http.resolve(workspaceDefaults(), collectionSettings(request.folder), transport);
  }
  /** Opens a collection's or folder's HTTP settings from the collection tree. */
  function openCollection(folder: string): void {
    const request = workspace.state.requests.find((item) => isWithin(item.folder, folder));
    if (!request) return;
    useRequestsStore().openRequest(request.id);
    scope.value = 'collection';
    scopeFolder.value = folder;
    useUiStore().requestTab = 'Settings';
    render();
  }
  /** Outside Electron only timeouts and redirects can be honoured. */
  function requireDesktop(config: HTTPSettings): void {
    if (window.workbench) return;
    const unsupported = http.fields.some(
      (field) =>
        !['timeoutMs', 'followRedirects', 'maxRedirects'].includes(field.key) &&
        config[field.key] !== http.defaults[field.key],
    );
    if (unsupported)
      throw new Error('Custom HTTP/TLS transport settings require the Electron desktop app.');
  }
  return {
    scope,
    scopeFolder,
    scopeTarget,
    folderSettings,
    filter,
    drafts,
    hasDraft,
    collectionSettings,
    effectiveRequest,
    scopeParent,
    effectiveProtocol,
    openCollection,
    requireDesktop,
  };
});

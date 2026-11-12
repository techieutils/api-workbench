import { createPinia, setActivePinia } from 'pinia';
import type { ApiRequest, WorkspaceState } from '@techieutils/api-workbench-common/types';
import { makeRequest, useWorkspaceStore } from '../stores/workspace';

/** A request for a test workspace, with tags and anything else it needs. */
export function request(
  name: string,
  folder: string,
  extra: Partial<ApiRequest> = {},
  method = 'GET',
  url = `{{base_url}}/${name.toLowerCase().replace(/\s+/g, '-')}`,
): ApiRequest {
  return { ...makeRequest(name, method, url, folder), ...extra };
}

/** A fresh Pinia with a workspace holding these requests, the first one open. */
export function workspaceWith(
  requests: ApiRequest[],
  extra: Partial<WorkspaceState> = {},
): ReturnType<typeof useWorkspaceStore> {
  setActivePinia(createPinia());
  const workspace = useWorkspaceStore();
  workspace.state = {
    requests,
    active: requests[0]?.id ?? '',
    tabs: requests.slice(0, 1).map((item) => item.id),
    environments: [
      {
        name: 'Development',
        variables: [
          { enabled: true, key: 'base_url', value: 'https://api.example.test' },
          { enabled: false, key: 'off', value: 'hidden' },
        ],
      },
    ],
    environment: 0,
    history: [],
    ...extra,
  };
  return workspace;
}

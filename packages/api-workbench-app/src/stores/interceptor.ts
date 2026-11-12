import { defineStore } from 'pinia';
import { computed, reactive, ref, shallowRef } from 'vue';
import { har } from '@techieutils/api-workbench-common/collection-formats/text-formats';
import type {
  InterceptorCapture,
  InterceptorStatus,
} from '@techieutils/api-workbench-common/types';
import { download, errorMessage, toast } from '../utils';
import { useRequestsStore } from './requests';
import { useWorkspaceStore } from './workspace';
import { confirmAction } from '../confirm';

/** Captures kept in memory; older ones drop off. They are never saved with the workspace. */
export const CAPTURE_LIMIT = 1000;
export const FOLDER = 'Intercepted';
const PREFERENCES_KEY = 'api-workbench:interceptor';
// CONNECT captures are tunnels, not requests to save.
const SAVABLE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'];
export const FILTERS = ['All', 'HTTP', 'HTTPS', 'Tunnels', 'Errors'] as const;
/** Headers a saved request should not carry: the client and proxy set these per connection. */
const CONNECTION_HEADERS =
  /^(host|connection|proxy-connection|keep-alive|content-length|transfer-encoding|te|upgrade|accept-encoding)$/i;

function preferences(): { port: number; decryptHttps: boolean; domains: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || '{}');
    return {
      port: Number.isInteger(saved.port) ? saved.port : 8899,
      decryptHttps: saved.decryptHttps !== false,
      domains: typeof saved.domains === 'string' ? saved.domains.slice(0, 2000) : '',
    };
  } catch {
    return { port: 8899, decryptHttps: true, domains: '' };
  }
}
/** The domains written in "Domains to decrypt", separated by commas or spaces. */
export const domainList = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
const headerValue = (headers: [string, string][] | undefined, name: string) =>
  headers?.find(([key]) => key.toLowerCase() === name)?.[1];
/** A capture's body as text, decoding base64 to show that it is binary. */
export function bodyText(body: string | undefined, encoding: string | undefined): string {
  if (!body) return '';
  return encoding === 'base64'
    ? `Binary content (${Math.round((body.length * 3) / 4)} bytes kept)`
    : body;
}

/** The Interceptor: a local capture proxy's status, and the traffic it has seen this session. */
export const useInterceptorStore = defineStore('interceptor', () => {
  const available = Boolean(window.workbench?.interceptor);
  const saved = preferences();
  const settings = reactive({
    port: saved.port,
    decryptHttps: saved.decryptHttps,
    domains: saved.domains,
  });
  const status = ref<InterceptorStatus>();
  const busy = ref(false);
  const error = ref('');
  const captures = shallowRef<InterceptorCapture[]>([]);
  const selectedId = ref<string>();
  /** `host` and `method` are empty for all hosts or methods. */
  const view = reactive({
    query: '',
    filter: 'All' as (typeof FILTERS)[number],
    host: '',
    method: '',
  });
  let subscribed = false;

  function receive(capture: InterceptorCapture): void {
    const list = captures.value;
    const index = list.findIndex((item) => item.id === capture.id);
    captures.value =
      index >= 0
        ? list.map((item, position) => (position === index ? capture : item))
        : [...list, capture].slice(-CAPTURE_LIMIT);
  }
  function subscribe(): void {
    if (subscribed || !available) return;
    subscribed = true;
    window.workbench!.interceptor!.onCapture(receive);
  }
  function remember(): void {
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(settings));
    } catch {
      // Preferences are a convenience; the defaults still work.
    }
  }
  async function run(operation: () => Promise<InterceptorStatus>): Promise<void> {
    busy.value = true;
    error.value = '';
    try {
      status.value = await operation();
    } catch (failure) {
      error.value = errorMessage(failure);
    } finally {
      busy.value = false;
    }
  }
  async function refresh(): Promise<void> {
    if (!available) return;
    subscribe();
    await run(() => window.workbench!.interceptor!.status());
  }
  async function start(): Promise<void> {
    subscribe();
    remember();
    await run(() =>
      window.workbench!.interceptor!.start({
        port: Number(settings.port),
        decryptHttps: settings.decryptHttps,
        domains: domainList(settings.domains),
      }),
    );
  }
  const stop = () => run(() => window.workbench!.interceptor!.stop());
  const setRecording = (recording: boolean) =>
    run(() => window.workbench!.interceptor!.setRecording(recording));
  async function resetAuthority(): Promise<void> {
    const confirmed = await confirmAction({
      title: 'Create a new Interceptor certificate?',
      message:
        'Apps that trust the current certificate must trust the new one before HTTPS can be decrypted again. Remove the old certificate from wherever you trusted it.',
      confirmLabel: 'Create new certificate',
      tone: 'danger',
    });
    if (!confirmed) return;
    await run(() => window.workbench!.interceptor!.resetAuthority());
    if (!error.value) toast('Created a new Interceptor certificate', 'success');
  }
  async function exportAuthority(): Promise<void> {
    try {
      if (await window.workbench!.interceptor!.exportAuthority())
        toast('Interceptor certificate saved', 'success');
    } catch (failure) {
      toast(errorMessage(failure), 'error');
    }
  }
  async function trustAuthority(): Promise<void> {
    busy.value = true;
    try {
      await window.workbench!.interceptor!.trustAuthority();
      toast('Interceptor certificate trusted. Restart browsers that were already open.', 'success');
    } catch (failure) {
      toast(`The certificate was not trusted: ${errorMessage(failure)}`, 'error');
    } finally {
      busy.value = false;
    }
  }
  function clear(): void {
    captures.value = [];
    selectedId.value = undefined;
    view.host = '';
    view.method = '';
  }

  const host = (capture: InterceptorCapture) => {
    try {
      return new URL(capture.url).host;
    } catch {
      return capture.url;
    }
  };
  const kind = (capture: InterceptorCapture) =>
    capture.error
      ? 'Errors'
      : capture.scheme === 'tunnel'
        ? 'Tunnels'
        : capture.scheme.toUpperCase();
  const shown = computed(() => {
    const query = view.query.trim().toLowerCase();
    return captures.value.filter(
      (capture) =>
        (view.filter === 'All' ||
          kind(capture) === view.filter ||
          (view.filter === 'Errors' && capture.error)) &&
        (!view.host || host(capture) === view.host) &&
        (!view.method || capture.method === view.method) &&
        (!query ||
          `${capture.method} ${capture.url} ${capture.status ?? ''}`.toLowerCase().includes(query)),
    );
  });
  /** Hosts and methods seen, busiest first, with how many captures each has. */
  const tally = (key: (capture: InterceptorCapture) => string) => {
    const counts = new Map<string, number>();
    for (const capture of captures.value)
      counts.set(key(capture), (counts.get(key(capture)) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const hosts = computed(() => tally(host));
  const methods = computed(() => tally((capture) => capture.method));
  const counts = computed(() => {
    const counts = new Map<string, number>();
    for (const capture of captures.value)
      counts.set(kind(capture), (counts.get(kind(capture)) || 0) + 1);
    return counts;
  });
  const selected = computed(() =>
    captures.value.find((capture) => capture.id === selectedId.value),
  );

  /** HAR 1.2 for decrypted and plain captures; tunnels carry no request to export. */
  function harDocument(list: InterceptorCapture[]) {
    const headers = (pairs: [string, string][] = []) =>
      pairs.map(([name, value]) => ({ name, value }));
    return {
      log: {
        version: '1.2',
        creator: { name: 'API Workbench Interceptor', version: '1.0.0' },
        entries: list
          .filter((capture) => capture.scheme !== 'tunnel' && capture.method !== 'CONNECT')
          .map((capture) => {
            const url = new URL(capture.url);
            return {
              startedDateTime: new Date(capture.startedAt).toISOString(),
              time: capture.durationMs ?? 0,
              request: {
                method: capture.method,
                url: capture.url,
                httpVersion: 'HTTP/1.1',
                headers: headers(capture.requestHeaders),
                queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
                cookies: [],
                headersSize: -1,
                bodySize: capture.requestBodySize,
                ...(capture.requestBody && capture.requestBodyEncoding === 'utf8'
                  ? {
                      postData: {
                        mimeType: headerValue(capture.requestHeaders, 'content-type') || '',
                        text: capture.requestBody,
                      },
                    }
                  : {}),
              },
              response: {
                status: capture.status ?? 0,
                statusText: capture.statusText || capture.error || '',
                httpVersion: 'HTTP/1.1',
                headers: headers(capture.responseHeaders),
                cookies: [],
                content: {
                  size: capture.responseBodySize ?? 0,
                  mimeType: headerValue(capture.responseHeaders, 'content-type') || '',
                  ...(capture.responseBody
                    ? {
                        text: capture.responseBody,
                        ...(capture.responseBodyEncoding === 'base64'
                          ? { encoding: 'base64' }
                          : {}),
                      }
                    : {}),
                },
                redirectURL: headerValue(capture.responseHeaders, 'location') || '',
                headersSize: -1,
                bodySize: capture.responseBodySize ?? -1,
              },
              cache: {},
              timings: { send: 0, wait: capture.durationMs ?? 0, receive: 0 },
            };
          }),
      },
    };
  }
  function exportHAR(): void {
    const document = harDocument(shown.value);
    if (!document.log.entries.length)
      return toast('No decrypted or HTTP traffic to export', 'warning');
    download(
      `interceptor-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.har`,
      JSON.stringify(document, null, 2),
      'application/json',
    );
    toast(
      `Exported ${document.log.entries.length} ${document.log.entries.length === 1 ? 'request' : 'requests'} as HAR`,
      'success',
    );
  }
  /** Adds captures to the Intercepted collection, without per-connection headers; opens the first. */
  async function saveToCollection(list: InterceptorCapture[]): Promise<void> {
    const savable = list.filter((capture) => SAVABLE_METHODS.includes(capture.method));
    const requests = har(harDocument(savable)).requests.map((request, index) => {
      const url = new URL(request.url!);
      return {
        ...request,
        name:
          `${request.method} ${url.host}${url.pathname}`.slice(0, 120) || `Request ${index + 1}`,
        folder: FOLDER,
        headers: request.headers?.filter((row) => !CONNECTION_HEADERS.test(row.key)),
      };
    });
    if (!requests.length)
      return toast('Tunnelled HTTPS has no request to save. Turn on HTTPS decryption.', 'warning');
    const workspace = useWorkspaceStore();
    try {
      await workspace.importCollection({ requests });
      const added = workspace.state.requests.slice(-requests.length);
      toast(
        `Saved ${requests.length} ${requests.length === 1 ? 'request' : 'requests'} to ${FOLDER}`,
        'success',
      );
      useRequestsStore().openRequest(added[0].id);
    } catch (failure) {
      toast(errorMessage(failure), 'error');
    }
  }

  return {
    available,
    settings,
    status,
    busy,
    error,
    captures,
    selectedId,
    selected,
    view,
    shown,
    counts,
    hosts,
    methods,
    refresh,
    start,
    stop,
    setRecording,
    resetAuthority,
    exportAuthority,
    trustAuthority,
    clear,
    exportHAR,
    saveToCollection,
    harDocument,
    receive,
  };
});

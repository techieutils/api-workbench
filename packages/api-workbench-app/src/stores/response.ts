import { defineStore } from 'pinia';
import { markRaw, reactive, ref } from 'vue';
import {
  bodyBytes,
  bytesToBase64,
  hexDump,
  HEX_VIEW_BYTE_LIMIT,
} from '@techieutils/api-workbench-common/body-views';
import { parseSetCookie } from '@techieutils/api-workbench-common/cookies';
import * as diff from '@techieutils/api-workbench-common/diff';
import type { ApiRequest, RequestResponse } from '@techieutils/api-workbench-common/types';
import { queryJSON } from '@techieutils/api-workbench-common/variables';
import { render } from '../shell';
import { errorMessage, uid } from '../utils';
import { useWorkspaceStore } from './workspace';
import { useRequestTestsStore } from './request-tests';
import { useSourceEditorsStore } from './source-editors';

const MAX_SNAPSHOTS = 10;
const MAX_COMPARE_ROWS = 5000;
/** Headers that change on every response and would drown out real differences. */
const VOLATILE_HEADERS = ['date', 'age', 'x-request-id', 'x-amzn-requestid', 'cf-ray'];
/** Body languages that show the bytes in another encoding rather than highlight the text. */
export const BYTE_VIEWS = ['hex', 'base64'] as const;
export const isByteView = (language: string) =>
  (BYTE_VIEWS as readonly string[]).includes(language);

/** The HTTP response viewer: inspector tab, Pretty/Raw mode, body language, filter, and compare. */
export const useResponseStore = defineStore('response', () => {
  const tab = ref('Body');
  const mode = ref<'Pretty' | 'Raw'>('Pretty');
  /**
   * 'auto' detects the language from the Content-Type and body, and shows 'raw' when it cannot
   * tell; 'raw', 'hex', and 'base64' are views of the body rather than languages.
   */
  const language = ref('auto');
  /** JSONPath filter for the body; kept across sends so a view can be watched. */
  const filter = ref('');
  /** HTML bodies in Pretty: rendered in a sandbox, or their source in the editor. */
  const htmlView = ref<'rendered' | 'source'>('rendered');
  const compare = reactive({
    baseline: new Map<string, string>(),
    pinned: new Map<string, string>(),
    sortKeys: true,
    changesOnly: true,
  });

  /**
   * Recent responses per request for this session, newest last. Raw, so a snapshot's response
   * stays the identical object as the request's; views read it through useRendered().
   */
  const snapshots = markRaw(new Map<string, ResponseSnapshot[]>());
  let sequence = 0;
  const limits = {
    rows: MAX_COMPARE_ROWS,
    snapshots: MAX_SNAPSHOTS,
    volatileHeaders: VOLATILE_HEADERS,
  };
  function recordSnapshot(request: ApiRequest, response: RequestResponse): void {
    if (response.error !== undefined) return;
    const list = snapshots.get(request.id) || [];
    list.push({ id: uid(), sequence: ++sequence, at: Date.now(), response });
    // Keep the pinned baseline even when it would otherwise be trimmed.
    const pinned = compare.pinned.get(request.id);
    while (list.length > MAX_SNAPSHOTS) {
      const index = list.findIndex((snapshot) => snapshot.id !== pinned);
      list.splice(index, 1);
    }
    snapshots.set(request.id, list);
  }
  function snapshotLabel(snapshot: ResponseSnapshot, current: boolean): string {
    const response = snapshot.response;
    return `#${snapshot.sequence} · ${response.status} ${response.statusText} · ${response.time} ms · ${new Date(snapshot.at).toLocaleTimeString()}${current ? ' · current' : ''}`;
  }
  /** The current response and the baseline it is compared with, when both exist. */
  function comparePair(request: ApiRequest): {
    current?: ResponseSnapshot;
    baseline?: ResponseSnapshot;
    options: ResponseSnapshot[];
  } {
    const list = snapshots.get(request.id) || [];
    const current = list.find((snapshot) => snapshot.response === request.response);
    const options = list.filter((snapshot) => snapshot !== current).reverse();
    const chosen =
      options.find((snapshot) => snapshot.id === compare.baseline.get(request.id)) ||
      options.find((snapshot) => snapshot.id === compare.pinned.get(request.id)) ||
      options[0];
    return { current, baseline: chosen, options };
  }
  function compareData(request: ApiRequest) {
    const { current, baseline, options } = comparePair(request);
    if (!current || !baseline) return { current, baseline, options };
    const before = diff.normalizeBody(baseline.response.body, compare.sortKeys).text;
    const after = diff.normalizeBody(current.response.body, compare.sortKeys).text;
    const body = diff.sideBySide(before, after);
    const headers = diff.diffHeaders(
      baseline.response.headers,
      current.response.headers,
      VOLATILE_HEADERS,
    );
    return { current, baseline, options, body, headers };
  }
  /** Unified diff text for the Raw view, copy, and download. */
  function compareUnifiedText(request: ApiRequest): string {
    const data = compareData(request);
    if (!data.body || !data.baseline || !data.current)
      return 'Send this request again to compare responses.';
    return diff.unifiedDiff(
      data.body.rows,
      `baseline ${snapshotLabel(data.baseline, false)}`,
      `current ${snapshotLabel(data.current, true)}`,
    );
  }

  function hasHTTPS(request: ApiRequest): boolean {
    if (request.response?.tls) return true;
    const url =
      request.response?.url ||
      request.response?.timings?.requests.at(-1)?.url ||
      useWorkspaceStore().resolve(request.url);
    try {
      return new URL(url).protocol === 'https:';
    } catch {
      return /^https:\/\//i.test(url);
    }
  }
  function certificateData(request: ApiRequest) {
    return (
      request.response?.tls || {
        available: false as const,
        message: !request.response
          ? 'Send an HTTPS request to inspect its certificate.'
          : !window.workbench
            ? 'Certificate inspection requires the Electron desktop app. Browsers do not expose server certificates.'
            : request.response.error
              ? 'No certificate was captured. The connection may have failed before a verified TLS handshake completed.'
              : 'No TLS certificate data was captured for this response. Send the request again in the desktop app.',
      }
    );
  }
  function tabIcon(name: string): MdiIconName {
    switch (name) {
      case 'Headers':
        return 'swap-horizontal';
      case 'Tests':
        return 'check-circle-outline';
      case 'Timeline':
        return 'timer-outline';
      case 'Certificate':
        return 'shield-lock-outline';
      case 'Cookies':
        return 'cookie-outline';
      case 'Compare':
        return 'view-split-vertical';
      default:
        return 'code-tags';
    }
  }
  /** The body with the JSONPath filter applied, when one applies to the Pretty body view. */
  function filteredBody(request: ApiRequest): { text: string; error: string } | undefined {
    const query = filter.value.trim();
    const body = request.response?.body;
    if (!query || body === undefined || tab.value !== 'Body' || mode.value !== 'Pretty')
      return undefined;
    // The filter reads JSON; it has nothing to apply to in a hex or Base64 view.
    if (isByteView(language.value)) return undefined;
    let root: unknown;
    try {
      root = JSON.parse(body);
    } catch {
      return { text: body, error: 'Filters apply to JSON responses; showing the original body.' };
    }
    try {
      const result = queryJSON(root, query);
      return {
        text: JSON.stringify(result, null, 2),
        error:
          Array.isArray(result) && !result.length && /\*/.test(query) ? 'No values match.' : '',
      };
    } catch (error) {
      return { text: '', error: errorMessage(error) };
    }
  }
  function timelineData(request: ApiRequest, response: RequestResponse) {
    return {
      request: {
        method: response.timings?.requests[0]?.method || request.method,
        url: response.timings?.requests[0]?.url || useWorkspaceStore().resolve(request.url),
      },
      response: {
        status: response.status,
        httpVersion: response.httpVersion,
        statusText: response.statusText,
        finalUrl:
          response.url ||
          response.timings?.requests.at(-1)?.url ||
          useWorkspaceStore().resolve(request.url),
      },
      totalDurationMs: response.timings?.totalMs ?? response.time ?? 0,
      responseBodyBytes: response.size ?? 0,
      timings: response.timings,
      ...(response.error !== undefined ? { error: response.error } : {}),
    };
  }
  // Hex and Base64 text for the last response shown, so re-renders do not encode it again.
  let byteViewCache: { response: RequestResponse; language: string; text: string } | undefined;
  /** The body in a byte view: a hex dump (up to HEX_VIEW_BYTE_LIMIT bytes) or Base64. */
  function byteViewText(response: RequestResponse, view: string): string {
    if (byteViewCache?.response === response && byteViewCache.language === view)
      return byteViewCache.text;
    const bytes = bodyBytes(response.body ?? '', response.bodyBase64);
    const text = view === 'hex' ? hexDump(bytes, HEX_VIEW_BYTE_LIMIT) : bytesToBase64(bytes);
    byteViewCache = { response, language: view, text };
    return text;
  }
  /** The inspector tab's content as source text, for the Raw view, copy, and download. */
  function inspectorSource(request: ApiRequest): { text: string; language: string } {
    const response = request.response;
    const json = (value: unknown) => ({ text: JSON.stringify(value, null, 2), language: 'json' });
    if (tab.value === 'Certificate') return json(certificateData(request));
    if (response && tab.value === 'Timeline') return json(timelineData(request, response));
    if (!response || response.error !== undefined) return { text: '', language: 'text' };
    if (tab.value === 'Headers')
      return {
        text: Object.entries(response.headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join('\n'),
        language: 'text',
      };
    if (tab.value === 'Compare') return { text: compareUnifiedText(request), language: 'text' };
    if (tab.value === 'Cookies')
      return json(
        (response.setCookies || []).map((item) => ({
          ...item,
          parsed: parseSetCookie(item.header, item.url) ?? null,
        })),
      );
    if (tab.value === 'Tests') {
      const tests = useRequestTestsStore().runTests(request, response);
      return json({
        total: tests.length,
        passed: tests.filter((test) => test.pass).length,
        failed: tests.filter((test) => !test.pass).length,
        assertions: tests,
      });
    }
    const bodyLanguage = useSourceEditorsStore().responseLanguage(request);
    if (isByteView(bodyLanguage))
      return { text: byteViewText(response, bodyLanguage), language: bodyLanguage };
    return { text: response.body, language: bodyLanguage };
  }
  /** Run tests in the Tests tab opens their results. */
  function showTests(): void {
    tab.value = 'Tests';
    mode.value = 'Pretty';
    render();
    document.querySelector<HTMLButtonElement>('[data-run-request-tests]')?.focus();
  }
  return {
    tab,
    mode,
    language,
    filter,
    htmlView,
    compare,
    snapshots,
    limits,
    recordSnapshot,
    snapshotLabel,
    comparePair,
    compareData,
    compareUnifiedText,
    hasHTTPS,
    certificateData,
    showTests,
    tabIcon,
    filteredBody,
    timelineData,
    inspectorSource,
  };
});

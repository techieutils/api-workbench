import { defineStore } from 'pinia';
import { automaticHeaders as clientHeaders } from '@techieutils/api-workbench-common/request-payload';
import { reactive, ref } from 'vue';
import { cookiesFor } from '@techieutils/api-workbench-common/cookies';
import type { ApiRequest, KeyValue } from '@techieutils/api-workbench-common/types';
import { useWorkspaceStore } from './workspace';
import { useCookiesStore } from './cookies';
import { useRequestBodyStore } from './request-body';

type AutomaticRow = { key: string; value: string; description: string };

/**
 * Params and Headers: the bulk text editor, the automatic headers sent with each request, and the
 * variables a request references that nothing provides.
 */
export const useRequestRowsStore = defineStore('requestRows', () => {
  const bulk = ref<BulkRowDraft | undefined>();
  const automaticHeaders = reactive({ expanded: false });

  function automaticRequestHeaders(
    request: ApiRequest = useWorkspaceStore().current(),
  ): Record<string, string> {
    const workspace = useWorkspaceStore();
    return clientHeaders({ ...workspace.state, settings: workspace.settings() }, request);
  }
  /** The headers the client adds, as rows listed beneath the request's own headers. */
  function automaticHeaderRows(request: ApiRequest): AutomaticRow[] {
    const resolve = useWorkspaceStore().resolve;
    const bodyType = useRequestBodyStore().bodyType(request);
    const custom = new Set(
      request.headers
        .filter((row) => row.enabled && row.key)
        .map((row) => resolve(row.key).trim().toLowerCase()),
    );
    const rows = Object.entries(automaticRequestHeaders(request))
      .filter(([key]) => !custom.has(key.toLowerCase()))
      .map(([key, value]) => ({
        key,
        value,
        description: 'Added automatically · add a custom header to override',
      }));
    let host = 'Derived from request URL';
    try {
      host = new URL(resolve(request.url)).host;
    } catch {
      /* Incomplete URL while editing. */
    }
    const cookies = useCookiesStore();
    const jarCookies = cookies.enabled() ? cookiesFor(cookies.jar(), resolve(request.url)) : [];
    if (jarCookies.length)
      rows.push({
        key: 'Cookie',
        value: jarCookies.map((cookie) => `${cookie.name}=…`).join('; '),
        description: `${jarCookies.length} from the cookie jar${custom.has('cookie') ? ' · merged with your Cookie header' : ''}`,
      });
    if (!custom.has('host'))
      rows.push({
        key: 'Host',
        value: host,
        description: 'Managed by the HTTP client for each destination',
      });
    if (!['GET', 'HEAD'].includes(request.method) && bodyType !== 'none') {
      if (!custom.has('content-type'))
        rows.push({
          key: 'Content-Type',
          value:
            bodyType === 'form-data'
              ? 'multipart/form-data; boundary=<generated>'
              : bodyType === 'x-www-form-urlencoded'
                ? 'application/x-www-form-urlencoded'
                : bodyType === 'binary'
                  ? 'File media type or application/octet-stream'
                  : request.rawContentType || 'application/json',
          description: 'Generated from the request body when sent',
        });
      if (!custom.has('content-length'))
        rows.push({
          key: 'Content-Length',
          value: 'Calculated when sent',
          description: 'Managed by the HTTP client from the encoded body',
        });
    }
    return rows;
  }
  function serializeBulkRows(rows: KeyValue[]): string {
    if (rows.some((row) => /[\r\n]/.test(row.key + row.value) || row.key.includes(':')))
      throw new Error('Rows with multiline values or colons in keys must be edited in the table.');
    return rows
      .filter((row) => row.key || row.value || row.description)
      .map((row) => `${row.enabled ? '' : '// '}${row.key}: ${row.value}`)
      .join('\n');
  }
  /** Parses `Key: Value` lines, keeping each key's description from the rows they replace. */
  function parseBulkRows(text: string, previous: KeyValue[]): KeyValue[] {
    const descriptions = new Map<string, KeyValue[]>();
    previous.forEach((row) =>
      descriptions.set(row.key, [...(descriptions.get(row.key) || []), row]),
    );
    return text.split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return [];
      const enabled = !line.trimStart().startsWith('//');
      const content = enabled ? line : line.trimStart().slice(2).trimStart();
      const separator = content.indexOf(':');
      if (separator < 1)
        throw new Error(`Line ${index + 1}: use Key: Value. Prefix disabled rows with //.`);
      const key = content.slice(0, separator).trim();
      if (!key) throw new Error(`Line ${index + 1}: enter a key.`);
      const value = content.slice(separator + 1).replace(/^ /, '');
      const original = descriptions.get(key)?.shift();
      return [{ key, value, enabled, description: original?.description }];
    });
  }
  /** Names referenced as {{name}} that neither the environment nor a dynamic variable provides. */
  function unresolvedVariables(request: ApiRequest): string[] {
    const rows = [...request.params, ...request.headers, ...(request.bodyFields || [])].filter(
      (row) => row.enabled,
    );
    const auth = request.auth === 'None' ? [] : [request.token, request.username, request.password];
    const sources = [
      request.url,
      ...rows.flatMap((row) => [row.key, row.value]),
      ...(useRequestBodyStore().bodyType(request) === 'raw' ? [request.body] : []),
      ...auth,
    ];
    const names = new Set<string>();
    for (const source of sources)
      for (const match of String(source || '').matchAll(/\{\{([^}]+)\}\}/g)) {
        const name = match[1].trim();
        if (useWorkspaceStore().resolve(`{{${name}}}`) === `{{${name}}}`) names.add(name);
      }
    return [...names];
  }
  return {
    bulk,
    automaticHeaders,
    automaticRequestHeaders,
    automaticHeaderRows,
    serializeBulkRows,
    parseBulkRows,
    unresolvedVariables,
  };
});

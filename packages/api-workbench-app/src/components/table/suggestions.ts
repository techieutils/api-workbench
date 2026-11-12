import { dynamicVariables } from '@techieutils/api-workbench-common/variables';
import { useWorkspaceStore } from '../../stores/workspace';
import { MOCK_TEMPLATE_HELPERS } from '@techieutils/api-workbench-common/mock-templates';

/** Suggestions supplement ordinary text inputs; custom names and values remain editable. */
export interface FieldSuggestion {
  value: string;
  detail: string;
  /** Shown instead of the value, when the value is longer than what is being completed. */
  label?: string;
  /** A heading the suggestion is listed under, such as Headers or Transforms. */
  group?: string;
  /** An icon for what it is; with icons, each suggestion fits on one row. */
  icon?: MdiIconName;
  /** A short tag beside it, such as a body's format. */
  badge?: string;
}

const HEADER_NAMES = [
  'Accept',
  'Accept-Charset',
  'Accept-Encoding',
  'Accept-Language',
  'Accept-Patch',
  'Accept-Ranges',
  'Access-Control-Request-Headers',
  'Access-Control-Request-Method',
  'Authorization',
  'Cache-Control',
  'Connection',
  'Content-Disposition',
  'Content-Encoding',
  'Content-Language',
  'Content-Length',
  'Content-MD5',
  'Content-Range',
  'Content-Type',
  'Cookie',
  'Date',
  'DNT',
  'Expect',
  'Forwarded',
  'From',
  'Host',
  'If-Match',
  'If-Modified-Since',
  'If-None-Match',
  'If-Range',
  'If-Unmodified-Since',
  'Idempotency-Key',
  'Max-Forwards',
  'Origin',
  'Pragma',
  'Prefer',
  'Proxy-Authorization',
  'Range',
  'Referer',
  'TE',
  'Traceparent',
  'Tracestate',
  'Trailer',
  'Transfer-Encoding',
  'Upgrade',
  'User-Agent',
  'Via',
  'Warning',
  'X-API-Key',
  'X-Auth-Token',
  'X-Correlation-ID',
  'X-CSRF-Token',
  'X-Forwarded-For',
  'X-Forwarded-Host',
  'X-Forwarded-Proto',
  'X-HTTP-Method-Override',
  'X-Request-ID',
  'X-Requested-With',
  'X-Tenant-ID',
  'X-XSRF-Token',
];
const HEADER_VALUES: Record<string, string[]> = {
  accept: [
    'application/json',
    'application/xml',
    'text/plain',
    'text/html',
    'text/event-stream',
    'application/pdf',
    '*/*',
  ],
  'content-type': [
    'application/json',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'text/plain',
    'application/xml',
    'text/xml',
    'text/html',
    'application/javascript',
    'application/octet-stream',
    'application/graphql',
    'text/csv',
    'application/yaml',
    'application/x-ndjson',
    'application/vnd.api+json',
  ],
  authorization: ['Bearer {{access_token}}', 'Basic {{credentials}}'],
  'accept-encoding': ['gzip, deflate, br', 'gzip', 'identity'],
  'accept-language': ['en-US,en;q=0.9', 'en-US', 'en-GB', 'fr-FR', 'de-DE', 'es-ES'],
  'cache-control': ['no-cache', 'no-store', 'max-age=0', 'max-age=3600', 'must-revalidate'],
  connection: ['keep-alive', 'close'],
  'content-encoding': ['gzip', 'deflate', 'br', 'identity'],
  'x-requested-with': ['XMLHttpRequest'],
  'access-control-request-method': ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  expect: ['100-continue'],
  pragma: ['no-cache'],
  prefer: ['return=representation', 'return=minimal', 'respond-async'],
  range: ['bytes=0-1023', 'bytes=0-'],
  'content-disposition': ['attachment', 'inline'],
  'x-forwarded-proto': ['https', 'http'],
};
/** Headers a server sends, for mock routes; each with what it does. */
const RESPONSE_HEADERS: Record<string, { description: string; values: string[] }> = {
  'Content-Type': {
    description: 'Media type of the body',
    values: [
      'application/json',
      'application/problem+json',
      'text/plain',
      'text/html',
      'application/xml',
      'text/csv',
      'application/yaml',
      'application/x-ndjson',
      'text/event-stream',
      'application/octet-stream',
    ],
  },
  'Set-Cookie': {
    description: 'Stores a cookie in the client',
    values: [
      'session=abc123; Path=/; HttpOnly; SameSite=Lax',
      'session=abc123; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600',
      'session=; Path=/; Max-Age=0',
    ],
  },
  'Cache-Control': {
    description: 'How the response may be cached',
    values: [
      'no-store',
      'no-cache',
      'private, max-age=0',
      'public, max-age=3600',
      'max-age=86400, immutable',
    ],
  },
  Location: {
    description: 'Where a redirect or created resource is',
    values: ['/items/1', 'https://example.com/'],
  },
  ETag: { description: 'Version of the resource', values: ['"v1"', 'W/"v1"'] },
  'Last-Modified': {
    description: 'When the resource last changed',
    values: ['Wed, 21 Oct 2026 07:28:00 GMT'],
  },
  Expires: {
    description: 'When the response goes stale',
    values: ['Thu, 01 Jan 1970 00:00:00 GMT'],
  },
  'Retry-After': { description: 'When to try again (429, 503)', values: ['30', '120'] },
  'WWW-Authenticate': {
    description: 'How to authenticate (401)',
    values: ['Bearer realm="api"', 'Bearer error="invalid_token"', 'Basic realm="api"'],
  },
  Allow: {
    description: 'Methods the resource supports (405)',
    values: ['GET, POST', 'GET, PUT, PATCH, DELETE'],
  },
  'Content-Disposition': {
    description: 'Show inline or download',
    values: ['inline', 'attachment', 'attachment; filename="report.csv"'],
  },
  'Content-Encoding': { description: 'Compression of the body', values: ['gzip', 'br', 'deflate'] },
  'Content-Language': {
    description: 'Language of the body',
    values: ['en-US', 'en-GB', 'fr-FR', 'de-DE'],
  },
  'Content-Range': {
    description: 'Part of the resource sent (206)',
    values: ['bytes 0-1023/4096'],
  },
  'Accept-Ranges': { description: 'Whether ranges are supported', values: ['bytes', 'none'] },
  Vary: {
    description: 'Request headers the response depends on',
    values: ['Accept', 'Origin', 'Accept-Encoding'],
  },
  'Access-Control-Allow-Origin': {
    description: 'Origins allowed to read it',
    values: ['*', 'http://localhost:3000'],
  },
  'Access-Control-Allow-Methods': {
    description: 'Methods allowed cross-origin',
    values: ['GET, POST, PUT, PATCH, DELETE, OPTIONS'],
  },
  'Access-Control-Allow-Headers': {
    description: 'Request headers allowed cross-origin',
    values: ['*', 'Content-Type, Authorization'],
  },
  'Access-Control-Allow-Credentials': {
    description: 'Whether cookies are allowed cross-origin',
    values: ['true'],
  },
  'Access-Control-Expose-Headers': {
    description: 'Headers scripts may read',
    values: ['*', 'Location, ETag'],
  },
  'Access-Control-Max-Age': {
    description: 'How long a preflight is cached',
    values: ['600', '86400'],
  },
  Link: {
    description: 'Related resources, such as pages',
    values: ['</items?page=2>; rel="next"', '</items?page=1>; rel="prev"'],
  },
  'X-Total-Count': { description: 'Total results across pages', values: ['0', '100'] },
  'X-RateLimit-Limit': { description: 'Requests allowed per window', values: ['100', '1000'] },
  'X-RateLimit-Remaining': { description: 'Requests left in this window', values: ['0', '99'] },
  'X-RateLimit-Reset': { description: 'When the window resets', values: ['60', '1767225600'] },
  'X-Request-ID': { description: 'Identifies this response for tracing', values: ['req-123'] },
  'Strict-Transport-Security': {
    description: 'Use HTTPS only',
    values: ['max-age=31536000; includeSubDomains'],
  },
  'Content-Security-Policy': {
    description: 'What a page may load',
    values: ["default-src 'self'"],
  },
  'X-Content-Type-Options': { description: 'Do not guess the media type', values: ['nosniff'] },
  'Referrer-Policy': {
    description: 'What referrer to send',
    values: ['no-referrer', 'strict-origin-when-cross-origin'],
  },
  Deprecation: { description: 'The endpoint is deprecated', values: ['true', '@1767225600'] },
  Sunset: {
    description: 'When the endpoint is removed',
    values: ['Wed, 31 Dec 2026 23:59:59 GMT'],
  },
};
const PARAM_SUGGESTIONS: Record<string, { description: string; values: string[] }> = {
  page: { description: 'Page number', values: ['1', '2', '3'] },
  limit: { description: 'Maximum results', values: ['10', '20', '50', '100'] },
  offset: { description: 'Results to skip', values: ['0', '10', '20', '50'] },
  per_page: { description: 'Results per page', values: ['10', '25', '50', '100'] },
  page_size: { description: 'Results per page', values: ['10', '25', '50', '100'] },
  sort: { description: 'Sort field', values: ['created_at', 'updated_at', 'name', 'id'] },
  order: { description: 'Sort direction', values: ['asc', 'desc'] },
  sort_order: { description: 'Sort direction', values: ['asc', 'desc'] },
  q: { description: 'Search query', values: [] },
  search: { description: 'Search text', values: [] },
  filter: { description: 'Filter expression', values: [] },
  fields: { description: 'Fields to return', values: ['id,name', 'id,name,created_at'] },
  include: { description: 'Related resources', values: [] },
  expand: { description: 'Expanded resources', values: [] },
  format: { description: 'Response format', values: ['json', 'xml', 'csv'] },
  active: { description: 'Active records', values: ['true', 'false'] },
  enabled: { description: 'Enabled records', values: ['true', 'false'] },
  status: { description: 'Record status', values: ['active', 'inactive', 'pending', 'completed'] },
  locale: { description: 'Response locale', values: ['en-US', 'en-GB', 'fr-FR', 'de-DE'] },
  start_date: { description: 'Start date (ISO 8601)', values: [] },
  end_date: { description: 'End date (ISO 8601)', values: [] },
  cursor: { description: 'Pagination cursor', values: [] },
  api_key: { description: 'API key (prefer saved credentials)', values: [] },
};

/**
 * Names or values offered for a params, headers, or response headers cell, most specific first,
 * without duplicates. Response headers (a mock's) offer mock templates instead of variables.
 */
export function fieldSuggestions(
  type: 'headers' | 'params' | 'response-headers',
  field: 'key' | 'value',
  rows: KeyValue[],
  row: KeyValue | undefined,
): FieldSuggestion[] {
  const key = (row?.key || '').trim().toLowerCase();
  const options: FieldSuggestion[] = [];
  if (type === 'response-headers') {
    if (field === 'key') {
      for (const [value, data] of Object.entries(RESPONSE_HEADERS))
        options.push({ value, detail: data.description });
      rows
        .filter((item) => item.key)
        .forEach((item) =>
          options.push({ value: item.key, detail: item.description || 'On this route' }),
        );
    } else {
      const known = Object.entries(RESPONSE_HEADERS).find(([name]) => name.toLowerCase() === key);
      known?.[1].values.forEach((value) =>
        options.push({ value, detail: `Suggested ${known[0]} value` }),
      );
      // Values are templates too: request values and fake data (not the body's repeat blocks).
      MOCK_TEMPLATE_HELPERS.filter((helper) => helper.group !== 'Blocks').forEach((helper) =>
        options.push({ value: helper.template, detail: helper.description }),
      );
    }
    return [...new Map(options.map((option) => [option.value.toLowerCase(), option])).values()];
  }
  if (field === 'key') {
    if (type === 'headers')
      HEADER_NAMES.forEach((value) => options.push({ value, detail: 'HTTP request header' }));
    else
      Object.entries(PARAM_SUGGESTIONS).forEach(([value, data]) =>
        options.push({ value, detail: data.description }),
      );
    rows
      .filter((item) => item.key)
      .forEach((item) =>
        options.push({ value: item.key, detail: item.description || 'In this request' }),
      );
  } else {
    const values =
      type === 'headers' ? HEADER_VALUES[key] || [] : PARAM_SUGGESTIONS[key]?.values || [];
    values.forEach((value) =>
      options.push({
        value,
        detail: value.includes('{{')
          ? 'Environment variable reference'
          : type === 'headers'
            ? `Suggested ${row?.key || 'header'} value`
            : PARAM_SUGGESTIONS[key]?.description || 'Suggested value',
      }),
    );
    useWorkspaceStore()
      .activeVariables()
      .forEach((variable) =>
        options.push({
          value: `{{${variable.key}}}`,
          detail: 'Environment variable · value stays private',
        }),
      );
    dynamicVariables.forEach((variable) =>
      options.push({
        value: `{{${variable.name}}}`,
        detail: `Dynamic · ${variable.description}`,
      }),
    );
  }
  return [...new Map(options.map((option) => [option.value.toLowerCase(), option])).values()];
}

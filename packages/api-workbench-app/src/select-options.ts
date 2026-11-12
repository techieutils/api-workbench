import type { SelectOption } from './components/ui/UiSelect.vue';

type OptionInput = SelectOption | [string, string] | string;
type IconMap = Partial<Record<string, MdiIconName>>;

/**
 * Select options with an icon each, for the app's select boxes: one icon for every option, an
 * icon per value (with `fallback` for the rest), or a function of the option. Options that already
 * have an icon keep it.
 */
export function withIcons(
  options: readonly OptionInput[],
  icon: MdiIconName | IconMap | ((option: SelectOption) => MdiIconName),
  fallback?: MdiIconName,
): SelectOption[] {
  return options.map((option) => {
    const item: SelectOption =
      typeof option === 'string'
        ? { value: option, label: option }
        : Array.isArray(option)
          ? { value: option[0], label: option[1] }
          : option;
    if (item.icon) return item;
    const chosen =
      typeof icon === 'function'
        ? icon(item)
        : typeof icon === 'string'
          ? icon
          : (icon[item.value] ?? fallback);
    return chosen ? { ...item, icon: chosen } : item;
  });
}

/** Icons by option value for the app's fixed lists. */
export const OPTION_ICONS = {
  accept: {
    'application/json': 'code-json',
    '*/*': 'asterisk',
    'application/xml': 'xml',
    'text/plain': 'text',
  },
  theme: { dark: 'weather-night', light: 'white-balance-sunny', system: 'monitor' },
  density: { comfortable: 'view-agenda-outline', compact: 'view-headline' },
  autoSave: { change: 'lightning-bolt-outline', delay: 'timer-outline', off: 'keyboard-outline' },
  /** Where a new workspace is saved. */
  workspaceLocation: {
    default: 'folder-outline',
    'app-data': 'database-outline',
    choose: 'folder-search-outline',
  },
  method: {
    GET: 'download-outline',
    POST: 'plus-box-outline',
    PUT: 'file-replace-outline',
    PATCH: 'file-edit-outline',
    DELETE: 'delete-outline',
    HEAD: 'eye-outline',
    OPTIONS: 'tune-variant',
    TRACE: 'map-marker-path',
    CONNECT: 'tunnel-outline',
  },
  /** HTTP settings with choices: proxy mode, HTTP version, and IP family. */
  httpSetting: {
    direct: 'lan-connect',
    custom: 'server-network',
    // The body integrity header's own choice; the proxy's is `custom`.
    'custom-header': 'pound-box-outline',
    '1.1': 'numeric-1-box-outline',
    '2': 'numeric-2-box-outline',
    auto: 'auto-fix',
    ipv4: 'ip-network-outline',
    ipv6: 'ip-network-outline',
  },
  codeTarget: {
    ansible: 'ansible',
    c: 'language-c',
    cpp: 'language-cpp',
    csharp: 'language-csharp',
    go: 'language-go',
    http: 'web',
    java: 'language-java',
    javascript: 'language-javascript',
    kotlin: 'language-kotlin',
    node: 'nodejs',
    objc: 'apple',
    php: 'language-php',
    powershell: 'powershell',
    python: 'language-python',
    r: 'language-r',
    ruby: 'language-ruby',
    rust: 'language-rust',
    shell: 'console',
    swift: 'language-swift',
    terraform: 'terraform',
    typescript: 'language-typescript',
    cmd: 'microsoft-windows',
  },
  runnerMode: {
    collection: 'play-box-multiple-outline',
    benchmark: 'speedometer',
    performance: 'chart-line',
  },
  loadModel: { workers: 'account-multiple-outline', rate: 'timer-outline' },
  runResult: {
    all: 'filter-variant',
    passed: 'check-circle-outline',
    failed: 'alert-circle-outline',
    cancelled: 'cancel',
  },
  credentialKind: {
    bearer: 'key-outline',
    basic: 'account-key-outline',
    'api-key': 'key-variant',
    digest: 'pound-box-outline',
    jwt: 'code-braces-box',
    aws: 'aws',
    oauth1: 'shield-key-outline',
    ntlm: 'microsoft-windows',
    wsse: 'account-lock-outline',
    edgegrid: 'cloud-lock-outline',
    hawk: 'bird',
    oauth2: 'shield-account-outline',
    'client-certificate': 'certificate-outline',
  },
  secretSource: {
    all: 'filter-variant',
    local: 'lock-outline',
    'aws-secrets-manager': 'aws',
    'aws-ssm': 'aws',
    'azure-key-vault': 'microsoft-azure',
    'gcp-secret-manager': 'google-cloud',
    'hashicorp-vault': 'safe-square-outline',
    'sap-btp': 'cloud-lock-outline',
  },
  /** Choices inside auth and credential forms: key location, grants, and client authentication. */
  authChoice: {
    header: 'format-header-pound',
    query: 'link-variant',
    pem: 'file-certificate-outline',
    pfx: 'package-variant-closed',
    authorization_code: 'account-arrow-right-outline',
    client_credentials: 'server-security',
    password: 'form-textbox-password',
    refresh_token: 'refresh',
    none: 'lock-open-outline',
    basic: 'account-key-outline',
    body: 'form-textbox-password',
  },
  authType: {
    None: 'cancel',
    'Inherit from collection': 'folder-arrow-down-outline',
    'Bearer token': 'key-outline',
    'API key': 'key-variant',
    'JWT bearer': 'code-braces-box',
    'OAuth 2.0 (request)': 'shield-account-outline',
    'Basic auth': 'account-key-outline',
    'Digest auth': 'pound-box-outline',
    'AWS Signature': 'aws',
    'OAuth 1.0': 'shield-key-outline',
    NTLM: 'microsoft-windows',
    WSSE: 'account-lock-outline',
    'Akamai EdgeGrid': 'cloud-lock-outline',
    Hawk: 'bird',
    'Saved credential': 'safe-square-outline',
  },
  rowType: { text: 'format-text', file: 'file-outline' },
  exportFormat: {
    workbench: 'briefcase-outline',
    'openapi-json': 'api',
    'openapi-yaml': 'api',
    swagger: 'api',
    curl: 'console',
    http: 'web',
    har: 'archive-outline',
    wsdl: 'xml',
  },
  contentType: {
    'application/json': 'code-json',
    'text/plain': 'text',
    'application/xml': 'xml',
    'text/html': 'language-html5',
    'application/javascript': 'language-javascript',
    'application/typescript': 'language-typescript',
    'text/css': 'language-css3',
    'text/markdown': 'language-markdown-outline',
    'application/sql': 'database-outline',
    'application/graphql': 'graphql',
    'text/csv': 'file-table-outline',
    'application/yaml': 'format-list-bulleted-square',
    'application/vnd.api+json': 'code-json',
    'application/x-ndjson': 'format-list-text',
    custom: 'pencil-outline',
  },
  ruleKind: {
    status: 'numeric',
    'response-time': 'timer-outline',
    'response-size': 'weight',
    header: 'format-header-pound',
    'content-type': 'file-document-outline',
    body: 'text-long',
    'json-valid': 'code-json',
    'json-field': 'code-json',
    json: 'code-json',
    'json-type': 'shape-outline',
    'json-length': 'ruler',
    'body-length': 'ruler',
    'json-schema': 'file-check-outline',
    cookie: 'cookie-outline',
    timing: 'timer-outline',
    'certificate-days-left': 'certificate-outline',
    custom: 'pencil-outline',
  },
  operator: {
    equals: 'equal',
    'not-equals': 'not-equal-variant',
    contains: 'text-search',
    'not-contains': 'text-box-remove-outline',
    exists: 'check',
    'not-exists': 'close',
    empty: 'circle-outline',
    'not-empty': 'circle-slice-8',
    'starts-with': 'format-align-left',
    'not-starts-with': 'format-align-left',
    'ends-with': 'format-align-right',
    'not-ends-with': 'format-align-right',
    'contains-all': 'format-list-checks',
    'contains-any': 'format-list-bulleted',
    'is-uuid': 'identifier',
    'is-email': 'identifier',
    'is-url': 'web',
    'is-date': 'calendar-outline',
    'is-number': 'numeric',
    'is-integer': 'numeric',
    'is-empty': 'circle-outline',
    'is-not-empty': 'circle-slice-8',
    'is-unique': 'format-list-checks',
    'is-sorted': 'format-list-bulleted',
    'is-sorted-desc': 'format-list-bulleted',
    'equals-ignore-case': 'format-letter-case',
    'contains-ignore-case': 'format-letter-case-lower',
    matches: 'regex',
    'not-matches': 'regex',
    between: 'arrow-expand-horizontal',
    in: 'format-list-checks',
    'not-in': 'playlist-remove',
    '<': 'less-than',
    '<=': 'less-than-or-equal',
    '>': 'greater-than',
    '>=': 'greater-than-or-equal',
  },
  jsonType: {
    string: 'format-quote-close',
    number: 'numeric',
    integer: 'numeric',
    boolean: 'toggle-switch-outline',
    null: 'null',
    object: 'code-braces',
    array: 'code-brackets',
  },
  boolean: { true: 'check', false: 'close' },
  exampleGroup: {
    All: 'filter-variant',
    Body: 'text-long',
    Cookies: 'cookie-outline',
    Headers: 'format-header-pound',
    JSON: 'code-json',
    Performance: 'speedometer',
    Security: 'shield-lock-outline',
    Status: 'numeric',
  },
} satisfies Record<string, IconMap>;

/** Options with a colour class by value, such as success and error tones for results. */
export function withTones(options: SelectOption[], tones: Record<string, string>): SelectOption[] {
  return options.map((option) =>
    tones[option.value] ? { ...option, class: tones[option.value] } : option,
  );
}

/** MQTT quality-of-service levels, for publishing and for each subscription. */
export const MQTT_QOS_OPTIONS: SelectOption[] = [
  { value: '0', label: 'QoS 0', description: 'At most once' },
  { value: '1', label: 'QoS 1', description: 'At least once' },
  { value: '2', label: 'QoS 2', description: 'Exactly once' },
];
export const MQTT_QOS_ICONS: IconMap = {
  '0': 'send-outline',
  '1': 'check',
  '2': 'check-circle-outline',
};
export const MQTT_VERSION_OPTIONS: SelectOption[] = [
  { value: '4', label: 'MQTT 3.1.1' },
  { value: '5', label: 'MQTT 5' },
];

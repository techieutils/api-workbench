/**
 * Global types shared by the stores and components, and the runtimes the app loads before its
 * Vue bundle: MDI icon paths, CodeMirror (src/editor/runtime.ts), and collection import/export,
 * whose Bruno parser does not bundle under Vite. scripts/copy-assets.ts builds them.
 */
type MdiIconName =
  (typeof import('@techieutils/api-workbench-common/icon-names').MDI_ICON_NAMES)[number];
/** SVG paths for the bundled MDI icons, from mdi-paths.js. */
declare const mdiPaths: Readonly<Record<MdiIconName, string>>;
/** Status, button, and tab shapes shared by the Vue UI primitives in src/components/ui. */
type UITone = 'neutral' | 'success' | 'warning' | 'danger' | 'brand';
type UIButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
interface UITab {
  name: string;
  count?: number | string;
  icon?: MdiIconName;
}
type SettingsSection =
  | 'General'
  | 'Saving'
  | 'Requests'
  | 'Appearance'
  | 'Privacy'
  | 'Certificates'
  | 'Data'
  | 'Updates'
  | 'Shortcuts'
  | 'Help';
type WorkspaceIndex = import('@techieutils/api-workbench-common/types').WorkspaceIndex;
declare const WorkbenchTransfer: typeof import('@techieutils/api-workbench-common/collection-transfer');
type TransferImportResult =
  import('@techieutils/api-workbench-common/collection-transfer').ImportResult;
type TransferExportResult =
  import('@techieutils/api-workbench-common/collection-formats/exporters').ExportResult;
type HTTPSettings = import('@techieutils/api-workbench-common/http-settings').HTTPSettings;
/** Unsaved edits in the HTTP settings form (src/components/editor/HTTPSettingsForm.vue). */
interface HTTPSettingsDraft {
  overrides: string[];
  values: Record<string, string | boolean>;
}
type AuthConfig = import('@techieutils/api-workbench-common/types').AuthConfig;
type AuthOptions = import('@techieutils/api-workbench-common/types').AuthOptions;
type SigningAuth = import('@techieutils/api-workbench-common/auth-signing').SigningAuth;
type RequestProtocol = import('@techieutils/api-workbench-common/types').RequestProtocol;
type ProtocolEvent = import('@techieutils/api-workbench-common/types').ProtocolEvent;
interface LiveProtocolState {
  id: string;
  phase: 'connecting' | 'open' | 'closed';
  events: ProtocolEvent[];
  methods: import('@techieutils/api-workbench-common/types').GRPCMethod[];
  finished: boolean;
  writable: boolean;
  destination?: string;
  grpcMethod?: string;
}
interface ProtocolUIState {
  tab: string;
  inspector: 'Body' | 'Headers' | 'Timeline';
  language: string;
  mode: 'Pretty' | 'Raw';
  binary: boolean;
}
type ApiRequest = import('@techieutils/api-workbench-common/types').ApiRequest;
type WorkspaceState = import('@techieutils/api-workbench-common/types').WorkspaceState;
type KeyValue = import('@techieutils/api-workbench-common/types').KeyValue;
type HttpResponse = import('@techieutils/api-workbench-common/types').HttpResponse;
type RequestResponse = import('@techieutils/api-workbench-common/types').RequestResponse;
type RequestPayload = import('@techieutils/api-workbench-common/types').RequestPayload;
type AuthType = import('@techieutils/api-workbench-common/types').AuthType;
type AppSettings = import('@techieutils/api-workbench-common/types').AppSettings;
type CredentialSummary = import('@techieutils/api-workbench-common/types').CredentialSummary;
type CredentialInput = import('@techieutils/api-workbench-common/types').CredentialInput;
type OAuthConfig = import('@techieutils/api-workbench-common/types').OAuthConfig;
declare const WorkbenchEditor: typeof import('./editor/runtime');
type TestRule = import('@techieutils/api-workbench-common/test-cases').TestRule;
type BodyType = import('@techieutils/api-workbench-common/types').BodyType;
type BodyField = import('@techieutils/api-workbench-common/types').BodyField;
type CodegenTarget = import('@techieutils/api-workbench-common/types').CodegenTarget;
type CodegenResult = import('@techieutils/api-workbench-common/types').CodegenResult;
interface BulkRowDraft {
  requestId: string;
  type: 'params' | 'headers';
  text: string;
  error: string;
}
/** The code generator (src/components/tools/CodeGenerator.vue). */
interface CodeDialogState {
  targets: CodegenTarget[];
  target: string;
  client: string;
  redact: boolean;
  result?: CodegenResult;
  error: string;
  loading: boolean;
  requestName: string;
  docked?: boolean;
  /** The protocol the targets were loaded for; reloaded when the request's protocol changes. */
  protocol?: string;
}
type StoredCookie = import('@techieutils/api-workbench-common/cookies').StoredCookie;
type ClientCertificate =
  import('@techieutils/api-workbench-common/client-certificates').ClientCertificate;
type CaptureResult = import('@techieutils/api-workbench-common/variables').CaptureResult;
interface ResponseSnapshot {
  id: string;
  sequence: number;
  at: number;
  response: import('@techieutils/api-workbench-common/types').HttpResponse;
}
interface RequestConsoleEntry {
  id: string;
  requestId: string;
  requestName: string;
  at: number;
  level: 'info' | 'success' | 'error';
  method: string;
  url: string;
  message: string;
}
/** A sent HTTP request in the dev tools network log (stores/tools.ts); no bodies are kept. */
interface NetworkEntry {
  id: string;
  requestId: string;
  requestName: string;
  at: number;
  method: string;
  /** The resolved URL with credentials and query values redacted. */
  url: string;
  status?: number;
  statusText?: string;
  error?: string;
  time: number;
  size?: number;
  contentType?: string;
  httpVersion?: string;
  timings?: import('@techieutils/api-workbench-common/types').NetworkTiming;
  /** Response headers, with likely secrets such as cookies redacted. */
  headers: [string, string][];
}
/** A workspace search result (stores/dialogs.ts). */
interface WorkspaceSearchResult {
  kind: string;
  name: string;
  detail: string;
  icon: MdiIconName;
  requestId?: string;
  environmentIndex?: number;
  page?: string;
  /** A request's tags (with its collection's and folders'), or the tags inside a collection. */
  tags?: string[];
}

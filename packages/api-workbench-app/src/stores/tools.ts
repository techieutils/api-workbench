import { defineStore } from 'pinia';
import { nextTick, reactive, ref } from 'vue';
import type {
  ApiRequest,
  CodegenInput,
  RequestProtocol,
  RequestResponse,
} from '@techieutils/api-workbench-common/types';
import { render } from '../shell';
import { errorMessage, toast, uid } from '../utils';
import { useRequestsStore } from './requests';
import { requestProtocol, useProtocolsStore } from './protocols';
import { useRequestBodyStore } from './request-body';
import { useUiStore } from './ui';
import { useWorkspaceStore } from './workspace';
import { useVaultStore } from './vault';

const MAX_CONSOLE_ENTRIES = 300;
const MAX_NETWORK_ENTRIES = 300;
/** Header, query, field, and JSON keys whose values are redacted from generated code. */
const SENSITIVE = /authorization|cookie|token|secret|password|api[-_]?key|credential/i;

/** The dev tools console and network logs, and the code generator's state. */
export const useToolsStore = defineStore('tools', () => {
  const workspace = useWorkspaceStore();
  /** Metadata-only request events for this session, newest last. */
  const consoleEntries = reactive<RequestConsoleEntry[]>([]);
  const consoleOptions = reactive({ scope: 'current', level: 'all', search: '' });
  /** Sent HTTP requests for this session, newest last. */
  const networkEntries = reactive<NetworkEntry[]>([]);
  /** The open code generator, docked beside the request or as a dialog. */
  const codeDialog = ref<CodeDialogState | undefined>();

  /** The request URL with credentials, fragment, and query values removed. */
  function consoleSafeURL(url: string): string {
    try {
      const parsed = new URL(workspace.resolve(url));
      parsed.username = '';
      parsed.password = '';
      parsed.hash = '';
      const keys = [...parsed.searchParams.keys()];
      parsed.search = '';
      keys.forEach((key) => parsed.searchParams.append(key, '<redacted>'));
      return parsed.toString();
    } catch {
      return '[Invalid request URL]';
    }
  }
  function addConsoleEntry(
    request: ApiRequest,
    level: RequestConsoleEntry['level'],
    message: string,
  ): void {
    // Metadata only. Request/response bodies, header values, and file contents are excluded.
    consoleEntries.push({
      id: uid(),
      requestId: request.id,
      requestName: request.name,
      at: Date.now(),
      level,
      method: request.method,
      url: consoleSafeURL(request.url),
      message,
    });
    if (consoleEntries.length > MAX_CONSOLE_ENTRIES)
      consoleEntries.splice(0, consoleEntries.length - MAX_CONSOLE_ENTRIES);
  }
  /** Records a sent request and its outcome in the network log; bodies are never kept. */
  function addNetworkEntry(request: ApiRequest, result: RequestResponse, started: number): void {
    const headers = Object.entries(result.headers ?? {}).map(([key, value]): [string, string] => [
      key,
      SENSITIVE.test(key) ? '<redacted>' : value,
    ]);
    networkEntries.push({
      id: uid(),
      requestId: request.id,
      requestName: request.name,
      at: started,
      method: request.method,
      url: consoleSafeURL(request.url),
      status: result.status,
      statusText: result.statusText,
      error: result.error === undefined ? undefined : consoleSafeError(result.error, request),
      time: result.time ?? result.timings?.totalMs ?? Date.now() - started,
      size: result.size,
      contentType: Object.entries(result.headers ?? {})
        .find(([key]) => key.toLowerCase() === 'content-type')?.[1]
        ?.split(';')[0],
      httpVersion: result.httpVersion,
      // Each redirect hop carries its own URL, redacted like the request's.
      timings: result.timings && {
        ...result.timings,
        requests: result.timings.requests.map((hop) => ({ ...hop, url: consoleSafeURL(hop.url) })),
      },
      headers,
    });
    if (networkEntries.length > MAX_NETWORK_ENTRIES)
      networkEntries.splice(0, networkEntries.length - MAX_NETWORK_ENTRIES);
  }
  /** An error message with the request URL and likely secrets redacted. */
  function consoleSafeError(message: string, request: ApiRequest): string {
    message = message.split(workspace.resolve(request.url)).join(consoleSafeURL(request.url));
    const secretValues = [
      request.token,
      request.password,
      ...request.headers
        .filter((header) => /authorization|cookie|token|secret|api[-_]?key/i.test(header.key))
        .map((header) => workspace.resolve(header.value)),
      ...workspace.state.environments.flatMap((environment) =>
        environment.variables
          .filter((variable) => /secret|token|password|api[-_]?key/i.test(variable.key))
          .map((variable) => variable.value),
      ),
    ];
    for (const value of secretValues)
      if (value && value.length >= 3) message = message.split(value).join('<redacted>');
    return message.slice(0, 500);
  }

  // Code generator
  /** Bumped per generation, so a slower earlier result never replaces a later one. */
  let generation = 0;
  let returnFocus: HTMLElement | null = null;
  let dockedTimer: ReturnType<typeof setTimeout> | undefined;
  /** The redacted form of a header value. */
  const redactedHeader = (key: string, value: string) =>
    key.toLowerCase().includes('authorization')
      ? `${value.match(/^(Basic|Bearer)\s/i)?.[1] || 'Bearer'} <REDACTED>`
      : '<REDACTED>';
  /** A live connection as code generation input: URL, headers (or gRPC metadata), and message. */
  function liveCodegenInput(request: ApiRequest, redact: boolean): CodegenInput {
    const protocol = requestProtocol(request) as Exclude<RequestProtocol, 'http'>;
    let headers: Record<string, string>;
    let query: [string, string][] = [];
    try {
      ({ headers, query } = useProtocolsStore().liveProtocolAuth(request));
    } catch {
      headers = Object.fromEntries(
        request.headers
          .filter((row) => row.enabled && row.key)
          .map((row) => [workspace.resolve(row.key), workspace.resolve(row.value)]),
      );
    }
    // Saved credentials are never read; signed and vault auth appear as placeholders.
    if (request.auth === 'Saved credential') headers.authorization = 'Bearer <ACCESS_TOKEN>';
    let url = workspace.resolve(request.url);
    if (query.length && protocol !== 'grpc') {
      try {
        const target = new URL(url);
        for (const [key, value] of query) target.searchParams.set(key, value);
        url = target.toString();
      } catch {
        /* An incomplete URL is shown as typed. */
      }
    }
    if (redact) {
      for (const key of Object.keys(headers))
        if (SENSITIVE.test(key)) headers[key] = redactedHeader(key, headers[key]);
      try {
        const target = new URL(url);
        for (const [key] of target.searchParams)
          if (SENSITIVE.test(key)) target.searchParams.set(key, '<REDACTED>');
        url = target.toString();
      } catch {
        /* gRPC host:port and incomplete URLs have no query to redact. */
      }
    }
    return {
      protocol,
      url,
      method: 'GET',
      headers,
      body: workspace.resolve(request.body),
      bodyType: 'raw',
      fields: [],
      binary: protocol === 'websocket' && useProtocolsStore().protocolUIState(request).binary,
      ...(protocol === 'grpc' && request.grpc ? { grpc: { ...request.grpc } } : {}),
      ...(protocol === 'socketio' && request.socketio
        ? { socketio: { ...request.socketio, event: workspace.resolve(request.socketio.event) } }
        : {}),
      ...(protocol === 'mqtt' && request.mqtt
        ? {
            mqtt: {
              ...request.mqtt,
              topic: workspace.resolve(request.mqtt.topic),
              subscriptions: request.mqtt.subscriptions.map((row) => ({
                ...row,
                topic: workspace.resolve(row.topic),
              })),
            },
          }
        : {}),
    };
  }
  /** The active request as code generation input, with secrets optionally redacted. */
  function codegenInput(redact: boolean): CodegenInput {
    const request = workspace.current();
    if (requestProtocol(request) !== 'http') return liveCodegenInput(request, redact);
    const resolve = workspace.resolve;
    const prepared = useRequestsStore().prepare({ ...request, bodyType: 'none' });
    const mode = useRequestBodyStore().bodyType(request);
    if (request.auth === 'Saved credential') {
      const credential = useVaultStore().credentials.find(
        (item) => item.id === request.credentialId,
      );
      if (credential?.kind === 'api-key')
        prepared.headers[credential.headerName || 'X-API-Key'] = '<API_KEY>';
      else
        prepared.headers.Authorization =
          credential?.kind === 'basic'
            ? 'Basic <BASE64_USERNAME_PASSWORD>'
            : credential
              ? 'Bearer <ACCESS_TOKEN>'
              : '<SAVED_CREDENTIAL>';
    }
    if (
      mode === 'raw' &&
      !Object.keys(prepared.headers).some((key) => key.toLowerCase() === 'content-type')
    )
      prepared.headers['Content-Type'] = request.rawContentType || 'application/json';
    let body = resolve(request.body);
    if (redact) {
      for (const key of Object.keys(prepared.headers))
        if (SENSITIVE.test(key)) prepared.headers[key] = redactedHeader(key, prepared.headers[key]);
      const url = new URL(prepared.url);
      const params = [...url.searchParams];
      url.search = '';
      params.forEach(([key, value]) =>
        url.searchParams.append(key, SENSITIVE.test(key) ? '<REDACTED>' : value),
      );
      prepared.url = url.toString();
      try {
        body = JSON.stringify(
          JSON.parse(body),
          (key, value) => (SENSITIVE.test(key) ? '<REDACTED>' : value),
          2,
        );
      } catch {
        /* Non-JSON raw data is preserved. */
      }
    }
    return {
      url: prepared.url,
      method: request.method,
      headers: prepared.headers,
      body,
      bodyType: mode,
      binaryName: request.binaryName,
      fields: (request.bodyFields || [])
        .filter((field) => field.enabled && field.key)
        .map((field) => ({
          name: resolve(field.key),
          value: redact && SENSITIVE.test(field.key) ? '<REDACTED>' : resolve(field.value),
          ...(mode === 'form-data' && field.kind === 'file'
            ? { fileName: field.fileName || 'upload.bin' }
            : {}),
        })),
    };
  }
  async function openCodeGenerator(docked = true): Promise<void> {
    const ui = useUiStore();
    if (!window.workbench?.codegen) {
      toast('Code generation requires the desktop application.', 'warning');
      return;
    }
    returnFocus = document.activeElement as HTMLElement;
    try {
      const protocol = requestProtocol(workspace.current());
      const targets = await window.workbench.codegen.targets(
        protocol === 'http' ? undefined : protocol,
      );
      const first = targets.find((target) => target.id === 'shell') ?? targets[0];
      ui.requestPanels.code = docked;
      codeDialog.value = {
        targets,
        docked,
        protocol,
        target: first.id,
        client: first.clients[0].id,
        redact: true,
        loading: true,
        error: '',
        requestName: workspace.current().name,
      };
      render();
      void nextTick(() => document.querySelector<HTMLSelectElement>('#code-language')?.focus());
      await updateCodeGeneration();
    } catch (error) {
      if (docked) {
        ui.requestPanels.code = false;
        render();
      }
      toast(errorMessage(error), 'error');
    }
  }
  /** Drops the generator without moving focus, cancelling any pending generation. */
  function dismissCodeGenerator(): void {
    codeDialog.value = undefined;
    generation++;
    if (dockedTimer) clearTimeout(dockedTimer);
  }
  function closeCodeGenerator(): void {
    if (codeDialog.value?.docked) useUiStore().requestPanels.code = false;
    dismissCodeGenerator();
    render();
    if (
      returnFocus?.isConnected &&
      returnFocus.matches('button,input,select,textarea,a[href],[tabindex]')
    )
      returnFocus.focus();
    else document.querySelector<HTMLElement>('[data-action=code]')?.focus();
  }
  async function updateCodeGeneration(): Promise<void> {
    const dialog = codeDialog.value;
    if (!dialog || !window.workbench) return;
    const current = () => codeDialog.value === dialog && version === generation;
    dialog.requestName = workspace.current().name;
    // Switching to a request of another protocol loads that protocol's languages.
    const protocol = requestProtocol(workspace.current());
    if (dialog.protocol !== protocol) {
      dialog.targets = await window.workbench.codegen.targets(
        protocol === 'http' ? undefined : protocol,
      );
      dialog.protocol = protocol;
      if (!dialog.targets.some((target) => target.id === dialog.target)) {
        const first = dialog.targets.find((target) => target.id === 'shell') ?? dialog.targets[0];
        dialog.target = first.id;
        dialog.client = first.clients[0].id;
      }
      const target = dialog.targets.find((item) => item.id === dialog.target)!;
      if (!target.clients.some((client) => client.id === dialog.client))
        dialog.client = target.clients[0].id;
    }
    const version = ++generation;
    dialog.loading = true;
    dialog.error = '';
    dialog.result = undefined;
    try {
      const result = await window.workbench.codegen.generate(
        codegenInput(dialog.redact),
        dialog.target,
        dialog.client,
      );
      if (current()) dialog.result = result;
    } catch (error) {
      if (current()) dialog.error = errorMessage(error);
    } finally {
      if (current()) dialog.loading = false;
    }
  }
  /** The docked generator follows edits to the request, a moment after they stop. */
  function scheduleDockedCodeGeneration(): void {
    const ui = useUiStore();
    if (dockedTimer) clearTimeout(dockedTimer);
    if (!codeDialog.value?.docked || !ui.requestPanels.code || ui.view !== 'Collections') return;
    dockedTimer = setTimeout(() => {
      if (!codeDialog.value?.docked || ui.view !== 'Collections') return;
      codeDialog.value.requestName = workspace.current().name;
      void updateCodeGeneration();
    }, 250);
  }
  // The dialog form keeps focus inside it and closes on Escape.
  document.addEventListener('keydown', (event) => {
    if (!codeDialog.value || codeDialog.value.docked) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeCodeGenerator();
    }
    if (event.key === 'Tab') {
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.codegen-modal button:not(:disabled),.codegen-modal select,.codegen-modal input,.codegen-modal [tabindex="0"]',
        ),
      );
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  return {
    consoleEntries,
    consoleOptions,
    networkEntries,
    addNetworkEntry,
    codeDialog,
    addConsoleEntry,
    consoleSafeError,
    codegenInput,
    openCodeGenerator,
    dismissCodeGenerator,
    closeCodeGenerator,
    updateCodeGeneration,
    scheduleDockedCodeGeneration,
  };
});

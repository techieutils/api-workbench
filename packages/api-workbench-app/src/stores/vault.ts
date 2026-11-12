import { defineStore } from 'pinia';
import { nextTick, reactive, ref, shallowRef } from 'vue';
import * as secretProviders from '@techieutils/api-workbench-common/secret-providers';
import type {
  ExternalSecretConfig,
  SecretProvider,
} from '@techieutils/api-workbench-common/secret-providers';
import type {
  OAuthConfig,
  VaultStatus,
  WorkbenchVaultBridge,
} from '@techieutils/api-workbench-common/types';
import { render } from '../shell';
import { errorMessage, toast, uid } from '../utils';
import { useUiStore } from './ui';
import { vaultUnavailable } from '@techieutils/api-workbench-common/vault-messages';
import { useWorkspaceStore } from './workspace';
import { useWorkspacesStore } from './workspaces';
import { confirmAction } from '../confirm';

type CredentialKindFilter = 'all' | CredentialInput['kind'];
type CredentialKind = CredentialInput['kind'];

export const kindLabels: Record<CredentialKind, string> = {
  bearer: 'Bearer token',
  basic: 'Basic auth',
  'api-key': 'API key',
  digest: 'Digest auth',
  jwt: 'JWT bearer',
  aws: 'AWS Signature',
  oauth1: 'OAuth 1.0',
  ntlm: 'NTLM',
  wsse: 'WSSE',
  edgegrid: 'Akamai EdgeGrid',
  hawk: 'Hawk',
  oauth2: 'OAuth 2.0',
  'client-certificate': 'Client certificate',
};
export const defaultOAuth = (): OAuthConfig => ({
  grantType: 'authorization_code',
  authorizationUrl: '',
  tokenUrl: '',
  clientId: '',
  scope: '',
  audience: '',
  resource: '',
  clientAuth: 'none',
  callbackPort: 43821,
});
/** Reads the non-secret settings each vault credential kind uses. */
function credentialOptionsFromForm(
  kind: CredentialKind,
  data: FormData,
): CredentialInput['options'] {
  const value = (key: string) => String(data.get(key) || '').trim();
  if (kind === 'api-key') return { apiKeyIn: value('apiKeyIn') === 'query' ? 'query' : 'header' };
  if (kind === 'aws') return { awsRegion: value('awsRegion'), awsService: value('awsService') };
  if (kind === 'oauth1')
    return {
      oauth1SignatureMethod: (value('oauth1SignatureMethod') || 'HMAC-SHA1') as 'HMAC-SHA1',
      oauth1Token: value('oauth1Token'),
      oauth1Realm: value('oauth1Realm'),
    };
  if (kind === 'ntlm')
    return { ntlmDomain: value('ntlmDomain'), ntlmWorkstation: value('ntlmWorkstation') };
  if (kind === 'edgegrid')
    return {
      edgegridHeadersToSign: value('edgegridHeadersToSign'),
      edgegridMaxBody: value('edgegridMaxBody'),
    };
  if (kind === 'hawk')
    return {
      hawkAlgorithm: value('hawkAlgorithm') === 'sha1' ? 'sha1' : 'sha256',
      hawkExt: value('hawkExt'),
      hawkApp: value('hawkApp'),
      hawkDlg: value('hawkDlg'),
      hawkPayloadHash: data.get('hawkPayloadHash') === 'on',
    };
  if (kind === 'jwt')
    return {
      jwtAlgorithm: (value('jwtAlgorithm') || 'HS256') as 'HS256',
      jwtPrefix: String(data.get('jwtPrefix') ?? 'Bearer'),
      jwtExpiresIn: value('jwtExpiresIn'),
      jwtPayload: value('jwtPayload'),
      jwtHeader: value('jwtHeader'),
      jwtSecretBase64: data.get('jwtSecretBase64') === 'on',
    };
  return undefined;
}

/**
 * The credential vault as this workspace sees it: saved profiles (loaded only once the Credentials
 * screen unlocks the keychain), the profile being edited, filters, and in-flight checks.
 */
export const useVaultStore = defineStore('vault', () => {
  // The list and the draft are always replaced, never edited in place, and stay plain objects so
  // they can be structured-cloned and sent over IPC.
  const credentials = shallowRef<CredentialSummary[]>([]);
  const loaded = ref(false);
  const loading = ref(false);
  const status = ref<VaultStatus | null>(null);
  /**
   * The API Workbench vault, used when the system has no credential store: a step in progress,
   * whether the recovery key was put away, and the last problem. Passwords live only in the
   * forms that ask for them and are sent once to the main process.
   */
  const workbench = reactive({
    busy: false,
    error: '',
    /** After setup, until the recovery key has been saved. */
    recoveryStep: false,
    recoverySaved: false,
  });
  const error = ref('');
  const draft = shallowRef<CredentialInput | null>(null);
  const filter = ref('');
  const kindFilter = ref<CredentialKindFilter>('all');
  const providerFilter = ref('all');
  /** The credential an OAuth action or provider access check is running for. */
  const oauthPending = ref('');
  const providerCheckPending = ref('');
  const providerChecks = reactive(new Map<string, { checkedAt?: string; error?: string }>());

  /** The status badge for a saved credential. */
  function tokenStatus(credential: CredentialSummary): { label: string; tone: UITone } {
    if (credential.kind === 'client-certificate') {
      const validTo = credential.clientCertificate?.validTo;
      const entry = useWorkspaceStore().state.clientCertificates?.find(
        (item) => item.credentialId === credential.id,
      );
      if (entry && !entry.enabled) return { label: 'Off', tone: 'neutral' };
      if (!validTo) return { label: 'Ready', tone: 'neutral' };
      const days = Math.floor((new Date(validTo).getTime() - Date.now()) / 86400000);
      if (days < 0) return { label: 'Expired', tone: 'danger' };
      if (days < 30)
        return { label: `Expires in ${days} day${days === 1 ? '' : 's'}`, tone: 'warning' };
      return { label: 'Ready', tone: 'success' };
    }
    if (credential.external && credential.kind !== 'oauth2') {
      if (providerCheckPending.value === credential.id)
        return { label: 'Checking…', tone: 'neutral' };
      const check = providerChecks.get(credential.id);
      return check?.error
        ? { label: 'Access failed', tone: 'danger' }
        : check?.checkedAt
          ? { label: 'Access verified', tone: 'success' }
          : { label: 'Remote lookup', tone: 'neutral' };
    }
    if (credential.kind !== 'oauth2') return { label: 'Ready', tone: 'neutral' };
    if (!credential.connected) return { label: 'Not connected', tone: 'neutral' };
    if (credential.expiresAt && credential.expiresAt <= Date.now())
      return { label: 'Expired', tone: 'warning' };
    return { label: 'Connected', tone: 'success' };
  }
  const sourceLabel = (credential: { external?: ExternalSecretConfig }): string =>
    secretProviders.providers.find((provider) => provider.id === credential.external?.provider)
      ?.label || 'Local vault';
  /** The secret source fields of the credential form. */
  function readProvider(
    data: FormData,
  ): Pick<CredentialInput, 'external' | 'providerSecrets' | 'secretField'> {
    const source = String(data.get('secretSource') || 'local');
    if (source === 'local') return {};
    const provider = secretProviders.definition(source);
    const external = secretProviders.defaults(provider.id);
    const secrets: Record<string, string> = {};
    for (const field of provider.fields) {
      const value = String(data.get(`provider:${field.key}`) ?? field.default ?? '');
      if (field.secret) secrets[field.key] = value;
      else external.config[field.key] = value;
    }
    return {
      external,
      providerSecrets: secrets,
      secretField: String(data.get('secretField') || ''),
    };
  }
  /** Switching secret source keeps the profile's other settings but none of its secrets. */
  function changeSource(source: string): void {
    const next = readCredentialForm();
    next.external =
      source === 'local' ? undefined : secretProviders.defaults(source as SecretProvider);
    next.providerSecrets = undefined;
    next.secretField = undefined;
    next.secret = undefined;
    if (next.oauth) {
      next.oauth.clientSecret = undefined;
      if (next.external && next.oauth.clientAuth === 'none') next.oauth.clientAuth = 'basic';
    }
    draft.value = next;
  }
  /** Checks that a remote-secret credential can be read, without revealing the value. */
  async function testProvider(id: string): Promise<void> {
    if (providerCheckPending.value || !window.workbench) return;
    const workspaces = useWorkspacesStore().manager;
    const workspaceId = workspaces.id;
    providerCheckPending.value = id;
    providerChecks.delete(id);
    try {
      const result = await window.workbench.credentials.test(id);
      if (workspaceId === workspaces.id) providerChecks.set(id, result);
    } catch (error) {
      if (workspaceId === workspaces.id) providerChecks.set(id, { error: errorMessage(error) });
    } finally {
      providerCheckPending.value = '';
    }
  }

  // Loading and editing
  async function loadCredentials(): Promise<void> {
    const workspaces = useWorkspacesStore().manager;
    const workspaceId = workspaces.id;
    if (!window.workbench) {
      error.value =
        'Credential management and OAuth require the Electron desktop app. Start with npm start.';
      return;
    }
    try {
      const vaultStatus = await window.workbench.credentials.status();
      if (workspaceId !== workspaces.id) return;
      status.value = vaultStatus;
      watchVaultLock();
      // The API Workbench vault's panel asks for its password; no error is shown for it here.
      if (!vaultStatus.available && vaultStatus.kind === 'workbench') {
        error.value = '';
        loaded.value = false;
        credentials.value = [];
        return;
      }
      if (!vaultStatus.available) {
        // Checked again on every attempt, so unlocking the keychain and trying again is enough.
        error.value = vaultUnavailable(vaultStatus.backend);
        return;
      }
      const entries = await window.workbench.credentials.list();
      if (workspaceId !== workspaces.id) return;
      credentials.value = entries;
      loaded.value = true;
      error.value = '';
      await moveCertificatesToVault();
      if (workspaceId === workspaces.id) syncCertificates();
    } catch (failure) {
      if (workspaceId === workspaces.id) error.value = errorMessage(failure);
    }
  }
  /**
   * Unlocks the vault where an error asked for it, without leaving the screen. The system may
   * show a keychain prompt; returns whether the vault opened.
   */
  async function unlock(): Promise<boolean> {
    if (loading.value) return false;
    loading.value = true;
    render();
    try {
      await loadCredentials();
    } finally {
      loading.value = false;
      render();
    }
    if (!loaded.value || error.value) return false;
    toast('Credential vault unlocked', 'success');
    return true;
  }
  // The API Workbench vault
  const vaultBridge = (): WorkbenchVaultBridge | undefined => window.workbench?.vault;
  let unwatchLock: (() => void) | undefined;
  /** When the vault locks on its own after going unused, the app forgets what it had read. */
  function watchVaultLock(): void {
    if (unwatchLock || !vaultBridge()) return;
    unwatchLock = vaultBridge()!.onLocked(() => {
      credentials.value = [];
      loaded.value = false;
      if (status.value) status.value = { ...status.value, available: false, locked: true };
      toast('The API Workbench vault locked after 15 minutes without use', 'info');
      render();
    });
  }
  /** Runs a vault step, then reads the credentials again when it left the vault open. */
  async function vaultStep(
    step: (bridge: WorkbenchVaultBridge) => Promise<VaultStatus>,
    done?: string,
  ): Promise<boolean> {
    const bridge = vaultBridge();
    if (!bridge || workbench.busy) return false;
    workbench.busy = true;
    workbench.error = '';
    render();
    try {
      status.value = await step(bridge);
    } catch (failure) {
      workbench.error = errorMessage(failure);
      // A wait after wrong attempts shows in the status.
      status.value = await window.workbench!.credentials.status().catch(() => status.value);
      return false;
    } finally {
      workbench.busy = false;
      render();
    }
    // The step worked; credentials that cannot be read (such as a file the system's store
    // encrypted before it went away) are reported on their own, as for any vault.
    if (status.value?.available) await loadCredentials();
    else {
      credentials.value = [];
      loaded.value = false;
    }
    if (done) toast(done, 'success');
    render();
    return true;
  }
  async function setupVault(password: string, confirm: string): Promise<boolean> {
    if (password !== confirm) {
      workbench.error = 'The passwords do not match.';
      render();
      return false;
    }
    const created = await vaultStep((bridge) => bridge.setup(password));
    if (created) Object.assign(workbench, { recoveryStep: true, recoverySaved: false });
    render();
    return created;
  }
  const unlockVault = (password: string) =>
    vaultStep((bridge) => bridge.unlock(password), 'API Workbench vault unlocked');
  async function recoverVault(key: string, password: string, confirm: string): Promise<boolean> {
    if (password !== confirm) {
      workbench.error = 'The passwords do not match.';
      render();
      return false;
    }
    return vaultStep(
      (bridge) => bridge.recover(key, password),
      'New vault password set, and the vault unlocked',
    );
  }
  async function changeVaultPassword(
    current: string,
    next: string,
    confirm: string,
  ): Promise<boolean> {
    if (next !== confirm) {
      workbench.error = 'The new passwords do not match.';
      render();
      return false;
    }
    return vaultStep((bridge) => bridge.changePassword(current, next), 'Vault password changed');
  }
  const lockVault = () => vaultStep((bridge) => bridge.lock(), 'API Workbench vault locked');
  async function resetVault(): Promise<boolean> {
    const confirmed = await confirmAction({
      title: 'Reset the API Workbench vault?',
      message:
        'The vault and every credential it holds, in every workspace, are deleted. They cannot be recovered. You will set a new vault password and add your credentials again.',
      confirmLabel: 'Reset vault',
      tone: 'danger',
    });
    if (!confirmed) return false;
    Object.assign(workbench, { recoveryStep: false, recoverySaved: false });
    return vaultStep((bridge) => bridge.reset(), 'The API Workbench vault was reset');
  }
  /**
   * Uses the API Workbench vault in place of the system's store, so the command line and the VS
   * Code extension can read credentials with its password; or goes back to the system's store.
   */
  async function useWorkbenchVault(enabled: boolean): Promise<boolean> {
    const system = status.value?.system || status.value?.backend || 'the system store';
    const confirmed = await confirmAction(
      enabled
        ? {
            title: 'Use the API Workbench vault?',
            message: `Your credentials move from ${status.value?.backend ?? 'the system store'} into the API Workbench vault, under a password of your own, once you set it up or unlock it. The command line and the VS Code extension can then use them with that password. You can go back to ${status.value?.backend ?? 'the system store'} later.`,
            confirmLabel: 'Use the vault',
          }
        : {
            title: `Go back to ${system}?`,
            message: `Your credentials move back to ${system}. The command line and the VS Code extension can no longer read them; the app keeps them as before.`,
            confirmLabel: `Use ${system}`,
          },
    );
    if (!confirmed) return false;
    return vaultStep(
      (bridge) => bridge.useWorkbench(enabled),
      enabled
        ? 'Set up or unlock the API Workbench vault to finish'
        : `Credentials are in ${system}`,
    );
  }
  /** Saves the recovery key to a file, from the main process; the app never sees it. */
  async function saveRecoveryKey(): Promise<void> {
    try {
      if (await vaultBridge()?.saveRecoveryKey()) {
        workbench.recoverySaved = true;
        toast('Recovery key saved', 'success');
      }
    } catch (failure) {
      workbench.error = errorMessage(failure);
    }
    render();
  }
  async function copyRecoveryKey(): Promise<void> {
    try {
      await vaultBridge()?.copyRecoveryKey();
      workbench.recoverySaved = true;
      toast('Recovery key copied; the clipboard is cleared in a minute', 'success');
    } catch (failure) {
      workbench.error = errorMessage(failure);
    }
    render();
  }
  async function finishVaultSetup(): Promise<void> {
    await vaultBridge()?.finishSetup();
    Object.assign(workbench, { recoveryStep: false, recoverySaved: false, error: '' });
    render();
  }
  /** Set while the app saves and restarts. */
  const restarting = ref(false);
  /**
   * Restarts the app so OS encryption is detected again, after the keychain was unlocked. The
   * workspace is saved first; if that fails the app stays open and says why.
   */
  async function restartApp(): Promise<void> {
    if (!window.workbench?.restart || restarting.value) return;
    const workspace = useWorkspaceStore();
    restarting.value = true;
    render();
    try {
      if (!workspace.persistenceBlocked) await useWorkspacesStore().flush();
      await window.workbench.restart();
    } catch (failure) {
      restarting.value = false;
      render();
      toast(
        `Could not save your workspace, so API Workbench was not restarted: ${errorMessage(failure)}`,
        'error',
      );
    }
  }
  /** Opens the Credentials screen, unlocking the vault only now (it may prompt for the keychain). */
  async function openCredentialsPage(): Promise<void> {
    const ui = useUiStore();
    ui.view = 'Credentials';
    if (loading.value) return render();
    loading.value = true;
    render();
    // Paint the credentials screen before the native keychain prompt can block Electron.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    if (ui.view !== 'Credentials') {
      loading.value = false;
      return;
    }
    try {
      await loadCredentials();
    } finally {
      loading.value = false;
      if (ui.view === 'Credentials') render();
    }
  }
  function openCredential(id?: string): void {
    if (!status.value?.available) {
      toast('Open the desktop app with OS-backed encryption to manage credentials.', 'warning');
      return;
    }
    const existing = credentials.value.find((item) => item.id === id);
    draft.value = existing
      ? {
          id: existing.id,
          name: existing.name,
          kind: existing.kind,
          allowedOrigin: existing.allowedOrigin,
          username: existing.username,
          headerName: existing.headerName,
          options: existing.options ? { ...existing.options } : undefined,
          oauth: existing.oauth ? { ...existing.oauth } : undefined,
          external: existing.external ? structuredClone(existing.external) : undefined,
          secretField: existing.secretField,
          clientCertificate: existing.clientCertificate
            ? { ...existing.clientCertificate }
            : undefined,
        }
      : { name: '', kind: 'bearer', allowedOrigin: '' };
    render();
    void nextTick(() =>
      document.querySelector<HTMLInputElement>('#credential-form [name="name"]')?.focus(),
    );
  }
  /** The credential dialog's form, as a credential to save. */
  function readCredentialForm(): CredentialInput {
    const form = document.querySelector<HTMLFormElement>('#credential-form');
    if (!form) throw new Error('Missing element: #credential-form');
    const data = new FormData(form);
    const value = (key: string) => String(data.get(key) || '');
    const kind = value('kind') as CredentialKind;
    return {
      ...readProvider(data),
      id: draft.value?.id,
      name: value('name').trim(),
      kind,
      allowedOrigin: value('allowedOrigin').trim(),
      username: value('username'),
      secret: value('secret'),
      extraSecret: value('extraSecret') || undefined,
      headerName: value('headerName'),
      options: credentialOptionsFromForm(kind, data),
      ...(kind === 'client-certificate'
        ? {
            clientCertificate: {
              type: value('certificateType') === 'pfx' ? 'pfx' : 'pem',
              host: value('certificateHost').trim(),
              ...(value('certificatePort').trim()
                ? { port: Number(value('certificatePort')) }
                : {}),
            },
            certificateFiles: {
              certPath: value('certPath') || undefined,
              keyPath: value('keyPath') || undefined,
              pfxPath: value('pfxPath') || undefined,
            },
          }
        : {}),
      oauth:
        kind === 'oauth2'
          ? {
              grantType: value('grantType') as OAuthConfig['grantType'],
              clientAuth: value('clientAuth') as OAuthConfig['clientAuth'],
              authorizationUrl: value('authorizationUrl').trim(),
              tokenUrl: value('tokenUrl').trim(),
              clientId: value('clientId').trim(),
              clientSecret: value('clientSecret'),
              scope: value('scope').trim(),
              audience: value('audience').trim(),
              resource: value('resource').trim() || undefined,
              callbackPort: Number(value('callbackPort')),
            }
          : undefined,
    };
  }
  /** Saves the open credential form; throws with a message for the dialog. */
  async function saveCredentialForm(): Promise<void> {
    const saved = await window.workbench!.credentials.save(readCredentialForm());
    providerChecks.delete(saved.id);
    // Close the dialog only once the list includes the saved credential.
    await loadCredentials();
    draft.value = null;
    render();
    toast('Credential saved securely', 'success');
  }
  async function deleteCredential(id: string): Promise<void> {
    const name = credentials.value.find((credential) => credential.id === id)?.name;
    const confirmed = await confirmAction({
      title: name ? `Delete “${name}”?` : 'Delete this saved credential?',
      message:
        'It is removed from the encrypted vault. Requests that use it will need another credential.',
      confirmLabel: 'Delete credential',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await window.workbench!.credentials.delete(id);
      await loadCredentials();
      render();
      toast('Credential deleted', 'success');
    } catch (failure) {
      toast(errorMessage(failure), 'error');
    }
  }
  /** A new credential type starts its secrets and type-specific settings over. */
  function changeCredentialKind(): void {
    const next = readCredentialForm();
    draft.value = {
      ...next,
      secret: undefined,
      extraSecret: undefined,
      options: undefined,
      oauth: next.kind === 'oauth2' ? defaultOAuth() : undefined,
    };
  }
  /** The secret control and field labels depend on the JWT algorithm and API key placement. */
  function changeCredentialOption(name: 'jwtAlgorithm' | 'apiKeyIn'): void {
    const next = readCredentialForm();
    draft.value = {
      ...next,
      secret: undefined,
      headerName: name === 'apiKeyIn' ? undefined : next.headerName,
    };
  }
  async function performOAuth(
    id: string,
    operation: 'authorize' | 'refresh' | 'disconnect',
  ): Promise<void> {
    if (!window.workbench || oauthPending.value) return;
    oauthPending.value = id;
    render();
    try {
      await window.workbench.oauth[operation](id);
      await loadCredentials();
      toast(
        operation === 'disconnect'
          ? 'Tokens removed from this device. Provider authorization remains active.'
          : 'OAuth credential updated',
        'success',
      );
    } catch (failure) {
      toast(errorMessage(failure), 'error');
    } finally {
      oauthPending.value = '';
      render();
    }
  }
  // Client certificates
  /**
   * Keeps the workspace's certificate list, which requests match by host while the vault is
   * locked, in step with the vault: one entry per vault certificate, keeping its on/off choice.
   * Entries that still reference files (saved before certificates moved to the vault) stay.
   */
  function syncCertificates(): void {
    const workspace = useWorkspaceStore();
    const current = workspace.state.clientCertificates || [];
    const next: ClientCertificate[] = [
      ...current.filter((entry) => !entry.credentialId),
      ...credentials.value.flatMap((credential): ClientCertificate[] => {
        const profile = credential.clientCertificate;
        if (credential.kind !== 'client-certificate' || !profile) return [];
        const existing = current.find((entry) => entry.credentialId === credential.id);
        return [
          {
            id: existing?.id || uid(),
            credentialId: credential.id,
            host: profile.host,
            ...(profile.port ? { port: profile.port } : {}),
            enabled: existing?.enabled ?? true,
            type: profile.type,
            subject: profile.subject,
            issuer: profile.issuer,
            validTo: profile.validTo,
          },
        ];
      }),
    ];
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    workspace.state.clientCertificates = next;
    workspace.persist();
  }
  /** Copies certificates saved in workspace settings (by file path) into the vault, once unlocked. */
  async function moveCertificatesToVault(): Promise<void> {
    const workspace = useWorkspaceStore();
    const legacy = (workspace.state.clientCertificates || []).filter(
      (entry) => !entry.credentialId,
    );
    if (!legacy.length || !window.workbench?.credentials.importCertificate) return;
    const moved: string[] = [],
      failed: string[] = [];
    for (const entry of legacy) {
      try {
        const summary = await window.workbench.credentials.importCertificate(
          structuredClone(entry),
          `Client certificate · ${entry.host}${entry.port ? `:${entry.port}` : ''}`,
        );
        credentials.value = [...credentials.value, summary];
        // Keep its place and on/off choice; the vault entry replaces its files.
        workspace.state.clientCertificates = (workspace.state.clientCertificates || []).map(
          (item) =>
            item.id === entry.id
              ? {
                  id: entry.id,
                  credentialId: summary.id,
                  host: entry.host,
                  ...(entry.port ? { port: entry.port } : {}),
                  enabled: entry.enabled,
                  type: entry.type,
                  subject: summary.clientCertificate?.subject,
                  issuer: summary.clientCertificate?.issuer,
                  validTo: summary.clientCertificate?.validTo,
                }
              : item,
        );
        moved.push(entry.host);
      } catch {
        failed.push(entry.host);
      }
    }
    if (moved.length) workspace.persist();
    if (failed.length)
      toast(
        `Could not move the client certificate for ${failed.join(', ')} into the vault. Its files are still used; add it again in Credentials to store it securely.`,
        'error',
      );
    else
      toast(
        `Moved ${moved.length} client certificate${moved.length === 1 ? '' : 's'} into the credential vault`,
        'success',
      );
  }
  /** Turns a vault certificate on or off for matching requests, without unlocking the vault. */
  function setCertificateEnabled(credentialId: string, enabled: boolean): void {
    const workspace = useWorkspaceStore();
    const entry = workspace.state.clientCertificates?.find(
      (item) => item.credentialId === credentialId,
    );
    if (!entry) return;
    entry.enabled = enabled;
    workspace.persist();
    render();
  }

  // The credential dialog keeps focus inside it and closes on Escape.
  document.addEventListener('keydown', (event) => {
    if (!draft.value) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      draft.value = null;
      render();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.modal button:not(:disabled), .modal input:not(:disabled), .modal select:not(:disabled), .modal textarea:not(:disabled)',
        ),
      ).filter((element) => !element.closest('[hidden]'));
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  return {
    credentials,
    loaded,
    loading,
    status,
    error,
    draft,
    filter,
    kindFilter,
    providerFilter,
    oauthPending,
    providerCheckPending,
    providerChecks,
    tokenStatus,
    sourceLabel,
    readProvider,
    changeSource,
    testProvider,
    loadCredentials,
    unlock,
    workbench,
    setupVault,
    unlockVault,
    recoverVault,
    changeVaultPassword,
    lockVault,
    resetVault,
    useWorkbenchVault,
    saveRecoveryKey,
    copyRecoveryKey,
    finishVaultSetup,
    restarting,
    restartApp,
    openCredentialsPage,
    openCredential,
    readCredentialForm,
    saveCredentialForm,
    deleteCredential,
    changeCredentialKind,
    changeCredentialOption,
    performOAuth,
    syncCertificates,
    setCertificateEnabled,
  };
});

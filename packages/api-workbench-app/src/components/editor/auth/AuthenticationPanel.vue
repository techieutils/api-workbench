<script setup lang="ts">
import { OPTION_ICONS, withIcons } from '../../../select-options';
import {
  folderChain,
  folderLabel,
  folderName,
  isWithin,
  parentFolder,
} from '@techieutils/api-workbench-common/folders';
import { computed, ref, watch } from 'vue';
import {
  applyDiscovery,
  type OAuthDiscovery,
} from '@techieutils/api-workbench-common/oauth-discovery';
import { render } from '../../../shell';
import { errorMessage, toast } from '../../../utils';
import { requestProtocol } from '../../../stores/protocols';
import {
  AUTH_DESCRIPTIONS,
  AUTH_GROUPS,
  SIGNING_AUTH_TYPES,
  useAuthenticationStore,
} from '../../../stores/authentication';
import { useVaultStore } from '../../../stores/vault';
import { useWorkspaceStore } from '../../../stores/workspace';
import MdiIcon from '../../MdiIcon.vue';
import ScrollRow from '../../ui/ScrollRow.vue';
import UiBadge from '../../ui/UiBadge.vue';
import UiButton from '../../ui/UiButton.vue';
import AuthInput from './AuthInput.vue';
import JWTInspector from './JWTInspector.vue';
import OAuthDiscover from './OAuthDiscover.vue';
import UiExpansionPanel from '../../ui/UiExpansionPanel.vue';
import { kindLabels } from '../../../stores/vault';
import VaultUnlockNotice from '../../VaultUnlockNotice.vue';
import UiSelect from '../../ui/UiSelect.vue';

/** Request or collection authentication, shared by the HTTP and live protocol editors. */
const store = useAuthenticationStore();
const workspace = useWorkspaceStore();
const vaultStore = useVaultStore();
// The request is mutated in place, so read it on every render rather than caching it in a computed.
const request = () => workspace.current();
/** The collection or folder the 'collection' scope edits. */
const level = () => store.scopeTarget(request());
const isCollection = (path: string) => parentFolder(path) === undefined;
/** The levels above the request, nearest first: its folder, the folders above, its collection. */
const levels = () => folderChain(request().folder).reverse();
const levelLabel = (path: string) => (isCollection(path) ? 'Collection' : folderName(path));
const NONE: AuthConfig = { auth: 'None', token: '', username: '', password: '' };
const INHERIT: AuthConfig = { ...NONE, auth: 'Inherit from collection' };
/** What the tab shows; a default is only created once it is edited (a folder's starts inheriting). */
const config = (): AuthConfig =>
  store.scope === 'collection'
    ? (store.collectionAuth(level()) ?? (isCollection(level()) ? NONE : INHERIT))
    : request();
/** What edits change. */
const target = (): AuthConfig =>
  store.scope === 'collection' ? store.editableCollectionAuth(level()) : request();
/** Edits the request, or a collection or folder above it (`folder` names which). */
function setScope(next: 'request' | 'collection', folder = ''): void {
  store.scope = next;
  store.scopeFolder = folder;
}
const options = () => config().authOptions || {};
const live = () => requestProtocol(request()) !== 'http';

const groups = computed(() =>
  AUTH_GROUPS.map(([group, types]) => ({
    group,
    types: types.filter(
      // A folder can pass on what is above it; the collection is the top, so it cannot inherit.
      (type) =>
        !(
          store.scope === 'collection' &&
          isCollection(level()) &&
          type === 'Inherit from collection'
        ),
    ),
  })).filter((group) => group.types.length),
);
const inheriting = () =>
  workspace.state.requests.filter(
    (item) => isWithin(item.folder, level()) && item.auth === 'Inherit from collection',
  ).length;
const notes = computed(() => {
  const current = config();
  const protocol = requestProtocol(request());
  const saved = current.auth === 'Saved credential';
  return [
    SIGNING_AUTH_TYPES.includes(current.auth)
      ? live()
        ? 'Signed in the desktop app when connecting: the handshake, stream request, or gRPC call is signed.'
        : 'Signed in the desktop app when sent. Generated code omits the signature.'
      : '',
    protocol === 'grpc' && current.auth === 'Digest auth'
      ? 'gRPC does not send Digest challenges. Choose another type for gRPC.'
      : '',
    protocol === 'socketio' &&
    SIGNING_AUTH_TYPES.includes(current.auth) &&
    !['JWT bearer', 'WSSE'].includes(current.auth)
      ? 'Socket.IO adds its own query to the handshake, so only header-based types work: Bearer, Basic, API key, JWT bearer, WSSE, or OAuth 2.0.'
      : '',
    protocol === 'mqtt' &&
    !['None', 'Inherit from collection', 'Basic auth', 'Saved credential'].includes(current.auth)
      ? 'MQTT brokers take a username and password, so use Basic auth. Other types send an HTTP header, which only reaches the broker over ws:// or wss://.'
      : '',
    live() && current.auth === 'NTLM'
      ? 'NTLM authenticates HTTP connections only. Choose another type for live protocols.'
      : '',
    !live() && current.auth === 'NTLM'
      ? 'The server’s challenge is answered on the same connection, so keep-alive must stay on in HTTP settings.'
      : '',
    protocol === 'grpc' && current.auth === 'API key' && current.authOptions?.apiKeyIn === 'query'
      ? 'gRPC has no query string. Choose Header to send the key as metadata.'
      : '',
    saved && live()
      ? protocol === 'websocket' || protocol === 'socketio'
        ? 'Match the saved HTTP origin for ws:// or HTTPS origin for wss://. Reconnect to apply changes.'
        : protocol === 'mqtt'
          ? 'Match the broker as an HTTP origin for mqtt:// and ws:// or HTTPS for mqtts:// and wss://, with its port (1883 and 8883 by default). Reconnect to apply changes.'
          : protocol === 'grpc'
            ? 'Match the saved HTTP origin for plaintext gRPC or HTTPS origin when TLS is enabled. Reconnect to apply changes.'
            : 'The saved credential must match this endpoint’s HTTP(S) origin. Reconnect to apply changes.'
      : '',
    !saved && !['None', 'Inherit from collection'].includes(current.auth)
      ? 'Inline secrets are stored in the local workspace file. Choose Saved credential for encrypted storage.'
      : '',
  ].filter(Boolean);
});

function setType(event: Event): void {
  const current = target();
  current.auth = (event.target as HTMLSelectElement).value as AuthType;
  if (current.auth === 'JWT bearer')
    current.authOptions = { jwtPayload: '{\n  "sub": "{{user_id}}"\n}', ...current.authOptions };
  workspace.persist();
  render();
}
function setField(field: 'token' | 'username' | 'password', value: string | boolean): void {
  target()[field] = String(value);
  workspace.persist();
}
function setOption(key: keyof AuthOptions, value: string | boolean): void {
  const current = target();
  current.authOptions = { ...current.authOptions, [key]: value };
  workspace.persist();
}
function setCredential(event: Event): void {
  target().credentialId = (event.target as HTMLSelectElement).value;
  workspace.persist();
  render();
}

// Saved credential: the vault is loaded by the Credentials screen.
// Client certificates are presented by host, not chosen as a request's authorization.
const vault = computed(() => ({
  loaded: vaultStore.loaded,
  credentials: vaultStore.credentials.filter(
    (credential) => credential.kind !== 'client-certificate',
  ),
}));
/** The saved-credential picker: a prompt, then each credential with its kind, source, and origin. */
const credentialOptions = () => [
  {
    value: '',
    label: vault.value.loaded ? 'Choose a credential…' : 'Unlock the vault to choose a credential',
  },
  ...vault.value.credentials.map((credential) => ({
    value: credential.id,
    label: credential.name,
    description: `${kindLabels[credential.kind]} · ${vaultStore.sourceLabel(credential)} · ${credential.allowedOrigin}`,
  })),
];
const selectedCredential = () =>
  vault.value.credentials.find((credential) => credential.id === config().credentialId);

// Inline OAuth 2.0
const grant = () => options().oauth2GrantType || 'authorization_code';
const oauthAvailable = Boolean(window.workbench?.oauth);
const cancelOAuth = () => void window.workbench?.oauth.cancel();
const tokenStatus = (): { label: string; tone: UITone } => {
  const expires = options().oauth2ExpiresAt;
  if (!config().token) return { label: 'No access token', tone: 'neutral' };
  if (expires && expires <= Date.now()) return { label: 'Expired', tone: 'danger' };
  return {
    label: expires ? `Valid until ${new Date(expires).toLocaleString()}` : 'Token ready',
    tone: 'success',
  };
};
async function getToken(): Promise<void> {
  const current = target();
  store.oauthPending = true;
  try {
    store.storeInlineOAuthTokens(
      current,
      await window.workbench!.oauth.token(store.inlineOAuthInput(current, grant())),
    );
    workspace.persist();
    toast('OAuth 2.0 access token received', 'success');
  } catch (error) {
    toast(errorMessage(error), 'error');
  } finally {
    store.oauthPending = false;
    render();
  }
}
// Discovery fills the OAuth fields from the server's published metadata.
const discovered = ref<{ discovery: OAuthDiscovery; changes: string[] }>();
watch(
  () => request().id,
  () => (discovered.value = undefined),
);
/** The request's URL with variables resolved, as a starting point for discovery. */
const discoveryURL = () => {
  try {
    return new URL(workspace.resolve(request().url)).origin;
  } catch {
    return '';
  }
};
function applyOAuthDiscovery(discovery: OAuthDiscovery): void {
  const current = target();
  const saved = current.authOptions || {};
  const { config: next, changes } = applyDiscovery(
    {
      grantType: grant(),
      clientAuth: saved.oauth2ClientAuth ?? (grant() === 'authorization_code' ? 'none' : 'basic'),
      authorizationUrl: saved.oauth2AuthorizationUrl || '',
      tokenUrl: saved.oauth2TokenUrl || '',
      scope: saved.oauth2Scope || '',
      resource: saved.oauth2Resource || '',
    },
    discovery,
  );
  current.authOptions = {
    ...saved,
    oauth2GrantType: next.grantType,
    oauth2ClientAuth: next.clientAuth,
    oauth2AuthorizationUrl: next.authorizationUrl,
    oauth2TokenUrl: next.tokenUrl,
    oauth2Scope: next.scope,
    oauth2Resource: next.resource || undefined,
  };
  discovered.value = { discovery, changes };
  workspace.persist();
  render();
}
/** How many advanced OAuth fields hold a value; the panel opens when any do. */
const advancedCount = () =>
  [options().oauth2Audience, options().oauth2Resource, options().oauth2CallbackPort].filter(
    (value) => value?.trim(),
  ).length;
function clearToken(): void {
  const current = target();
  current.token = '';
  current.authOptions = {
    ...current.authOptions,
    oauth2RefreshToken: undefined,
    oauth2ExpiresAt: undefined,
  };
  workspace.persist();
  render();
}

/** Where an inheriting request or folder gets its auth: the nearest level above that sets it. */
const inheritedSource = () => {
  const above = store.scope === 'request' ? request().folder : parentFolder(level());
  return above === undefined ? undefined : store.inheritedAuth(above);
};
const inherited = () => inheritedSource()?.config.auth ?? 'None';
/** The level to edit for the inherited auth: where it comes from, or the collection. */
const inheritedLevel = () => inheritedSource()?.folder ?? folderChain(request().folder)[0];
const jwtPayloadPlaceholder = '{\n  "sub": "{{user_id}}",\n  "scope": "read"\n}';
const jwtAlgorithms: [string, string][] = [
  ['HS256', 'HS256 · HMAC'],
  ['HS384', 'HS384 · HMAC'],
  ['HS512', 'HS512 · HMAC'],
  ['RS256', 'RS256 · RSA'],
  ['RS384', 'RS384 · RSA'],
  ['RS512', 'RS512 · RSA'],
  ['ES256', 'ES256 · ECDSA P-256'],
  ['ES384', 'ES384 · ECDSA P-384'],
];
</script>

<template>
  <div class="authentication-layout" :data-auth-scope-view="store.scope">
    <div class="auth-type">
      <!-- One line of levels; deep folders scroll with arrows. -->
      <ScrollRow
        class="segmented-control auth-scope"
        frame-class="auth-scope-frame"
        role="group"
        aria-label="Authentication scope"
        noun="levels"
      >
        <button
          type="button"
          data-auth-scope="request"
          :aria-pressed="store.scope === 'request'"
          :class="{ selected: store.scope === 'request' }"
          @click="setScope('request')"
        >
          This request
        </button>
        <button
          v-for="path in levels()"
          :key="path"
          type="button"
          :data-auth-scope="isCollection(path) ? 'collection' : 'folder'"
          :data-auth-folder="path"
          :title="folderLabel(path)"
          :aria-pressed="store.scope === 'collection' && level() === path"
          :class="{ selected: store.scope === 'collection' && level() === path }"
          @click="setScope('collection', path)"
        >
          {{ levelLabel(path) }}
        </button>
      </ScrollRow>
      <label class="form-field"
        ><span>Authentication type</span
        ><UiSelect
          id="auth"
          class="field-input"
          :value="config().auth"
          @input="setType"
          :options="
            withIcons(
              groups.flatMap(({ group, types }) =>
                types.map((type) => ({ value: type, label: type, group })),
              ),
              OPTION_ICONS.authType,
              'shield-lock-outline',
            )
          "
      /></label>
      <p class="field-help">{{ AUTH_DESCRIPTIONS[config().auth] }}</p>
    </div>
    <div class="auth-details">
      <template v-if="config().auth === 'Saved credential'">
        <label class="form-field"
          ><span>Saved credential</span
          ><UiSelect
            id="request-credential"
            class="field-input"
            :value="config().credentialId || ''"
            @change="setCredential"
            :options="withIcons(credentialOptions(), 'safe-square-outline')"
        /></label>
        <div v-if="selectedCredential()" class="auth-connection-info">
          <UiBadge v-bind="vaultStore.tokenStatus(selectedCredential()!)" /><code>{{
            selectedCredential()!.allowedOrigin
          }}</code>
        </div>
        <template v-else-if="config().credentialId">
          <p v-if="vault.loaded" class="form-error">
            This credential was deleted. Choose another credential.
          </p>
        </template>
        <template v-if="!vault.loaded">
          <p class="field-help">
            Saved credentials stay locked until you unlock the vault. Your system may ask for
            keychain access.
          </p>
          <VaultUnlockNotice />
        </template>
        <button class="text-button" @click="vaultStore.openCredentialsPage()">
          Manage credentials &amp; OAuth connections <MdiIcon name="arrow-top-right" />
        </button>
      </template>

      <template v-else-if="config().auth === 'Bearer token'">
        <AuthInput
          label="Bearer token"
          field="token"
          :value="config().token"
          secret
          placeholder="Token or {{variable}}"
          @update="setField('token', $event)"
        />
        <JWTInspector v-if="store.scope === 'request'" :token="request().token" />
      </template>

      <div
        v-else-if="config().auth === 'Basic auth' || config().auth === 'Digest auth'"
        class="form-grid"
      >
        <AuthInput
          label="Username"
          field="username"
          :value="config().username"
          @update="setField('username', $event)"
        /><AuthInput
          label="Password"
          field="password"
          :value="config().password"
          secret
          @update="setField('password', $event)"
        />
      </div>

      <div v-else-if="config().auth === 'API key'" class="form-grid auth-grid-3">
        <AuthInput
          label="Key name"
          field="username"
          :value="config().username"
          placeholder="X-API-Key"
          @update="setField('username', $event)"
        /><AuthInput
          label="Value"
          field="token"
          :value="config().token"
          secret
          placeholder="Key or {{variable}}"
          @update="setField('token', $event)"
        /><AuthInput
          label="Add to"
          option="apiKeyIn"
          :value="options().apiKeyIn ?? 'header'"
          :choices="[
            ['header', 'Header'],
            ['query', 'Query parameter'],
          ]"
          @update="setOption('apiKeyIn', $event)"
        />
      </div>

      <template v-else-if="config().auth === 'JWT bearer'">
        <div class="form-grid auth-grid-3">
          <AuthInput
            label="Algorithm"
            option="jwtAlgorithm"
            :value="options().jwtAlgorithm ?? 'HS256'"
            :choices="jwtAlgorithms"
            @update="setOption('jwtAlgorithm', $event)"
          /><AuthInput
            label="Header prefix"
            option="jwtPrefix"
            :value="options().jwtPrefix ?? 'Bearer'"
            placeholder="Bearer"
            @update="setOption('jwtPrefix', $event)"
          /><AuthInput
            label="Expires in (seconds)"
            option="jwtExpiresIn"
            :value="options().jwtExpiresIn"
            placeholder="0 = no exp claim"
            @update="setOption('jwtExpiresIn', $event)"
          />
        </div>
        <template v-if="(options().jwtAlgorithm || 'HS256').startsWith('HS')">
          <AuthInput
            label="Secret"
            field="password"
            :value="config().password"
            secret
            placeholder="Shared secret or {{variable}}"
            @update="setField('password', $event)"
          /><AuthInput
            label="Secret is Base64 encoded"
            option="jwtSecretBase64"
            :value="options().jwtSecretBase64"
            checkbox
            @update="setOption('jwtSecretBase64', $event)"
          />
        </template>
        <AuthInput
          v-else
          label="Private key (PEM)"
          field="password"
          :value="config().password"
          multiline
          placeholder="-----BEGIN PRIVATE KEY-----"
          @update="setField('password', $event)"
        />
        <AuthInput
          label="Payload (JSON)"
          option="jwtPayload"
          :value="options().jwtPayload"
          multiline
          :placeholder="jwtPayloadPlaceholder"
          @update="setOption('jwtPayload', $event)"
        /><AuthInput
          label="Extra header claims (JSON, optional)"
          option="jwtHeader"
          :value="options().jwtHeader"
          placeholder='{"kid": "key-1"}'
          @update="setOption('jwtHeader', $event)"
        />
      </template>

      <template v-else-if="config().auth === 'AWS Signature'">
        <div class="form-grid">
          <AuthInput
            label="Access key ID"
            field="username"
            :value="config().username"
            placeholder="AKIA… or {{aws_access_key}}"
            @update="setField('username', $event)"
          /><AuthInput
            label="Secret access key"
            field="password"
            :value="config().password"
            secret
            @update="setField('password', $event)"
          /><AuthInput
            label="Region"
            option="awsRegion"
            :value="options().awsRegion"
            placeholder="us-east-1"
            @update="setOption('awsRegion', $event)"
          /><AuthInput
            label="Service"
            option="awsService"
            :value="options().awsService"
            placeholder="execute-api, s3, lambda…"
            @update="setOption('awsService', $event)"
          />
        </div>
        <AuthInput
          label="Session token (optional)"
          option="awsSessionToken"
          :value="options().awsSessionToken"
          secret
          placeholder="For temporary credentials"
          @update="setOption('awsSessionToken', $event)"
        />
      </template>

      <div v-else-if="config().auth === 'OAuth 1.0'" class="form-grid">
        <AuthInput
          label="Consumer key"
          field="username"
          :value="config().username"
          @update="setField('username', $event)"
        /><AuthInput
          label="Consumer secret"
          field="password"
          :value="config().password"
          secret
          @update="setField('password', $event)"
        /><AuthInput
          label="Access token"
          option="oauth1Token"
          :value="options().oauth1Token"
          placeholder="Optional"
          @update="setOption('oauth1Token', $event)"
        /><AuthInput
          label="Token secret"
          option="oauth1TokenSecret"
          :value="options().oauth1TokenSecret"
          secret
          placeholder="Optional"
          @update="setOption('oauth1TokenSecret', $event)"
        /><AuthInput
          label="Signature method"
          option="oauth1SignatureMethod"
          :value="options().oauth1SignatureMethod ?? 'HMAC-SHA1'"
          :choices="[
            ['HMAC-SHA1', 'HMAC-SHA1'],
            ['HMAC-SHA256', 'HMAC-SHA256'],
            ['PLAINTEXT', 'PLAINTEXT'],
          ]"
          @update="setOption('oauth1SignatureMethod', $event)"
        /><AuthInput
          label="Realm"
          option="oauth1Realm"
          :value="options().oauth1Realm"
          placeholder="Optional"
          @update="setOption('oauth1Realm', $event)"
        />
      </div>

      <div v-else-if="config().auth === 'NTLM'" class="form-grid">
        <AuthInput
          label="Username"
          field="username"
          :value="config().username"
          placeholder="user, or DOMAIN\\user"
          @update="setField('username', $event)"
        /><AuthInput
          label="Password"
          field="password"
          :value="config().password"
          secret
          @update="setField('password', $event)"
        /><AuthInput
          label="Domain"
          option="ntlmDomain"
          :value="options().ntlmDomain"
          placeholder="Optional"
          @update="setOption('ntlmDomain', $event)"
        /><AuthInput
          label="Workstation"
          option="ntlmWorkstation"
          :value="options().ntlmWorkstation"
          placeholder="Optional"
          @update="setOption('ntlmWorkstation', $event)"
        />
      </div>

      <div v-else-if="config().auth === 'WSSE'" class="form-grid">
        <AuthInput
          label="Username"
          field="username"
          :value="config().username"
          @update="setField('username', $event)"
        /><AuthInput
          label="Password"
          field="password"
          :value="config().password"
          secret
          @update="setField('password', $event)"
        />
      </div>

      <template v-else-if="config().auth === 'Akamai EdgeGrid'">
        <div class="form-grid auth-grid-3">
          <AuthInput
            label="Client token"
            field="username"
            :value="config().username"
            placeholder="akab-… or {{client_token}}"
            @update="setField('username', $event)"
          /><AuthInput
            label="Client secret"
            field="password"
            :value="config().password"
            secret
            @update="setField('password', $event)"
          /><AuthInput
            label="Access token"
            field="token"
            :value="config().token"
            secret
            placeholder="akab-… or {{access_token}}"
            @update="setField('token', $event)"
          />
        </div>
        <div class="form-grid">
          <AuthInput
            label="Headers to sign (optional)"
            option="edgegridHeadersToSign"
            :value="options().edgegridHeadersToSign"
            placeholder="X-Custom-Header, Content-Type"
            @update="setOption('edgegridHeadersToSign', $event)"
          /><AuthInput
            label="Max body size (bytes)"
            option="edgegridMaxBody"
            :value="options().edgegridMaxBody"
            placeholder="131072"
            @update="setOption('edgegridMaxBody', $event)"
          />
        </div>
      </template>

      <template v-else-if="config().auth === 'Hawk'">
        <div class="form-grid auth-grid-3">
          <AuthInput
            label="Hawk ID"
            field="username"
            :value="config().username"
            @update="setField('username', $event)"
          /><AuthInput
            label="Hawk key"
            field="password"
            :value="config().password"
            secret
            @update="setField('password', $event)"
          /><AuthInput
            label="Algorithm"
            option="hawkAlgorithm"
            :value="options().hawkAlgorithm ?? 'sha256'"
            :choices="[
              ['sha256', 'SHA-256'],
              ['sha1', 'SHA-1'],
            ]"
            @update="setOption('hawkAlgorithm', $event)"
          />
        </div>
        <div class="form-grid auth-grid-3">
          <AuthInput
            label="Extra data (ext)"
            option="hawkExt"
            :value="options().hawkExt"
            placeholder="Optional"
            @update="setOption('hawkExt', $event)"
          /><AuthInput
            label="App ID"
            option="hawkApp"
            :value="options().hawkApp"
            placeholder="Optional"
            @update="setOption('hawkApp', $event)"
          /><AuthInput
            label="Delegated by (dlg)"
            option="hawkDlg"
            :value="options().hawkDlg"
            placeholder="Optional, with an app ID"
            @update="setOption('hawkDlg', $event)"
          />
        </div>
        <AuthInput
          label="Include a payload hash"
          option="hawkPayloadHash"
          :value="options().hawkPayloadHash"
          checkbox
          @update="setOption('hawkPayloadHash', $event)"
        />
      </template>

      <template v-else-if="config().auth === 'OAuth 2.0 (request)'">
        <OAuthDiscover
          :url="discoveryURL()"
          :outcome="discovered"
          :open="!options().oauth2TokenUrl"
          @discovered="applyOAuthDiscovery"
        />
        <div class="form-grid">
          <AuthInput
            label="Grant type"
            option="oauth2GrantType"
            :value="grant()"
            :choices="[
              ['authorization_code', 'Authorization code + PKCE'],
              ['client_credentials', 'Client credentials'],
              ['password', 'Password'],
            ]"
            @update="setOption('oauth2GrantType', $event)"
          /><AuthInput
            label="Client authentication"
            option="oauth2ClientAuth"
            :value="
              options().oauth2ClientAuth ?? (grant() === 'authorization_code' ? 'none' : 'basic')
            "
            :choices="[
              ['basic', 'HTTP Basic'],
              ['body', 'Secret in body'],
              ['none', 'Public client'],
            ]"
            @update="setOption('oauth2ClientAuth', $event)"
          />
        </div>
        <AuthInput
          v-if="grant() === 'authorization_code'"
          label="Authorization URL"
          option="oauth2AuthorizationUrl"
          :value="options().oauth2AuthorizationUrl"
          placeholder="https://identity.example.com/authorize"
          @update="setOption('oauth2AuthorizationUrl', $event)"
        />
        <AuthInput
          label="Token URL"
          option="oauth2TokenUrl"
          :value="options().oauth2TokenUrl"
          placeholder="https://identity.example.com/oauth/token"
          @update="setOption('oauth2TokenUrl', $event)"
        />
        <div class="form-grid">
          <AuthInput
            label="Client ID"
            option="oauth2ClientId"
            :value="options().oauth2ClientId"
            @update="setOption('oauth2ClientId', $event)"
          /><AuthInput
            label="Client secret"
            option="oauth2ClientSecret"
            :value="options().oauth2ClientSecret"
            secret
            :placeholder="
              grant() === 'authorization_code' ? 'Optional for public clients' : 'Required'
            "
            @update="setOption('oauth2ClientSecret', $event)"
          /><AuthInput
            label="Scope"
            option="oauth2Scope"
            :value="options().oauth2Scope"
            placeholder="read write"
            @update="setOption('oauth2Scope', $event)"
          />
        </div>
        <UiExpansionPanel
          class="oauth-advanced"
          title="Advanced"
          :description="
            grant() === 'authorization_code'
              ? 'Audience, resource indicator, and callback port'
              : 'Audience and resource indicator'
          "
          icon="tune-variant"
          :badge="advancedCount() ? `${advancedCount()} set` : undefined"
          :open="advancedCount() > 0"
        >
          <div class="form-grid">
            <AuthInput
              label="Audience"
              option="oauth2Audience"
              :value="options().oauth2Audience"
              placeholder="Optional · some providers, such as Auth0, require it"
              @update="setOption('oauth2Audience', $event)"
            /><AuthInput
              v-if="grant() === 'authorization_code'"
              label="Callback port"
              option="oauth2CallbackPort"
              :value="options().oauth2CallbackPort"
              placeholder="43821"
              @update="setOption('oauth2CallbackPort', $event)"
            />
          </div>
          <AuthInput
            label="Resource"
            option="oauth2Resource"
            :value="options().oauth2Resource"
            placeholder="Optional · the API the token is for (RFC 8707)"
            @update="setOption('oauth2Resource', $event)"
          />
        </UiExpansionPanel>
        <div v-if="grant() === 'password'" class="form-grid">
          <AuthInput
            label="Username"
            field="username"
            :value="config().username"
            @update="setField('username', $event)"
          /><AuthInput
            label="Password"
            field="password"
            :value="config().password"
            secret
            @update="setField('password', $event)"
          />
        </div>
        <div class="oauth-inline-token">
          <div class="oauth-inline-token-heading">
            <strong>Access token</strong><UiBadge v-bind="tokenStatus()" /><UiBadge
              v-if="options().oauth2RefreshToken"
              label="Refresh token saved"
            />
          </div>
          <AuthInput
            label="Access token"
            field="token"
            :value="config().token"
            secret
            placeholder="Get a token, or paste one"
            @update="setField('token', $event)"
          />
          <div class="oauth-inline-actions">
            <UiButton
              :label="store.oauthPending ? 'Waiting for provider…' : 'Get new access token'"
              :icon="store.oauthPending ? 'loading' : 'key-variant'"
              variant="primary"
              data-inline-oauth-get
              :disabled="store.oauthPending || !oauthAvailable"
              @click="getToken"
            /><UiButton
              v-if="store.oauthPending"
              label="Cancel"
              variant="ghost"
              data-inline-oauth-cancel
              @click="cancelOAuth"
            /><UiButton
              v-if="config().token"
              label="Clear token"
              icon="delete-outline"
              variant="ghost"
              data-inline-oauth-clear
              @click="clearToken"
            />
          </div>
          <p class="field-help">
            {{ grant() === 'authorization_code' ? 'Opens your browser to sign in. ' : '' }}Expired
            tokens are renewed on send with the refresh token{{
              grant() === 'authorization_code' ? '' : ' or by requesting a new one'
            }}. Tokens and secrets are stored in the local workspace and excluded from exports; use
            the vault's OAuth 2.0 profiles for encrypted storage.
          </p>
        </div>
      </template>

      <div v-else-if="config().auth === 'Inherit from collection'" class="auth-inherit">
        <span class="auth-inherit-icon"><MdiIcon name="folder-outline" /></span>
        <div>
          <strong>{{ folderLabel(inheritedLevel()) }} uses {{ inherited() }}</strong>
          <p>
            {{ AUTH_DESCRIPTIONS[inherited()]
            }}{{
              inherited() === 'None'
                ? ' Configure collection or folder authentication to share it across requests.'
                : ''
            }}
          </p>
        </div>
        <UiButton
          :label="
            inherited() === 'None'
              ? 'Set up collection auth'
              : `Edit ${isCollection(inheritedLevel()) ? 'collection' : 'folder'} auth`
          "
          icon="pencil-outline"
          data-auth-scope="collection"
          @click="setScope('collection', inheritedLevel())"
        />
      </div>

      <div v-else class="auth-empty">
        <span><MdiIcon name="shield-lock-outline" /></span><strong>No authentication</strong>
        <p>
          This
          {{
            store.scope === 'collection'
              ? `${isCollection(level()) ? 'collection' : 'folder'} does not add authentication to inheriting requests`
              : 'request will be sent without authorization'
          }}.
        </p>
      </div>

      <p v-if="store.scope === 'collection'" class="field-help auth-note">
        Default for <strong>{{ folderLabel(level()) }}</strong> · {{ inheriting() }} request{{
          inheriting() === 1 ? '' : 's'
        }}
        inherit{{ inheriting() === 1 ? 's' : '' }} it
      </p>
      <p v-for="note in notes" :key="note" class="field-help auth-note">{{ note }}</p>
    </div>
  </div>
</template>

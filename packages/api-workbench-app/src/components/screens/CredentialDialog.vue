<script setup lang="ts">
import { OPTION_ICONS, withIcons } from '../../select-options';
import { computed, ref, watch } from 'vue';
import * as secretProviders from '@techieutils/api-workbench-common/secret-providers';
import { render } from '../../shell';
import { defaultOAuth, useVaultStore } from '../../stores/vault';
import MdiIcon from '../MdiIcon.vue';
import UiField from '../ui/UiField.vue';
import { errorMessage, objectId } from '../../utils';
import { kindLabels } from '../../stores/vault';
import {
  applyDiscovery,
  type OAuthDiscovery,
} from '@techieutils/api-workbench-common/oauth-discovery';
import OAuthDiscover from '../editor/auth/OAuthDiscover.vue';
import UiExpansionPanel from '../ui/UiExpansionPanel.vue';
import UiSelect from '../ui/UiSelect.vue';

/**
 * Adds or edits a vault credential. The form is uncontrolled and saved from FormData, like the
 * vault expects; choices that change which fields exist (type, secret source, provider auth,
 * JWT algorithm, API key placement) rebuild the draft from the form, which re-creates the fields.
 */
const vault = useVaultStore();
// App.vue mounts this only while a draft is open; closing it unmounts the dialog.
const draft = computed(() => vault.draft!);
const formKey = computed(() => objectId(vault.draft));
const oauth = computed(() => draft.value.oauth || defaultOAuth());
const options = computed(() => draft.value.options || {});
const keep = computed(() => Boolean(draft.value.id));
const asymmetric = computed(
  () => draft.value.kind === 'jwt' && !(options.value.jwtAlgorithm || 'HS256').startsWith('HS'),
);
const secretLabels: Record<string, string> = {
  bearer: 'Bearer token',
  basic: 'Password',
  digest: 'Password',
  'api-key': 'API key value',
  aws: 'Secret access key',
  oauth1: 'Consumer secret',
  ntlm: 'Password',
  wsse: 'Password',
  edgegrid: 'Client secret',
  hawk: 'Hawk key',
  jwt: 'Signing secret',
};
const kinds = computed(() => Object.entries(kindLabels) as [CredentialInput['kind'], string][]);
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
const jwtPayloadPlaceholder = '{\n  "sub": "service-account",\n  "scope": "read"\n}';

// External secret providers
const provider = computed(() =>
  draft.value.external ? secretProviders.definition(draft.value.external.provider) : undefined,
);
const providerFields = computed(() => {
  const external = draft.value.external;
  if (!external) return [];
  const existing = vault.credentials.find((credential) => credential.id === draft.value.id);
  return secretProviders.visibleFields(external).map((field) => {
    const stored = Boolean(
      existing?.external?.provider === external.provider &&
      existing.external.config.auth === external.config.auth &&
      existing.providerSecretFields?.includes(field.key),
    );
    return {
      field,
      name: `provider:${field.key}`,
      value: field.secret
        ? draft.value.providerSecrets?.[field.key] || ''
        : String(external.config[field.key] ?? field.default ?? ''),
      required: Boolean(field.required) && !stored,
      placeholder: stored ? 'Leave blank to keep stored value' : field.placeholder || '',
    };
  });
});

// OAuth 2.0 grant and callback, shown as they are edited.
const grant = ref(oauth.value.grantType);
const callbackPort = ref(String(oauth.value.callbackPort));
watch(formKey, () => {
  grant.value = oauth.value.grantType;
  callbackPort.value = String(oauth.value.callbackPort);
});
function setGrant(event: Event): void {
  grant.value = (event.target as HTMLSelectElement).value as OAuthConfig['grantType'];
  // Client credentials always authenticate the client.
  const clientAuth = document.querySelector<HTMLSelectElement>(
    '#credential-form select[name="clientAuth"]',
  );
  if (grant.value === 'client_credentials' && clientAuth?.value === 'none') {
    clientAuth.value = 'basic';
    clientAuth.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

const saving = ref(false);
const error = ref('');
watch(formKey, () => {
  saving.value = false;
  error.value = '';
});
async function save(event: Event): Promise<void> {
  if (!(event.target as HTMLFormElement).reportValidity()) return;
  saving.value = true;
  try {
    await vault.saveCredentialForm();
  } catch (failure) {
    error.value = errorMessage(failure);
    saving.value = false;
  }
}
function close(): void {
  vault.draft = null;
  render();
}
const rebuild = () => (vault.draft = vault.readCredentialForm());

/** Advanced OAuth settings that differ from the defaults; their panel opens when there are any. */
const advancedOAuth = computed(
  () =>
    [oauth.value.audience, oauth.value.resource].filter((value) => value?.trim()).length +
    (oauth.value.callbackPort !== defaultOAuth().callbackPort ? 1 : 0),
);

// OAuth discovery fills the form by rebuilding the draft, so its outcome is kept here.
const discovered = ref<{ url: string; discovery: OAuthDiscovery; changes: string[] }>();
function applyOAuthDiscovery(discovery: OAuthDiscovery, url: string): void {
  const form = vault.readCredentialForm();
  const current = { ...defaultOAuth(), ...form.oauth };
  const { config, changes } = applyDiscovery(
    { ...current, resource: current.resource || '' },
    discovery,
  );
  vault.draft = { ...form, oauth: config };
  discovered.value = { url, discovery, changes };
}

// Client certificates: files are chosen with the system picker, then read once when saving.
const certificate = computed(
  () => draft.value.clientCertificate || { type: 'pem' as const, host: '' },
);
const certificateFiles = ref<{ certPath?: string; keyPath?: string; pfxPath?: string }>({});
watch(formKey, () => (certificateFiles.value = {}));
const fileName = (file?: string) => (file ? file.split(/[\\/]/).pop() || file : '');
const certificateFileFields = computed(() =>
  certificate.value.type === 'pfx'
    ? ([['pfx', 'pfxPath', 'PFX / P12 bundle']] as const)
    : ([
        ['cert', 'certPath', 'Certificate'],
        ['key', 'keyPath', 'Private key'],
      ] as const),
);
async function chooseCertificateFile(
  kind: 'cert' | 'key' | 'pfx',
  field: 'certPath' | 'keyPath' | 'pfxPath',
): Promise<void> {
  try {
    const chosen = await window.workbench?.certificates?.choose(kind);
    if (chosen) certificateFiles.value = { ...certificateFiles.value, [field]: chosen.path };
  } catch (failure) {
    error.value = errorMessage(failure);
  }
}
</script>

<template>
  <div class="modal-backdrop">
    <section
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="credential-dialog-title"
      tabindex="-1"
    >
      <div class="modal-heading">
        <div>
          <span class="eyebrow">SECURE CREDENTIAL VAULT</span>
          <h2 id="credential-dialog-title">{{ draft.id ? 'Edit' : 'Add' }} credential</h2>
        </div>
        <button
          class="icon-button"
          data-action="close-credential"
          aria-label="Close credential dialog"
          @click="close"
        >
          <MdiIcon name="close" />
        </button>
      </div>
      <form id="credential-form" :key="formKey" @submit.prevent="save">
        <div class="modal-body">
          <div class="form-grid">
            <UiField
              label="Credential name"
              name="name"
              :value="draft.name"
              required
              maxlength="100"
              placeholder="e.g. Production API"
            />
            <label class="form-field"
              ><span>Credential type</span
              ><UiSelect
                id="credential-kind"
                class="field-input"
                name="kind"
                @change="vault.changeCredentialKind()"
                :value="draft.kind"
                :options="withIcons(kinds, OPTION_ICONS.credentialKind)"
            /></label>
          </div>
          <template v-if="draft.kind !== 'client-certificate'">
            <UiField
              label="Allowed API origin"
              name="allowedOrigin"
              :value="draft.allowedOrigin"
              type="url"
              required
              placeholder="https://api.example.com"
            />
            <p class="field-help">
              This credential can only be sent to this exact origin (scheme, host, and port).
            </p>

            <label class="form-field"
              ><span>Secret source</span
              ><UiSelect
                id="credential-source"
                class="field-input"
                name="secretSource"
                @change="vault.changeSource(($event.target as HTMLSelectElement).value)"
                :value="draft.external?.provider || 'local'"
                :options="
                  withIcons(
                    [
                      ['local', 'Local encrypted vault'],
                      ...secretProviders.providers.map(
                        (option) => [option.id, option.label] as [string, string],
                      ),
                    ],
                    OPTION_ICONS.secretSource,
                    'cloud-lock-outline',
                  )
                "
            /></label>
            <div v-if="provider" class="provider-configuration">
              <div class="provider-description">
                <MdiIcon name="shield-lock-outline" />
                <p>{{ provider.description }}</p>
              </div>
              <div class="form-grid">
                <template v-for="item in providerFields" :key="item.name">
                  <label v-if="item.field.options" class="form-field"
                    ><span>{{ item.field.label }}</span
                    ><UiSelect
                      class="field-input"
                      :name="item.name"
                      data-provider-select
                      @change="rebuild"
                      :value="item.value"
                      :options="
                        withIcons(item.field.options, OPTION_ICONS.authChoice, 'tune-variant')
                      "
                  /></label>
                  <label v-else-if="item.field.multiline" class="form-field provider-full-width"
                    ><span>{{ item.field.label }}</span
                    ><textarea
                      class="field-input provider-secret-editor"
                      :name="item.name"
                      rows="3"
                      :required="item.required"
                      autocomplete="off"
                      spellcheck="false"
                      :placeholder="item.placeholder"
                      :defaultValue="item.value"
                    ></textarea>
                  </label>
                  <UiField
                    v-else
                    :label="item.field.label"
                    :name="item.name"
                    :value="item.value"
                    :type="item.field.secret ? 'password' : 'text'"
                    :required="item.required"
                    :autocomplete="item.field.secret ? 'new-password' : 'off'"
                    :placeholder="item.placeholder"
                  />
                </template>
              </div>
              <UiField
                label="JSON Pointer to secret value (optional)"
                name="secretField"
                :value="draft.secretField || ''"
                placeholder="/api_key"
              />
              <p class="field-help">
                Leave blank for a plain string secret. For Vault KV objects or JSON secrets, select
                a string field with a JSON Pointer such as /token or /credentials/password.{{
                  draft.kind === 'oauth2'
                    ? ' The selected value supplies the OAuth client secret.'
                    : ' The selected value supplies the token, API key, or Basic password.'
                }}
              </p>
              <p class="field-help">
                Provider authentication is encrypted locally. Remote values are read when used and
                stay in the main process. Save, then use Test access to check the lookup.
              </p>
            </div>
          </template>
          <div v-else class="certificate-credential">
            <div class="form-grid">
              <UiField
                label="Host"
                name="certificateHost"
                :value="certificate.host"
                required
                autocomplete="off"
                placeholder="api.example.com or *.example.com"
              />
              <UiField
                label="Port"
                name="certificatePort"
                :value="certificate.port ? String(certificate.port) : ''"
                inputmode="numeric"
                placeholder="Any"
              />
            </div>
            <p class="field-help">
              Presented automatically to matching hosts over HTTPS, wss://, HTTPS streams, and TLS
              gRPC. The most specific match wins: exact host over wildcard, a specific port over any
              port.
            </p>
            <label class="form-field"
              ><span>Format</span
              ><UiSelect
                id="certificate-type"
                class="field-input"
                name="certificateType"
                @change="rebuild"
                :value="certificate.type"
                :options="
                  withIcons(
                    [
                      ['pem', 'PEM certificate and private key'],
                      ['pfx', 'PFX / P12 bundle'],
                    ],
                    OPTION_ICONS.authChoice,
                  )
                "
            /></label>
            <div class="form-grid">
              <div
                v-for="[kind, field, label] in certificateFileFields"
                :key="field"
                class="form-field cert-file"
              >
                <span>{{ label }}</span
                ><button
                  type="button"
                  :class="['cert-file-button', { 'has-file': certificateFiles[field] }]"
                  :data-cert-choose="kind"
                  :title="certificateFiles[field] || ''"
                  @click="chooseCertificateFile(kind, field)"
                >
                  <MdiIcon
                    :name="certificateFiles[field] ? 'file-code-outline' : 'tray-arrow-down'"
                  /><span>{{
                    fileName(certificateFiles[field]) ||
                    (keep ? 'Keep the stored file' : 'Choose file…')
                  }}</span>
                </button>
                <input type="hidden" :name="field" :value="certificateFiles[field] || ''" />
              </div>
              <UiField
                label="Passphrase"
                name="extraSecret"
                type="password"
                autocomplete="new-password"
                :placeholder="
                  keep
                    ? 'Leave blank to keep the saved passphrase'
                    : certificate.type === 'pem'
                      ? 'Only for encrypted keys'
                      : 'Optional'
                "
              />
            </div>
            <p class="field-help">
              The certificate, its private key, and the passphrase are copied into the encrypted
              vault; the files are not used after saving. Choose new files to replace them.
            </p>
          </div>

          <template v-if="draft.kind !== 'oauth2' && draft.kind !== 'client-certificate'">
            <div v-if="draft.kind === 'basic' || draft.kind === 'digest'" class="form-grid">
              <UiField
                label="Username"
                name="username"
                :value="draft.username || ''"
                required
                autocomplete="off"
              />
              <UiField
                v-if="!draft.external"
                :label="secretLabels[draft.kind]"
                name="secret"
                type="password"
                autocomplete="new-password"
                :required="!keep"
                :placeholder="keep ? 'Leave blank to keep the saved value' : 'Enter secret'"
              />
            </div>
            <p v-if="draft.kind === 'digest'" class="field-help">
              Answers the server’s Digest challenge (MD5 or SHA-256, including -sess) on each
              request.
            </p>
            <template v-if="draft.kind === 'api-key'">
              <div class="form-grid">
                <label class="form-field"
                  ><span>Send as</span
                  ><UiSelect
                    class="field-input"
                    name="apiKeyIn"
                    @change="vault.changeCredentialOption('apiKeyIn')"
                    :value="options.apiKeyIn || 'header'"
                    :options="
                      withIcons(
                        [
                          ['header', 'Header'],
                          ['query', 'Query parameter'],
                        ],
                        OPTION_ICONS.authChoice,
                      )
                    "
                /></label>
                <UiField
                  :label="options.apiKeyIn === 'query' ? 'Parameter name' : 'Header name'"
                  name="headerName"
                  :value="
                    draft.headerName || (options.apiKeyIn === 'query' ? 'api_key' : 'X-API-Key')
                  "
                  required
                />
              </div>
            </template>
            <div v-if="draft.kind === 'aws'" class="form-grid">
              <UiField
                label="Access key ID"
                name="username"
                :value="draft.username || ''"
                required
                autocomplete="off"
                placeholder="AKIA…"
              />
              <UiField
                v-if="!draft.external"
                :label="secretLabels.aws"
                name="secret"
                type="password"
                autocomplete="new-password"
                :required="!keep"
                :placeholder="keep ? 'Leave blank to keep the saved value' : 'Enter secret'"
              />
              <UiField
                label="Region"
                name="awsRegion"
                :value="options.awsRegion || ''"
                required
                placeholder="us-east-1"
              />
              <UiField
                label="Service"
                name="awsService"
                :value="options.awsService || ''"
                required
                placeholder="execute-api, s3, lambda…"
              />
            </div>
            <div v-if="draft.kind === 'oauth1'" class="form-grid">
              <UiField
                label="Consumer key"
                name="username"
                :value="draft.username || ''"
                required
                autocomplete="off"
              />
              <UiField
                v-if="!draft.external"
                :label="secretLabels.oauth1"
                name="secret"
                type="password"
                autocomplete="new-password"
                :required="!keep"
                :placeholder="keep ? 'Leave blank to keep the saved value' : 'Enter secret'"
              />
              <UiField
                label="Access token"
                name="oauth1Token"
                :value="options.oauth1Token || ''"
                autocomplete="off"
                placeholder="Optional"
              />
              <UiField
                label="Token secret"
                name="extraSecret"
                type="password"
                autocomplete="new-password"
                :placeholder="keep ? 'Leave blank to keep the saved value' : 'Optional'"
              />
              <label class="form-field"
                ><span>Signature method</span
                ><UiSelect
                  class="field-input"
                  name="oauth1SignatureMethod"
                  :value="options.oauth1SignatureMethod || 'HMAC-SHA1'"
                  :options="
                    withIcons(['HMAC-SHA1', 'HMAC-SHA256', 'PLAINTEXT'], 'function-variant')
                  "
              /></label>
              <UiField
                label="Realm"
                name="oauth1Realm"
                :value="options.oauth1Realm || ''"
                placeholder="Optional"
              />
            </div>
            <div v-if="draft.kind === 'ntlm' || draft.kind === 'wsse'" class="form-grid">
              <UiField
                label="Username"
                name="username"
                :value="draft.username || ''"
                required
                autocomplete="off"
                :placeholder="draft.kind === 'ntlm' ? 'user, or DOMAIN\\user' : ''"
              />
              <UiField
                v-if="!draft.external"
                :label="secretLabels[draft.kind]"
                name="secret"
                type="password"
                autocomplete="new-password"
                :required="!keep"
                :placeholder="keep ? 'Leave blank to keep the saved value' : 'Enter secret'"
              />
              <template v-if="draft.kind === 'ntlm'">
                <UiField
                  label="Domain"
                  name="ntlmDomain"
                  :value="options.ntlmDomain || ''"
                  placeholder="Optional"
                />
                <UiField
                  label="Workstation"
                  name="ntlmWorkstation"
                  :value="options.ntlmWorkstation || ''"
                  placeholder="Optional"
                />
              </template>
            </div>
            <p v-if="draft.kind === 'ntlm'" class="field-help">
              Negotiates NTLMv2 with the server over one keep-alive connection. HTTP requests only.
            </p>
            <template v-if="draft.kind === 'edgegrid'">
              <div class="form-grid">
                <UiField
                  label="Client token"
                  name="username"
                  :value="draft.username || ''"
                  required
                  autocomplete="off"
                  placeholder="akab-…"
                />
                <UiField
                  v-if="!draft.external"
                  :label="secretLabels.edgegrid"
                  name="secret"
                  type="password"
                  autocomplete="new-password"
                  :required="!keep"
                  :placeholder="keep ? 'Leave blank to keep the saved value' : 'Enter secret'"
                />
                <UiField
                  label="Access token"
                  name="extraSecret"
                  type="password"
                  autocomplete="new-password"
                  :required="!keep"
                  :placeholder="keep ? 'Leave blank to keep the saved value' : 'akab-…'"
                />
                <UiField
                  label="Max body size (bytes)"
                  name="edgegridMaxBody"
                  :value="options.edgegridMaxBody || ''"
                  inputmode="numeric"
                  placeholder="131072"
                />
              </div>
              <UiField
                label="Headers to sign (optional)"
                name="edgegridHeadersToSign"
                :value="options.edgegridHeadersToSign || ''"
                placeholder="X-Custom-Header, Content-Type"
              />
            </template>
            <template v-if="draft.kind === 'hawk'">
              <div class="form-grid">
                <UiField
                  label="Hawk ID"
                  name="username"
                  :value="draft.username || ''"
                  required
                  autocomplete="off"
                />
                <UiField
                  v-if="!draft.external"
                  :label="secretLabels.hawk"
                  name="secret"
                  type="password"
                  autocomplete="new-password"
                  :required="!keep"
                  :placeholder="keep ? 'Leave blank to keep the saved value' : 'Enter secret'"
                />
                <label class="form-field"
                  ><span>Algorithm</span
                  ><UiSelect
                    class="field-input"
                    name="hawkAlgorithm"
                    :value="options.hawkAlgorithm || 'sha256'"
                    :options="
                      withIcons(
                        [
                          ['sha256', 'SHA-256'],
                          ['sha1', 'SHA-1'],
                        ],
                        'function-variant',
                      )
                    "
                /></label>
                <UiField
                  label="Extra data (ext)"
                  name="hawkExt"
                  :value="options.hawkExt || ''"
                  placeholder="Optional"
                />
                <UiField
                  label="App ID"
                  name="hawkApp"
                  :value="options.hawkApp || ''"
                  placeholder="Optional"
                />
                <UiField
                  label="Delegated by (dlg)"
                  name="hawkDlg"
                  :value="options.hawkDlg || ''"
                  placeholder="Optional, with an app ID"
                />
              </div>
              <label class="auth-check"
                ><input
                  type="checkbox"
                  name="hawkPayloadHash"
                  :checked="options.hawkPayloadHash === true"
                /><span>Include a payload hash</span></label
              >
            </template>
            <template v-if="draft.kind === 'jwt'">
              <div class="form-grid">
                <label class="form-field"
                  ><span>Algorithm</span
                  ><UiSelect
                    class="field-input"
                    name="jwtAlgorithm"
                    @change="vault.changeCredentialOption('jwtAlgorithm')"
                    :value="options.jwtAlgorithm || 'HS256'"
                    :options="withIcons(jwtAlgorithms, 'function-variant')"
                /></label>
                <UiField
                  label="Header prefix"
                  name="jwtPrefix"
                  :value="options.jwtPrefix ?? 'Bearer'"
                  placeholder="Bearer"
                />
                <UiField
                  label="Expires in (seconds)"
                  name="jwtExpiresIn"
                  :value="options.jwtExpiresIn || ''"
                  inputmode="numeric"
                  placeholder="0 = no exp claim"
                />
              </div>
              <label v-if="!draft.external && asymmetric" class="form-field"
                ><span>Private key (PEM)</span
                ><textarea
                  class="field-input auth-textarea"
                  name="secret"
                  rows="4"
                  spellcheck="false"
                  :placeholder="
                    keep ? 'Leave blank to keep the saved key' : '-----BEGIN PRIVATE KEY-----'
                  "
                ></textarea>
              </label>
              <UiField
                v-else-if="!draft.external"
                :label="secretLabels.jwt"
                name="secret"
                type="password"
                autocomplete="new-password"
                :required="!keep"
                :placeholder="keep ? 'Leave blank to keep the saved value' : 'Enter secret'"
              />
              <label v-if="!asymmetric" class="auth-check"
                ><input
                  type="checkbox"
                  name="jwtSecretBase64"
                  :checked="options.jwtSecretBase64 === true"
                /><span>Secret is Base64 encoded</span></label
              >
              <label class="form-field"
                ><span>Payload (JSON)</span
                ><textarea
                  class="field-input auth-textarea"
                  name="jwtPayload"
                  rows="4"
                  spellcheck="false"
                  :placeholder="jwtPayloadPlaceholder"
                  :defaultValue="options.jwtPayload || ''"
                ></textarea>
              </label>
              <UiField
                label="Extra header claims (JSON, optional)"
                name="jwtHeader"
                :value="options.jwtHeader || ''"
                placeholder='{"kid": "key-1"}'
              />
              <p class="field-help">
                A fresh token is signed for every request. Vault payloads are used as written;
                environment variables are not substituted.
              </p>
            </template>
            <UiField
              v-if="['bearer', 'api-key'].includes(draft.kind) && !draft.external"
              :label="secretLabels[draft.kind]"
              name="secret"
              type="password"
              autocomplete="new-password"
              :required="!keep"
              :placeholder="keep ? 'Leave blank to keep the saved value' : 'Enter secret'"
            />
            <template v-if="draft.kind === 'aws'">
              <UiField
                label="Session token (optional)"
                name="extraSecret"
                type="password"
                autocomplete="new-password"
                :placeholder="keep ? 'Leave blank to keep the saved value' : 'Optional'"
              />
              <p class="field-help">Requests are signed with AWS Signature Version 4 when sent.</p>
            </template>
          </template>

          <template v-else-if="draft.kind === 'oauth2'">
            <div class="form-divider">OAUTH 2.0 CONFIGURATION</div>
            <OAuthDiscover
              :url="discovered?.url || draft.allowedOrigin"
              :outcome="discovered"
              :open="!oauth.tokenUrl"
              @discovered="applyOAuthDiscovery"
            />
            <div class="form-grid">
              <label class="form-field"
                ><span>Grant type</span
                ><UiSelect
                  id="oauth-grant"
                  class="field-input"
                  name="grantType"
                  @change="setGrant"
                  :value="oauth.grantType"
                  :options="
                    withIcons(
                      [
                        ['authorization_code', 'Authorization code + PKCE'],
                        ['client_credentials', 'Client credentials'],
                      ],
                      OPTION_ICONS.authChoice,
                    )
                  "
              /></label>
              <label class="form-field"
                ><span>Client authentication</span
                ><UiSelect
                  class="field-input"
                  name="clientAuth"
                  :value="oauth.clientAuth"
                  :options="
                    withIcons(
                      [
                        ['none', 'Public client (no secret)'],
                        ['basic', 'HTTP Basic'],
                        ['body', 'Secret in request body'],
                      ],
                      OPTION_ICONS.authChoice,
                    )
                  "
              /></label>
            </div>
            <div id="authorization-url-row" :hidden="grant === 'client_credentials'">
              <UiField
                label="Authorization URL"
                name="authorizationUrl"
                :value="oauth.authorizationUrl"
                type="url"
                placeholder="https://identity.example.com/authorize"
              />
            </div>
            <UiField
              label="Token URL"
              name="tokenUrl"
              :value="oauth.tokenUrl"
              type="url"
              required
              placeholder="https://identity.example.com/oauth/token"
            />
            <div class="form-grid">
              <UiField
                label="Client ID"
                name="clientId"
                :value="oauth.clientId"
                required
                autocomplete="off"
              />
              <UiField
                v-if="!draft.external"
                label="Client secret (if required)"
                name="clientSecret"
                :value="oauth.clientSecret || ''"
                type="password"
                autocomplete="new-password"
                :placeholder="keep ? 'Leave blank to retain secret' : 'Optional for public clients'"
              />
              <p v-else class="field-help">Client secret is read from the selected provider.</p>
            </div>
            <UiField
              label="Scopes"
              name="scope"
              :value="oauth.scope"
              placeholder="openid profile api.read"
            />
            <div class="info-callout">
              Register
              <code id="redirect-preview">http://127.0.0.1:{{ callbackPort }}/oauth/callback</code>
              with your provider for authorization code flows. Login opens in your system browser
              with PKCE (S256). Saving changes clears existing tokens.
            </div>
            <!-- Fields inside a closed panel still submit with the form. -->
            <UiExpansionPanel
              class="oauth-advanced"
              title="Advanced"
              description="Audience, resource indicator, and loopback callback port"
              icon="tune-variant"
              :badge="advancedOAuth ? `${advancedOAuth} set` : undefined"
              :open="advancedOAuth > 0"
            >
              <div class="form-grid">
                <UiField
                  label="Audience (optional)"
                  name="audience"
                  :value="oauth.audience"
                  placeholder="https://api.example.com"
                />
                <UiField
                  label="Loopback callback port"
                  name="callbackPort"
                  :value="String(oauth.callbackPort)"
                  type="number"
                  min="1024"
                  max="65535"
                  required
                  @input="callbackPort = ($event.target as HTMLInputElement).value"
                />
              </div>
              <UiField
                label="Resource (optional)"
                name="resource"
                :value="oauth.resource || ''"
                type="url"
                placeholder="https://api.example.com — the API the token is for (RFC 8707)"
              />
            </UiExpansionPanel>
          </template>
          <p id="credential-error" class="form-error" role="alert">{{ error }}</p>
        </div>
        <div class="modal-footer">
          <span><MdiIcon name="shield-lock-outline" /> Encrypted by your operating system</span
          ><button
            class="subtle-button"
            type="button"
            data-action="close-credential"
            @click="close"
          >
            Cancel</button
          ><button id="save-credential" class="primary-button" type="submit" :disabled="saving">
            {{ saving ? 'Saving…' : 'Save credential' }}
          </button>
        </div>
      </form>
    </section>
  </div>
</template>

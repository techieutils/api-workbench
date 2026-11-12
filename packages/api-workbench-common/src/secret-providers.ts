export type SecretProvider =
  | 'aws-secrets-manager'
  | 'aws-ssm'
  | 'azure-key-vault'
  | 'hashicorp-vault'
  | 'sap-btp'
  | 'gcp-secret-manager';
export interface ExternalSecretConfig {
  provider: SecretProvider;
  config: Record<string, string>;
}
export interface ProviderField {
  key: string;
  label: string;
  secret?: boolean;
  multiline?: boolean;
  required?: boolean;
  placeholder?: string;
  default?: string;
  options?: [string, string][];
  when?: { key: string; values: string[] };
}
export interface ProviderDefinition {
  id: SecretProvider;
  label: string;
  description: string;
  fields: ProviderField[];
}
const awsFields: ProviderField[] = [
  { key: 'region', label: 'AWS region', required: true, placeholder: 'us-east-1' },
  { key: 'secretId', label: 'Secret / parameter name or ARN', required: true },
  {
    key: 'auth',
    label: 'AWS authentication',
    default: 'default',
    options: [
      ['default', 'Default AWS credential chain'],
      ['profile', 'Shared AWS profile'],
      ['keys', 'Access keys'],
    ],
  },
  {
    key: 'profile',
    label: 'AWS profile name',
    required: true,
    when: { key: 'auth', values: ['profile'] },
  },
  {
    key: 'accessKeyId',
    label: 'Access key ID',
    secret: true,
    required: true,
    when: { key: 'auth', values: ['keys'] },
  },
  {
    key: 'secretAccessKey',
    label: 'Secret access key',
    secret: true,
    required: true,
    when: { key: 'auth', values: ['keys'] },
  },
  {
    key: 'sessionToken',
    label: 'Session token (optional)',
    secret: true,
    when: { key: 'auth', values: ['keys'] },
  },
];
export const providers: ProviderDefinition[] = [
  {
    id: 'aws-secrets-manager',
    label: 'AWS Secrets Manager',
    description:
      'Read SecretString or UTF-8 SecretBinary using AWS credentials, shared profiles, or access keys.',
    fields: [
      ...awsFields,
      { key: 'version', label: 'Version stage (optional)', placeholder: 'AWSCURRENT' },
    ],
  },
  {
    id: 'aws-ssm',
    label: 'AWS Systems Manager Parameter Store',
    description:
      'Read a parameter with decryption enabled. The AWS identity needs ssm:GetParameter and applicable KMS permissions.',
    fields: awsFields,
  },
  {
    id: 'azure-key-vault',
    label: 'Azure Key Vault',
    description:
      'Read a secret using a Microsoft Entra application or an existing Key Vault access token.',
    fields: [
      {
        key: 'vaultUrl',
        label: 'Vault URL',
        required: true,
        placeholder: 'https://my-vault.vault.azure.net',
      },
      { key: 'secretName', label: 'Secret name', required: true },
      { key: 'version', label: 'Secret version (optional)' },
      {
        key: 'auth',
        label: 'Azure authentication',
        default: 'client-secret',
        options: [
          ['client-secret', 'Entra client credentials'],
          ['token', 'Access token'],
        ],
      },
      {
        key: 'tenantId',
        label: 'Tenant ID',
        required: true,
        when: { key: 'auth', values: ['client-secret'] },
      },
      {
        key: 'clientId',
        label: 'Application (client) ID',
        required: true,
        when: { key: 'auth', values: ['client-secret'] },
      },
      {
        key: 'clientSecret',
        label: 'Application client secret',
        secret: true,
        required: true,
        when: { key: 'auth', values: ['client-secret'] },
      },
      {
        key: 'accessToken',
        label: 'Key Vault access token',
        secret: true,
        required: true,
        when: { key: 'auth', values: ['token'] },
      },
    ],
  },
  {
    id: 'hashicorp-vault',
    label: 'HashiCorp Vault / OpenBao',
    description:
      'Read a KV v1 or KV v2 secret using a token or AppRole, with optional enterprise namespace.',
    fields: [
      {
        key: 'vaultUrl',
        label: 'Vault address',
        required: true,
        placeholder: 'https://vault.example.com:8200',
      },
      { key: 'mount', label: 'KV mount path', default: 'secret', required: true },
      { key: 'path', label: 'Secret path', required: true, placeholder: 'apps/my-api' },
      {
        key: 'kvVersion',
        label: 'KV engine version',
        default: '2',
        options: [
          ['2', 'KV v2'],
          ['1', 'KV v1'],
        ],
      },
      {
        key: 'version',
        label: 'Secret version (KV v2, optional)',
        when: { key: 'kvVersion', values: ['2'] },
      },
      { key: 'namespace', label: 'Vault namespace (optional)' },
      {
        key: 'auth',
        label: 'Vault authentication',
        default: 'token',
        options: [
          ['token', 'Vault token'],
          ['approle', 'AppRole'],
        ],
      },
      {
        key: 'token',
        label: 'Vault token',
        secret: true,
        required: true,
        when: { key: 'auth', values: ['token'] },
      },
      {
        key: 'authMount',
        label: 'AppRole auth mount',
        default: 'approle',
        required: true,
        when: { key: 'auth', values: ['approle'] },
      },
      {
        key: 'roleId',
        label: 'AppRole role ID',
        secret: true,
        required: true,
        when: { key: 'auth', values: ['approle'] },
      },
      {
        key: 'secretId',
        label: 'AppRole secret ID',
        secret: true,
        required: true,
        when: { key: 'auth', values: ['approle'] },
      },
    ],
  },
  {
    id: 'sap-btp',
    label: 'SAP BTP Credential Store',
    description:
      'Read a password or key using a Basic-auth service key. Encrypted JWE responses are decrypted only in the main process.',
    fields: [
      {
        key: 'serviceUrl',
        label: 'Service key URL (credentials base)',
        required: true,
        placeholder: 'https://…/api/v1/credentials',
      },
      { key: 'namespace', label: 'Credential namespace', required: true },
      { key: 'credentialName', label: 'Credential name', required: true },
      {
        key: 'credentialType',
        label: 'Credential type',
        default: 'password',
        options: [
          ['password', 'Password'],
          ['key', 'Key (base64 value)'],
        ],
      },
      { key: 'bindingUsername', label: 'Service key username', secret: true, required: true },
      { key: 'bindingPassword', label: 'Service key password', secret: true, required: true },
      {
        key: 'privateKey',
        label: 'encryption.client_private_key (PEM or base64 PKCS#8)',
        secret: true,
        multiline: true,
        required: true,
      },
    ],
  },
  {
    id: 'gcp-secret-manager',
    label: 'Google Cloud Secret Manager',
    description:
      'Read a secret version using Application Default Credentials, a service account JSON key, or an access token.',
    fields: [
      { key: 'projectId', label: 'Google Cloud project ID / number', required: true },
      { key: 'secretName', label: 'Secret name', required: true },
      { key: 'version', label: 'Secret version', default: 'latest', required: true },
      {
        key: 'auth',
        label: 'Google authentication',
        default: 'adc',
        options: [
          ['adc', 'Application Default Credentials'],
          ['service-account', 'Service account JSON'],
          ['token', 'Access token'],
        ],
      },
      {
        key: 'serviceAccount',
        label: 'Service account JSON key',
        secret: true,
        multiline: true,
        required: true,
        when: { key: 'auth', values: ['service-account'] },
      },
      {
        key: 'accessToken',
        label: 'Google access token',
        secret: true,
        required: true,
        when: { key: 'auth', values: ['token'] },
      },
    ],
  },
];
export function definition(id: string): ProviderDefinition {
  const result = providers.find((provider) => provider.id === id);
  if (!result) throw new Error('Unsupported secret provider.');
  return result;
}
export function defaults(id: SecretProvider): ExternalSecretConfig {
  return {
    provider: id,
    config: Object.fromEntries(
      definition(id)
        .fields.filter((field) => !field.secret && field.default !== undefined)
        .map((field) => [field.key, field.default!]),
    ),
  };
}
export function visibleFields(external: ExternalSecretConfig): ProviderField[] {
  return definition(external.provider).fields.filter(
    (field) => !field.when || field.when.values.includes(external.config[field.when.key] || ''),
  );
}

/**
 * Where people get help with API Workbench, and report problems: its GitHub repository's issue
 * forms (filled in with what the app or extension knows), the private security advisory form,
 * and the documentation site. Shared by the app's Settings and the VS Code extension, so both
 * send people to the same places. Links are built from fixed addresses; what is filled in is
 * the person's own text and the program's version, never workspace data.
 */

export const REPOSITORY_URL = 'https://github.com/techieutils/api-workbench';
export const SITE_URL = 'https://techieutils.github.io/api-workbench';

export const SUPPORT_LINKS = {
  repository: REPOSITORY_URL,
  issues: `${REPOSITORY_URL}/issues`,
  releases: `${REPOSITORY_URL}/releases`,
  /** Vulnerabilities are reported privately, never in a public issue. */
  security: `${REPOSITORY_URL}/security/advisories/new`,
  securityPolicy: `${REPOSITORY_URL}/blob/main/SECURITY.md`,
  docs: `${SITE_URL}/docs/index.html`,
  troubleshooting: `${SITE_URL}/docs/troubleshooting.html`,
  faq: `${SITE_URL}/docs/faq.html`,
  changelog: `${SITE_URL}/docs/changelog.html`,
  vscode: `${SITE_URL}/docs/vscode.html`,
} as const;

/**
 * The guide for each part of the app and the extension, by its page on the documentation site
 * (`docs/<page>.md` becomes `docs/<page>.html`). Screens link here so a person can read how the
 * feature works without searching; the extension accepts only these names from its pages.
 */
export const GUIDES = {
  overview: 'getting-started',
  requests: 'requests',
  scripts: 'scripts',
  tests: 'tests',
  authentication: 'authentication',
  variables: 'variables',
  environments: 'environments',
  collections: 'collections',
  history: 'history',
  specs: 'api-specs',
  documentation: 'api-documentation',
  mocks: 'mock-servers',
  runner: 'runner',
  cookies: 'cookies',
  interceptor: 'interceptor',
  credentials: 'credentials',
  certificates: 'client-certificates',
  liveProtocols: 'live-protocols',
  grpc: 'grpc',
  settings: 'settings',
  shortcuts: 'shortcuts',
  updates: 'updates',
  workspaces: 'workspaces',
  vscode: 'vscode',
  cli: 'cli',
} as const;
export type GuideName = keyof typeof GUIDES;

export const isGuideName = (name: unknown): name is GuideName =>
  typeof name === 'string' && Object.hasOwn(GUIDES, name);

/** The documentation site's page for a guide, optionally at one of its headings. */
export const guideUrl = (name: GuideName, heading?: string): string =>
  `${SITE_URL}/docs/${GUIDES[name]}.html${heading ? `#${encodeURIComponent(heading)}` : ''}`;

/** The issue form's operating system choice for a Node or browser platform name. */
export function osName(platform: string): 'macOS' | 'Windows' | 'Linux' {
  const name = platform.toLowerCase();
  if (name.startsWith('mac') || name === 'darwin') return 'macOS';
  if (name.startsWith('win')) return 'Windows';
  return 'Linux';
}

/** Long fields are cut, as browsers and GitHub refuse very long addresses. */
const MAX_FIELD = 1500;
const cut = (text: string) => (text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD)}\n…` : text);

/**
 * GitHub's bug report form, with the version, operating system, and diagnostic details (such as
 * the VS Code version) already filled in; the person writes what happened.
 */
export function bugReportUrl(fields: {
  version: string;
  platform: string;
  details?: string;
  title?: string;
}): string {
  const query = new URLSearchParams({
    template: 'bug_report.yml',
    ...(fields.title ? { title: fields.title.slice(0, 200) } : {}),
    version: fields.version.slice(0, 200),
    os: osName(fields.platform),
    ...(fields.details ? { extra: cut(fields.details) } : {}),
  });
  return `${SUPPORT_LINKS.issues}/new?${query}`;
}

/** GitHub's feature request form, optionally started with the problem it solves. */
export function featureRequestUrl(fields: { title?: string; problem?: string } = {}): string {
  const query = new URLSearchParams({
    template: 'feature_request.yml',
    ...(fields.title ? { title: fields.title.slice(0, 200) } : {}),
    ...(fields.problem ? { problem: cut(fields.problem) } : {}),
  });
  return `${SUPPORT_LINKS.issues}/new?${query}`;
}

/** Issues already reported that mention `words`, to look before reporting again. */
export const issueSearchUrl = (words: string) =>
  `${SUPPORT_LINKS.issues}?${new URLSearchParams({ q: `is:issue ${words.slice(0, 200)}` })}`;

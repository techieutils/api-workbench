import { SUPPORT_LINKS } from '@techieutils/api-workbench-common/support-links';

/**
 * What a bug report from VS Code says about where it happened: versions, how the command line
 * runs, the platform, and how many workspaces of each kind are open. Never a path, a workspace
 * or request name, a URL, or a setting's value beyond the engine, as issues are public.
 */
export function diagnostics(info: {
  extensionVersion: string;
  vscodeVersion: string;
  appName: string;
  platform: string;
  arch: string;
  engine: string;
  cliVersion?: string;
  remote?: string;
  uiKind: 'desktop' | 'web';
  teamFolders: number;
  appWorkspaces: number;
}): string {
  return [
    `API Workbench for VS Code ${info.extensionVersion}`,
    `${info.appName.replace(/[^\w .-]/g, '').slice(0, 40)} ${info.vscodeVersion} (${info.uiKind}${
      info.remote
        ? `, remote: ${info.remote
            .split('+')[0]
            .replace(/[^\w.-]/g, '')
            .slice(0, 30)}`
        : ''
    })`,
    `Platform: ${info.platform} ${info.arch}`,
    `Engine: ${info.engine === 'builtIn' ? 'built in' : 'command line'}${info.cliVersion ? `, command line ${info.cliVersion.replace(/[^\w .+-]/g, '').slice(0, 40)}` : ''}`,
    `Open: ${info.teamFolders} team folder${info.teamFolders === 1 ? '' : 's'}, ${info.appWorkspaces} app workspace${info.appWorkspaces === 1 ? '' : 's'}`,
  ].join('\n');
}

/** The Help and Feedback view's entries: what each does, its icon, and its command. */
export const HELP_ITEMS = [
  {
    label: 'Report a problem',
    description: 'Opens GitHub’s bug form, filled in',
    icon: 'bug',
    command: 'apiWorkbench.reportIssue',
  },
  {
    label: 'Request a feature',
    description: 'Opens GitHub’s feature form',
    icon: 'lightbulb',
    command: 'apiWorkbench.requestFeature',
  },
  {
    label: 'Search known issues',
    description: 'Before reporting again',
    icon: 'search',
    command: 'apiWorkbench.searchIssues',
  },
  {
    label: 'Report a security vulnerability',
    description: 'Privately, never in an issue',
    icon: 'shield',
    command: 'apiWorkbench.reportVulnerability',
  },
  {
    label: 'Documentation',
    description: 'Guides for every feature',
    icon: 'book',
    command: 'apiWorkbench.openDocs',
  },
  {
    label: 'Troubleshooting and FAQ',
    description: 'Common problems',
    icon: 'question',
    command: 'apiWorkbench.openTroubleshooting',
  },
  {
    label: 'What’s new',
    description: 'The changelog',
    icon: 'history',
    command: 'apiWorkbench.openChangelog',
  },
  {
    label: 'View on GitHub',
    description: 'Source, releases, and issues',
    icon: 'github',
    command: 'apiWorkbench.openRepository',
  },
  {
    label: 'Copy diagnostic information',
    description: 'Versions and platform, for a report',
    icon: 'copy',
    command: 'apiWorkbench.copyDiagnostics',
  },
] as const;

/** Where each of the support commands that only open a page goes. */
export const HELP_PAGES: Record<string, string> = {
  'apiWorkbench.reportVulnerability': SUPPORT_LINKS.security,
  'apiWorkbench.openDocs': SUPPORT_LINKS.vscode,
  'apiWorkbench.openTroubleshooting': SUPPORT_LINKS.troubleshooting,
  'apiWorkbench.openChangelog': SUPPORT_LINKS.changelog,
  'apiWorkbench.openRepository': SUPPORT_LINKS.repository,
};

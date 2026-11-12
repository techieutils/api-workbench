/** The command palette's commands; the dialog is src/components/dialogs/CommandPalette.vue. */
import { useSpecsStore } from '../stores/api-specs';
import { useMocksStore } from '../stores/mocks';
import type { ApiRequest, AppSettings } from '@techieutils/api-workbench-common/types';
import { collectionOf, isWithin } from '@techieutils/api-workbench-common/folders';
import {
  effectiveTags,
  emptyTagFilter,
  sameTag,
  tagCounts,
  tagFilterActive,
  type TagFilter,
} from '@techieutils/api-workbench-common/tags';
import { useRunnerStore } from '../stores/runner';
import { useScreensStore } from '../stores/screens';
import { render } from '../shell';
import { action } from '../actions';
import { errorMessage, toast } from '../utils';
import { useRequestsStore } from '../stores/requests';
import { useVaultStore } from '../stores/vault';
import { requestProtocol } from '../stores/protocols';
import { useCookiesStore } from '../stores/cookies';
import { useDialogsStore } from '../stores/dialogs';
import { useRequestTabsStore } from '../stores/request-tabs';
import { useUpdatesStore } from '../stores/updates';
import { SUPPORT_LINKS, bugReportUrl } from '@techieutils/api-workbench-common/support-links';
import { useSettingsStore } from '../stores/settings';
import { useToolsStore } from '../stores/tools';
import { DEV_TOOLS_TABS, useUiStore } from '../stores/ui';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkspacesStore } from '../stores/workspaces';

export interface PaletteCommand {
  id: string;
  title: string;
  group: string;
  icon: MdiIconName;
  shortcut?: string;
  keywords?: string;
  /**
   * Tags a `#tag` in the query matches exactly. Commands with tags (the tag commands and the
   * tagged requests) are listed only once something is typed, so the list stays short.
   */
  tags?: string[];
  run: () => void | Promise<void>;
}
function goToView(name: string): void {
  if (name === 'Credentials') {
    void useVaultStore().openCredentialsPage();
    return;
  }
  useUiStore().view = name;
  render();
}
function updateSettings(changes: Partial<AppSettings>, message: string): void {
  const workspace = useWorkspaceStore();
  workspace.state.settings = { ...useWorkspaceStore().settings(), ...changes };
  useWorkspaceStore().persist();
  render();
  toast(message);
}
async function copyCurlCommand(): Promise<void> {
  if (requestProtocol(useWorkspaceStore().current()) !== 'http')
    return toast('cURL is available for HTTP / GraphQL requests.', 'warning');
  if (!window.workbench?.codegen)
    return toast('Code generation requires the desktop application.', 'warning');
  try {
    const result = await window.workbench.codegen.generate(
      useToolsStore().codegenInput(true),
      'shell',
      'curl',
    );
    await navigator.clipboard.writeText(result.code);
    toast('cURL copied · secrets redacted', 'success');
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}
export function paletteCommands(): PaletteCommand[] {
  const ui = useUiStore();
  const state = useWorkspaceStore().state;
  const cookies = useCookiesStore();
  const settings = useWorkspaceStore().settings;
  const current = useWorkspaceStore().current;
  const editing = ui.view === 'Collections';
  const http = editing && requestProtocol(current()) === 'http';
  const host = (() => {
    try {
      return new URL(useWorkspaceStore().resolve(current().url)).hostname;
    } catch {
      return '';
    }
  })();
  const commands: PaletteCommand[] = [
    {
      id: 'send',
      title: editing ? `Send “${current().name}”` : 'Send active request',
      group: 'Request',
      icon: 'arrow-top-right',
      shortcut: '⌘ ↵',
      run: () => {
        if (!editing) {
          ui.view = 'Collections';
          render();
        }
        void action('send');
      },
    },
    {
      id: 'new',
      title: 'New request',
      group: 'Request',
      icon: 'plus',
      shortcut: '⌘ N',
      run: () => void action('new'),
    },
    {
      id: 'save',
      title: 'Save request',
      group: 'Request',
      icon: 'content-save-outline',
      shortcut: '⌘ S',
      run: () => void action('save'),
    },
    {
      id: 'duplicate',
      title: 'Duplicate request',
      group: 'Request',
      icon: 'content-copy',
      run: () => void action('duplicate'),
    },
    {
      id: 'rename',
      title: 'Rename request',
      group: 'Request',
      icon: 'pencil-outline',
      shortcut: 'F2',
      run: () => {
        ui.view = 'Collections';
        ui.startRequestRename(current().id);
      },
    },
    {
      id: 'delete',
      title: 'Delete request',
      group: 'Request',
      icon: 'delete-outline',
      run: () => useRequestsStore().deleteRequest(current().id),
    },
    {
      id: 'reopen-tab',
      title: 'Reopen closed tab',
      group: 'Request',
      icon: 'undo',
      shortcut: '⌘ ⇧ T',
      run: () => useRequestTabsStore().reopenLast(),
    },
    {
      id: 'copy-curl',
      title: 'Copy request as cURL',
      group: 'Request',
      icon: 'console-line',
      keywords: 'shell command export',
      run: copyCurlCommand,
    },
    {
      id: 'code',
      title: 'Generate code snippet',
      group: 'Request',
      icon: 'code-tags',
      keywords: 'python javascript go java',
      run: () => {
        ui.view = 'Collections';
        void useToolsStore().openCodeGenerator(true);
      },
    },
    ...(http
      ? [
          {
            id: 'format',
            title: 'Format request body',
            group: 'Request',
            icon: 'code-tags' as MdiIconName,
            run: () => void action('format'),
          },
        ]
      : []),
    ...(['Params', 'Headers', 'Body', 'Auth', 'Tests', 'Scripts', 'Vars', 'Settings'] as const).map(
      (tab) => ({
        id: `tab-${tab}`,
        title: `Go to ${tab} tab`,
        group: 'Request',
        icon: 'tune-variant' as MdiIconName,
        keywords:
          tab === 'Vars'
            ? 'capture variables chaining'
            : tab === 'Auth'
              ? 'authentication jwt token'
              : tab === 'Scripts'
                ? 'javascript pre-request post-response script'
                : '',
        run: () => {
          ui.view = 'Collections';
          ui.requestTab = tab;
          render();
        },
      }),
    ),
    ...state.environments.map((environment, index) => ({
      id: `env-${index}`,
      title: `Switch environment to ${environment.name}`,
      group: 'Environment',
      icon: 'layers-outline' as MdiIconName,
      keywords: index === state.environment ? 'active current' : '',
      run: () => {
        state.environment = index;
        useWorkspaceStore().persist();
        render();
        toast(`Environment: ${environment.name}`);
      },
    })),
    {
      id: 'new-env',
      title: 'New environment',
      group: 'Environment',
      icon: 'plus',
      run: () => {
        ui.view = 'Environments';
        void action('new-env');
      },
    },
    {
      id: 'new-spec',
      title: 'New API specification',
      group: 'Design',
      icon: 'file-code-outline',
      run: () => {
        ui.view = 'APIs';
        useSpecsStore().create();
      },
    },
    {
      id: 'new-mock',
      title: 'New mock server',
      group: 'Design',
      icon: 'server-network',
      run: () => {
        ui.view = 'Mocks';
        useMocksStore().create();
      },
    },
    ...[
      'Overview',
      'Collections',
      'APIs',
      'Mocks',
      'Environments',
      'Credentials',
      'Runner',
      'History',
      'Cookies',
      'Documentation',
      'Settings',
    ].map((page) => ({
      id: `view-${page}`,
      title: `Open ${page}`,
      group: 'Navigate',
      icon: 'arrow-top-right' as MdiIconName,
      run: () => goToView(page),
    })),
    {
      id: 'search',
      title: 'Search workspace',
      group: 'Navigate',
      icon: 'magnify',
      shortcut: '⌘ K',
      run: () => useDialogsStore().openSearch(),
    },
    {
      id: 'workspace',
      title: 'Switch workspace',
      group: 'Navigate',
      icon: 'folder-outline',
      run: () => void useWorkspacesStore().open(),
    },
    {
      id: 'certificates',
      title: 'Manage certificates',
      group: 'Navigate',
      icon: 'shield-lock-outline',
      keywords: 'mtls mutual tls client certificate pfx p12 ca',
      run: () => {
        ui.view = 'Settings';
        useSettingsStore().section = 'Certificates';
        render();
      },
    },
    {
      id: 'help',
      title: 'Help and support',
      group: 'Navigate',
      icon: 'help-circle-outline',
      keywords: 'report problem bug issue github feature request documentation docs faq security',
      run: () => {
        ui.view = 'Settings';
        useSettingsStore().section = 'Help';
        render();
      },
    },
    {
      id: 'open-docs',
      title: 'Open documentation',
      group: 'Navigate',
      icon: 'book-open-variant-outline',
      keywords: 'docs guide manual help how to learn website',
      run: () => void window.workbench?.openExternal?.(SUPPORT_LINKS.docs),
    },
    {
      id: 'report-problem',
      title: 'Report a problem on GitHub',
      group: 'Navigate',
      icon: 'alert-circle-outline',
      keywords: 'bug issue github feedback',
      run: () =>
        void window.workbench?.openExternal?.(
          bugReportUrl({
            version: useUpdatesStore().info?.currentVersion ?? 'unknown',
            platform: navigator.platform,
            details: `API Workbench ${useUpdatesStore().info?.currentVersion ?? ''}\nPlatform: ${navigator.platform}`,
          }),
        ),
    },
    {
      id: 'check-updates',
      title: 'Check for updates',
      group: 'Navigate',
      icon: 'update',
      keywords: 'upgrade new version release download install',
      run: () => {
        const updates = useUpdatesStore();
        updates.open();
        void updates.check();
      },
    },
    {
      id: 'overview-banner',
      title: ui.overviewBannerHidden ? 'Show welcome banner' : 'Hide welcome banner',
      group: 'View',
      icon: ui.overviewBannerHidden ? 'eye-outline' : 'eye-off-outline',
      keywords: 'overview hero intro',
      run: () => {
        ui.view = 'Overview';
        ui.setOverviewBannerHidden(!ui.overviewBannerHidden);
      },
    },
    {
      id: 'explorer',
      title: ui.explorerCollapsed ? 'Show explorer' : 'Hide explorer',
      group: 'View',
      icon: ui.explorerCollapsed ? 'chevron-right' : 'chevron-left',
      shortcut: '⌘ B',
      run: () => ui.toggleExplorer(),
    },
    {
      id: 'layout',
      title: ui.paneLayout() === 'stacked' ? 'Layout: side by side' : 'Layout: stacked',
      group: 'View',
      icon: ui.paneLayout() === 'stacked' ? 'view-split-vertical' : 'view-split-horizontal',
      shortcut: '⌘ \\',
      run: () => {
        ui.view = 'Collections';
        ui.togglePaneLayout();
      },
    },
    {
      id: 'layout-auto',
      title: 'Layout: auto (side by side on wide windows)',
      group: 'View',
      icon: 'theme-light-dark',
      keywords: 'responsive adaptive',
      run: () => {
        ui.view = 'Collections';
        ui.setPaneLayout('auto');
      },
    },
    {
      id: 'maximize-response',
      title: ui.requestPanels.request ? 'Maximize response' : 'Restore request and response split',
      group: 'View',
      icon: ui.requestPanels.request ? 'arrow-top-right' : 'view-split-horizontal',
      shortcut: '⌘ ⇧ M',
      run: () => {
        ui.view = 'Collections';
        ui.toggleResponseMaximized();
      },
    },
    {
      id: 'reset-layout',
      title: 'Reset pane layout',
      group: 'View',
      icon: 'undo',
      run: () => {
        ui.view = 'Collections';
        ui.resetPanelLayout();
      },
    },
    {
      id: 'dev-tools',
      title: ui.devTools.open ? 'Hide dev tools' : 'Show dev tools',
      group: 'View',
      icon: 'tools',
      shortcut: '⌘ J',
      run: () => ui.toggleDevTools(),
    },
    ...DEV_TOOLS_TABS.map((tab) => ({
      id: `dev-tools-${tab.toLowerCase()}`,
      title: `Open ${tab.toLowerCase()} in dev tools`,
      group: 'View',
      icon: (
        {
          Console: 'console-line',
          Network: 'lan',
          Performance: 'speedometer',
          Terminal: 'console',
        } as const
      )[tab],
      run: () => {
        if (!ui.devTools.open || ui.devTools.tab !== tab) ui.toggleDevTools(tab);
      },
    })),
    {
      id: 'terminal-window',
      title: 'Open the terminal in a new window',
      group: 'View',
      icon: 'dock-window',
      keywords: 'shell command line bash zsh powershell expand pop out',
      run: () => ui.expandTerminal(),
    },
    {
      id: 'theme',
      title: settings().theme === 'light' ? 'Theme: dark' : 'Theme: light',
      group: 'View',
      icon: 'theme-light-dark',
      keywords: 'appearance color mode',
      run: () =>
        updateSettings({ theme: settings().theme === 'light' ? 'dark' : 'light' }, 'Theme updated'),
    },
    {
      id: 'density',
      title: settings().density === 'compact' ? 'Density: comfortable' : 'Density: compact',
      group: 'View',
      icon: 'tune-variant',
      keywords: 'spacing dense',
      run: () =>
        updateSettings(
          { density: settings().density === 'compact' ? 'comfortable' : 'compact' },
          'Density updated',
        ),
    },
    {
      id: 'wrap',
      title: settings().wordWrap ? 'Disable word wrap' : 'Enable word wrap',
      group: 'View',
      icon: 'code-tags',
      run: () => updateSettings({ wordWrap: !settings().wordWrap }, 'Word wrap updated'),
    },
    {
      id: 'cookies',
      title: 'Open cookie jar',
      group: 'Cookies',
      icon: 'cookie-outline',
      run: () => goToView('Cookies'),
    },
    ...(host
      ? [
          {
            id: 'cookies-clear-host',
            title: `Clear cookies for ${host}`,
            group: 'Cookies',
            icon: 'delete-outline' as MdiIconName,
            run: () => cookies.clear(host),
          },
        ]
      : []),
    {
      id: 'cookies-clear',
      title: 'Clear all cookies',
      group: 'Cookies',
      icon: 'delete-outline',
      run: () => cookies.clear(),
    },
    {
      id: 'cookies-toggle',
      title: cookies.enabled() ? 'Turn cookie jar off' : 'Turn cookie jar on',
      group: 'Cookies',
      icon: 'cookie-outline',
      run: () => {
        cookies.setJar(cookies.jar(), !cookies.enabled());
        useWorkspaceStore().persist();
        render();
        toast(`Cookie jar ${cookies.enabled() ? 'on' : 'off'}`);
      },
    },
    {
      id: 'run',
      title: 'Run collection',
      group: 'Data',
      icon: 'play-outline',
      keywords: 'runner benchmark performance',
      run: () => goToView('Runner'),
    },
    {
      id: 'import',
      title: 'Import collection',
      group: 'Data',
      icon: 'import',
      keywords: 'postman openapi curl har bruno insomnia',
      run: () => void action('import'),
    },
    {
      id: 'new-collection',
      title: 'New collection',
      group: 'Data',
      icon: 'folder-plus-outline',
      keywords: 'folder create',
      run: () => {
        useUiStore().view = 'Collections';
        useRequestsStore().createCollection();
      },
    },
    {
      id: 'shortcuts',
      title: 'Keyboard shortcuts',
      group: 'Help',
      icon: 'keyboard-outline',
      shortcut: '?',
      keywords: 'keys hotkeys help',
      run: () => {
        useUiStore().shortcutsOpen = true;
      },
    },
    {
      id: 'export',
      title: 'Export workspace',
      group: 'Data',
      icon: 'export',
      run: () => void action('export'),
    },
    {
      id: 'clear-history',
      title: 'Clear request history',
      group: 'Data',
      icon: 'history',
      run: () => void action('clear-history'),
    },
    ...tagCommands(),
  ];
  return commands;
}

/**
 * Commands for each tag in the workspace — show its requests in the explorer, run them, or show
 * them in History — and an Open command for every tagged request, for `#tag` searches.
 */
function tagCommands(): PaletteCommand[] {
  const workspace = useWorkspaceStore();
  const state = workspace.state;
  const ui = useUiStore();
  const only = (tag: string): TagFilter => ({ include: [tag], mode: 'any', exclude: [] });
  const tagsOf = (request: ApiRequest) => effectiveTags(state, request);
  const tags = tagCounts(state.requests.map((request) => ({ tags: tagsOf(request) })));
  const commands: PaletteCommand[] = tags.flatMap(({ tag, count }) => {
    const requests = `${count} request${count === 1 ? '' : 's'}`;
    return [
      {
        id: `tag-explorer-${tag}`,
        title: `Show requests tagged ${tag}`,
        group: 'Tags',
        icon: 'tag-outline' as MdiIconName,
        keywords: `${requests} explorer filter tag`,
        tags: [tag],
        run: () => {
          ui.explorerTags = only(tag);
          ui.view = 'Collections';
          render();
        },
      },
      {
        id: `tag-run-${tag}`,
        title: `Run requests tagged ${tag}`,
        group: 'Tags',
        icon: 'play-outline' as MdiIconName,
        keywords: `${requests} runner collection tag`,
        tags: [tag],
        run: () => {
          const runner = useRunnerStore();
          runner.initialize();
          // The Runner runs one collection: keep its own when it has the tag, else the first that does.
          const tagged = state.requests.filter((request) =>
            tagsOf(request).some((own) => sameTag(own, tag)),
          );
          if (!tagged.some((request) => isWithin(request.folder, runner.run.folder)))
            runner.run.folder = collectionOf(tagged[0].folder);
          runner.run.selected = null;
          runner.run.tags = only(tag);
          ui.view = 'Runner';
          render();
        },
      },
      {
        id: `tag-history-${tag}`,
        title: `Show history tagged ${tag}`,
        group: 'Tags',
        icon: 'history' as MdiIconName,
        keywords: 'history sent filter tag',
        tags: [tag],
        run: () => {
          useScreensStore().history.tags = only(tag);
          ui.view = 'History';
          render();
        },
      },
    ];
  });
  if (
    tagFilterActive(ui.explorerTags) ||
    tagFilterActive(useScreensStore().history.tags) ||
    tagFilterActive(useRunnerStore().run.tags)
  )
    commands.push({
      id: 'tag-clear',
      title: 'Clear tag filters',
      group: 'Tags',
      icon: 'tag-off-outline' as MdiIconName,
      keywords: 'tags filter reset explorer history runner',
      tags: [],
      run: () => {
        ui.explorerTags = emptyTagFilter();
        useScreensStore().history.tags = emptyTagFilter();
        useRunnerStore().run.tags = emptyTagFilter();
        render();
      },
    });
  for (const request of state.requests) {
    const own = tagsOf(request);
    if (!own.length) continue;
    commands.push({
      id: `open-${request.id}`,
      title: `Open “${request.name}”`,
      group: 'Tagged requests',
      icon: 'arrow-top-right' as MdiIconName,
      keywords: `${request.folder} ${request.method} ${own.join(' ')}`,
      tags: own,
      run: () => {
        ui.view = 'Collections';
        useRequestsStore().openRequest(request.id);
        render();
      },
    });
  }
  return commands;
}

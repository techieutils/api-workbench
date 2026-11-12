import { emptyTagFilter, type TagFilter } from '@techieutils/api-workbench-common/tags';
import { defineStore } from 'pinia';
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { render } from '../shell';
import { promptText } from '../terminal-input';
import { toast } from '../utils';
import { useToolsStore } from './tools';
import { useWorkspaceStore } from './workspace';

const EXPLORER_KEY = 'api-workbench:explorer-collapsed';
const OVERVIEW_BANNER_KEY = 'api-workbench:overview-banner-hidden';
const PANES_KEY = 'api-workbench:panes';
const EXPLORER_WIDTH_KEY = 'api-workbench:explorer-width';
const DEV_TOOLS_KEY = 'api-workbench:dev-tools';
const DEFAULT_PANE_SHARE = 55;
/** Pixel sizes and limits of the panes the user can resize. */
export const PANE_SIZES = {
  code: { initial: 360, min: 260, max: 720 },
  devTools: { initial: 260, min: 140, max: 640 },
  explorer: { initial: 254, min: 200, max: 480 },
} as const;
const withinLimits = (value: unknown, pane: keyof typeof PANE_SIZES): value is number =>
  typeof value === 'number' && value >= PANE_SIZES[pane].min && value <= PANE_SIZES[pane].max;

/** Per-viewer flags live in local storage when it is available. */
function storedFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}
function storeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* Storage unavailable; keep the in-memory choice. */
  }
}

export const DEV_TOOLS_TABS = ['Console', 'Network', 'Performance', 'Terminal'] as const;
export type DevToolsTab = (typeof DEV_TOOLS_TABS)[number];

export type PaneLayout = 'stacked' | 'side' | 'auto';
export const paneLayoutLabels: Record<PaneLayout, string> = {
  stacked: 'Stacked',
  side: 'Side by side',
  auto: 'Auto',
};

/** Navigation and layout state for the workbench shell. */
export const useUiStore = defineStore('ui', () => {
  const view = ref('Collections');
  const filter = ref('');
  /** The explorer's tag filter, with its text filter: what the tree shows. */
  const explorerTags = ref<TagFilter>(emptyTagFilter());
  /** The request editor's configuration tab. */
  const requestTab = ref('Params');
  const busy = ref(false);
  /** The HTTP request being sent, or '' when none is. */
  const activeRequestId = ref('');
  const saveState = ref('Saved locally');
  const explorerCollapsed = ref(storedFlag(EXPLORER_KEY));
  const overviewBannerHidden = ref(storedFlag(OVERVIEW_BANNER_KEY));
  const renamingRequestId = ref<string | undefined>();
  /** The collection whose name is being edited in the explorer. */
  const renamingFolder = ref<string | undefined>();
  /** Whether the keyboard shortcuts sheet is open. */
  const shortcutsOpen = ref(false);
  const collapsedFolders = reactive(new Set<string>());
  const requestPanels = reactive({
    request: true,
    response: true,
    code: false,
    layout: 'stacked' as PaneLayout,
    share: DEFAULT_PANE_SHARE,
    codeWidth: PANE_SIZES.code.initial as number,
  });
  /** The dev tools panel above the status bar: console, network, performance, and terminal. */
  const devTools = reactive({
    open: false,
    tab: 'Console' as DevToolsTab,
    height: PANE_SIZES.devTools.initial as number,
    /** The shell new terminals open with, by id; unset uses the login shell. */
    shell: undefined as string | undefined,
  });
  /** Shells running in the terminal window, as the main process counts them. */
  const liveTerminals = ref(0);
  window.workbench?.terminalWindow?.onLive((count) => (liveTerminals.value = count));
  /** The collection explorer's width; undefined keeps the width that suits the window. */
  const explorerWidth = ref<number | undefined>();
  // Layout, split, and dev tools are per-viewer preferences kept in local storage.
  try {
    const saved = JSON.parse(localStorage.getItem(PANES_KEY) || 'null') as
      (Partial<typeof requestPanels> & { console?: unknown }) | null;
    if (saved) {
      if (['stacked', 'side', 'auto'].includes(saved.layout as string))
        requestPanels.layout = saved.layout as PaneLayout;
      if (typeof saved.share === 'number' && saved.share >= 25 && saved.share <= 75)
        requestPanels.share = saved.share;
      if (withinLimits(saved.codeWidth, 'code')) requestPanels.codeWidth = saved.codeWidth;
    }
    const tools = JSON.parse(localStorage.getItem(DEV_TOOLS_KEY) || 'null') as Partial<
      typeof devTools
    > | null;
    // The request console these replace was open: open dev tools on its Console tab.
    if (tools) devTools.open = tools.open === true;
    else devTools.open = saved?.console === true;
    if (DEV_TOOLS_TABS.includes(tools?.tab as DevToolsTab)) devTools.tab = tools!.tab!;
    if (withinLimits(tools?.height, 'devTools')) devTools.height = tools!.height!;
    if (typeof tools?.shell === 'string' && /^[\w-]{1,40}$/.test(tools.shell))
      devTools.shell = tools.shell;
    const width = Number(localStorage.getItem(EXPLORER_WIDTH_KEY));
    if (withinLimits(width, 'explorer')) explorerWidth.value = width;
  } catch {
    /* Storage unavailable or malformed; keep defaults. */
  }
  /** The collection explorer belongs to the Collections screen; every other screen uses the full width. */
  const management = computed(() => view.value !== 'Collections');
  watch(explorerCollapsed, (value) => storeFlag(EXPLORER_KEY, value));
  watch(overviewBannerHidden, (value) => storeFlag(OVERVIEW_BANNER_KEY, value));

  /** The explorer can be hidden from the keyboard and the command palette, as well as the shell. */
  function toggleExplorer(): void {
    explorerCollapsed.value = !explorerCollapsed.value;
    // Auto pane layout depends on how much width the explorer leaves.
    render();
    void nextTick(() =>
      document
        .querySelector<HTMLElement>(explorerCollapsed.value ? '.explorer-expand' : '#filter')
        ?.focus({ preventScroll: true }),
    );
  }
  function setOverviewBannerHidden(hidden: boolean): void {
    overviewBannerHidden.value = hidden;
    render();
    void nextTick(() =>
      document
        .querySelector<HTMLElement>(
          hidden ? '[data-overview-banner="show"]' : '.overview-hero-dismiss',
        )
        ?.focus({ preventScroll: true }),
    );
  }

  // Request workspace panes
  function savePanelPreferences(): void {
    try {
      const { layout, share, codeWidth } = requestPanels;
      localStorage.setItem(PANES_KEY, JSON.stringify({ layout, share, codeWidth }));
      localStorage.setItem(DEV_TOOLS_KEY, JSON.stringify(devTools));
      if (explorerWidth.value === undefined) localStorage.removeItem(EXPLORER_WIDTH_KEY);
      else localStorage.setItem(EXPLORER_WIDTH_KEY, String(explorerWidth.value));
    } catch {
      /* Storage unavailable; the choice still applies for this session. */
    }
  }
  /** Auto uses side by side when the editor area is wide enough for two readable columns. */
  function paneLayout(): 'stacked' | 'side' {
    if (requestPanels.layout !== 'auto') return requestPanels.layout;
    const editorWidth = window.innerWidth - (explorerCollapsed.value ? 72 : 326);
    return editorWidth >= 1100 ? 'side' : 'stacked';
  }
  function setPaneLayout(layout: PaneLayout): void {
    requestPanels.layout = layout;
    savePanelPreferences();
    render();
  }
  /** Switches between stacked and side by side, resolving Auto to its opposite. */
  function togglePaneLayout(): void {
    setPaneLayout(paneLayout() === 'stacked' ? 'side' : 'stacked');
    toast(`Layout: ${paneLayoutLabels[requestPanels.layout]}`);
  }
  /**
   * Opens dev tools (on `tab` when given), switches an open panel to `tab`, or closes it when it
   * already shows that tab.
   */
  /**
   * Types `command` at the prompt of a new terminal without pressing Enter, so the person can
   * read or edit it first. The main process cleans it again and shows the terminal (here, on the
   * Terminal tab, or in its own window); this window never types into a shell itself.
   */
  function runInTerminal(command: string): void {
    // Control characters would run or rewrite the line on their own; the person presses Enter.
    const text = promptText(command);
    if (!text) return;
    void window.workbench?.terminalWindow
      ?.type(text)
      .catch((error: unknown) => toast(errorText(error), 'error'));
  }
  /** Shows the terminal: on the Terminal tab of dev tools, where it starts docked. */
  function openTerminal(): void {
    devTools.open = true;
    devTools.tab = 'Terminal';
    savePanelPreferences();
    render();
  }
  /** Moves the terminal into a window of its own, starting it first if need be. */
  function expandTerminal(): void {
    void window.workbench?.terminalWindow
      ?.expand()
      .catch((error: unknown) => toast(errorText(error), 'error'));
  }
  // A staged command shows the Terminal tab, so the docked terminal has room to show it.
  window.workbench?.terminalWindow?.onReveal(openTerminal);
  const errorText = (error: unknown) =>
    (error instanceof Error ? error.message : String(error)).replace(
      /^Error invoking remote method '[^']+': (Error: )?/,
      '',
    );
  function toggleDevTools(tab?: DevToolsTab): void {
    if (devTools.open && (!tab || tab === devTools.tab)) devTools.open = false;
    else {
      devTools.open = true;
      if (tab) devTools.tab = tab;
    }
    savePanelPreferences();
    render();
    void nextTick(() =>
      document
        .querySelector<HTMLElement>(
          devTools.open ? '.devtools-tabs .ui-tab.active' : '[data-dev-tools-toggle]',
        )
        ?.focus({ preventScroll: true }),
    );
  }
  /** Gives the response the whole editor area, or restores the split. */
  function toggleResponseMaximized(): void {
    const maximized = requestPanels.response && !requestPanels.request;
    requestPanels.request = maximized;
    requestPanels.response = true;
    render();
    document.querySelector<HTMLElement>('[data-maximize-response]')?.focus({ preventScroll: true });
  }
  function resetPanelLayout(): void {
    Object.assign(requestPanels, {
      request: true,
      response: true,
      layout: 'stacked',
      share: DEFAULT_PANE_SHARE,
      codeWidth: PANE_SIZES.code.initial,
    });
    Object.assign(devTools, { open: false, height: PANE_SIZES.devTools.initial });
    explorerWidth.value = undefined;
    savePanelPreferences();
    render();
    toast('Layout reset');
  }
  /** Shows or hides a pane from the status bar menu, keeping at least one of request and response. */
  function toggleRequestPanel(panel: 'request' | 'response' | 'code'): void {
    if (panel === 'code') {
      if (requestPanels.code) {
        requestPanels.code = false;
        if (useToolsStore().codeDialog?.docked) useToolsStore().dismissCodeGenerator();
        render();
      } else {
        requestPanels.code = true;
        void useToolsStore().openCodeGenerator(true);
      }
      return;
    }
    if (
      (panel === 'request' || panel === 'response') &&
      requestPanels[panel] &&
      !requestPanels[panel === 'request' ? 'response' : 'request']
    ) {
      toast('Keep at least one request or response panel open.', 'warning');
      return;
    }
    requestPanels[panel] = !requestPanels[panel];
    render();
  }
  // Auto layout follows the window width while a request is shown.
  let lastResolvedLayout = '';
  window.addEventListener('resize', () => {
    if (requestPanels.layout !== 'auto' || view.value !== 'Collections') return;
    const resolved = paneLayout();
    if (resolved === lastResolvedLayout) return;
    lastResolvedLayout = resolved;
    render();
  });
  function startFolderRename(folder: string): void {
    renamingFolder.value = folder;
    render();
    void nextTick(() => {
      const input = document.querySelector<HTMLInputElement>('[data-folder-rename]');
      input?.focus();
      input?.select();
    });
  }
  function startRequestRename(id: string): void {
    if (!useWorkspaceStore().state.requests.some((request) => request.id === id)) return;
    // The collection tree (src/components/CollectionExplorer.vue) shows the rename field.
    renamingRequestId.value = id;
    render();
    void nextTick(() => {
      const input = document.querySelector<HTMLInputElement>('[data-request-rename]');
      input?.focus();
      input?.select();
    });
  }

  return {
    view,
    filter,
    explorerTags,
    requestTab,
    busy,
    activeRequestId,
    saveState,
    explorerCollapsed,
    overviewBannerHidden,
    renamingRequestId,
    renamingFolder,
    shortcutsOpen,
    startFolderRename,
    collapsedFolders,
    requestPanels,
    devTools,
    liveTerminals,
    explorerWidth,
    management,
    toggleExplorer,
    setOverviewBannerHidden,
    savePanelPreferences,
    paneLayout,
    setPaneLayout,
    togglePaneLayout,
    toggleDevTools,
    runInTerminal,
    openTerminal,
    expandTerminal,
    toggleResponseMaximized,
    resetPanelLayout,
    toggleRequestPanel,
    startRequestRename,
  };
});

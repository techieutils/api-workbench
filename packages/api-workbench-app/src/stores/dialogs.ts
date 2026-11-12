import type { ApiRequest } from '@techieutils/api-workbench-common/types';
import {
  effectiveTags,
  emptyTagFilter,
  matchesTags,
  tagCounts,
  tagFilterActive,
  type TagFilter,
} from '@techieutils/api-workbench-common/tags';
import { defineStore } from 'pinia';
import {
  collectionOf,
  folderEntry,
  isWithin,
  folderLabel,
  parentFolder,
} from '@techieutils/api-workbench-common/folders';
import { nextTick, reactive, shallowReactive } from 'vue';
import type { WorkspaceState } from '@techieutils/api-workbench-common/types';
import { collectionLink } from '@techieutils/api-workbench-common/share-links';
import { paletteCommands, type PaletteCommand } from '../commands/palette';
import { render } from '../shell';
import { errorMessage, toast } from '../utils';
import { useRequestsStore } from './requests';
import { useVaultStore } from './vault';
import { useShareStore } from './share';
import { requestMethodLabel } from './protocols';
import { useUiStore } from './ui';
import { useWorkspaceStore } from './workspace';

const PAGES = [
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
];

/** Workspace search, the command palette, and collection import/export. */
export const useDialogsStore = defineStore('dialogs', () => {
  const ui = useUiStore();
  const workspace = useWorkspaceStore();
  const search = reactive({
    open: false,
    query: '',
    category: 'All',
    selected: 0,
    /** Results by their tags, as the explorer filters requests. */
    tags: emptyTagFilter() as TagFilter,
  });
  const palette = reactive({ open: false, query: '', selected: 0 });
  /** The collection or folder whose tags are being edited, or '' when none is. */
  const folderTags = reactive({ folder: '' });
  /** Most recently run command ids, newest first; kept for this session only. */
  const recentCommands = reactive<string[]>([]);
  /**
   * Import/export state. Shallow, so parsed previews and exported bytes stay plain objects that
   * can be cloned and committed as they are.
   */
  const transfer = shallowReactive({
    mode: '' as '' | 'import' | 'export',
    format: 'workbench',
    scope: '',
    archive: false,
    busy: false,
    error: '',
    pasted: '',
    /** A link to a collection: a gist, a file on GitHub, GitLab, or Bitbucket, or any URL. */
    link: '',
    /** Where an import comes from, as the source tabs show it. */
    importSource: 'Files' as 'Files' | 'Link' | 'Paste',
    /** Where an export goes. */
    destination: 'download' as 'download' | 'copy' | 'gist',
    /** Set while files are dragged over the drop area. */
    dragging: false,
    preview: undefined as TransferImportResult | undefined,
    exported: undefined as TransferExportResult | undefined,
    /** What to export instead of the workspace, such as a mock server's routes as requests. */
    source: undefined as { name: string; snapshot: WorkspaceState } | undefined,
    returnFocus: undefined as HTMLElement | undefined,
  });

  // Workspace search
  function searchResults(): WorkspaceSearchResult[] {
    const state = workspace.state;
    const tagsOf = (request: ApiRequest) => effectiveTags(state, request);
    const tagText = (tags: string[]) =>
      tags.length ? ` · ${tags.map((tag) => `#${tag}`).join(' ')}` : '';
    const entries: WorkspaceSearchResult[] = [
      ...state.requests.map((request) => {
        const tags = tagsOf(request);
        return {
          kind: 'Requests',
          name: request.name,
          detail: `${requestMethodLabel(request)} · ${folderLabel(request.folder)} · ${request.url}${tagText(tags)}`,
          icon: 'console-network-outline' as MdiIconName,
          requestId: request.id,
          tags,
        };
      }),
      ...[...new Set(state.requests.map((request) => collectionOf(request.folder)))].map(
        (folder) => {
          const inside = state.requests.filter((request) => isWithin(request.folder, folder));
          // A collection has its own tags and those of every request in it.
          const tags = tagCounts([
            { tags: folderEntry(state.collectionTags, folder) },
            ...inside.map((request) => ({ tags: tagsOf(request) })),
          ]).map((entry) => entry.tag);
          return {
            kind: 'Collections',
            name: folder,
            detail: `${inside.length} requests · Open collection${tagText(folderEntry(state.collectionTags, folder) ?? [])}`,
            icon: 'folder-outline' as MdiIconName,
            requestId: inside[0].id,
            tags,
          };
        },
      ),
      ...state.environments.map((environment, index) => ({
        kind: 'Environments',
        name: environment.name,
        detail: `${environment.variables.length} variables · Open environment`,
        icon: 'layers-outline' as MdiIconName,
        environmentIndex: index,
      })),
      ...PAGES.map((page) => ({
        kind: 'Pages',
        name: page,
        detail: 'Workspace page',
        icon: 'arrow-top-right' as MdiIconName,
        page,
      })),
    ];
    const query = search.query.trim().toLocaleLowerCase();
    // `#smoke` matches a tag exactly; other words match names, details, and kinds.
    const words = query.split(/\s+/).filter(Boolean);
    const tagWords = words.filter((word) => word.length > 1 && word.startsWith('#'));
    const tokens = words.filter((word) => !tagWords.includes(word));
    const byTags = tagFilterActive(search.tags) || tagWords.length > 0;
    return entries
      .filter(
        (item) =>
          (search.category === 'All' || search.category === item.kind) &&
          // With tags chosen, only what has tags — requests and collections — is shown.
          (!byTags ||
            (item.tags !== undefined &&
              matchesTags(item.tags, search.tags) &&
              tagWords.every((word) =>
                item.tags!.some((tag) => tag.toLocaleLowerCase() === word.slice(1)),
              ))) &&
          tokens.every((token) =>
            `${item.name} ${item.detail} ${item.kind}`.toLocaleLowerCase().includes(token),
          ),
      )
      .sort((a, b) => {
        if (query)
          return (
            Number(b.name.toLocaleLowerCase().startsWith(query)) -
            Number(a.name.toLocaleLowerCase().startsWith(query))
          );
        return Number(b.requestId === state.active) - Number(a.requestId === state.active);
      });
  }
  function openSearch(): void {
    search.open = true;
    search.query = '';
    search.category = 'All';
    search.selected = 0;
    search.tags = emptyTagFilter();
    render();
    void nextTick(() =>
      document.querySelector<HTMLInputElement>('#global-workspace-search')?.focus(),
    );
  }
  function closeSearch(): void {
    search.open = false;
    render();
    document.querySelector<HTMLButtonElement>('.top-search')?.focus();
  }
  function selectSearchResult(index: number): void {
    const item = searchResults()[index];
    if (!item) return;
    const state = workspace.state;
    search.open = false;
    if (item.requestId) {
      ui.filter = '';
      // Show the request: open its folder and every folder above it.
      const folder = state.requests.find((request) => request.id === item.requestId)!.folder;
      for (let path: string | undefined = folder; path !== undefined; path = parentFolder(path))
        ui.collapsedFolders.delete(path);
      useRequestsStore().openRequest(item.requestId);
    } else {
      if (item.environmentIndex !== undefined) {
        state.environment = item.environmentIndex;
        ui.view = 'Environments';
        workspace.persist();
      } else if (item.page === 'Credentials') {
        void useVaultStore().openCredentialsPage();
        return;
      } else if (item.page) ui.view = item.page;
      render();
    }
  }

  // Command palette
  function paletteResults(): PaletteCommand[] {
    const query = palette.query.trim().toLocaleLowerCase();
    // `#smoke` matches a tag exactly; other words match titles, groups, keywords, and tags.
    const words = query.split(/\s+/).filter(Boolean);
    const tagWords = words.filter((word) => word.length > 1 && word.startsWith('#'));
    const tokens = words.filter((word) => !tagWords.includes(word));
    const commands = paletteCommands();
    if (!words.length) {
      // Tag commands and tagged requests wait for a search, so the full list stays short.
      const plain = commands.filter((command) => !command.tags);
      const recent = recentCommands
        .map((id) => plain.find((command) => command.id === id))
        .filter((command): command is PaletteCommand => Boolean(command))
        .map((command) => ({ ...command, group: 'Recent' }));
      return [...recent, ...plain.filter((command) => !recentCommands.includes(command.id))];
    }
    return commands
      .filter(
        (command) =>
          tagWords.every((word) =>
            (command.tags ?? []).some((tag) => tag.toLocaleLowerCase() === word.slice(1)),
          ) &&
          tokens.every((token) =>
            `${command.title} ${command.group} ${command.keywords || ''} ${(command.tags ?? []).join(' ')}`
              .toLocaleLowerCase()
              .includes(token),
          ),
      )
      .sort(
        (a, b) =>
          Number(b.title.toLocaleLowerCase().startsWith(query)) -
          Number(a.title.toLocaleLowerCase().startsWith(query)),
      );
  }
  let paletteReturnFocus: HTMLElement | null = null;
  function openPalette(query = ''): void {
    paletteReturnFocus = document.activeElement as HTMLElement | null;
    search.open = false;
    palette.open = true;
    palette.query = query;
    palette.selected = 0;
    render();
    void nextTick(() => {
      const input = document.querySelector<HTMLInputElement>('#command-palette-input');
      input?.focus();
      input?.setSelectionRange(query.length, query.length);
    });
  }
  function closePalette(restoreFocus = true): void {
    palette.open = false;
    render();
    if (restoreFocus && paletteReturnFocus?.isConnected) paletteReturnFocus.focus();
  }
  async function runCommand(index: number): Promise<void> {
    const command = paletteResults()[index];
    if (!command) return;
    recentCommands.splice(
      0,
      recentCommands.length,
      command.id,
      ...recentCommands.filter((id) => id !== command.id).slice(0, 4),
    );
    closePalette(false);
    try {
      await command.run();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  // Collection import/export. The converters come from the WorkbenchTransfer runtime, which
  // esbuild bundles: the Bruno parser's grammar library does not survive bundling with Vite.
  function openTransfer(
    mode: 'import' | 'export',
    source?: { name: string; snapshot: WorkspaceState },
  ): void {
    transfer.mode = mode;
    transfer.source = mode === 'export' ? source : undefined;
    transfer.returnFocus = document.activeElement as HTMLElement;
    transfer.error = '';
    transfer.preview = undefined;
    transfer.pasted = '';
    transfer.link = '';
    transfer.importSource = 'Files';
    transfer.destination = 'download';
    transfer.dragging = false;
    transfer.scope = '';
    render();
    void nextTick(() =>
      document.querySelector<HTMLElement>('.collection-transfer button')?.focus(),
    );
  }
  function closeTransfer(): void {
    if (transfer.busy) return;
    transfer.mode = '';
    transfer.preview = undefined;
    transfer.exported = undefined;
    transfer.source = undefined;
    render();
    if (transfer.returnFocus?.isConnected) transfer.returnFocus.focus();
    else
      document
        .querySelector<HTMLElement>(
          '[data-action="' + (ui.view === 'Settings' ? 'export' : 'import') + '"]',
        )
        ?.focus();
  }
  /** The workspace, or the one collection chosen as the export's scope. */
  function exportSnapshot(): WorkspaceState {
    if (transfer.source) return structuredClone(transfer.source.snapshot);
    const snapshot = workspace.backupWorkspace();
    const scope = transfer.scope;
    if (scope) {
      snapshot.requests = snapshot.requests.filter((request) => isWithin(request.folder, scope));
      snapshot.settings = { ...workspace.settings(), workspaceName: scope };
      // Settings and default auth of the collection and each folder in it; none from elsewhere.
      const within = <T>(byFolder: Record<string, T> | undefined) =>
        Object.fromEntries(
          Object.entries(byFolder || {}).filter(([path]) => isWithin(path, scope)),
        );
      snapshot.collectionHttpSettings = within(snapshot.collectionHttpSettings);
      snapshot.collectionAuth = within(snapshot.collectionAuth);
      snapshot.collectionScripts = within(snapshot.collectionScripts);
      snapshot.collectionTags = within(snapshot.collectionTags);
      // The workspace's own scripts belong to the workspace, not to one collection exported.
      delete snapshot.workspaceScripts;
      delete snapshot.scriptSnippets;
    }
    return snapshot;
  }
  async function previewFiles(files: File[]): Promise<void> {
    if (!files.length || transfer.busy) return;
    transfer.busy = true;
    transfer.error = '';
    transfer.preview = undefined;
    render();
    try {
      if (files.length > 1000 || files.reduce((n, file) => n + file.size, 0) > 50 * 1024 * 1024)
        throw new Error('Choose at most 1,000 files and 50 MB total.');
      const input = await Promise.all(
        files.map(async (file) => ({
          name: file.webkitRelativePath || file.name,
          data: new Uint8Array(await file.arrayBuffer()),
        })),
      );
      // Yield once so the reading state is painted before parsing larger archives.
      await new Promise((resolve) => setTimeout(resolve, 0));
      transfer.preview = WorkbenchTransfer.importFiles(input);
    } catch (error) {
      transfer.error = errorMessage(error);
    } finally {
      transfer.busy = false;
      render();
    }
  }
  /** Downloads a link in the main process and previews its files like chosen files. */
  async function previewLink(): Promise<void> {
    if (transfer.busy) return;
    transfer.error = '';
    transfer.preview = undefined;
    const download = window.workbench?.importLink;
    if (!download) {
      transfer.error = 'Importing from a link requires the desktop app.';
      render();
      return;
    }
    try {
      // Checked here first, so a mistyped link says so without a round trip.
      collectionLink(transfer.link);
    } catch (error) {
      transfer.error = errorMessage(error);
      render();
      return;
    }
    transfer.busy = true;
    render();
    try {
      const result = await download(transfer.link.trim());
      transfer.preview = WorkbenchTransfer.importFiles(result.files);
    } catch (error) {
      transfer.error = errorMessage(error);
    } finally {
      transfer.busy = false;
      render();
    }
  }
  function previewPasted(): void {
    transfer.error = '';
    transfer.preview = undefined;
    try {
      transfer.preview = WorkbenchTransfer.parseText(transfer.pasted);
    } catch (error) {
      transfer.error = errorMessage(error);
    }
  }
  function exportCollection(snapshot: WorkspaceState, format: string, archive: boolean) {
    const result = WorkbenchTransfer.exportCollection(snapshot, format, archive);
    // Something exported in place of the workspace, such as a mock, is named after itself.
    const name = transfer.source?.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return name ? { ...result, name: result.name.replace(/^api-workbench/, name) } : result;
  }
  /** Commits the import preview, or downloads the export. */
  async function confirmTransfer(): Promise<void> {
    try {
      if (transfer.mode === 'import' && transfer.preview) {
        const count = transfer.preview.data.requests.length,
          environments = transfer.preview.data.environments?.length || 0;
        await workspace.importCollection(transfer.preview.data);
        closeTransfer();
        toast(
          `Imported ${count} ${count === 1 ? 'request' : 'requests'} and ${environments} ${environments === 1 ? 'environment' : 'environments'}`,
          'success',
        );
      } else if (transfer.exported && transfer.destination === 'copy') {
        await useShareStore().copy();
      } else if (transfer.exported && transfer.destination === 'gist') {
        await useShareStore().publish();
      } else if (transfer.exported) {
        const result = transfer.exported;
        const blob = new Blob([new Uint8Array(result.data)], { type: result.type });
        const url = URL.createObjectURL(blob),
          a = document.createElement('a');
        a.href = url;
        a.download = result.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        closeTransfer();
        toast('Export downloaded', 'success');
      }
    } catch (error) {
      transfer.error = errorMessage(error);
    }
  }
  return {
    folderTags,
    search,
    palette,
    recentCommands,
    transfer,
    searchResults,
    openSearch,
    closeSearch,
    selectSearchResult,
    paletteResults,
    openPalette,
    closePalette,
    runCommand,
    openTransfer,
    closeTransfer,
    exportSnapshot,
    previewFiles,
    previewPasted,
    previewLink,
    confirmTransfer,
    exportCollection,
  };
});

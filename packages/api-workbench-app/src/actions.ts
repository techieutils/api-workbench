/**
 * Named commands behind `data-action` buttons, the command palette, and keyboard shortcuts, and
 * the global shortcut handler.
 */
import { render } from './shell';
import { teammateHistory } from '@techieutils/api-workbench-common/history';
import { useDialogsStore } from './stores/dialogs';
import { useRequestTabsStore } from './stores/request-tabs';
import { useRequestsStore } from './stores/requests';
import { isByteView, useResponseStore } from './stores/response';
import { useRunnerStore } from './stores/runner';
import { useSourceEditorsStore } from './stores/source-editors';
import { useToolsStore } from './stores/tools';
import { useUiStore } from './stores/ui';
import { useVaultStore } from './stores/vault';
import { useWorkspaceStore } from './stores/workspace';
import { useWorkspacesStore } from './stores/workspaces';
import { download, toast } from './utils';
import { confirmAction } from './confirm';
import { extensionFor, mediaType } from '@techieutils/api-workbench-common/response-body';

/** Copies or downloads the response tab: the (filtered) body, or the tab's source. */
async function exportResponse(kind: 'copy' | 'download'): Promise<void> {
  const response = useResponseStore();
  const request = useWorkspaceStore().current();
  const tab = response.tab;
  const bytes = tab === 'Body' ? request.response?.bodyBase64 : undefined;
  const type = mediaType(request.response?.headers?.['content-type']) || 'application/octet-stream';
  if (kind === 'copy' && bytes) {
    // Binary bodies are not text: PNG images copy as images, anything else is downloaded.
    if (type !== 'image/png' || typeof ClipboardItem === 'undefined')
      return toast('Binary responses cannot be copied as text. Download it instead.', 'warning');
    try {
      const blob = new Blob([Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0))], { type });
      await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
      toast('Image copied', 'success');
    } catch {
      toast('Clipboard unavailable', 'error');
    }
    return;
  }
  if (kind === 'copy') {
    try {
      // A hex or Base64 view copies what it shows; other body views copy the (filtered) body.
      const byteView = isByteView(useSourceEditorsStore().responseLanguage(request));
      await navigator.clipboard.writeText(
        tab === 'Body' && !byteView
          ? response.filteredBody(request)?.text || request.response?.body || ''
          : response.inspectorSource(request).text,
      );
      toast(`Response ${tab.toLowerCase()} copied`, 'success');
    } catch {
      toast('Clipboard unavailable', 'error');
    }
    return;
  }
  if (bytes) {
    // Binary bodies download as their original bytes, named for their type.
    const blob = new Blob([Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0))], { type });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `response.${extensionFor(type)}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    return;
  }
  const body =
    tab === 'Body'
      ? request.response?.body
      : request.response
        ? response.inspectorSource(request).text
        : undefined;
  if (body === undefined) return toast('Send a request first', 'warning');
  const extension = tab === 'Headers' ? 'txt' : tab === 'Compare' ? 'diff' : 'json';
  download(
    tab === 'Body'
      ? `response.${extensionFor(type) === 'bin' ? 'txt' : extensionFor(type)}`
      : `response-${tab.toLowerCase()}.${extension}`,
    body,
    ['Tests', 'Timeline', 'Certificate', 'Cookies'].includes(tab)
      ? 'application/json'
      : 'text/plain',
  );
}

export async function action(name: string): Promise<void> {
  const workspace = useWorkspaceStore();
  const state = workspace.state;
  const ui = useUiStore();
  const requests = useRequestsStore();
  const vault = useVaultStore();
  const tools = useToolsStore();
  switch (name) {
    case 'delete-env':
      if (state.environments.length < 2) return;
      void confirmAction({
        title: `Delete the ${state.environments[state.environment].name} environment?`,
        message:
          'Its variables are deleted too. Requests that use them will not resolve until another environment defines them.',
        confirmLabel: 'Delete environment',
        tone: 'danger',
      }).then((confirmed) => {
        if (!confirmed) return;
        state.environments.splice(state.environment, 1);
        state.environment = 0;
        workspace.persist();
        render();
      });
      return;
    case 'new-env':
      state.environments.push({
        name: `Environment ${state.environments.length + 1}`,
        variables: [],
      });
      state.environment = state.environments.length - 1;
      workspace.persist();
      return render();
    case 'new-credential':
      return vault.openCredential();
    case 'close-credential':
      vault.draft = null;
      return render();
    case 'cancel-oauth':
      await window.workbench?.oauth.cancel();
      return;
    case 'manage-credentials':
      return vault.openCredentialsPage();
    case 'duplicate':
      return requests.duplicateRequest();
    case 'delete-request':
      return requests.deleteRequest(workspace.current().id);
    case 'new':
      return requests.createRequest();
    case 'send':
      return requests.send();
    case 'save': {
      const form = document.querySelector<HTMLFormElement>('#settings-form');
      if (ui.view === 'Settings' && form) return form.requestSubmit();
      // Saves the whole workspace now, whatever auto save says; a failure says so itself.
      return void workspace.saveNow().then(
        () => toast('Workspace saved', 'success'),
        () => {},
      );
    }
    case 'search':
      return useDialogsStore().openSearch();
    case 'workspace':
      return useWorkspacesStore().open();
    case 'format':
      return useSourceEditorsStore().formatRequest();
    case 'format-response':
      useResponseStore().mode = 'Pretty';
      render();
      return useSourceEditorsStore().formatResponse(true);
    case 'copy':
    case 'download':
      return exportResponse(name);
    case 'export':
    case 'import':
      return useDialogsStore().openTransfer(name);
    case 'clear-history': {
      // In a team workspace only your own history is cleared; teammates' stays theirs.
      const kept = teammateHistory(state.history);
      const count = state.history.length - kept.length;
      if (!count) return toast('History is already empty', 'info');
      void confirmAction({
        title: 'Clear request history?',
        message: `All ${count} ${count === 1 ? 'entry' : 'entries'} you sent are removed from History${kept.length ? '; teammates’ history stays' : ' on this device'}. Your requests and their saved responses are not affected.`,
        confirmLabel: 'Clear history',
        tone: 'danger',
      }).then((confirmed) => {
        if (!confirmed) return;
        state.history = teammateHistory(state.history);
        workspace.persist();
        render();
        toast(`Cleared ${count} history ${count === 1 ? 'entry' : 'entries'}`, 'success');
      });
      return;
    }
    case 'code':
      if (ui.requestPanels.code) return tools.closeCodeGenerator();
      return tools.openCodeGenerator(true);
    case 'run':
      return useRunnerStore().start();
  }
}

/** ? opens the shortcuts sheet, unless typing or a dialog is open. */
document.addEventListener('keydown', (event) => {
  if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, [contenteditable], .cm-editor')) return;
  if (document.querySelector('dialog[open], .modal-backdrop')) return;
  event.preventDefault();
  useUiStore().shortcutsOpen = true;
});

/** Shortcuts that apply while no dialog is open. */
document.addEventListener('keydown', (event) => {
  const dialogs = useDialogsStore();
  const codeDialog = useToolsStore().codeDialog;
  if (
    dialogs.search.open ||
    dialogs.palette.open ||
    dialogs.transfer.mode ||
    useWorkspacesStore().manager.open ||
    useVaultStore().draft ||
    (codeDialog && !codeDialog.docked)
  )
    return;
  if (!event.metaKey && !event.ctrlKey) return;
  const ui = useUiStore();
  const key = event.key.toLowerCase();
  const editing = ui.view === 'Collections';
  const run = (callback: () => unknown) => {
    event.preventDefault();
    void callback();
  };
  if (event.shiftKey && key === 't') return run(() => useRequestTabsStore().reopenLast());
  if (event.shiftKey && key === 'p') return run(() => dialogs.openPalette());
  if (!event.shiftKey && key === 'b') return run(() => ui.toggleExplorer());
  if (editing && !event.shiftKey && event.key === '\\') return run(() => ui.togglePaneLayout());
  if (!event.shiftKey && key === 'j') return run(() => ui.toggleDevTools());
  if (editing && event.shiftKey && key === 'm') return run(() => ui.toggleResponseMaximized());
  if (event.key === 'Enter') run(() => editing && action('send'));
  if (key === 's') run(() => action('save'));
  if (key === 'k') run(() => action('search'));
  if (key === 'n') run(() => action('new'));
});

import { defineStore } from 'pinia';
import { shallowReactive } from 'vue';
import type { CredentialSummary, GistPublishResult } from '@techieutils/api-workbench-common/types';
import { render } from '../shell';
import { errorMessage, toast } from '../utils';
import { useDialogsStore } from './dialogs';
import { useVaultStore } from './vault';
import { useWorkspacesStore } from './workspaces';

/** The GitHub API origin a GitHub.com token is restricted to. */
export const GITHUB_API = 'https://api.github.com';

/**
 * Where an export goes besides a download: the clipboard, or a GitHub gist. Gists are published by
 * the main process with a saved Bearer token from the vault; this store only knows which one.
 */
export const useShareStore = defineStore('share', () => {
  const gist = shallowReactive({
    credentialId: '',
    visibility: 'secret' as 'secret' | 'public',
    description: '',
    /** Create a new gist, or update the one in `target` (a gist link or ID). */
    mode: 'new' as 'new' | 'update',
    target: '',
    busy: false,
    error: '',
    result: null as GistPublishResult | null,
    /** The form for saving a GitHub token to the vault. */
    adding: false,
    tokenName: 'GitHub',
    /** Empty for GitHub.com; a GitHub Enterprise Server address otherwise. */
    tokenServer: '',
    token: '',
    tokenError: '',
  });

  /** Saved tokens that can publish gists: Bearer tokens for GitHub.com or a GitHub server. */
  function githubCredentials(): CredentialSummary[] {
    return useVaultStore().credentials.filter(
      (credential) =>
        credential.kind === 'bearer' &&
        (credential.allowedOrigin === GITHUB_API || /github/i.test(credential.allowedOrigin)),
    );
  }
  /** The text of the current export, or why it cannot be shared as text. */
  function exportText(): { name: string; text: string } {
    const exported = useDialogsStore().transfer.exported;
    if (!exported) throw new Error('Choose a format that can be exported.');
    if (exported.name.endsWith('.zip'))
      throw new Error('ZIP exports cannot be copied or published as a gist. Turn off ZIP.');
    return { name: exported.name, text: new TextDecoder().decode(new Uint8Array(exported.data)) };
  }

  /** Remembered per workspace, scope, and format, so the next publish can update the same gist. */
  const memoryKey = () => {
    const transfer = useDialogsStore().transfer;
    return `api-workbench:gist:${useWorkspacesStore().manager.id}:${transfer.source?.name ?? transfer.scope}:${transfer.format}`;
  };
  function rememberedGist(): { id: string; url: string } | undefined {
    try {
      const value = JSON.parse(localStorage.getItem(memoryKey()) ?? 'null') as {
        id?: unknown;
        url?: unknown;
      } | null;
      return typeof value?.id === 'string' && typeof value.url === 'string'
        ? { id: value.id, url: value.url }
        : undefined;
    } catch {
      return undefined;
    }
  }
  /** Prepares the gist form when the export's scope or format changes. */
  function prepare(): void {
    const remembered = rememberedGist();
    gist.result = null;
    gist.error = '';
    gist.mode = remembered ? 'update' : 'new';
    gist.target = remembered?.url ?? '';
    if (!gist.credentialId || !githubCredentials().some((item) => item.id === gist.credentialId))
      gist.credentialId = githubCredentials()[0]?.id ?? '';
  }

  async function copy(): Promise<void> {
    try {
      const { text } = exportText();
      await navigator.clipboard.writeText(text);
      toast('Export copied to the clipboard', 'success');
    } catch (error) {
      useDialogsStore().transfer.error = errorMessage(error);
      render();
    }
  }

  /** Saves a GitHub token to the vault as a Bearer token restricted to GitHub's API. */
  async function saveToken(): Promise<void> {
    const save = window.workbench?.credentials.save;
    if (!save) return;
    const token = gist.token.trim();
    let origin = GITHUB_API;
    if (gist.tokenServer.trim())
      try {
        const server = new URL(
          /^https?:\/\//i.test(gist.tokenServer.trim())
            ? gist.tokenServer.trim()
            : `https://${gist.tokenServer.trim()}`,
        );
        if (server.protocol !== 'https:') throw new Error();
        origin = server.origin;
      } catch {
        gist.tokenError = 'Enter the GitHub server’s https:// address, such as github.example.com.';
        render();
        return;
      }
    gist.tokenError = !gist.tokenName.trim()
      ? 'Name the token.'
      : !token
        ? 'Paste a GitHub token with the gist scope.'
        : '';
    if (gist.tokenError) {
      render();
      return;
    }
    gist.busy = true;
    render();
    try {
      const saved = await save({
        name: gist.tokenName.trim(),
        kind: 'bearer',
        allowedOrigin: origin,
        secret: token,
      });
      await useVaultStore().loadCredentials();
      gist.credentialId = saved.id;
      Object.assign(gist, { adding: false, token: '', tokenServer: '', tokenError: '' });
      toast(`Saved “${saved.name}” in the credential vault`, 'success');
    } catch (error) {
      gist.tokenError = errorMessage(error);
    } finally {
      gist.busy = false;
      render();
    }
  }

  /** The gist ID in a gist link or a bare ID, or undefined. */
  const gistId = (value: string) => /(?:^|\/)([0-9a-f]{20,40})(?:[/?#]|$)/i.exec(value.trim())?.[1];

  async function publish(): Promise<void> {
    const bridge = window.workbench?.gists;
    if (!bridge || gist.busy) return;
    gist.error = '';
    gist.result = null;
    let file: { name: string; text: string };
    try {
      file = exportText();
      if (!gist.credentialId) throw new Error('Choose a GitHub token, or add one.');
      if (gist.mode === 'update' && !gistId(gist.target))
        throw new Error('Paste the link or ID of the gist to update.');
    } catch (error) {
      gist.error = errorMessage(error);
      render();
      return;
    }
    gist.busy = true;
    render();
    try {
      const result = await bridge.publish({
        credentialId: gist.credentialId,
        files: [{ name: file.name, content: file.text }],
        description: gist.description,
        public: gist.visibility === 'public',
        ...(gist.mode === 'update' ? { gistId: gistId(gist.target) } : {}),
      });
      gist.result = result;
      // Publishing again updates this gist rather than making a second one.
      gist.mode = 'update';
      gist.target = result.url;
      try {
        localStorage.setItem(memoryKey(), JSON.stringify({ id: result.id, url: result.url }));
      } catch {
        /* Remembering the gist is a convenience. */
      }
      toast(result.updated ? 'Gist updated' : 'Gist published', 'success');
    } catch (error) {
      gist.error = errorMessage(error);
    } finally {
      gist.busy = false;
      render();
    }
  }
  async function copyLink(): Promise<void> {
    if (!gist.result) return;
    await navigator.clipboard.writeText(gist.result.url);
    toast('Gist link copied', 'success');
  }
  const openGist = () => {
    if (gist.result) void window.workbench?.openExternal?.(gist.result.url);
  };

  return {
    gist,
    githubCredentials,
    rememberedGist,
    prepare,
    copy,
    saveToken,
    publish,
    copyLink,
    openGist,
  };
});

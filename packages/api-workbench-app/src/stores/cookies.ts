import { defineStore } from 'pinia';
import { reactive } from 'vue';
import * as cookies from '@techieutils/api-workbench-common/cookies';
import type { RequestResponse } from '@techieutils/api-workbench-common/types';
import { render } from '../shell';
import { toast } from '../utils';
import { useWorkspaceStore } from './workspace';
import { confirmAction } from '../confirm';

/** The workspace cookie jar, and the Cookies screen's filter and add form. */
export const useCookiesStore = defineStore('cookies', () => {
  const workspace = useWorkspaceStore();
  /** `domain` narrows the jar to one domain's cookies; '' shows every domain. */
  const ui = reactive({ filter: '', domain: '', adding: false, error: '' });

  const enabled = (): boolean => workspace.state.cookieJar?.enabled !== false;
  const jar = (): StoredCookie[] => workspace.state.cookieJar?.cookies || [];
  function setJar(next: StoredCookie[], on = enabled()): void {
    workspace.state.cookieJar = { enabled: on, cookies: next };
  }
  /** Stores Set-Cookie headers from a response; returns how many headers were received. */
  function storeResponse(response: RequestResponse): number {
    if (response.error !== undefined || !response.setCookies?.length || !enabled()) return 0;
    setJar(cookies.storeCookies(jar(), response.setCookies));
    return response.setCookies.length;
  }
  /** The jar snapshot sent with a request, or undefined when the jar is off. */
  const requestJar = (): StoredCookie[] | undefined =>
    enabled() ? cookies.sanitizeJar(jar()) : undefined;
  function expiry(cookie: StoredCookie): string {
    if (cookie.expires === undefined) return 'Session';
    if (cookie.expires - Date.now() <= 0) return 'Expired';
    return new Date(cookie.expires).toLocaleString();
  }
  /** Clears every cookie, or only those for one domain. */
  async function clear(domain?: string): Promise<void> {
    const count = jar().filter((cookie) => !domain || cookie.domain === domain).length;
    if (!count) return toast('No cookies to clear', 'warning');
    const confirmed = await confirmAction({
      title: domain
        ? `Delete ${count} cookie${count === 1 ? '' : 's'} for ${domain}?`
        : `Delete all ${count} cookie${count === 1 ? '' : 's'}?`,
      message: 'Requests stop sending them until a response sets them again.',
      confirmLabel: domain ? 'Delete cookies' : 'Delete all cookies',
      tone: 'danger',
    });
    if (!confirmed) return;
    setJar(domain ? jar().filter((cookie) => cookie.domain !== domain) : []);
    workspace.persist();
    render();
    toast(`Deleted ${count} cookie${count === 1 ? '' : 's'}`, 'success');
  }
  return { ui, enabled, jar, setJar, storeResponse, requestJar, expiry, clear };
});

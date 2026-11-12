import { defineStore } from 'pinia';
import type { ApiRequest } from '@techieutils/api-workbench-common/types';
import { render } from '../shell';
import { action } from '../actions';
import { useRequestsStore } from './requests';
import { useProtocolsStore } from './protocols';
import { useUiStore } from './ui';
import { useWorkspaceStore } from './workspace';

const MAX_RECENT = 20;

/** Open request tabs, their recent and recently closed history, and the tab menu commands. */
export const useRequestTabsStore = defineStore('requestTabs', () => {
  const workspace = useWorkspaceStore();

  function recent(kind: 'recentTabs' | 'closedTabs'): ApiRequest[] {
    const state = workspace.state;
    const ids = state[kind] || (kind === 'recentTabs' ? [...state.tabs].reverse() : []);
    return [...new Set(ids)]
      .map((id) => state.requests.find((request) => request.id === id))
      .filter((request): request is ApiRequest => Boolean(request))
      .slice(0, MAX_RECENT);
  }
  function remember(id: string): void {
    const state = workspace.state;
    state.recentTabs = [
      id,
      ...recent('recentTabs')
        .map((request) => request.id)
        .filter((value) => value !== id),
    ].slice(0, MAX_RECENT);
    state.closedTabs = recent('closedTabs')
      .map((request) => request.id)
      .filter((value) => value !== id);
  }
  /** Moves a tab to sit before or after another, and saves the order. */
  function move(id: string, target: string, after: boolean): void {
    const tabs = workspace.state.tabs;
    if (id === target || !tabs.includes(id) || !tabs.includes(target)) return;
    tabs.splice(tabs.indexOf(id), 1);
    tabs.splice(tabs.indexOf(target) + (after ? 1 : 0), 0, id);
    workspace.persist();
  }
  /** Closes tabs; saved collection requests stay intact. */
  function close(ids: string[]): void {
    const state = workspace.state;
    const closing = new Set(ids.filter((id) => state.tabs.includes(id)));
    if (!closing.size) return;
    closing.forEach((id) => void useProtocolsStore().stopLiveProtocol(id));
    state.recentTabs = recent('recentTabs').map((request) => request.id);
    const oldIndex = state.tabs.indexOf(state.active || '');
    const closed = state.tabs.filter((id) => closing.has(id));
    // The active request is the first one restored when a group of tabs is closed.
    const closedOrder = [
      ...closed.filter((id) => id !== state.active),
      ...closed.filter((id) => id === state.active),
    ].reverse();
    state.closedTabs = [
      ...closedOrder,
      ...recent('closedTabs')
        .map((request) => request.id)
        .filter((id) => !closing.has(id)),
    ].slice(0, MAX_RECENT);
    state.tabs = state.tabs.filter((id) => !closing.has(id));
    if (closing.has(state.active || '')) {
      state.active =
        state.tabs[Math.min(Math.max(0, oldIndex), state.tabs.length - 1)] || state.requests[0]?.id;
      if (state.tabs.length) remember(state.active!);
    }
    if (!state.tabs.length) useUiStore().view = 'Overview';
    workspace.persist();
    render();
    document.querySelector<HTMLButtonElement>('.tab-menu-trigger')?.focus({ preventScroll: true });
  }
  function reopenLast(): void {
    const state = workspace.state;
    const request = recent('closedTabs').find((item) => !state.tabs.includes(item.id));
    if (request) useRequestsStore().openRequest(request.id);
  }
  function runCommand(command: string): void {
    const state = workspace.state;
    const index = state.tabs.indexOf(state.active || '');
    if (command === 'reopen') return reopenLast();
    if (command === 'duplicate') {
      if (index >= 0) void action('duplicate');
      return;
    }
    if (command === 'previous' || command === 'next') {
      if (state.tabs.length)
        useRequestsStore().openRequest(
          state.tabs[
            (Math.max(0, index) + (command === 'next' ? 1 : -1) + state.tabs.length) %
              state.tabs.length
          ],
        );
      return;
    }
    const ids =
      command === 'all'
        ? [...state.tabs]
        : command === 'others'
          ? state.tabs.filter((id) => id !== state.active)
          : command === 'left'
            ? state.tabs.slice(0, Math.max(0, index))
            : command === 'right'
              ? state.tabs.slice(index + 1)
              : index >= 0
                ? [state.active!]
                : [];
    close(ids);
  }
  return { recent, remember, move, close, reopenLast, runCommand };
});

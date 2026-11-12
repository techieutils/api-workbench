import { computed } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';

/**
 * Reads state that is not reactive, such as objects mutated in place, raw caches, and the window
 * size. The value re-evaluates on every render().
 */
export function useRendered<T>(read: () => T) {
  const workspace = useWorkspaceStore();
  return computed(() => {
    void workspace.revision;
    return read();
  });
}

/** Reads live protocol connection state, re-evaluating as connections change. */
export function useLiveProtocol<T>(read: () => T) {
  const workspace = useWorkspaceStore();
  return computed(() => {
    void workspace.liveRevision;
    void workspace.revision;
    return read();
  });
}

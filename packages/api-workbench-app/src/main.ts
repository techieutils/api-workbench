// First, so the desktop window's narrower content policy applies before anything else runs.
import './content-policy';
import { nextTick } from 'vue';
import './actions';
import { render } from './shell';
import { useUpdatesStore } from './stores/updates';
import { useWorkspaceStore } from './stores/workspace';
import { installTestGlobals } from './test-globals';

installTestGlobals();
// The bundle loads after the runtimes it calls, so the saved workspace can load and show now.
void useWorkspaceStore()
  .load()
  .then(render)
  // Update status follows once the workspace shows, so its toasts never delay the first paint.
  .then(() => useUpdatesStore().start());

/** The bundle's export, the WorkbenchShell global; the smoke tests wait on Vue updates with it. */
export default { afterUpdate: (callback: () => void) => void nextTick(callback) };

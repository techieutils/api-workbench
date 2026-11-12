import { guideUrl, type GuideName } from '@techieutils/api-workbench-common/support-links';
import { toast } from './utils';

/**
 * Opens a feature's guide on the documentation site in the browser. The address is built from a
 * fixed page name, never from workspace data, so it opens without asking, like Settings → Help.
 */
export function openGuide(name: GuideName, heading?: string): void {
  if (!window.workbench?.openExternal) return void toast('Links open in the desktop app.', 'error');
  void window.workbench.openExternal(guideUrl(name, heading));
}

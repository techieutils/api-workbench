import { render } from './shell';
import { useVaultStore } from './stores/vault';
import { useSettingsStore } from './stores/settings';
import { useUiStore } from './stores/ui';

/** Shows a top-level screen. Credentials first unlock the vault, so they load asynchronously. */
export function openView(name: string): void {
  if (name === 'Credentials') {
    void useVaultStore().openCredentialsPage();
    return;
  }
  useUiStore().view = name;
  render();
}

/** Shows Settings at one section. */
export function openSettings(section: SettingsSection): void {
  useSettingsStore().section = section;
  openView('Settings');
}

/** Keyboard shortcuts, listed once for the shortcuts sheet and Settings. `Mod` is ⌘ on macOS, Ctrl elsewhere. */
export interface Shortcut {
  label: string;
  keys: string[];
}
export const SHORTCUT_GROUPS: { group: string; shortcuts: Shortcut[] }[] = [
  {
    group: 'Requests',
    shortcuts: [
      { label: 'Send request', keys: ['Mod', 'Enter'] },
      { label: 'New request', keys: ['Mod', 'N'] },
      { label: 'Save request', keys: ['Mod', 'S'] },
      { label: 'Format the current editor', keys: ['Shift', 'Alt', 'F'] },
      { label: 'Search inside an editor', keys: ['Mod', 'F'] },
    ],
  },
  {
    group: 'Navigation',
    shortcuts: [
      { label: 'Search the workspace', keys: ['Mod', 'K'] },
      { label: 'Command palette', keys: ['Mod', 'Shift', 'P'] },
      { label: 'Keyboard shortcuts', keys: ['?'] },
      { label: 'Reopen the last closed tab', keys: ['Mod', 'Shift', 'T'] },
      { label: 'Close a tab', keys: ['Middle-click'] },
    ],
  },
  {
    group: 'Collections',
    shortcuts: [
      { label: 'Rename a request or collection', keys: ['F2'] },
      { label: 'Move the focused request tab', keys: ['Alt', '← / →'] },
      { label: 'Move a request up or down', keys: ['Alt', '↑ / ↓'] },
      { label: 'Show or hide the explorer', keys: ['Mod', 'B'] },
    ],
  },
  {
    group: 'Panels',
    shortcuts: [
      { label: 'Stacked or side-by-side layout', keys: ['Mod', '\\'] },
      { label: 'Show or hide dev tools', keys: ['Mod', 'J'] },
      { label: 'Maximize or restore the response', keys: ['Mod', 'Shift', 'M'] },
    ],
  },
  {
    group: 'Terminal (while it has focus)',
    shortcuts: [
      { label: 'Split the terminal right', keys: ['Mod', '\\'] },
      { label: 'Split the terminal down', keys: ['Mod', 'Shift', '\\'] },
      {
        label: 'Focus the pane to the left, right, above, or below',
        keys: ['Mod', 'Alt', '← → ↑ ↓'],
      },
      { label: 'Close the focused terminal pane', keys: ['Mod', 'Shift', 'W'] },
      { label: 'Open a new terminal', keys: ['Ctrl', 'Shift', '`'] },
      { label: 'Rename the selected terminal tab', keys: ['F2'] },
      { label: 'Move the selected terminal tab', keys: ['Alt', '← / →'] },
    ],
  },
  {
    group: 'Dialogs and menus',
    shortcuts: [
      { label: 'Close a dialog or menu', keys: ['Esc'] },
      { label: 'Move through menus and lists', keys: ['↑ / ↓'] },
    ],
  },
];
export const mac = /Mac|iPhone|iPad/.test(navigator.platform);
/** A key as shown on this platform. */
export const keyLabel = (key: string): string =>
  key === 'Mod'
    ? mac
      ? '⌘'
      : 'Ctrl'
    : key === 'Alt' && mac
      ? '⌥'
      : key === 'Shift' && mac
        ? '⇧'
        : key;

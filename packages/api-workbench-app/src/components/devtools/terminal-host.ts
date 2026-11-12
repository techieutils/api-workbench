import type { InjectionKey } from 'vue';

/**
 * What the terminal needs from the page it runs in: the shell new terminals open with, commands
 * the app staged for a new terminal's prompt, and somewhere to say how many shells run. The
 * terminal window provides it (terminal/TerminalApp.vue); the app's window never runs a shell.
 */
export interface TerminalHost {
  /** The default shell's id; unset uses the login shell. */
  defaultShell?: string;
  setDefaultShell(id: string | undefined): void;
  /** Commands waiting to be typed into a new terminal, oldest first; the terminal takes them. */
  commands: string[];
  /** How many shells are running. */
  live: number;
  /** Where the terminal is: over the app's dev tools panel, or in a window of its own. */
  placement: 'panel' | 'window';
  /** Moves the terminal, shells and all, into a window of its own. */
  expand(): void;
  /** Puts it back in the dev tools panel. */
  returnToPanel(): void;
}
export const TERMINAL_HOST: InjectionKey<TerminalHost> = Symbol('terminal-host');

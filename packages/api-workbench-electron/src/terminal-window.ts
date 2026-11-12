/**
 * The terminal's own window. A shell runs whatever is typed into it, so only a window that shows
 * nothing but the terminal may type: the app's window, which renders responses, Markdown, and
 * imports from anywhere, cannot reach the terminal's channels at all. It may only ask for the
 * window to open, or stage a command at a new terminal's prompt for the person to read and run.
 */

/** Control characters, which would run or rewrite a staged line on their own; tabs complete. */
const char = (code: number) => String.fromCharCode(code);
const CONTROL = new RegExp(
  `[${char(0x00)}-${char(0x1f)}${char(0x7f)}-${char(0x9f)}${char(0x2028)}${char(0x2029)}]`,
  'g',
);
/** The longest command the app may stage at a prompt. */
export const MAX_STAGED = 10_000;

/**
 * A command from the app's window, as it may appear at a prompt: text only, never Enter. The
 * app's window cleans it too (`terminal-input.ts`), but that window is the one this guards
 * against, so the main process cleans it again. Undefined when nothing is left.
 */
export function stagedCommand(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const line = text.slice(0, MAX_STAGED).replace(CONTROL, ' ').trim();
  return line || undefined;
}

/** The terminal window's saved preferences, as read from disk: only what is valid. */
export interface TerminalPreferences {
  /** The shell new terminals open with, by id; unset uses the login shell. */
  defaultShell?: string;
}
export function terminalPreferences(
  saved: unknown,
  shellIds: readonly string[],
): TerminalPreferences {
  const shell = (saved as { defaultShell?: unknown } | null)?.defaultShell;
  return typeof shell === 'string' && shellIds.includes(shell) ? { defaultShell: shell } : {};
}

/** Where the docked terminal goes in the app's window, in its content's pixels. */
export interface DockBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
/**
 * The docked terminal's place, as the app's window asks for it: whole pixels inside the window,
 * at least a little of it visible, or undefined to hide it. The app's window can move or hide the
 * terminal, but never type into it, so a bad request only misplaces it.
 */
export function dockBounds(
  value: unknown,
  window: { width: number; height: number },
): DockBounds | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { x, y, width, height } = value as Record<string, unknown>;
  const whole = [x, y, width, height].map((part) =>
    typeof part === 'number' && Number.isFinite(part) ? Math.round(part) : NaN,
  );
  if (whole.some(Number.isNaN)) return undefined;
  const [left, top, right, bottom] = [
    Math.max(0, whole[0]),
    Math.max(0, whole[1]),
    Math.min(window.width, whole[0] + whole[2]),
    Math.min(window.height, whole[1] + whole[3]),
  ];
  if (right - left < 40 || bottom - top < 40) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

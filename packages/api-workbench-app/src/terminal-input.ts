/** Control characters: C0, DEL, C1, and the Unicode line and paragraph separators. */
const char = (code: number) => String.fromCharCode(code);
const CONTROL = new RegExp(
  `[${char(0x00)}-${char(0x1f)}${char(0x7f)}-${char(0x9f)}${char(0x2028)}${char(0x2029)}]`,
  'g',
);

/**
 * Text that is safe to type at a shell prompt for the person to run. A line break, carriage return,
 * or other control character would act on its own as soon as it reaches the shell — Enter runs
 * the line, and escape sequences can rewrite it — so each becomes a space. Tabs become spaces too,
 * since they trigger completion.
 */
export function promptText(command: string): string {
  return command.replace(CONTROL, ' ').trim();
}

/** A shell word in single quotes, so spaces, `;`, `|`, `$`, and backticks are taken literally. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A value as one shell word: as it is when it is plainly safe, otherwise in single quotes. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9._/:@%+=,-]+$/.test(value) ? value : shellQuote(value);
}

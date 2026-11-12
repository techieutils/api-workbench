/**
 * Choosing which smoke test parts to run. Each part starts from the app as it boots, so any of
 * them can run on its own:
 *
 *   npm run test:ui -- --only=14
 *   npm run test:ui -- --only=specs-and-mocks,3
 *
 * A part is named by its number or by a word in its name.
 */
export type SmokePart<Context> = readonly [
  name: string,
  run: (context: Context) => Promise<unknown>,
];

export function selectParts<Context>(
  parts: readonly SmokePart<Context>[],
  argv: readonly string[] = process.argv,
): { selected: { number: number; name: string; run: SmokePart<Context>[1] }[]; all: boolean } {
  const numbered = parts.map(([name, run], index) => ({ number: index + 1, name, run }));
  const option = argv.find((value) => value.startsWith('--only='))?.slice('--only='.length);
  if (!option) return { selected: numbered, all: true };
  const wanted = option
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const selected = numbered.filter((part) =>
    wanted.some((value) => Number(value) === part.number || part.name.includes(value)),
  );
  if (!selected.length) {
    // Exiting here, before the app starts, avoids Electron's main-process error dialog.
    console.error(
      `No smoke test part matches "${option}". Parts:\n${numbered.map((part) => `  ${part.number} ${part.name}`).join('\n')}`,
    );
    process.exit(2);
  }
  return { selected, all: selected.length === parts.length };
}

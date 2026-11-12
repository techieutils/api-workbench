#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { HELP, UsageError, parseArgs, type RunOptions } from './args';
import { readSource, sourceFromTarget, type Source } from './source';
import { openTarget } from './target';
import { terminalPassword, vaultAccess } from './vault';
import {
  RESOURCES,
  RESOURCE_ALIASES,
  resourceCommand,
  type CommandContext,
  type Resource,
} from './commands';
import { runHosts, runSource, selectRequests } from './run';
import { effectiveTags, tagFilterActive } from '@techieutils/api-workbench-common/tags';
import {
  runPassed,
  loadPlan,
  loadSummaryLines,
  iterationLine,
  jsonReport,
  junitReport,
  painter,
  resultLines,
  summaryLines,
} from './report';

/** The command line's entry point: parses arguments, runs, writes reports, and sets the exit code. */

/** The bundle has its version built in; run from the repository, it reads package.json. */
export const VERSION: string =
  process.env.API_WORKBENCH_CLI_VERSION ??
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- JSON beside the compiled file.
  (require('../package.json') as { version: string }).version;
/** 130 is what shells report for a process stopped by Ctrl+C (128 + SIGINT). */
export const EXIT = { passed: 0, failed: 1, usage: 2, interrupted: 130 } as const;

interface Output {
  out(line: string): void;
  err(line: string): void;
}

/** All of standard input, for `secret set --stdin`. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY)
    throw new UsageError('--stdin reads the secret from a pipe, such as: printf %s "$TOKEN" | …');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** What list --json prints: names and structure only, never URLs' secrets or variable values. */
export function listJson(source: Source) {
  return {
    name: source.name,
    kind: source.kind,
    collections: [...new Set(source.workspace.requests.map((request) => request.folder))],
    requests: source.workspace.requests.map((request) => ({
      id: request.id,
      name: request.name,
      folder: request.folder,
      method: request.method,
      // Its own tags and its collection's and folders', as runs read them.
      ...(effectiveTags(source.workspace, request).length
        ? { tags: effectiveTags(source.workspace, request) }
        : {}),
      protocol: request.protocol || 'http',
      // The command line runs only HTTP requests; scripts can filter on this.
      runnable: !request.protocol || request.protocol === 'http',
    })),
    environments: source.workspace.environments.map((environment) => environment.name),
  };
}

function listSource(source: Source, out: Output['out']): void {
  out(`${source.name} (${source.kind})`);
  const collections = new Map<string, typeof source.workspace.requests>();
  for (const request of source.workspace.requests)
    collections.set(request.folder, [...(collections.get(request.folder) ?? []), request]);
  out('');
  out('Requests:');
  for (const [folder, requests] of collections) {
    out(`  ${folder}`);
    for (const request of requests)
      out(
        `    ${(request.protocol && request.protocol !== 'http' ? request.protocol : request.method).padEnd(9)} ${request.name}${
          effectiveTags(source.workspace, request).length
            ? `  ${effectiveTags(source.workspace, request)
                .map((tag) => `#${tag}`)
                .join(' ')}`
            : ''
        }${request.protocol && request.protocol !== 'http' ? '  (live protocol, not run)' : ''}`,
      );
  }
  out('');
  out(
    `Environments: ${source.workspace.environments.map((environment) => environment.name).join(', ') || 'none'}`,
  );
}

async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.writeFile(file, text);
}

/**
 * Standard input line by line, for request connect. Closed with closeLines once the command ends,
 * as an open standard input would keep the command line running after the connection closed.
 */
let lineReader: ReturnType<typeof createInterface> | undefined;
function openLines() {
  lineReader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  return lineReader;
}
function closeLines() {
  if (!lineReader) return;
  lineReader.close();
  lineReader = undefined;
  process.stdin.destroy();
}

export async function main(
  argv: readonly string[],
  output: Output = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  },
  env: Record<string, string | undefined> = process.env,
  terminal = Boolean(process.stdout.isTTY),
  /** Aborted by Ctrl+C: the run stops, and its summary and reports cover what ran. */
  interrupt?: AbortSignal,
  /** Stand-ins for standard input and the vault password prompt, for tests. */
  inputs: Partial<Pick<CommandContext, 'stdin' | 'password' | 'writeRaw' | 'lines'>> = {},
): Promise<number> {
  const resource =
    RESOURCE_ALIASES[argv[0]] ?? (RESOURCES as readonly string[]).find((name) => name === argv[0]);
  if (resource)
    try {
      return await resourceCommand(resource as Resource, argv.slice(1), {
        output,
        env,
        stdin: inputs.stdin ?? readStdin,
        password: inputs.password,
        interrupt,
        color:
          argv.includes('--color') || (terminal && !env.NO_COLOR && !argv.includes('--no-color')),
        terminal,
        writeRaw: inputs.writeRaw ?? ((data) => process.stdout.write(data)),
        // Read only by request connect, as it sends each line while the connection is open.
        lines: inputs.lines ?? (argv[1] === 'connect' ? openLines() : undefined),
      });
    } catch (error) {
      output.err(`api-workbench: ${(error as Error).message}`);
      return error instanceof UsageError ? EXIT.usage : EXIT.failed;
    } finally {
      closeLines();
    }
  let options: RunOptions;
  try {
    const parsed = parseArgs(argv, env, terminal);
    if (parsed === 'help') {
      output.out(HELP);
      return EXIT.passed;
    }
    if (parsed === 'version') {
      output.out(VERSION);
      return EXIT.passed;
    }
    options = parsed;
  } catch (error) {
    output.err(`api-workbench: ${(error as Error).message}`);
    return EXIT.usage;
  }
  const paint = painter(options.color);
  let vault: ReturnType<typeof vaultAccess> | undefined;
  try {
    let source: Source;
    if (options.source) source = await readSource(options.source);
    else {
      const target = await openTarget(
        { workspace: options.workspace, dataDir: options.dataDir },
        env,
      );
      // Its vault, for requests with a saved credential, with API_WORKBENCH_VAULT_PASSWORD.
      vault = vaultAccess(target, inputs.password ?? terminalPassword(env));
      source = { ...sourceFromTarget(target), credentials: vault.credentials };
      await target.close();
    }
    for (const warning of source.warnings) output.err(paint.dim(`warning: ${warning}`));
    if (options.command === 'list') {
      // With tags, only what a run with them would send.
      const listed = tagFilterActive(options.tags)
        ? {
            ...source,
            workspace: { ...source.workspace, requests: selectRequests(source, options) },
          }
        : source;
      if (options.json) output.out(JSON.stringify(listJson(listed), null, 2));
      else listSource(listed, output.out);
      return EXIT.passed;
    }
    // Where the run would go, for a caller to ask about before anything is sent.
    if (options.listHosts) {
      output.out(JSON.stringify(await runHosts(source, options), null, 2));
      return EXIT.passed;
    }
    // Checked before the heading, so a mistyped name fails with nothing else printed.
    selectRequests(source, options);
    const startedAt = new Date().toISOString();
    output.out(paint.bold(`API Workbench · ${source.name}`));
    let iteration = 0;
    // A load test sends thousands of requests: only its first few failures are shown as they come.
    let failuresShown = 0;
    if (options.load)
      output.out(paint.dim(loadPlan(options.load, selectRequests(source, options).length)));
    const outcome = await runSource(
      source,
      options,
      (result, data) => {
        if (options.load) {
          if (!result.passed && failuresShown++ < 5)
            for (const line of resultLines(result, paint, true)) output.out(line);
          return;
        }
        // Each iteration is headed when there is more than one, or a data file.
        const total = data ? data.rows.length : (options.iterations ?? 1);
        if (result.iteration !== iteration) {
          iteration = result.iteration;
          if (data || total > 1)
            output.out(iterationLine({ data }, result.iteration, total, paint));
        }
        for (const line of resultLines(result, paint, options.quiet)) output.out(line);
      },
      interrupt,
    );
    for (const line of options.load
      ? loadSummaryLines(outcome, paint)
      : summaryLines(outcome, paint))
      output.out(line);
    if (options.jsonFile) {
      await write(options.jsonFile, `${JSON.stringify(jsonReport(outcome, startedAt), null, 2)}\n`);
      output.out(paint.dim(`JSON report: ${options.jsonFile}`));
    }
    if (options.junitFile) {
      await write(options.junitFile, junitReport(outcome));
      output.out(paint.dim(`JUnit report: ${options.junitFile}`));
    }
    if (outcome.interrupted) return EXIT.interrupted;
    return runPassed(outcome) ? EXIT.passed : EXIT.failed;
  } catch (error) {
    output.err(`api-workbench: ${(error as Error).message}`);
    return error instanceof UsageError ? EXIT.usage : EXIT.failed;
  } finally {
    // The vault locks again once the run is over.
    await vault?.close();
  }
}

if (require.main === module) {
  // The first Ctrl+C stops the run and still writes its reports; a second one quits at once.
  const interrupt = new AbortController();
  process.on('SIGINT', () => {
    if (interrupt.signal.aborted) process.exit(EXIT.interrupted);
    process.stderr.write('\nStopping… (Ctrl+C again to quit now)\n');
    interrupt.abort();
  });
  void main(
    process.argv.slice(2),
    undefined,
    process.env,
    Boolean(process.stdout.isTTY),
    interrupt.signal,
  ).then((code) => {
    process.exitCode = code;
    // Nothing else should keep the process alive once the run is over.
    process.removeAllListeners('SIGINT');
  });
}

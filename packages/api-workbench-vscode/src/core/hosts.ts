/**
 * Where a `.http` file's requests may go without asking. A file from a repository can point a
 * request anywhere, with the environment's values and earlier responses' captures in it, so the
 * first send to each new host asks; the command line enforces the list (`--allow-host`), after
 * it has filled in variables, so what is checked is where the request really goes.
 */

/** This computer: sending here never asks. */
export const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** A host as `--allow-host` takes it: a host name or a bracketed IPv6 address, lower case. */
export const isHostName = (host: string): boolean =>
  /^[a-z0-9_][a-z0-9_-]*(\.[a-z0-9_][a-z0-9_-]*)*$|^\[[0-9a-f:.]+\]$/.test(host);

/** The command line's arguments for the hosts that need no question: this computer's and `allowed`. */
export function hostArgs(allowed: Iterable<string>): string[] {
  const hosts = new Set([...LOOPBACK, ...[...allowed].filter(isHostName)]);
  return [...hosts].map((host) => `--allow-host=${host}`);
}

/** The host a send was refused for, from the command line's message, or undefined. */
export function refusedHost(message: string): string | undefined {
  const host = /goes to (\S+), which --allow-host does not list/.exec(message)?.[1]?.toLowerCase();
  return host && isHostName(host) ? host : undefined;
}

/** The hosts a run's requests were not sent to, each once, in the order they came. */
export function refusedHosts(results: readonly { error?: string }[] | undefined): string[] {
  const hosts = (results ?? []).flatMap((result) => {
    const host = result.error ? refusedHost(result.error) : undefined;
    return host ? [host] : [];
  });
  return [...new Set(hosts)];
}

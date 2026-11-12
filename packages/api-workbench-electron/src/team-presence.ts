import fs from 'node:fs/promises';
import { rmSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type {
  TeamMember,
  TeamPresence,
  TeamPresenceChange,
} from '@techieutils/api-workbench-common/types';
import { PRESENCE_DIRECTORY } from './team-files';

/** How often your presence file is refreshed, and when a teammate's is too old to count. */
export const HEARTBEAT_MS = 20_000;
export const STALE_MS = 60_000;
const POLL_MS = 5_000;
const MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Who has a team workspace open. Each person writes a small file in the team folder,
 * `.workbench/presence/<member id>.json`, with their name and the request they are on, refreshed
 * every 20 seconds and removed when they leave. Files are read when the directory changes and
 * every few seconds, since network drives and synced folders do not always report changes.
 */
export class TeamPresenceService {
  private session?: {
    workspaceId: string;
    folder: string;
    member: TeamMember;
    requestId?: string;
    requestName?: string;
  };
  private heartbeat?: ReturnType<typeof setInterval>;
  private poll?: ReturnType<typeof setInterval>;
  private watcher?: FSWatcher;
  private last = '';
  constructor(
    private readonly publish: (change: TeamPresenceChange) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts showing you in `folder`, ending any earlier session. */
  async start(workspaceId: string, folder: string, member: TeamMember): Promise<void> {
    await this.stop();
    if (!MEMBER_ID.test(member.id)) throw new Error('Invalid member ID.');
    this.session = { workspaceId, folder, member };
    this.last = '';
    await this.write();
    this.heartbeat = setInterval(() => void this.write(), HEARTBEAT_MS);
    this.poll = setInterval(() => void this.read(), POLL_MS);
    try {
      this.watcher = watch(path.join(folder, PRESENCE_DIRECTORY), () => void this.read());
      this.watcher.on('error', () => this.watcher?.close());
    } catch {
      /* Polling still finds teammates. */
    }
    await this.read();
  }
  /** Removes your presence file and stops reading teammates'. */
  async stop(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    clearInterval(this.heartbeat);
    clearInterval(this.poll);
    this.watcher?.close();
    this.watcher = undefined;
    if (!session) return;
    await fs.rm(this.fileOf(session.folder, session.member.id), { force: true }).catch(() => {});
    this.publish({ workspaceId: session.workspaceId, others: [] });
  }
  /** On quit there is no time to wait: your presence file is removed straight away. */
  stopNow(): void {
    const session = this.session;
    this.session = undefined;
    clearInterval(this.heartbeat);
    clearInterval(this.poll);
    this.watcher?.close();
    if (session) rmSync(this.fileOf(session.folder, session.member.id), { force: true });
  }
  /** Updates the request you are on, and your name when it changed. */
  async update(requestId?: string, requestName?: string, member?: TeamMember): Promise<void> {
    if (!this.session) return;
    this.session.requestId = requestId;
    this.session.requestName = requestName;
    if (member) this.session.member = member;
    await this.write();
  }
  get active(): string | undefined {
    return this.session?.workspaceId;
  }

  private fileOf(folder: string, id: string): string {
    return path.join(folder, PRESENCE_DIRECTORY, `${id}.json`);
  }
  private async write(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const presence: TeamPresence = {
      member: session.member,
      ...(session.requestId ? { requestId: session.requestId } : {}),
      ...(session.requestName ? { requestName: session.requestName.slice(0, 200) } : {}),
      updatedAt: new Date(this.now()).toISOString(),
    };
    const file = this.fileOf(session.folder, session.member.id);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file + '.tmp', JSON.stringify(presence));
      await fs.rename(file + '.tmp', file);
    } catch {
      /* A read-only or unavailable folder: you are not shown, and the workspace still works. */
    }
  }
  /** Reads teammates' presence and publishes it when it changed. */
  async read(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const directory = path.join(session.folder, PRESENCE_DIRECTORY);
    const names = await fs.readdir(directory).catch(() => [] as string[]);
    const others: TeamPresence[] = [];
    for (const name of names) {
      const id = name.replace(/\.json$/, '');
      if (!name.endsWith('.json') || !MEMBER_ID.test(id) || id === session.member.id) continue;
      try {
        const value = JSON.parse(
          await fs.readFile(path.join(directory, name), 'utf8'),
        ) as TeamPresence;
        const updated = Date.parse(value.updatedAt);
        if (!Number.isFinite(updated) || this.now() - updated > STALE_MS) continue;
        others.push({
          member: { id, name: String(value.member?.name || 'Teammate').slice(0, 60) },
          ...(typeof value.requestId === 'string' ? { requestId: value.requestId } : {}),
          ...(typeof value.requestName === 'string'
            ? { requestName: value.requestName.slice(0, 200) }
            : {}),
          updatedAt: value.updatedAt,
        });
      } catch {
        /* Half written or synced: read again next time. */
      }
    }
    others.sort((a, b) => a.member.name.localeCompare(b.member.name));
    // Only who and where count as a change, not each heartbeat.
    const key = JSON.stringify(others.map(({ updatedAt: _ignored, ...rest }) => rest));
    if (this.session !== session || key === this.last) return;
    this.last = key;
    this.publish({ workspaceId: session.workspaceId, others });
  }
}

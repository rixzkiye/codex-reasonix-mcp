import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { BridgeError } from './errors.js';
import { atomicWrite, privateDirectory } from './state.js';

interface LeaseOwner {
  pid: number;
  processStartToken: string;
  createdAt: string;
  heartbeatAt: string;
  nonce: string;
}

async function linuxStartToken(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const fields = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ');
    return fields[21];
  } catch {
    return undefined;
  }
}

async function currentStartToken(): Promise<string> {
  return (
    (await linuxStartToken(process.pid)) ??
    String(Math.floor(Date.now() - process.uptime() * 1_000))
  );
}

async function ownerAlive(owner: LeaseOwner): Promise<boolean> {
  try {
    process.kill(owner.pid, 0);
  } catch {
    return false;
  }
  const token = await linuxStartToken(owner.pid);
  return token === undefined || token === owner.processStartToken;
}

export class Lease {
  private heartbeat?: NodeJS.Timeout;

  constructor(
    readonly file: string,
    readonly owner: LeaseOwner,
    private readonly heartbeatMs: number,
  ) {}

  start(): void {
    this.heartbeat = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, this.heartbeatMs);
    this.heartbeat.unref();
  }

  async refresh(): Promise<void> {
    const current = JSON.parse(await readFile(this.file, 'utf8')) as LeaseOwner;
    if (current.nonce !== this.owner.nonce) {
      throw new BridgeError('lease_conflict', `Lease ownership changed: ${this.file}`);
    }
    this.owner.heartbeatAt = new Date().toISOString();
    await atomicWrite(this.file, `${JSON.stringify(this.owner)}\n`);
  }

  async release(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      const current = JSON.parse(await readFile(this.file, 'utf8')) as LeaseOwner;
      if (current.nonce === this.owner.nonce) await unlink(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function acquireLease(
  locksDir: string,
  name: string,
  staleMs: number,
  heartbeatMs: number,
): Promise<Lease> {
  await privateDirectory(locksDir);
  const file = path.join(locksDir, `${name}.lease`);
  const now = new Date().toISOString();
  const owner: LeaseOwner = {
    pid: process.pid,
    processStartToken: await currentStartToken(),
    createdAt: now,
    heartbeatAt: now,
    nonce: randomUUID(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      const lease = new Lease(file, owner, heartbeatMs);
      lease.start();
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    let existing: LeaseOwner;
    try {
      existing = JSON.parse(await readFile(file, 'utf8')) as LeaseOwner;
    } catch {
      throw new BridgeError(
        'lease_conflict',
        `Unreadable lease must be inspected manually: ${file}`,
      );
    }
    const age = Date.now() - Date.parse(existing.heartbeatAt);
    if (age <= staleMs || (await ownerAlive(existing))) {
      throw new BridgeError('lease_conflict', `Repository already has an active writer lease`, {
        pid: existing.pid,
        heartbeatAt: existing.heartbeatAt,
      });
    }
    try {
      await rename(file, `${file}.stale.${existing.nonce}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  throw new BridgeError('lease_conflict', 'Unable to acquire repository writer lease');
}

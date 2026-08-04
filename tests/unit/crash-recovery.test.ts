import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseTaskContract } from '../../src/contracts.js';
import { makeTaskRecordForTest } from '../../src/runtime.js';
import { StateStore } from '../../src/state.js';
import type { JournalEvent } from '../../src/types.js';
import { contractFixture } from '../helpers.js';

async function freshStore(): Promise<{ store: StateStore; taskId: string; taskDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reasonix-crash-recovery-'));
  const store = new StateStore(root);
  await store.initialize();
  const record = makeTaskRecordForTest(
    'crash-task',
    parseTaskContract(contractFixture()),
    { id: 'repo', root: '/repo', commonDir: '/repo/.git', head: 'base' },
    '/worktree',
  );
  await store.createTask(record); // appends task_created with seq 1
  return { store, taskId: record.taskId, taskDir: path.join(root, 'tasks', record.taskId) };
}

const event = (seq: number, type = 'test_event'): JournalEvent => ({
  seq,
  timestamp: '2026-08-04T00:00:00.000Z',
  type,
  data: { seq },
});

const envelope = (seq: number, state: unknown): string =>
  `${JSON.stringify({ schemaVersion: 1, seq, event: event(seq), state })}\n`;

async function writeState(
  taskDir: string,
  stateJson: string,
  eventSequence: number,
): Promise<void> {
  const parsed = JSON.parse(stateJson) as Record<string, unknown>;
  parsed.eventSequence = eventSequence;
  await writeFile(path.join(taskDir, 'state.json'), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

async function writeJournal(taskDir: string, events: Array<JournalEvent | string>): Promise<void> {
  const lines = events
    .map((entry) => (typeof entry === 'string' ? entry : `${JSON.stringify(entry)}\n`))
    .join('');
  await writeFile(path.join(taskDir, 'events.jsonl'), lines, 'utf8');
}

async function writePending(taskDir: string, envelopeRaw: string | null): Promise<void> {
  const pending = path.join(taskDir, 'pending-event.json');
  await rm(pending, { force: true });
  if (envelopeRaw !== null) await writeFile(pending, envelopeRaw, 'utf8');
}

describe('crash-consistent journal transactions', () => {
  it('leaves no envelope behind on the happy path and keeps sequences contiguous', async () => {
    const { store, taskId, taskDir } = await freshStore();
    await store.recordEvent(taskId, 'second_event', { marker: true });
    await expect(readFile(path.join(taskDir, 'pending-event.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const record = await store.loadTask(taskId);
    expect(record.eventSequence).toBe(2);
    const events = await store.readEvents(taskId);
    expect(events.map((item) => item.seq)).toEqual([1, 2]);
  });

  it('completes a transaction crashed after the envelope, before the journal append', async () => {
    const { store, taskId, taskDir } = await freshStore();
    const stateJson = await readFile(path.join(taskDir, 'state.json'), 'utf8');
    const nextState = JSON.parse(stateJson) as Record<string, unknown>;
    nextState.eventSequence = 2;
    nextState.phase = 'verification';
    await writePending(taskDir, envelope(2, nextState));
    await writeJournal(taskDir, [event(1, 'task_created')]);
    await writeState(taskDir, stateJson, 1);

    const record = await store.loadTask(taskId);
    expect(record.eventSequence).toBe(2);
    expect(record.phase).toBe('verification');
    expect((await store.readEvents(taskId)).map((item) => item.seq)).toEqual([1, 2]);
    await expect(readFile(path.join(taskDir, 'pending-event.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // The next append continues without duplicating a sequence.
    await store.recordEvent(taskId, 'after_recovery', {});
    expect((await store.readEvents(taskId)).map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it('completes a transaction crashed after the journal append, before the state write', async () => {
    const { store, taskId, taskDir } = await freshStore();
    const stateJson = await readFile(path.join(taskDir, 'state.json'), 'utf8');
    const nextState = JSON.parse(stateJson) as Record<string, unknown>;
    nextState.eventSequence = 2;
    await writePending(taskDir, envelope(2, nextState));
    await writeJournal(taskDir, [event(1, 'task_created'), event(2)]);
    await writeState(taskDir, stateJson, 1);

    const record = await store.loadTask(taskId);
    expect(record.eventSequence).toBe(2);
    expect((await store.readEvents(taskId)).map((item) => item.seq)).toEqual([1, 2]);
  });

  it('drops the envelope when the transaction completed before the crash', async () => {
    const { store, taskId, taskDir } = await freshStore();
    const stateJson = await readFile(path.join(taskDir, 'state.json'), 'utf8');
    const nextState = JSON.parse(stateJson) as Record<string, unknown>;
    nextState.eventSequence = 2;
    await writePending(taskDir, envelope(2, nextState));
    await writeJournal(taskDir, [event(1, 'task_created'), event(2)]);
    await writeState(taskDir, stateJson, 2);

    const record = await store.loadTask(taskId);
    expect(record.eventSequence).toBe(2);
    expect((await store.readEvents(taskId)).map((item) => item.seq)).toEqual([1, 2]);
    await expect(readFile(path.join(taskDir, 'pending-event.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('recovers a partial trailing journal write provable from the envelope', async () => {
    const { store, taskId, taskDir } = await freshStore();
    const stateJson = await readFile(path.join(taskDir, 'state.json'), 'utf8');
    const nextState = JSON.parse(stateJson) as Record<string, unknown>;
    nextState.eventSequence = 2;
    await writePending(taskDir, envelope(2, nextState));
    await writeJournal(taskDir, [event(1, 'task_created'), '{"seq":2,"timestamp":"2026']);
    await writeState(taskDir, stateJson, 1);

    const record = await store.loadTask(taskId);
    expect(record.eventSequence).toBe(2);
    const journal = await readFile(path.join(taskDir, 'events.jsonl'), 'utf8');
    const lines = journal.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1]!) as { seq?: unknown }).seq).toBe(2);
  });

  it('fails closed on a malformed pending envelope', async () => {
    const { store, taskId, taskDir } = await freshStore();
    await writePending(taskDir, '{"schemaVersion":99,"seq":"nope"}');
    await expect(store.loadTask(taskId)).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('fails closed on a journal sequence gap', async () => {
    const { store, taskId, taskDir } = await freshStore();
    const stateJson = await readFile(path.join(taskDir, 'state.json'), 'utf8');
    await writePending(taskDir, envelope(4, JSON.parse(stateJson)));
    await writeJournal(taskDir, [event(1, 'task_created'), event(3)]);
    await writeState(taskDir, stateJson, 1);
    await expect(store.loadTask(taskId)).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('fails closed when the journal is ahead of the pending envelope', async () => {
    const { store, taskId, taskDir } = await freshStore();
    const stateJson = await readFile(path.join(taskDir, 'state.json'), 'utf8');
    await writePending(taskDir, envelope(2, JSON.parse(stateJson)));
    await writeJournal(taskDir, [event(1, 'task_created'), event(2), event(3)]);
    await writeState(taskDir, stateJson, 1);
    await expect(store.loadTask(taskId)).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('fails closed when the stored state is ahead of the envelope', async () => {
    const { store, taskId, taskDir } = await freshStore();
    const stateJson = await readFile(path.join(taskDir, 'state.json'), 'utf8');
    await writePending(taskDir, envelope(1, JSON.parse(stateJson)));
    await writeJournal(taskDir, [event(1, 'task_created')]);
    await writeState(taskDir, stateJson, 2);
    await expect(store.loadTask(taskId)).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('aligns a legacy journal-ahead state so the next append never duplicates a sequence', async () => {
    const { store, taskId, taskDir } = await freshStore();
    const stateJson = await readFile(path.join(taskDir, 'state.json'), 'utf8');
    await writePending(taskDir, null);
    await writeJournal(taskDir, [event(1, 'task_created'), event(2)]);
    await writeState(taskDir, stateJson, 1);

    const record = await store.loadTask(taskId);
    expect(record.eventSequence).toBe(2);
    await store.recordEvent(taskId, 'after_align', {});
    expect((await store.readEvents(taskId)).map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it('fails closed when the stored state is ahead of the journal without an envelope', async () => {
    const { store, taskId, taskDir } = await freshStore();
    const stateJson = await readFile(path.join(taskDir, 'state.json'), 'utf8');
    await writePending(taskDir, null);
    await writeJournal(taskDir, [event(1, 'task_created')]);
    await writeState(taskDir, stateJson, 2);
    await expect(store.loadTask(taskId)).rejects.toMatchObject({ code: 'invalid_state' });
  });
});

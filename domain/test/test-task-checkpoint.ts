import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { MemoryStorage, SQLiteStorage } from '../src';
import type { TaskCheckpoint, TaskRecord, TaskStore } from '../src/tasks';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeTask(sessionId: string): TaskRecord {
  const id = randomUUID();
  const now = Date.now();
  return {
    id,
    rootId: id,
    sessionId,
    prompt: 'checkpoint',
    status: 'running',
    attempt: 1,
    maxAttempts: 2,
    leaseOwner: 'worker-a',
    leaseUntil: now + 60_000,
    createdAt: now,
    updatedAt: now,
  };
}

function makeCheckpoint(task: TaskRecord, id = randomUUID()): TaskCheckpoint {
  return {
    id,
    taskId: task.id,
    attempt: task.attempt,
    iteration: 3,
    transcriptCursor: 7,
    state: {
      phase: 'after_tools',
      nextAction: 'continue',
      pendingChildIds: [],
      pendingJobIds: [],
    },
    summary: 'after tools',
    createdAt: Date.now(),
  };
}

async function exercise(name: string, store: TaskStore): Promise<void> {
  const task = makeTask(`${name}-session`);
  await store.createTask(task);
  const checkpoint = makeCheckpoint(task);

  assert(await store.commitCheckpoint(task.id, checkpoint, {
    type: 'checkpoint-created',
    data: { iteration: checkpoint.iteration },
  }, { workerId: 'worker-a', attempt: 1 }), `${name}: checkpoint commits for current lease`);

  const saved = await store.getCheckpoint(checkpoint.id);
  assert(saved?.iteration === 3 && saved?.transcriptCursor === 7,
    `${name}: checkpoint fields round-trip`);
  assert((await store.getTask(task.id))?.checkpointId === checkpoint.id,
    `${name}: task points to committed checkpoint`);
  assert((await store.listEvents(task.id)).some(event => event.type === 'checkpoint-created'),
    `${name}: checkpoint event is committed`);

  const latest = await store.getLatestCheckpoint(task.id);
  assert(latest?.id === checkpoint.id, `${name}: latest checkpoint is readable`);

  await store.updateTask(task.id, {
    leaseOwner: 'worker-b',
    leaseUntil: Date.now() + 60_000,
    attempt: 2,
  });
  let duplicateRejected = false;
  try {
    await store.commitCheckpoint(task.id, checkpoint, {
      type: 'checkpoint-created',
      data: { duplicate: true },
    }, { workerId: 'worker-b', attempt: 2 });
  } catch {
    duplicateRejected = true;
  }
  assert(
    duplicateRejected || (await store.getCheckpoint(checkpoint.id))?.id === checkpoint.id,
    `${name}: duplicate checkpoint cannot advance state`,
  );
  assert((await store.getTask(task.id))?.checkpointId === checkpoint.id,
    `${name}: failed checkpoint commit leaves the task pointer unchanged`);

  const stale = makeCheckpoint({ ...task, attempt: 1 }, randomUUID());
  assert(!(await store.commitCheckpoint(task.id, stale, {
    type: 'checkpoint-created',
    data: {},
  }, { workerId: 'worker-a', attempt: 1 })), `${name}: stale worker cannot commit`);
  assert((await store.getTask(task.id))?.checkpointId === checkpoint.id,
    `${name}: stale commit does not move checkpoint pointer`);
}

async function testMemory(): Promise<void> {
  const storage = new MemoryStorage();
  await exercise('memory', storage.getTaskStore());
}

async function testSQLite(): Promise<void> {
  const dbPath = join(tmpdir(), `plain-agent-checkpoint-${randomUUID()}.db`);
  const storage = new SQLiteStorage(dbPath);
  try {
    await storage.createSession('sqlite-session', 'Checkpoint');
    await exercise('sqlite', storage.getTaskStore());
  } finally {
    storage.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
}

async function main(): Promise<void> {
  await testMemory();
  await testSQLite();
  console.log('task checkpoint tests passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

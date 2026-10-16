import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import {
  MemoryStorage,
  SQLiteStorage,
} from '../src';
import type { TaskRecord, TaskStore } from '../src/tasks';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeTask(sessionId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const id = randomUUID();
  const now = Date.now();
  return {
    id,
    rootId: id,
    sessionId,
    prompt: 'store test',
    status: 'queued',
    attempt: 0,
    maxAttempts: 2,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function exerciseMemoryStore(): Promise<void> {
  const storage = new MemoryStorage();
  const store = storage.getTaskStore();
  await storage.createSession('memory-session', 'Memory');
  await exerciseStore('memory', store, storage);
}

async function exerciseSQLiteStore(): Promise<void> {
  const dbPath = join(tmpdir(), `plain-agent-task-store-${randomUUID()}.db`);
  const storage = new SQLiteStorage(dbPath);
  try {
    const store = storage.getTaskStore();
    await storage.createSession('sqlite-session', 'SQLite');
    await exerciseStore('sqlite', store, storage);
  } finally {
    storage.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
}

async function exerciseStore(
  name: string,
  store: TaskStore,
  storage: MemoryStorage | SQLiteStorage,
): Promise<void> {
  const sessionId = `${name}-session`;
  const task = makeTask(sessionId);
  await store.createTask(task);

  const created = await store.getTask(task.id);
  assert(created?.status === 'queued', `${name}: task is persisted as queued`);
  assert((await store.listEvents(task.id)).some(event => event.type === 'task-created'),
    `${name}: task-created event is persisted`);
  assert(!(await store.transition(task.id, 'queued', 'completed')),
    `${name}: illegal queued -> completed transition is rejected`);

  const firstClaim = await store.claimTask(task.id, 'worker-a');
  assert(firstClaim?.status === 'running', `${name}: first claim enters running`);
  assert(firstClaim?.attempt === 1, `${name}: first claim increments attempt`);
  assert(await store.renewLease(task.id, 'worker-a'),
    `${name}: lease owner can renew`);
  assert(!(await store.finishAttempt(task.id, 'worker-b', 1, 'completed', { output: 'wrong' })),
    `${name}: a different worker cannot complete a claimed task`);
  assert(await store.releaseLease(task.id, 'worker-a'),
    `${name}: lease owner can release`);

  await store.updateTask(task.id, {
    leaseOwner: 'dead-worker',
    leaseUntil: Date.now() - 1,
  });
  assert(await store.recoverExpiredTasks() === 1,
    `${name}: expired lease is recovered`);
  assert((await store.getTask(task.id))?.status === 'queued',
    `${name}: recovered task is queued`);

  const secondClaim = await store.claimTask(task.id, 'worker-b');
  assert(secondClaim?.attempt === 2, `${name}: recovered task can be claimed again`);
  assert(!(await store.finishAttempt(task.id, 'worker-a', 1, 'completed', { output: 'stale' })),
    `${name}: stale attempt cannot overwrite a newer claim`);
  assert(await store.finishAttempt(task.id, 'worker-b', 2, 'failed', { error: 'expected failure' }),
    `${name}: current owner can finish`);
  assert((await store.getTask(task.id))?.error === 'expected failure',
    `${name}: failure result is persisted`);

  const exhausted = makeTask(sessionId, {
    status: 'running',
    attempt: 1,
    maxAttempts: 1,
    leaseOwner: 'dead-worker',
    leaseUntil: Date.now() - 1,
  });
  await store.createTask(exhausted);
  await store.recoverExpiredTasks();
  const exhaustedRecord = await store.getTask(exhausted.id);
  assert(exhaustedRecord?.status === 'failed',
    `${name}: exhausted lease is marked failed`);

  const cascade = makeTask(sessionId);
  await store.createTask(cascade);
  const childSessionId = `${name}-child-session`;
  await storage.createSession(childSessionId, 'Child');
  const child = makeTask(childSessionId, {
    parentId: cascade.id,
    rootId: cascade.rootId,
  });
  await store.createTask(child);
  await storage.deleteSession(sessionId);
  assert(await store.getTask(task.id) === null,
    `${name}: deleting a session deletes tasks`);
  assert((await store.listEvents(cascade.id)).length === 0,
    `${name}: deleting a session deletes task events`);
  assert(await store.getTask(child.id) === null,
    `${name}: deleting a session deletes child tasks from the same tree`);
  assert(!(await storage.listSessions()).some(session => session.id === childSessionId),
    `${name}: deleting a session deletes child sessions from the same tree`);
}

async function main(): Promise<void> {
  await exerciseMemoryStore();
  await exerciseSQLiteStore();
  console.log('task store tests passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

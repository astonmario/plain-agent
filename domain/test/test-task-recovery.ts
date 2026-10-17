import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { MemoryStorage, SQLiteStorage, TaskOrchestrator } from '../src';
import type { PlainAgent, TaskRecord } from '../src';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class RecoveryAgent extends EventEmitter {
  async submit(prompt: string): Promise<string> {
    await new Promise(resolve => setTimeout(resolve, 2));
    return `recovered: ${prompt}`;
  }

  stop(): void {}
  destroy(): void {}
  getMessages(): Array<{ role: 'assistant' }> {
    return [{ role: 'assistant' }];
  }
}

async function main(): Promise<void> {
  await exerciseRecovery('memory');
  await exerciseRecovery('sqlite');

  console.log('task recovery tests passed');
}

async function exerciseRecovery(kind: 'memory' | 'sqlite'): Promise<void> {
  const dbPath = kind === 'sqlite'
    ? join(tmpdir(), `plain-agent-recovery-${randomUUID()}.db`)
    : undefined;
  const storage = kind === 'sqlite'
    ? new SQLiteStorage(dbPath!)
    : new MemoryStorage();

  try {
    const taskStore = storage.getTaskStore();
    const sessionId = `${kind}-recovery-session`;
    await storage.createSession(sessionId, 'Recovery');

    const taskId = randomUUID();
    const crashedTask: TaskRecord = {
      id: taskId,
      rootId: taskId,
      sessionId,
      prompt: 'continue after worker crash',
      status: 'running',
      attempt: 1,
      maxAttempts: 2,
      leaseOwner: 'dead-worker',
      leaseUntil: Date.now() - 1,
      createdAt: Date.now() - 100,
      updatedAt: Date.now() - 100,
    };
    await taskStore.createTask(crashedTask);

    const orchestrator = new TaskOrchestrator({
      taskStore,
      sessionStorage: storage,
      workerId: 'replacement-worker',
      createAgent: () => new RecoveryAgent() as unknown as PlainAgent,
    });
    const recovery = await orchestrator.recover();
    const recovered = await taskStore.getTask(taskId);
    const events = await taskStore.listEvents(taskId);

    assert(recovery.expired === 1, `${kind}: expired lease is detected during recovery`);
    assert(recovery.started === 1, `${kind}: queued task is resumed by replacement worker`);
    assert(recovered?.status === 'completed', `${kind}: crashed task completes after recovery`);
    assert(recovered?.attempt === 2, `${kind}: recovered task increments attempt`);
    assert(events.some(event => event.type === 'lease-expired'),
      `${kind}: lease-expired event is persisted`);
    assert(events.some(event => event.type === 'task-completed'),
      `${kind}: recovered completion event is persisted`);

    const secondRecovery = await orchestrator.recover();
    assert(secondRecovery.started === 0 && secondRecovery.blocked === 0,
      `${kind}: completed task is not started twice`);

    const waitingId = randomUUID();
    const waitingChildId = randomUUID();
    const now = Date.now();
    await taskStore.createTask({
      id: waitingId,
      rootId: waitingId,
      sessionId,
      prompt: 'parent waiting for child',
      status: 'waiting_child',
      attempt: 1,
      maxAttempts: 2,
      createdAt: now,
      updatedAt: now,
    });
    await storage.createSession(`${kind}-child-session`, 'Child');
    await taskStore.createTask({
      id: waitingChildId,
      parentId: waitingId,
      rootId: waitingId,
      sessionId: `${kind}-child-session`,
      prompt: 'child already completed',
      status: 'completed',
      attempt: 1,
      maxAttempts: 2,
      result: { output: 'child result' },
      createdAt: now + 1,
      updatedAt: now + 1,
    });
    const tree = await taskStore.recoverTaskTree(waitingId);
    assert(tree.length === 2 && tree.some(task => task.id === waitingChildId),
      `${kind}: recoverTaskTree returns the complete parent tree`);
    assert((await taskStore.listChildren(waitingId)).length === 1,
      `${kind}: listChildren returns persisted child tasks`);

    const deferred = await orchestrator.recover();
    const blockedParent = await taskStore.getTask(waitingId);
    const deferredEvents = await taskStore.listEvents(waitingId);
    assert(deferred.blocked === 1, `${kind}: unsafe waiting parent is reported as blocked`);
    assert(blockedParent?.status === 'blocked',
      `${kind}: waiting parent enters explicit blocked state`);
    assert(deferredEvents.some(event => event.type === 'task-recovery-deferred'),
      `${kind}: recovery deferral is persisted`);

    const idempotent = await orchestrator.recover();
    assert(idempotent.blocked === 0 && (await taskStore.getTask(waitingId))?.status === 'blocked',
      `${kind}: blocked recovery is idempotent`);

    const delayedId = randomUUID();
    await taskStore.createTask({
      id: delayedId,
      rootId: delayedId,
      sessionId,
      prompt: 'recover after the previous lease expires',
      status: 'running',
      attempt: 1,
      maxAttempts: 2,
      leaseOwner: 'previous-process',
      leaseUntil: Date.now() + 40,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const earlyRecovery = await orchestrator.recover();
    assert(earlyRecovery.expired === 0 && earlyRecovery.started === 0,
      `${kind}: a still-valid lease is not stolen during startup`);
    let delayed = await taskStore.getTask(delayedId);
    for (let i = 0; i < 100 && delayed?.status !== 'completed'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      delayed = await taskStore.getTask(delayedId);
    }
    assert(delayed?.status === 'completed' && delayed.attempt === 2,
      `${kind}: startup recovery retries after an unexpired lease naturally expires`);
    orchestrator.shutdown();
  } finally {
    if (storage instanceof SQLiteStorage) {
      storage.close();
      rmSync(dbPath!, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

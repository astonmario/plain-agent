import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { MemoryStorage, TaskOrchestrator } from '../src';
import type { PlainAgent, TaskRecord } from '../src';

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
  const storage = new MemoryStorage();
  const taskStore = storage.getTaskStore();
  const sessionId = 'recovery-session';
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

  assert(recovery.expired === 1, 'expired lease is detected during recovery');
  assert(recovery.started === 1, 'queued task is resumed by replacement worker');
  assert(recovered?.status === 'completed', 'crashed task completes after recovery');
  assert(recovered?.attempt === 2, 'recovered task increments attempt');
  assert(events.some(event => event.type === 'lease-expired'),
    'lease-expired event is persisted');
  assert(events.some(event => event.type === 'task-completed'),
    'recovered completion event is persisted');

  console.log('task recovery tests passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

import { EventEmitter } from 'events';
import { MemoryStorage, TaskOrchestrator } from '../src';
import type { AgentEvent, PlainAgent } from '../src';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class FakeAgent extends EventEmitter {
  private stopped = false;

  constructor(
    private readonly delayMs: number,
    private readonly fail: boolean,
  ) {
    super();
  }

  async submit(task: string): Promise<string> {
    this.emit('event', {
      type: 'task-start',
      taskId: 'fake',
      task,
      timestamp: Date.now(),
    } satisfies AgentEvent);
    await new Promise(resolve => setTimeout(resolve, this.delayMs));
    if (this.stopped) {
      const error = new Error('stopped');
      error.name = 'AbortError';
      throw error;
    }
    if (this.fail) throw new Error('transient failure');
    this.emit('event', {
      type: 'done',
      result: `done: ${task}`,
      timestamp: Date.now(),
    } satisfies AgentEvent);
    return `done: ${task}`;
  }

  stop(): void {
    this.stopped = true;
  }

  getMessages(): Array<{ role: 'assistant'; tool_calls?: [] }> {
    return [{ role: 'assistant' }];
  }

  destroy(): void {
    this.removeAllListeners();
  }
}

async function waitForTask(storage: MemoryStorage, count = 1): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const tasks = await storage.getTaskStore().listTasks();
    if (tasks.length >= count) return tasks[tasks.length - 1].id;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('task was not created');
}

async function testCompletionAndEvents(): Promise<void> {
  const storage = new MemoryStorage();
  const created: FakeAgent[] = [];
  const orchestrator = new TaskOrchestrator({
    taskStore: storage.getTaskStore(),
    sessionStorage: storage,
    createAgent: () => {
      const agent = new FakeAgent(5, false);
      created.push(agent);
      return agent as unknown as PlainAgent;
    },
    leaseRenewIntervalMs: 2,
  });

  const output = await orchestrator.run('session-a', 'hello');
  const task = (await storage.getTaskStore().listTasks())[0];
  const events = await storage.getTaskStore().listEvents(task.id);
  assert(output === 'done: hello', 'orchestrator returns agent output');
  assert(task.status === 'completed', 'successful task becomes completed');
  assert(task.attempt === 1, 'successful task is claimed once');
  assert(task.leaseOwner === undefined && task.leaseUntil === undefined,
    'terminal task releases its lease');
  assert(events.some(event => event.type === 'task-started'),
    'task-started event is persisted');
  assert(events.some(event => event.type === 'task-completed'),
    'task-completed event is persisted');
  assert(created.length === 1, 'one agent is used for a successful task');
}

async function testRetry(): Promise<void> {
  const storage = new MemoryStorage();
  let factoryCalls = 0;
  const orchestrator = new TaskOrchestrator({
    taskStore: storage.getTaskStore(),
    sessionStorage: storage,
    maxAttempts: 2,
    createAgent: () => {
      factoryCalls++;
      return new FakeAgent(1, factoryCalls === 1) as unknown as PlainAgent;
    },
  });

  const output = await orchestrator.run('session-b', 'retry me');
  const task = (await storage.getTaskStore().listTasks())[0];
  const events = await storage.getTaskStore().listEvents(task.id);
  assert(output === 'done: retry me', 'transient failure is retried');
  assert(task.status === 'completed' && task.attempt === 2,
    'retry ends in completed with attempt 2');
  assert(events.some(event => event.type === 'task-retry'),
    'task-retry event is persisted');
}

async function testCancellation(): Promise<void> {
  const storage = new MemoryStorage();
  const orchestrator = new TaskOrchestrator({
    taskStore: storage.getTaskStore(),
    sessionStorage: storage,
    createAgent: () => new FakeAgent(100, false) as unknown as PlainAgent,
  });

  const pending = orchestrator.run('session-c', 'cancel me');
  const taskId = await waitForTask(storage);
  await orchestrator.cancel(taskId);
  let rejected = false;
  try {
    await pending;
  } catch (error: any) {
    rejected = error?.name === 'AbortError';
  }
  assert(rejected, 'cancelled task rejects with AbortError');
  assert((await storage.getTaskStore().getTask(taskId))?.status === 'cancelled',
    'cancelled task remains cancelled');
}

async function main(): Promise<void> {
  await testCompletionAndEvents();
  await testRetry();
  await testCancellation();
  console.log('task orchestrator tests passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

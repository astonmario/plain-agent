import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { MemoryStorage, PlainAgent, SQLiteStorage, TaskOrchestrator } from '../src';
import type { AgentEvent, ChatMessage, LLMConfig, TaskCheckpoint, TaskRecord, Tool } from '../src';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const llm: LLMConfig = {
  provider: 'openai',
  apiKey: 'test-key',
  model: 'test-model',
  baseUrl: 'https://resume.example.test/v1',
};

function call(id: string, name: string, args: object = {}) {
  return {
    id,
    type: 'function' as const,
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function sseResponse(reply: string | ReturnType<typeof call>): Response {
  const delta = typeof reply === 'string'
    ? { content: reply }
    : {
        tool_calls: [{
          index: 0,
          id: reply.id,
          type: 'function',
          function: {
            name: reply.function.name,
            arguments: reply.function.arguments,
          },
        }],
      };
  const body = `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`;
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

let scripted: Array<string | ReturnType<typeof call>> = [];
globalThis.fetch = (async () => {
  const reply = scripted.shift();
  if (reply === undefined) throw new Error('No scripted LLM response');
  return sseResponse(reply);
}) as typeof fetch;

const tool: Tool = {
  name: 'read_probe',
  description: 'read probe',
  schema: {
    type: 'function',
    function: {
      name: 'read_probe',
      description: 'read probe',
      parameters: { type: 'object', properties: {} },
    },
  },
  handler: async () => 'probe-result',
  meta: { readonly: true, concurrent: true },
};

const unsafeTool: Tool = {
  ...tool,
  name: 'unsafe_probe',
  schema: {
    ...tool.schema,
    function: {
      ...tool.schema.function,
      name: 'unsafe_probe',
    },
  },
  meta: { readonly: false, concurrent: false },
};

function makeTask(sessionId: string, owner: string): TaskRecord {
  const id = randomUUID();
  const now = Date.now();
  return {
    id,
    rootId: id,
    sessionId,
    prompt: 'resume task',
    status: 'running',
    attempt: 1,
    maxAttempts: 3,
    leaseOwner: owner,
    leaseUntil: now + 60_000,
    createdAt: now,
    updatedAt: now,
  };
}

function createAgent(storage: MemoryStorage | SQLiteStorage, sessionId: string): PlainAgent {
  return new PlainAgent({
    llm,
    tools: [tool, unsafeTool],
    storage,
    taskStore: storage.getTaskStore(),
    sessionId,
    historyManagement: { enabled: false },
    maxIterations: 20,
    systemPrompt: 'test system',
  });
}

async function testDurableTurns(): Promise<void> {
  const storage = new MemoryStorage();
  const sessionId = 'durable-turn-session';
  await storage.createSession(sessionId, 'Durable turns');
  scripted = [call('read-1', 'read_probe'), 'final answer'];

  const orchestrator = new TaskOrchestrator({
    taskStore: storage.getTaskStore(),
    sessionStorage: storage,
    workerId: 'turn-worker',
    turnMaxIterations: 1,
    createAgent: (sid) => createAgent(storage, sid),
  });

  const output = await orchestrator.run(sessionId, 'do the work');
  const task = (await storage.getTaskStore().listTasks())[0];
  const transcript = await storage.loadMessages(sessionId, task.id);
  const sessionHistory = await storage.loadMessages(sessionId);
  const events = await storage.getTaskStore().listEvents(task.id);

  assert(output === 'final answer', 'durable turns eventually return the final answer');
  assert(task.status === 'completed', 'durable turns finish the task');
  assert(transcript.filter(message => message.role === 'user').length === 1,
    'durable turns persist the user prompt exactly once');
  assert(transcript.some(message => message.tool_call_id === 'read-1'),
    'durable turns persist tool output in the task transcript');
  assert(sessionHistory.some(message => message.content === 'do the work'),
    'durable turns keep messages in the user-visible session history');
  assert(events.some(event => event.type === 'turn-paused'),
    'turn budget creates a persisted pause event');
  assert(events.some(event => event.type === 'checkpoint-created'),
    'durable turns create checkpoints');
}

async function testResumeAcrossAgentInstances(): Promise<void> {
  const storage = new MemoryStorage();
  await exerciseResumeAcrossAgentInstances(storage, 'resume-session');
}

async function exerciseResumeAcrossAgentInstances(
  storage: MemoryStorage | SQLiteStorage,
  sessionId: string,
): Promise<void> {
  await storage.createSession(sessionId, 'Resume');
  const store = storage.getTaskStore();
  const task = makeTask(sessionId, 'worker-a');
  await store.createTask(task);
  scripted = [call('read-1', 'read_probe')];

  const first = createAgent(storage, sessionId);
  const firstEvents: AgentEvent[] = [];
  first.on('event', (event: AgentEvent) => firstEvents.push(event));
  const paused = await first.runTurn(task.id, task.prompt, { maxIterations: 1 });
  assert(paused.status === 'paused', 'first worker pauses at the turn boundary');
  assert(firstEvents.some(event => event.type === 'task-start'),
    'durable turns announce task start');
  assert(!firstEvents.some(event => event.type === 'stopped'),
    'turn budget pauses do not look like user cancellation');

  await store.updateTask(task.id, {
    attempt: 2,
    leaseOwner: 'worker-b',
    leaseUntil: Date.now() + 60_000,
  });
  scripted = ['resumed answer'];
  const second = createAgent(storage, sessionId);
  const secondEvents: AgentEvent[] = [];
  second.on('event', (event: AgentEvent) => secondEvents.push(event));
  const resumed = await second.resume(task.id);
  const transcript = await storage.loadMessages(sessionId, task.id);

  assert(resumed.status === 'completed', 'a new agent instance resumes the task');
  assert(resumed.output === 'resumed answer', 'resume returns the new model output');
  assert(transcript.filter(message => message.role === 'user').length === 1,
    'resume does not inject the original user prompt again');
  assert(transcript.filter(message => message.role === 'assistant').length === 2,
    'resume preserves the previous and resumed assistant messages');
  assert(secondEvents.some(event => event.type === 'task-start'),
    'resumed durable turns announce task start');
  assert(secondEvents.some(event => event.type === 'done') &&
    secondEvents.some(event => event.type === 'task-end'),
  'completed durable turns emit terminal lifecycle events');
}

async function testSQLiteResumeAcrossAgentInstances(): Promise<void> {
  const dbPath = join(tmpdir(), `plain-agent-resume-${randomUUID()}.db`);
  const storage = new SQLiteStorage(dbPath);
  try {
    await exerciseResumeAcrossAgentInstances(storage, 'sqlite-resume-session');
  } finally {
    storage.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
}

async function testUnsafeReplayBlocks(): Promise<void> {
  const storage = new MemoryStorage();
  const sessionId = 'unsafe-replay-session';
  await storage.createSession(sessionId, 'Unsafe replay');
  const store = storage.getTaskStore();
  const task = makeTask(sessionId, 'worker-a');
  await store.createTask(task);

  const unsafeCall = call('unsafe-1', 'unsafe_probe');
  const userMessage: ChatMessage = { role: 'user', content: task.prompt };
  const assistantMessage: ChatMessage = {
    role: 'assistant',
    content: '',
    tool_calls: [unsafeCall],
  };
  await storage.saveMessage(sessionId, userMessage, task.id);
  await storage.saveMessage(sessionId, assistantMessage, task.id);
  await store.appendEvent(task.id, 'tool-call-started', {
    callId: unsafeCall.id,
    tool: unsafeCall.function.name,
    args: {},
  });

  const checkpoint: TaskCheckpoint = {
    id: randomUUID(),
    taskId: task.id,
    attempt: task.attempt,
    iteration: 1,
    transcriptCursor: 2,
    state: {
      phase: 'after_llm',
      nextAction: 'continue',
      pendingChildIds: [],
      pendingJobIds: [],
      pendingToolCalls: [unsafeCall],
    },
    summary: 'unsafe tool pending',
    createdAt: Date.now(),
  };
  assert(await store.commitCheckpoint(task.id, checkpoint, {
    type: 'checkpoint-created',
    data: { checkpointId: checkpoint.id },
  }, { workerId: 'worker-a', attempt: 1 }), 'unsafe replay checkpoint commits');

  const agent = createAgent(storage, sessionId);
  const result = await agent.resume(task.id);
  const events = await store.listEvents(task.id);

  assert(result.status === 'blocked', 'unknown unsafe tool outcome blocks recovery');
  assert(events.some(event => event.type === 'task-blocked'),
    'unsafe replay writes a task-blocked event');
}

async function testFinalCheckpointDoesNotReplayModel(): Promise<void> {
  const storage = new MemoryStorage();
  const sessionId = 'final-checkpoint-session';
  await storage.createSession(sessionId, 'Final checkpoint');
  const store = storage.getTaskStore();
  const task = makeTask(sessionId, 'worker-a');
  await store.createTask(task);
  const finalAnswer = 'already persisted final answer';
  await storage.saveMessage(sessionId, { role: 'user', content: task.prompt }, task.id);
  await storage.saveMessage(sessionId, { role: 'assistant', content: finalAnswer }, task.id);
  const checkpoint: TaskCheckpoint = {
    id: randomUUID(),
    taskId: task.id,
    attempt: task.attempt,
    iteration: 1,
    transcriptCursor: 2,
    state: {
      phase: 'after_llm',
      nextAction: 'complete',
      pendingChildIds: [],
      pendingJobIds: [],
    },
    summary: 'final assistant response persisted',
    createdAt: Date.now(),
  };
  assert(await store.commitCheckpoint(task.id, checkpoint, {
    type: 'checkpoint-created',
    data: { checkpointId: checkpoint.id },
  }, { workerId: 'worker-a', attempt: 1 }), 'final response checkpoint commits');

  scripted = [];
  const agent = createAgent(storage, sessionId);
  const events: AgentEvent[] = [];
  agent.on('event', (event: AgentEvent) => events.push(event));
  const resumed = await agent.resume(task.id);
  assert(resumed.status === 'completed', 'resume completes from a final-response checkpoint');
  assert(resumed.output === finalAnswer, 'resume returns the persisted final response');
  assert(scripted.length === 0, 'resume does not call the model again');
  assert(events.some(event => event.type === 'task-start') &&
    events.some(event => event.type === 'done') &&
    events.some(event => event.type === 'task-end'),
  'final-response checkpoint emits a complete task lifecycle without model replay');
}

async function main(): Promise<void> {
  await testDurableTurns();
  await testResumeAcrossAgentInstances();
  await testSQLiteResumeAcrossAgentInstances();
  await testUnsafeReplayBlocks();
  await testFinalCheckpointDoesNotReplayModel();
  console.log('task resume tests passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

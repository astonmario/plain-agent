import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import {
  MemoryStorage,
  SQLiteStorage,
  TaskOrchestrator,
} from '../src';
import type {
  PlainAgent,
  SessionStorage,
  TaskRecord,
  TaskStore,
  TaskVerificationPolicy,
  VerificationCheckRunner,
} from '../src';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const scratch = mkdtempSync(join(tmpdir(), 'plain-agent-verification-'));

class DurableAgent extends EventEmitter {
  turns: string[] = [];

  constructor(private readonly output = 'done') {
    super();
  }

  async runTurn(_taskId: string, prompt: string): Promise<{ status: 'completed'; output: string }> {
    this.turns.push(prompt);
    return { status: 'completed', output: this.output };
  }

  async resume(): Promise<{ status: 'completed'; output: string }> {
    return { status: 'completed', output: this.output };
  }

  stop(): void {}

  destroy(): void {
    this.removeAllListeners();
  }
}

interface Harness {
  storage: SessionStorage & { getTaskStore(): TaskStore; close?: () => void };
  store: TaskStore;
  orchestrator: TaskOrchestrator;
  agent: DurableAgent;
  sessionId: string;
}

function makeHarness(
  kind: 'memory' | 'sqlite',
  options: {
    workerId?: string;
    runner?: VerificationCheckRunner;
    agent?: DurableAgent;
    dbPath?: string;
    existingStorage?: SessionStorage & { getTaskStore(): TaskStore; close?: () => void };
  } = {},
): Harness {
  const storage = options.existingStorage ?? (kind === 'sqlite'
    ? new SQLiteStorage(options.dbPath ?? join(scratch, `${randomUUID()}.db`))
    : new MemoryStorage());
  const agent = options.agent ?? new DurableAgent();
  const orchestrator = new TaskOrchestrator({
    taskStore: storage.getTaskStore(),
    sessionStorage: storage,
    workerId: options.workerId ?? `worker-${randomUUID()}`,
    workspaceRoot: scratch,
    verificationLogRoot: join(scratch, 'logs'),
    verificationRunner: options.runner,
    leaseRenewIntervalMs: 60_000,
    createAgent: () => agent as unknown as PlainAgent,
  });
  return {
    storage,
    store: storage.getTaskStore(),
    orchestrator,
    agent,
    sessionId: `session-${randomUUID()}`,
  };
}

async function firstTask(store: TaskStore): Promise<TaskRecord> {
  const tasks = await store.listTasks();
  assert(tasks.length === 1, `expected exactly one task, got ${tasks.length}`);
  return tasks[0];
}

function okCheck(name = 'ok'): { kind: 'command'; name: string; command: string } {
  return { kind: 'command', name, command: 'node -e "process.exit(0)"' };
}

function failCheck(name = 'fails'): { kind: 'command'; name: string; command: string } {
  return { kind: 'command', name, command: 'node -e "console.error(\'boom\'); process.exit(3)"' };
}

function policy(checks: TaskVerificationPolicy['checks']): TaskVerificationPolicy {
  return { mode: 'required', checks };
}

async function waitForStatus(
  store: TaskStore,
  taskId: string,
  status: TaskRecord['status'],
  attempts = 200,
): Promise<TaskRecord> {
  for (let i = 0; i < attempts; i++) {
    const task = await store.getTask(taskId);
    if (task?.status === status) return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const task = await store.getTask(taskId);
  throw new Error(`task did not reach ${status}, current=${task?.status}`);
}

async function waitForTaskId(store: TaskStore): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const tasks = await store.listTasks();
    if (tasks.length > 0) return tasks[0].id;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('task was not created');
}

async function testPass(kind: 'memory' | 'sqlite'): Promise<void> {
  const h = makeHarness(kind);
  await h.storage.createSession(h.sessionId, 'verify');
  const output = await h.orchestrator.run(h.sessionId, 'do work', undefined, undefined, {
    verification: policy([okCheck('typecheck')]),
  });
  assert(output === 'done', `${kind}: run returns the agent output`);

  const task = await firstTask(h.store);
  assert(task.status === 'completed', `${kind}: task completed after verification`);

  const verifications = await h.store.listVerifications(task.id);
  assert(verifications.length === 1, `${kind}: one verification record`);
  assert(verifications[0].status === 'passed', `${kind}: verification passed`);
  assert(verifications[0].attempt === task.attempt, `${kind}: verification bound to attempt`);
  assert(verifications[0].checks[0].status === 'passed', `${kind}: check passed`);
  assert(verifications[0].checks[0].exitCode === 0, `${kind}: exit code persisted`);

  const events = (await h.store.listEvents(task.id)).map(event => event.type);
  assert(events.includes('verification-started'), `${kind}: verification-started event`);
  assert(events.includes('verification-check-completed'), `${kind}: check event`);
  assert(events.includes('verification-completed'), `${kind}: verification-completed event`);
  assert(events.includes('task-completed'), `${kind}: task-completed event`);

  h.orchestrator.shutdown();
  h.storage.close?.();
}

async function testFailure(): Promise<void> {
  const h = makeHarness('memory');
  await h.storage.createSession(h.sessionId, 'verify');

  let failed = false;
  try {
    await h.orchestrator.run(h.sessionId, 'do work', undefined, undefined, {
      verification: policy([failCheck()]),
    });
  } catch (error) {
    failed = true;
    assert(String(error).includes('fails'), 'failure reason names the failing check');
  }
  assert(failed, 'verification failure rejects the run');

  const task = await firstTask(h.store);
  assert(task.status === 'failed', 'task is failed, not completed');
  const verification = (await h.store.listVerifications(task.id))[0];
  assert(verification.status === 'failed', 'verification recorded as failed');
  assert(verification.checks[0].exitCode === 3, 'exit code persisted');
  assert((verification.checks[0].outputTail ?? '').includes('boom'), 'stderr tail captured');
  assert(typeof verification.checks[0].outputRef === 'string', 'log path recorded');

  const events = (await h.store.listEvents(task.id)).map(event => event.type);
  assert(events.includes('verification-failed'), 'verification-failed event');
  assert(!events.includes('task-completed'), 'no completion event on failure');

  h.orchestrator.shutdown();
}

async function testStopOnFailure(): Promise<void> {
  const h = makeHarness('memory');
  await h.storage.createSession(h.sessionId, 'verify');
  await h.orchestrator.run(h.sessionId, 'do work', undefined, undefined, {
    verification: policy([okCheck('first'), failCheck('second'), okCheck('third')]),
  }).catch(() => undefined);

  const task = await firstTask(h.store);
  const verification = (await h.store.listVerifications(task.id))[0];
  assert(verification.status === 'failed', 'verification failed');
  assert(verification.checks[0].status === 'passed', 'first check passed');
  assert(verification.checks[1].status === 'failed', 'second check failed');
  assert(verification.checks[2].status === 'skipped', 'remaining check skipped');

  h.orchestrator.shutdown();
}

async function testPolicyOff(): Promise<void> {
  const h = makeHarness('memory');
  await h.storage.createSession(h.sessionId, 'verify');
  const output = await h.orchestrator.run(h.sessionId, 'plain task');
  assert(output === 'done', 'no policy still completes');

  const task = await firstTask(h.store);
  assert(task.status === 'completed', 'task completed without verification');
  assert((await h.store.listVerifications(task.id)).length === 0, 'no verification rows');
  const events = (await h.store.listEvents(task.id)).map(event => event.type);
  assert(events.includes('verification-skipped'), 'skipped event recorded');

  h.orchestrator.shutdown();
}

async function testEmptyRequiredPolicy(): Promise<void> {
  const h = makeHarness('memory');
  await h.storage.createSession(h.sessionId, 'verify');
  let message = '';
  try {
    await h.orchestrator.run(h.sessionId, 'do work', undefined, undefined, {
      verification: { mode: 'required', checks: [] },
    });
  } catch (error) {
    message = String(error);
  }
  assert(message.includes('verification-policy-has-no-checks'), 'empty policy fails loudly');
  const task = await firstTask(h.store);
  assert(task.status === 'failed', 'task failed on empty policy');
  h.orchestrator.shutdown();
}

async function testCrashRecovery(kind: 'memory' | 'sqlite'): Promise<void> {
  const dbPath = join(scratch, `${randomUUID()}.db`);
  const callsA: number[] = [];
  const runnerA: VerificationCheckRunner = async (check, ctx) => {
    callsA.push(Number(check.name.replace('check-', '')));
    if (check.name === 'check-1') {
      const task = await hA.store.listTasks();
      // Simulate the worker dying mid-check: expire the lease, then blow up.
      await hA.store.updateTask(task[0].id, { leaseUntil: Date.now() - 1 });
      throw new Error('simulated-crash');
    }
    assert(ctx.timeoutMs > 0, 'runner receives a timeout');
    return { status: 'passed', durationMs: 1 };
  };

  const hA = makeHarness(kind, { runner: runnerA, dbPath });
  await hA.storage.createSession(hA.sessionId, 'verify');

  let crashed = false;
  try {
    await hA.orchestrator.run(hA.sessionId, 'do work', undefined, undefined, {
      verification: policy([
        { kind: 'command', name: 'check-0', command: 'noop' },
        { kind: 'command', name: 'check-1', command: 'noop' },
      ]),
    });
  } catch {
    crashed = true;
  }
  assert(crashed, `${kind}: crashed verification rejects the run`);

  const taskId = (await firstTask(hA.store)).id;
  const afterCrash = await hA.store.getTask(taskId);
  assert(afterCrash?.status === 'verifying', `${kind}: task stays in verifying`);
  assert(afterCrash?.attempt === 1, `${kind}: crash does not bump attempt`);

  hA.orchestrator.shutdown();
  hA.storage.close?.();

  const callsB: number[] = [];
  const runnerB: VerificationCheckRunner = async check => {
    callsB.push(Number(check.name.replace('check-', '')));
    return { status: 'passed', durationMs: 1 };
  };
  const hB = makeHarness(kind, {
    runner: runnerB,
    dbPath: kind === 'sqlite' ? dbPath : undefined,
    existingStorage: kind === 'memory' ? hA.storage : undefined,
  });
  const recovery = await hB.orchestrator.recover();
  assert(recovery.expired >= 1, `${kind}: expired lease was recovered`);

  const recovered = await hB.store.getTask(taskId);
  assert(recovered?.status === 'completed', `${kind}: recovered verification completes the task`);
  assert(recovered?.attempt === 1, `${kind}: recovery keeps the same attempt`);
  assert(hA.agent.turns.length === 1, `${kind}: agent turn ran once`);
  assert(hB.agent.turns.length === 0, `${kind}: recovery does not re-run the agent turn`);
  assert(!callsB.includes(0), `${kind}: passed checks are not re-run`);
  assert(callsB.includes(1), `${kind}: interrupted safe check is re-run`);

  hB.orchestrator.shutdown();
  hB.storage.close?.();
}

async function testUnsafeRerun(): Promise<void> {
  const callsA: number[] = [];
  let signalCheckOne: () => void = () => undefined;
  const checkOneStarted = new Promise<void>(resolveSignal => {
    signalCheckOne = resolveSignal;
  });
  const runnerA: VerificationCheckRunner = async check => {
    callsA.push(Number(check.name.replace('check-', '')));
    if (check.name === 'check-1') {
      const tasks = await hA.store.listTasks();
      await hA.store.updateTask(tasks[0].id, { leaseUntil: Date.now() - 1 });
      signalCheckOne();
      throw new Error('worker-died');
    }
    return { status: 'passed', durationMs: 1 };
  };
  const hA = makeHarness('memory', { runner: runnerA });
  await hA.storage.createSession(hA.sessionId, 'verify');
  const runPromise = hA.orchestrator.run(hA.sessionId, 'deploy', undefined, undefined, {
    verification: policy([
      { kind: 'command', name: 'check-0', command: 'noop' },
      { kind: 'command', name: 'check-1', command: 'deploy', rerunSafe: false },
    ]),
  });
  const taskId = await waitForTaskId(hA.store);
  await checkOneStarted;
  await runPromise.catch(() => undefined);
  hA.orchestrator.shutdown();

  const callsB: number[] = [];
  const hB = makeHarness('memory', {
    existingStorage: hA.storage,
    runner: async check => {
      callsB.push(Number(check.name.replace('check-', '')));
      return { status: 'passed', durationMs: 1 };
    },
  });
  await hB.orchestrator.recover();
  const task = await hB.store.getTask(taskId);
  assert(task?.status === 'failed', 'unsafe interrupted check fails the task');
  const verification = (await hB.store.listVerifications(taskId))[0];
  assert((verification.error ?? '').includes('check-interrupted-unsafe-rerun'),
    'failure explains the unsafe rerun refusal');
  assert(!callsB.includes(1), 'unsafe check is not re-run after a crash');
  hB.orchestrator.shutdown();
}

async function testStaleWorkerAndLease(): Promise<void> {
  const h = makeHarness('memory');
  await h.storage.createSession(h.sessionId, 'verify');
  const task = await h.orchestrator.createTask(h.sessionId, 'guarded', {
    verification: policy([okCheck()]),
  });
  const claimed = await h.store.claimTask(task.id, 'worker-a');
  assert(claimed?.status === 'running', 'task claimed');
  const verification = await h.store.beginVerification(
    task.id,
    'worker-a',
    claimed!.attempt,
    [{ index: 0, name: 'ok', kind: 'command', command: 'noop' }],
  );
  assert(verification !== null, 'verification started');

  // G2 regression: the lease must be renewable while verifying.
  assert(await h.store.renewLease(task.id, 'worker-a', claimed!.attempt),
    'lease renews during verifying');

  assert(await h.store.concludeVerification(verification!.id, 'worker-b', {
    passed: true,
    changedFiles: [],
  }) === null, 'another worker cannot conclude the verification');

  await h.store.updateTask(task.id, { leaseUntil: Date.now() - 1 });
  assert(await h.store.concludeVerification(verification!.id, 'worker-a', {
    passed: true,
    changedFiles: [],
  }) === null, 'expired lease cannot conclude the verification');

  const current = await h.store.getTask(task.id);
  assert(current?.status === 'verifying', 'task remains verifying after rejected conclusions');
  h.orchestrator.shutdown();
}

async function testCompletionGuard(): Promise<void> {
  const h = makeHarness('memory');
  await h.storage.createSession(h.sessionId, 'verify');
  const task = await h.orchestrator.createTask(h.sessionId, 'guarded', {
    verification: policy([okCheck()]),
  });
  const claimed = await h.store.claimTask(task.id, 'worker-a');
  assert(claimed !== null, 'claimed');

  const completed = await h.store.finishAttempt(
    task.id,
    'worker-a',
    claimed!.attempt,
    'completed',
    { output: 'sneaky' },
  );
  assert(!completed, 'completion without a passed verification is rejected');
  const events = (await h.store.listEvents(task.id)).map(event => event.type);
  assert(events.includes('completion-rejected'), 'completion-rejected event recorded');
  assert((await h.store.getTask(task.id))?.status === 'running', 'task stays running');
  h.orchestrator.shutdown();
}

async function testCancelDuringVerification(): Promise<void> {
  const h = makeHarness('memory', {
    runner: async (_check, ctx) => new Promise(resolve => {
      const finish = () => resolve({ status: 'failed' as const, durationMs: 0, error: 'aborted' });
      if (ctx.signal.aborted) return finish();
      ctx.signal.addEventListener('abort', finish, { once: true });
    }),
  });
  await h.storage.createSession(h.sessionId, 'verify');
  const runPromise = h.orchestrator.run(h.sessionId, 'long check', undefined, undefined, {
    verification: policy([okCheck('slow')]),
  });
  const taskId = await waitForTaskId(h.store);
  await waitForStatus(h.store, taskId, 'verifying');

  assert(await h.orchestrator.cancel(taskId), 'cancel accepted while verifying');
  await runPromise.catch(() => undefined);
  const task = await h.store.getTask(taskId);
  assert(task?.status === 'cancelled', 'task cancelled from verifying');
  const events = (await h.store.listEvents(taskId)).map(event => event.type);
  assert(!events.includes('task-failed'), 'cancel does not emit task-failed');
  h.orchestrator.shutdown();
}

async function testSqliteMigration(): Promise<void> {
  const dbPath = join(scratch, `${randomUUID()}.db`);
  const storage = new SQLiteStorage(dbPath);
  const store = storage.getTaskStore();
  await storage.createSession('legacy-session', 'Legacy');
  const task = await new TaskOrchestrator({
    taskStore: store,
    sessionStorage: storage,
    workspaceRoot: scratch,
    createAgent: () => new DurableAgent() as unknown as PlainAgent,
  }).createTask('legacy-session', 'old task');
  storage.close();

  // node:sqlite types are not in @types/node 20; load it without a static import.
  const { createRequire } = await import('node:module');
  const requireNode = createRequire(import.meta.url);
  const { DatabaseSync } = requireNode('node:sqlite') as {
    DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
  };
  const raw = new DatabaseSync(dbPath);
  raw.exec('DROP TABLE task_verification_checks');
  raw.exec('DROP TABLE task_verifications');
  raw.close();

  const reopened = new SQLiteStorage(dbPath);
  const reopenedStore = reopened.getTaskStore();
  const loaded = await reopenedStore.getTask(task.id);
  assert(loaded?.prompt === 'old task', 'legacy task still readable');
  assert((await reopenedStore.listVerifications(task.id)).length === 0,
    'verification tables recreated empty');
  reopened.close();
}

async function testPoliciesRoundTrip(): Promise<void> {
  const h = makeHarness('sqlite');
  await h.storage.createSession(h.sessionId, 'verify');
  const task = await h.orchestrator.createTask(h.sessionId, 'policy roundtrip', {
    verification: {
      mode: 'required',
      timeoutMs: 42_000,
      checks: [
        { kind: 'files-exist', name: 'artifact', paths: ['package.json'] },
        { kind: 'command', name: 'cmd', command: 'echo hi', rerunSafe: false },
      ],
    },
  });
  const loaded = await h.store.getTask(task.id);
  assert(loaded?.verification?.mode === 'required', 'policy mode persisted');
  assert(loaded?.verification?.timeoutMs === 42_000, 'policy timeout persisted');
  assert(loaded?.verification?.checks?.length === 2, 'policy checks persisted');
  h.orchestrator.shutdown();
  h.storage.close?.();
}

async function testFilesExistAndGitDiff(): Promise<void> {
  const h = makeHarness('memory');
  await h.storage.createSession(h.sessionId, 'verify');
  writeFileSync(join(scratch, 'artifact.txt'), 'built', 'utf-8');
  await h.orchestrator.run(h.sessionId, 'check artifacts', undefined, undefined, {
    verification: policy([
      { kind: 'files-exist', name: 'pkg', paths: ['artifact.txt'] },
      { kind: 'files-exist', name: 'missing', paths: ['definitely-missing.txt'] },
    ]),
  }).catch(() => undefined);
  const task = await firstTask(h.store);
  const verification = (await h.store.listVerifications(task.id))[0];
  assert(verification.checks[0].status === 'passed', 'existing artifact passes');
  assert(verification.checks[1].status === 'failed', 'missing artifact fails');
  assert((verification.checks[1].error ?? '').includes('definitely-missing.txt'),
    'missing path reported');
  h.orchestrator.shutdown();
}

async function testGitDiffCheck(): Promise<void> {
  const repo = join(scratch, `repo-${randomUUID()}`);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'verify@example.test'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Verify'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'two\n');

  const h = makeHarness('memory');
  await h.storage.createSession(h.sessionId, 'verify');
  await h.orchestrator.run(h.sessionId, 'changed repo', undefined, undefined, {
    verification: {
      mode: 'required',
      cwd: repo,
      checks: [{ kind: 'git-diff', name: 'changed' }],
    },
  });
  const task = await firstTask(h.store);
  assert(task.status === 'completed', 'git-diff passes when the tree has changes');
  const verification = (await h.store.listVerifications(task.id))[0];
  assert(verification.changedFiles.includes('a.txt'), 'changedFiles evidence recorded');
  assert(
    typeof verification.diffHash === 'string' && verification.diffHash.length === 64,
    'diffHash evidence recorded',
  );
  h.orchestrator.shutdown();

  execFileSync('git', ['checkout', '--', 'a.txt'], { cwd: repo });
  const cleanHarness = makeHarness('memory');
  await cleanHarness.storage.createSession(cleanHarness.sessionId, 'verify');
  await cleanHarness.orchestrator.run(cleanHarness.sessionId, 'clean repo', undefined, undefined, {
    verification: {
      mode: 'required',
      cwd: repo,
      checks: [{ kind: 'git-diff', name: 'changed' }],
    },
  }).catch(() => undefined);
  const cleanTask = await firstTask(cleanHarness.store);
  assert(cleanTask.status === 'failed', 'git-diff fails when the tree is clean');
  const cleanVerification = (await cleanHarness.store.listVerifications(cleanTask.id))[0];
  assert((cleanVerification.error ?? '').includes('no-changes'), 'failure reason is no-changes');
  cleanHarness.orchestrator.shutdown();
}

async function main(): Promise<void> {
  try {
    await testPass('memory');
    await testPass('sqlite');
    await testFailure();
    await testStopOnFailure();
    await testPolicyOff();
    await testEmptyRequiredPolicy();
    await testCrashRecovery('memory');
    await testCrashRecovery('sqlite');
    await testUnsafeRerun();
    await testStaleWorkerAndLease();
    await testCompletionGuard();
    await testCancelDuringVerification();
    await testSqliteMigration();
    await testPoliciesRoundTrip();
    await testFilesExistAndGitDiff();
    await testGitDiffCheck();
    console.log('task verification tests passed');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

void main();

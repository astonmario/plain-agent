/**
 * 跨进程崩溃测试的子进程：持有 SQLite 任务库，跑到 verifying 的慢检查，
 * 打印 `READY <taskId>` 后一直挂着，等待父进程 kill -9。
 */

import { EventEmitter } from 'node:events';
import { SQLiteStorage, TaskOrchestrator } from '../../src';
import type { PlainAgent } from '../../src';

const [dbPath, scratch, sessionId] = process.argv.slice(2);

class WorkerAgent extends EventEmitter {
  async runTurn(): Promise<{ status: 'completed'; output: string }> {
    return { status: 'completed', output: 'worker-done' };
  }

  async resume(): Promise<{ status: 'completed'; output: string }> {
    return { status: 'completed', output: 'worker-done' };
  }

  stop(): void {}

  destroy(): void {
    this.removeAllListeners();
  }
}

async function main(): Promise<void> {
  const storage = new SQLiteStorage(dbPath);
  const store = storage.getTaskStore();
  await storage.createSession(sessionId, 'crash worker');

  const orchestrator = new TaskOrchestrator({
    taskStore: store,
    sessionStorage: storage,
    workerId: 'crash-worker',
    workspaceRoot: scratch,
    verificationLogRoot: `${scratch}/logs`,
    leaseRenewIntervalMs: 60_000,
    createAgent: () => new WorkerAgent() as unknown as PlainAgent,
  });

  const run = orchestrator.run(sessionId, 'long verification', undefined, undefined, {
    verification: {
      mode: 'required',
      checks: [{ kind: 'command', name: 'slow', command: 'node probe.js' }],
    },
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const tasks = await store.listTasks();
    const task = tasks[0];
    if (task?.status === 'verifying') {
      const verification = await store.getLatestVerification(task.id);
      if (verification?.checks[0]?.status === 'running') {
        process.stdout.write(`READY ${task.id}\n`);
        break;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  await run.catch(() => undefined);
}

void main();

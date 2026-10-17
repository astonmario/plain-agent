/**
 * 跨进程崩溃恢复测试（真杀进程，不是模拟）
 *
 * 1. 子进程持有 SQLite 任务库，把任务推进到 verifying 并启动一个会挂起的检查；
 * 2. 父进程用 taskkill /T /F 杀掉整个子进程树；
 * 3. 父进程重新打开同一个库，recover() 恢复验证；
 * 4. 断言：任务 completed、attempt 仍为 1、Agent turn 没有被重跑。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQLiteStorage, TaskOrchestrator } from '../src';
import type { PlainAgent } from '../src';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const scratch = mkdtempSync(join(tmpdir(), 'plain-agent-crash-'));
const dbPath = join(scratch, 'crash.db');
const sessionId = 'crash-session';
const workerScript = fileURLToPath(new URL('./fixtures/verification-worker.ts', import.meta.url));
const tsxCli = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const probeSource = fileURLToPath(new URL('./fixtures/verification-probe.js', import.meta.url));

class NeverRunsAgent extends EventEmitter {
  turns = 0;

  async runTurn(): Promise<never> {
    this.turns++;
    throw new Error('recovery must not re-run the agent turn');
  }

  async resume(): Promise<never> {
    this.turns++;
    throw new Error('recovery must not resume the agent turn');
  }

  stop(): void {}

  destroy(): void {
    this.removeAllListeners();
  }
}

function startWorker(): { child: ChildProcess; ready: Promise<string> } {
  const child = spawn(
    process.execPath,
    [tsxCli, workerScript, dbPath, scratch, sessionId],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  const ready = new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`worker did not reach verifying:\n${stdout}\n${stderr}`));
    }, 30_000);

    child.stdout?.on('data', chunk => {
      stdout += String(chunk);
      const match = stdout.match(/READY (\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr?.on('data', chunk => {
      stderr += String(chunk);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`worker exited before READY (code ${code}):\n${stderr}`));
    });
  });
  return { child, ready };
}

function killTree(child: ChildProcess): void {
  if (process.platform === 'win32') {
    if (child.pid !== undefined) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }
    return;
  }
  child.kill('SIGKILL');
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not exit after kill')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  copyFileSync(probeSource, join(scratch, 'probe.js'));
  const { child, ready } = startWorker();
  const taskId = await ready;

  killTree(child);
  await waitForExit(child);

  assert(existsSync(join(scratch, 'probe.marker')),
    'probe ran at least once before the crash');

  const storage = new SQLiteStorage(dbPath);
  const store = storage.getTaskStore();
  const crashed = await store.getTask(taskId);
  assert(crashed?.status === 'verifying', `task stays verifying after kill, got ${crashed?.status}`);
  assert(crashed?.attempt === 1, `attempt unchanged after kill, got ${crashed?.attempt}`);
  const crashedVerification = await store.getLatestVerification(taskId);
  assert(crashedVerification?.status === 'running', 'verification still running after kill');
  assert(crashedVerification?.checks[0].status === 'running', 'check still running after kill');

  // 真实重启时租约最多还会剩 60s；测试不等真实超时，直接把租约提前过期，
  // 模拟「启动时判定上一个 worker 已死」。其余路径都是真实进程与真实数据库。
  await store.updateTask(taskId, { leaseUntil: Date.now() - 1 });

  const agent = new NeverRunsAgent();
  const orchestrator = new TaskOrchestrator({
    taskStore: store,
    sessionStorage: storage,
    workerId: 'recovered-worker',
    workspaceRoot: scratch,
    verificationLogRoot: join(scratch, 'logs'),
    createAgent: () => agent as unknown as PlainAgent,
  });

  try {
    const recovery = await orchestrator.recover();
    assert(recovery.expired >= 1, 'expired verifying lease was recovered');

    const final = await store.getTask(taskId);
    assert(final?.status === 'completed', `task completed after recovery, got ${final?.status}`);
    assert(final?.attempt === 1, `attempt stays 1 after recovery, got ${final?.attempt}`);
    assert(agent.turns === 0, 'recovery never re-ran the agent turn');

    const verification = await store.getLatestVerification(taskId);
    assert(verification?.status === 'passed', 'verification passed after recovery');
    assert(verification?.checks[0].status === 'passed', 'interrupted check re-ran and passed');

    const events = (await store.listEvents(taskId)).map(event => event.type);
    assert(events.includes('verification-interrupted'), 'interruption recorded');
    assert(events.includes('verification-claimed'), 'recovery claim recorded');
    assert(events.includes('verification-completed'), 'completion recorded');
  } finally {
    orchestrator.shutdown();
    storage.close();
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log('task verification crash (real process kill) tests passed');
}

void main().catch(error => {
  rmSync(scratch, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});

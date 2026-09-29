/**
 * bash 后台任务注册表（搬运自 any-code domain/src/jobs.ts）
 * launch 立即返回 job id，输出后台累积；job_output 查询、job_kill 终止。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { killTree, detachedIfPosix } from './process-kill';
import { createStreamDecoder } from './text-decode';

export const DONE_RETENTION_MS = 60_000;
export const DONE_JOB_LIMIT = 50;

export interface BashJob {
  id: string;
  command: string;
  intent?: string;
  output: string;
  truncated: boolean;
  done: boolean;
  exitCode: number | null;
  startedAt: number;
  finishedAt?: number;
  pid: number | undefined;
}

const OUTPUT_CAP = 200_000;

export class JobRegistry {
  private jobs = new Map<string, BashJob & { child: ChildProcess }>();
  private listeners = new Set<(job: BashJob) => void>();

  /** 订阅任务完成事件；返回退订函数 */
  onDone(listener: (job: BashJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 后台启动命令；返回 job id。 */
  launch(binary: string, args: string[], cwd: string, intent?: string): string {
    const id = randomBytes(4).toString('hex');
    const child = spawn(binary, args, { cwd, windowsHide: true, ...detachedIfPosix });
    const job: BashJob & { child: ChildProcess } = {
      id,
      command: args[args.length - 1] ?? '',
      intent,
      output: '',
      truncated: false,
      done: false,
      exitCode: null,
      startedAt: Date.now(),
      pid: child.pid,
      child,
    };

    const decOut = createStreamDecoder();
    const decErr = createStreamDecoder();
    const onChunk = (c: Buffer, src: 'out' | 'err') => {
      job.output += src === 'out' ? decOut.decode(c) : decErr.decode(c);
      if (job.output.length > OUTPUT_CAP) {
        job.output = '…[earlier output dropped]\n' + job.output.slice(-OUTPUT_CAP);
        job.truncated = true;
      }
    };
    child.stdout?.on('data', (c: Buffer) => onChunk(c, 'out'));
    child.stderr?.on('data', (c: Buffer) => onChunk(c, 'err'));
    child.on('close', (code) => {
      job.done = true;
      job.exitCode = code;
      job.finishedAt = Date.now();

      // 通知订阅者（异常隔离）
      for (const listener of this.listeners) {
        try {
          listener(job);
        } catch (err) {
          console.error('[JobRegistry] onDone listener error:', err);
        }
      }

      const done = [...this.jobs.values()].filter((x) => x.done);
      if (done.length > DONE_JOB_LIMIT) {
        done.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
        for (const old of done.slice(0, done.length - DONE_JOB_LIMIT)) {
          this.jobs.delete(old.id);
        }
      }
    });
    child.on('error', () => {
      job.done = true;
      job.exitCode = -1;
      job.output += '\n[job error: failed to spawn]';

      // 通知订阅者
      for (const listener of this.listeners) {
        try {
          listener(job);
        } catch (err) {
          console.error('[JobRegistry] onDone listener error:', err);
        }
      }
    });
    this.jobs.set(id, job);
    return id;
  }

  get(id: string): BashJob | null {
    const j = this.jobs.get(id);
    if (!j) return null;
    const { child: _child, ...rest } = j;
    return rest;
  }

  list(): BashJob[] {
    const cutoff = Date.now() - DONE_RETENTION_MS;
    return [...this.jobs.values()]
      .reverse()
      .filter((j) => !j.done || (j.finishedAt ?? 0) > cutoff)
      .map(({ child: _c, ...rest }) => rest);
  }

  kill(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.done) return j ? true : false;
    killTree(j.child);
    return true;
  }

  killAll(): void {
    for (const j of this.jobs.values()) {
      if (!j.done) killTree(j.child);
    }
  }
}

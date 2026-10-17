/**
 * 验证检查器执行（P3-A）
 *
 * 只执行宿主显式声明的检查项，不接收模型生成的命令。
 * 输出全量写日志文件，内存只保留尾部，避免长输出撑爆进程。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { killTree, detachedIfPosix } from '../tools/process-kill';
import { createStreamDecoder } from '../tools/text-decode';
import { resolveShell } from '../tools/shell';
import type { VerificationCheck, VerificationCheckOutcome } from './verification';

export interface VerificationRunContext {
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** 该检查的日志文件路径；undefined = 不落文件 */
  logPath?: string;
}

export type VerificationCheckRunner = (
  check: VerificationCheck,
  ctx: VerificationRunContext,
) => Promise<VerificationCheckOutcome>;

const TAIL_MAX = 4_000;
const DEFAULT_TIMEOUT_MS = 120_000;

function appendTail(tail: string, chunk: string): string {
  const next = `${tail}${chunk}`;
  return next.length > TAIL_MAX ? next.slice(-TAIL_MAX) : next;
}

function openLog(logPath?: string): WriteStream | undefined {
  if (!logPath) return undefined;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    return createWriteStream(logPath, { flags: 'w' });
  } catch {
    return undefined;
  }
}

function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
    logPath?: string;
    binary?: string;
  },
): Promise<{
  exitCode: number | null;
  output: string;
  outputRef?: string;
  timedOut: boolean;
  aborted: boolean;
  error?: string;
}> {
  return new Promise(resolvePromise => {
    let settled = false;
    let tail = '';
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | undefined;
    const log = openLog(options.logPath);
    const decOut = createStreamDecoder();
    const decErr = createStreamDecoder();

    const finish = (result: {
      exitCode: number | null;
      timedOut: boolean;
      aborted: boolean;
      error?: string;
    }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      log?.end();
      resolvePromise({
        ...result,
        output: tail,
        outputRef: options.logPath,
      });
    };

    const onAbort = () => {
      if (child) killTree(child);
      finish({ exitCode: null, timedOut: false, aborted: true, error: 'aborted' });
    };

    try {
      child = spawn(options.binary ?? command, args, {
        cwd: options.cwd,
        windowsHide: true,
        ...detachedIfPosix,
      });
    } catch (error) {
      finish({
        exitCode: -1,
        timedOut: false,
        aborted: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      if (child) killTree(child);
    }, Math.max(options.timeoutMs, 1_000));

    const onChunk = (chunk: Buffer, decode: (value: Buffer) => string) => {
      const text = decode(chunk);
      tail = appendTail(tail, text);
      if (log && !log.destroyed) log.write(text);
    };
    child.stdout?.on('data', (chunk: Buffer) => onChunk(chunk, decOut.decode));
    child.stderr?.on('data', (chunk: Buffer) => onChunk(chunk, decErr.decode));
    child.on('error', (error: Error) => {
      finish({ exitCode: -1, timedOut, aborted: false, error: error.message });
    });
    child.on('close', (code: number | null) => {
      finish({ exitCode: code, timedOut, aborted: false });
    });

    if (options.signal.aborted) {
      onAbort();
      return;
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function runCommand(
  command: string,
  ctx: VerificationRunContext,
): Promise<VerificationCheckOutcome> {
  const startedAt = Date.now();
  let shell: { binary: string; cwd: string };
  try {
    shell = resolveShell(ctx.cwd);
  } catch (error) {
    return {
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const result = await runProcess(shell.binary, ['-c', command], {
    cwd: shell.cwd,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
    logPath: ctx.logPath,
  });
  const durationMs = Date.now() - startedAt;
  if (result.timedOut) {
    return {
      status: 'failed',
      exitCode: result.exitCode,
      outputTail: result.output,
      outputRef: result.outputRef,
      durationMs,
      error: `timeout after ${ctx.timeoutMs}ms`,
    };
  }
  if (result.aborted) {
    return {
      status: 'failed',
      exitCode: null,
      outputTail: result.output,
      outputRef: result.outputRef,
      durationMs,
      error: 'aborted',
    };
  }
  if (result.error) {
    return {
      status: 'failed',
      exitCode: result.exitCode,
      outputTail: result.output,
      outputRef: result.outputRef,
      durationMs,
      error: result.error,
    };
  }
  return {
    status: result.exitCode === 0 ? 'passed' : 'failed',
    exitCode: result.exitCode,
    outputTail: result.output,
    outputRef: result.outputRef,
    durationMs,
    error: result.exitCode === 0 ? undefined : `exit ${result.exitCode}`,
  };
}

function runFilesExist(paths: string[], cwd: string): VerificationCheckOutcome {
  const startedAt = Date.now();
  const missing = paths.filter(target => !existsSync(resolve(cwd, target)));
  return missing.length === 0
    ? { status: 'passed', durationMs: Date.now() - startedAt }
    : {
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: `missing: ${missing.join(', ')}`,
      };
}

async function readGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string } | null> {
  const result = await runProcess('git', args, {
    cwd,
    timeoutMs,
    signal: new AbortController().signal,
    binary: 'git',
  });
  if (result.timedOut || result.aborted || result.error) return null;
  return { exitCode: result.exitCode, output: result.output };
}

function parseChangedFiles(porcelain: string): string[] {
  const files = new Set<string>();
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue;
    const path = line.slice(3).trim();
    if (!path) continue;
    files.add(path);
  }
  return [...files];
}

/** 变更文件与 diff 指纹：best-effort，git 不可用时返回空证据。 */
export async function collectGitEvidence(
  cwd: string,
  timeoutMs = 10_000,
): Promise<{ changedFiles: string[]; diffHash?: string }> {
  const status = await readGit(['status', '--porcelain'], cwd, timeoutMs);
  const changedFiles = status?.exitCode === 0 ? parseChangedFiles(status.output) : [];
  const diff = await readGit(['diff', '--no-color'], cwd, timeoutMs);
  const diffHash = diff?.exitCode === 0 && diff.output.length > 0
    ? createHash('sha256').update(diff.output).digest('hex')
    : undefined;
  return { changedFiles, diffHash };
}

async function runGitDiffCheck(
  cwd: string,
  allowEmpty: boolean,
  ctx: VerificationRunContext,
): Promise<VerificationCheckOutcome> {
  const startedAt = Date.now();
  const status = await readGit(['status', '--porcelain'], cwd, ctx.timeoutMs);
  if (!status) {
    return {
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: 'git-unavailable',
    };
  }
  const changedFiles = parseChangedFiles(status.output);
  const durationMs = Date.now() - startedAt;
  if (allowEmpty || changedFiles.length > 0) {
    return {
      status: 'passed',
      durationMs,
      outputTail: changedFiles.join('\n').slice(-4_000),
    };
  }
  return { status: 'failed', durationMs, error: 'no-changes' };
}

export const runVerificationCheck: VerificationCheckRunner = async (check, ctx) => {
  switch (check.kind) {
    case 'command':
      return runCommand(check.command, {
        ...ctx,
        cwd: check.cwd ? resolveIfRelative(check.cwd, ctx.cwd) : ctx.cwd,
        timeoutMs: check.timeoutMs ?? ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    case 'files-exist':
      return runFilesExist(check.paths, ctx.cwd);
    case 'git-diff':
      return runGitDiffCheck(ctx.cwd, check.allowEmpty ?? false, ctx);
  }
};

function resolveIfRelative(target: string, cwd: string): string {
  return isAbsolute(target) ? target : resolve(cwd, target);
}

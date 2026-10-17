/**
 * 验证流程（P3-A）
 *
 * running -> verifying -> 逐检查执行 -> completed | failed
 * 每条检查结果立即落库，崩溃恢复的粒度是「单个检查项」。
 */

import type { TaskStore } from './store';
import type { TaskRecord } from './types';
import type {
  TaskVerificationPolicy,
  TaskVerificationRecord,
  VerificationCheck,
} from './verification';
import { describeCheck, isVerificationRequired, toCheckSeeds } from './verification';
import type { VerificationCheckRunner } from './verification-runner';
import { collectGitEvidence } from './verification-runner';

export interface VerificationFlowDeps {
  store: TaskStore;
  runner: VerificationCheckRunner;
  workerId: string;
  workspaceRoot: string;
  logRoot: string;
  /** 只通知事件订阅者；持久化由 TaskStore 负责 */
  notify?: (type: string, data: unknown) => void;
  /** 每个检查开始前调用，续租并检测租约是否仍在自己手上 */
  keepAlive: () => Promise<boolean>;
  signal: AbortSignal;
  changedFilesCollector?: (cwd: string) => Promise<{ changedFiles: string[]; diffHash?: string }>;
}

export type VerificationFlowResult =
  | { status: 'skipped' }
  | { status: 'passed'; verificationId: string }
  | { status: 'failed'; verificationId?: string; error: string }
  | { status: 'not-owner' };

interface CheckRunOutcome {
  passed: boolean;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 600_000;

export async function runVerificationFlow(
  deps: VerificationFlowDeps,
  input: { task: TaskRecord; attempt: number; output: string },
): Promise<VerificationFlowResult> {
  const policy = input.task.verification;

  if (!isVerificationRequired(policy)) {
    deps.notify?.('verification-skipped', { attempt: input.attempt });
    await deps.store.appendEvent(input.task.id, 'verification-skipped', {
      attempt: input.attempt,
    });
    return { status: 'skipped' };
  }

  if (!policy.checks || policy.checks.length === 0) {
    // 空策略等于「自动通过」，必须按配置错误失败。
    return { status: 'failed', error: 'verification-policy-has-no-checks' };
  }

  const verification = await deps.store.beginVerification(
    input.task.id,
    deps.workerId,
    input.attempt,
    toCheckSeeds(policy.checks),
  );
  if (!verification) return { status: 'not-owner' };

  deps.notify?.('verification-started', {
    verificationId: verification.id,
    attempt: input.attempt,
  });

  const evidence = await collectEvidence(deps, policy);
  const run = await executeChecks(deps, verification, policy);
  if (run === 'not-owner') return { status: 'not-owner' };

  return conclude(deps, verification, run, evidence, input.output, policy);
}

export async function resumeVerificationFlow(
  deps: VerificationFlowDeps,
  input: { taskId: string },
): Promise<VerificationFlowResult> {
  const claimed = await deps.store.claimVerification(input.taskId, deps.workerId);
  if (!claimed) return { status: 'not-owner' };

  const policy = claimed.task.verification;
  if (!isVerificationRequired(policy)) {
    return {
      status: 'failed',
      verificationId: claimed.verification.id,
      error: 'verifying-without-policy',
    };
  }

  deps.notify?.('verification-resumed', {
    verificationId: claimed.verification.id,
    attempt: claimed.task.attempt,
  });

  const evidence = await collectEvidence(deps, policy);
  const run = await executeChecks(deps, claimed.verification, policy);
  if (run === 'not-owner') return { status: 'not-owner' };

  const output = typeof claimed.task.result === 'object' && claimed.task.result !== null
    ? String((claimed.task.result as Record<string, unknown>).output ?? '')
    : claimed.task.resultSummary ?? '';
  return conclude(deps, claimed.verification, run, evidence, output, policy);
}

async function collectEvidence(
  deps: VerificationFlowDeps,
  policy: TaskVerificationPolicy,
): Promise<{ changedFiles: string[]; diffHash?: string }> {
  const collector = deps.changedFilesCollector ?? collectGitEvidence;
  return collector(policy.cwd ?? deps.workspaceRoot);
}

function checkTimeoutMs(check: VerificationCheck, policy: TaskVerificationPolicy): number {
  const raw = 'timeoutMs' in check && check.timeoutMs !== undefined
    ? check.timeoutMs
    : policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(raw, 1_000), 600_000);
}

function isRerunSafe(check: VerificationCheck): boolean {
  // files-exist / git-diff are read-only by construction.
  if (check.kind !== 'command') return true;
  return check.rerunSafe !== false;
}

async function executeChecks(
  deps: VerificationFlowDeps,
  verification: TaskVerificationRecord,
  policy: TaskVerificationPolicy,
): Promise<CheckRunOutcome | 'not-owner'> {
  const checks = policy.checks ?? [];
  const deadline = Date.now() + (policy.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
  const failures: string[] = [];

  for (const [index, check] of checks.entries()) {
    const record = verification.checks.find(candidate => candidate.index === index);
    if (!record) continue;

    if (record.status === 'passed') continue;
    if (record.status === 'failed') {
      failures.push(describeCheck(record));
      break;
    }

    if (record.status === 'running' || record.status === 'interrupted') {
      // 上一次执行被中断：不可重跑的检查不能自动再执行一次。
      if (!isRerunSafe(check)) {
        failures.push(`${check.name}: check-interrupted-unsafe-rerun`);
        break;
      }
    }

    if (Date.now() >= deadline) {
      failures.push('verification-timeout');
      break;
    }
    if (!(await deps.keepAlive())) return 'not-owner';

    const started = await deps.store.startVerificationCheck(
      verification.id,
      index,
      deps.workerId,
    );
    if (!started) return 'not-owner';

    const timeoutMs = Math.min(
      checkTimeoutMs(check, policy),
      Math.max(deadline - Date.now(), 1_000),
    );
    const outcome = await runCheckSafely(
      deps,
      check,
      verification.taskId,
      verification.id,
      index,
      timeoutMs,
      policy.cwd ?? deps.workspaceRoot,
    );

    const saved = await deps.store.finishVerificationCheck(
      verification.id,
      index,
      deps.workerId,
      outcome,
    );
    if (!saved) return 'not-owner';

    deps.notify?.('verification-check-completed', {
      verificationId: verification.id,
      index,
      name: check.name,
      status: outcome.status,
      exitCode: outcome.exitCode ?? null,
      durationMs: outcome.durationMs,
    });

    if (outcome.status === 'failed') {
      failures.push(`${check.name}: ${outcome.error ?? `exit ${outcome.exitCode}`}`);
      if (policy.stopOnFailure !== false) break;
    }
  }

  return failures.length === 0 ? { passed: true } : { passed: false, error: failures.join('; ') };
}

/**
 * 检查器永远不让异常冒到编排器：验证失败不能变成「执行失败」而被重新 claim。
 * 异常只转成一次 failed 检查结果；若此时租约已失效，落库会失败并返回 not-owner。
 */
async function runCheckSafely(
  deps: VerificationFlowDeps,
  check: VerificationCheck,
  taskId: string,
  verificationId: string,
  index: number,
  timeoutMs: number,
  cwd: string,
) {
  const startedAt = Date.now();
  try {
    return await deps.runner(check, {
      cwd,
      timeoutMs,
      signal: deps.signal,
      logPath: `${deps.logRoot}/${taskId}/${verificationId}/${index}.log`,
    });
  } catch (error) {
    return {
      status: 'failed' as const,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? `runner-crashed: ${error.message}` : 'runner-crashed',
    };
  }
}

async function conclude(
  deps: VerificationFlowDeps,
  verification: TaskVerificationRecord,
  run: CheckRunOutcome,
  evidence: { changedFiles: string[]; diffHash?: string },
  output: string,
  policy: TaskVerificationPolicy,
): Promise<VerificationFlowResult> {
  const error = run.passed ? undefined : run.error ?? 'verification-failed';
  const result = run.passed
    ? { output, summary: summarize(output), verificationId: verification.id }
    : undefined;

  const final = await deps.store.concludeVerification(verification.id, deps.workerId, {
    passed: run.passed,
    changedFiles: evidence.changedFiles,
    diffHash: evidence.diffHash,
    result,
    error,
  });
  if (!final) return { status: 'not-owner' };

  deps.notify?.(run.passed ? 'verification-completed' : 'verification-failed', {
    verificationId: verification.id,
    error,
    stopOnFailure: policy.stopOnFailure !== false,
  });

  return run.passed
    ? { status: 'passed', verificationId: verification.id }
    : { status: 'failed', verificationId: verification.id, error: error! };
}

function summarize(output: string): string {
  return output.length <= 500 ? output : `${output.slice(0, 500)}... (truncated)`;
}

/**
 * 任务验证模型（P3-A）
 *
 * 模型只能声称「做完了」，任务是否完成由这里定义的检查项决定。
 * 检查项由宿主（CLI / Desktop）显式声明，不允许模型自行生成。
 */

export type VerificationMode = 'off' | 'required';

export type VerificationCheck =
  | {
      kind: 'command';
      name: string;
      command: string;
      /** 单检查超时，默认 120_000，上限 600_000 */
      timeoutMs?: number;
      /** 中断后是否允许重跑；默认 true。部署类命令应显式设 false。 */
      rerunSafe?: boolean;
      cwd?: string;
    }
  | { kind: 'files-exist'; name: string; paths: string[] }
  | { kind: 'git-diff'; name: string; allowEmpty?: boolean };

export interface TaskVerificationPolicy {
  mode: VerificationMode;
  /** mode='required' 时必须非空，空策略按配置错误处理 */
  checks?: VerificationCheck[];
  /** 单检查默认超时 */
  timeoutMs?: number;
  /** 整个验证的预算，默认 600_000 */
  totalTimeoutMs?: number;
  /** 默认 true：首个失败即停止，剩余检查标 skipped */
  stopOnFailure?: boolean;
  /** 检查命令的默认 cwd，默认取编排器注入的 workspaceRoot */
  cwd?: string;
}

export type VerificationStatus = 'running' | 'passed' | 'failed' | 'interrupted';

export type VerificationCheckStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'interrupted';

export interface VerificationCheckRecord {
  index: number;
  name: string;
  kind: VerificationCheck['kind'];
  command?: string;
  status: VerificationCheckStatus;
  exitCode?: number | null;
  outputRef?: string;
  outputTail?: string;
  durationMs?: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface TaskVerificationRecord {
  id: string;
  taskId: string;
  attempt: number;
  status: VerificationStatus;
  checks: VerificationCheckRecord[];
  changedFiles: string[];
  diffHash?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

/** beginVerification 的入参：策略里的检查项扁平化后落库 */
export interface VerificationCheckSeed {
  index: number;
  name: string;
  kind: VerificationCheck['kind'];
  command?: string;
}

/** 检查项执行结果，由检查器返回、由 store 落库 */
export interface VerificationCheckOutcome {
  status: 'passed' | 'failed';
  exitCode?: number | null;
  outputRef?: string;
  outputTail?: string;
  durationMs: number;
  error?: string;
}

export function describeCheck(check: VerificationCheckRecord): string {
  if (check.kind !== 'command') return `${check.name}(${check.kind})`;
  return `${check.name}(exit ${check.exitCode ?? 'null'})`;
}

export function isVerificationRequired(
  policy?: TaskVerificationPolicy,
): policy is TaskVerificationPolicy & { mode: 'required' } {
  return policy?.mode === 'required';
}

/** 把策略检查项扁平化成可落库的种子；command 之外不带执行细节 */
export function toCheckSeeds(checks: VerificationCheck[]): VerificationCheckSeed[] {
  return checks.map((check, index) => ({
    index,
    name: check.name,
    kind: check.kind,
    command: check.kind === 'command' ? check.command : undefined,
  }));
}

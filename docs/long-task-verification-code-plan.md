# 长任务验证闭环：详细 Coding 计划

> 对应计划：`docs/long-task-verification-plan.md`
> 基线：`2a20331`（P1/P2 已完成）
> 目标：`running -> verifying -> completed | failed`，证据可查，崩溃可恢复，不重跑 Agent turn。

## 0. 变更面总览

| 文件 | 类型 | 内容 | 量级 |
|---|---|---|---|
| `domain/src/tasks/verification.ts` | 新增 | 策略/记录/检查项类型 | ~110 行 |
| `domain/src/tasks/verification-runner.ts` | 新增 | 三种检查器执行实现 | ~180 行 |
| `domain/src/tasks/verification-flow.ts` | 新增 | 验证流程编排（begin→checks→conclude） | ~230 行 |
| `domain/src/tasks/types.ts` | 修改 | `TaskRecord.verification` | +6 行 |
| `domain/src/tasks/transitions.ts` | 修改 | `verifying -> cancelled` | +1 行 |
| `domain/src/tasks/store.ts` | 修改 | 新增 8 个方法签名 | ~+60 行 |
| `domain/src/tasks/sqlite.ts` | 修改 | 建表/迁移/8 个实现/3 处 guard 放宽 | ~+300 行 |
| `domain/src/tasks/memory.ts` | 修改 | 同上（内存等价） | ~+230 行 |
| `domain/src/tasks/orchestrator.ts` | 修改 | 完成路径、恢复、取消、配置注入 | ~+90 行 |
| `domain/src/tasks/index.ts` | 修改 | 导出新模块 | +4 行 |
| `domain/src/index.ts` | 修改 | 导出新类型 | +8 行 |
| `domain/package.json` | 修改 | `test:verification`，并入 `test:tasks` | +1 行 |
| `domain/test/test-task-verification.ts` | 新增 | 主测试文件 | ~450 行 |
| `cli/src/cli.tsx` | 修改 | `--verify` / `--verify-timeout` | ~+25 行 |
| `desktop/src/shared/desktop-api.ts` | 修改 | `AppSettings.verification` | +10 行 |
| `desktop/src/main/settings-store.ts` | 修改 | 默认值 | +3 行 |
| `desktop/src/main/agent-service.ts` | 修改 | 注入策略与 workspaceRoot | ~+20 行 |

**不做**：不改 `server/`、不改 `agent.ts`/`loop.ts`、不改 `tools/`、不改 `subagent/runtime.ts`（子任务无策略，自动走 `off`）。

---

## 1. 公共类型：`domain/src/tasks/verification.ts`

```ts
import type { TaskRecord } from './types';

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
  /** mode='required' 时必须非空 */
  checks?: VerificationCheck[];
  /** 单检查默认超时 */
  timeoutMs?: number;
  /** 整个验证的预算，默认 600_000 */
  totalTimeoutMs?: number;
  /** 默认 true：首个失败即停止，剩余检查标 skipped */
  stopOnFailure?: boolean;
  /** 检查命令的默认 cwd，默认取 orchestrator 注入的 workspaceRoot */
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

export function describeCheck(check: VerificationCheckRecord): string {
  if (check.kind !== 'command') return `${check.name}(${check.kind})`;
  return `${check.name}(exit ${check.exitCode ?? 'null'})`;
}

export function isRequired(task: Pick<TaskRecord, 'verification'>): boolean {
  return task.verification?.mode === 'required';
}
```

**约束（在 `beginVerification` 里断言，不要静默降级）**：`mode:'required'` 且 `checks` 为空 → 返回 `null` 并由编排器写 `verification-failed`，`error='verification-policy-has-no-checks'`。空检查等于「自动通过」，必须显式失败。

---

## 2. `TaskRecord` 变更

`domain/src/tasks/types.ts`：

```ts
import type { TaskVerificationPolicy } from './verification';

export interface TaskRecord {
  // ...existing
  /** 任务级验证策略；undefined 等价于 mode:'off' */
  verification?: TaskVerificationPolicy;
}
```

注意循环依赖：`verification.ts` 只反向 `import type { TaskRecord }` 用于 `Pick`，TypeScript 的 `import type` 不产生运行时依赖，但为彻底避免环，`describeCheck/isRequired` 的入参改为结构类型（上面已按结构写，仅 `Pick<TaskRecord,...>` 保留类型导入即可；若 `tsc` 报环，直接把 `isRequired` 改成 `(verification?: TaskVerificationPolicy) => boolean`）。

---

## 3. SQLite：建表与迁移

在 `SQLiteTaskStore.initTables()` 的 `db.exec()` 字符串里追加（位置：`task_checkpoints` 之后）：

```sql
CREATE TABLE IF NOT EXISTS task_verifications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  diff_hash TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_verification_checks (
  verification_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  command TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  output_ref TEXT,
  output_tail TEXT,
  duration_ms INTEGER,
  error TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (verification_id, idx),
  FOREIGN KEY (verification_id) REFERENCES task_verifications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_verifications_task
  ON task_verifications(task_id, attempt, started_at);
CREATE INDEX IF NOT EXISTS idx_task_verification_checks_status
  ON task_verification_checks(verification_id, status);
```

迁移：`initTables()` 末尾追加

```ts
this.ensureColumn('verification_json', 'TEXT');
```

`tasks` 表的三处读写补齐：

1. `createTask` 的 `INSERT` 列表加 `verification_json`（占位符 `?`，值 `task.verification === undefined ? null : encode(task.verification)`）；注意参数顺序，别错位。
2. `updateTask`：

```ts
if ('verification' in patch) {
  add('verification_json', patch.verification === undefined ? null : encode(patch.verification));
}
```

3. `fromRow`：

```ts
verification: row.verification_json ? JSON.parse(row.verification_json) : undefined,
```

新增读方法：

```ts
private verificationFromRows(row: any, checks: any[]): TaskVerificationRecord { ... }
private loadVerification(verificationId: string): TaskVerificationRecord | null { ... }
```

`task_verification_checks` 按 `idx ASC` 排序组装。

---

## 4. `TaskStore` 接口新增

`domain/src/tasks/store.ts`：

```ts
import type {
  TaskVerificationRecord,
  VerificationCheckSeed,
} from './verification';

export interface VerificationCheckOutcome {
  status: 'passed' | 'failed';
  exitCode?: number | null;
  outputRef?: string;
  outputTail?: string;
  durationMs: number;
  error?: string;
}

export interface TaskStore {
  // ...existing

  /**
   * running -> verifying（原子）。
   * 若该 (taskId, attempt) 已存在 running/interrupted 的验证记录，直接返回它（幂等）。
   * guard：status='running' AND lease_owner=workerId AND attempt AND lease 未过期。
   */
  beginVerification(
    taskId: string,
    workerId: string,
    attempt: number,
    checks: VerificationCheckSeed[],
  ): Promise<TaskVerificationRecord | null>;

  getVerification(verificationId: string): Promise<TaskVerificationRecord | null>;
  getLatestVerification(taskId: string, attempt?: number): Promise<TaskVerificationRecord | null>;
  listVerifications(taskId: string): Promise<TaskVerificationRecord[]>;

  /**
   * 恢复路径：只接管租约，不改 status、不改 attempt。
   * guard：task.status='verifying' 且 (lease_owner IS NULL OR lease_until <= now)。
   */
  claimVerification(
    taskId: string,
    workerId: string,
  ): Promise<{ task: TaskRecord; verification: TaskVerificationRecord } | null>;

  startVerificationCheck(
    verificationId: string,
    index: number,
    workerId: string,
  ): Promise<boolean>;

  finishVerificationCheck(
    verificationId: string,
    index: number,
    workerId: string,
    outcome: VerificationCheckOutcome,
  ): Promise<boolean>;

  /**
   * verifying -> completed | failed（原子，含证据、清理租约、写事件）。
   * 返回终态；非本 worker/attempt、或任务已不是 verifying 时返回 null。
   */
  concludeVerification(
    verificationId: string,
    workerId: string,
    input: {
      passed: boolean;
      changedFiles: string[];
      diffHash?: string;
      result?: unknown;
      error?: string;
    },
  ): Promise<'completed' | 'failed' | null>;
}
```

**语义契约（写进注释，测试覆盖）**：

- 所有方法在 guard 不满足时返回 `null/false`，**抛异常只允许出现在真正的存储故障**；
- `beginVerification` 成功后任务持有租约，`renewLease` 必须能继续续（见 §5.3）；
- `concludeVerification` 之后任务状态必为终态且 `lease_owner/lease_until` 已清空。

---

## 5. SQLite 实现

### 5.1 `beginVerification`

```ts
async beginVerification(taskId, workerId, attempt, checks) {
  if (checks.length === 0) return null;
  const now = Date.now();
  this.db.exec('BEGIN IMMEDIATE');
  try {
    const task = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
    if (!task || task.status !== 'running' || task.lease_owner !== workerId ||
        task.attempt !== attempt || task.lease_until === null || task.lease_until <= now) {
      this.db.exec('ROLLBACK');
      return null;
    }
    const existing = this.db.prepare(`
      SELECT * FROM task_verifications
      WHERE task_id = ? AND attempt = ? AND status IN ('running','interrupted')
      ORDER BY started_at DESC LIMIT 1
    `).get(taskId, attempt) as any;
    if (existing) {
      this.db.exec('COMMIT');
      return this.loadVerification(existing.id);
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO task_verifications
        (id, task_id, attempt, status, changed_files_json, started_at)
      VALUES (?, ?, ?, 'running', '[]', ?)
    `).run(id, taskId, attempt, now);
    const insertCheck = this.db.prepare(`
      INSERT INTO task_verification_checks
        (verification_id, idx, name, kind, command, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `);
    for (const check of checks) {
      insertCheck.run(id, check.index, check.name, check.kind, check.command ?? null);
    }
    this.db.prepare(`
      UPDATE tasks SET status = 'verifying', updated_at = ? WHERE id = ?
    `).run(now, taskId);
    this.insertEvent(taskId, 'status-changed', { from: 'running', to: 'verifying' }, now);
    this.insertEvent(taskId, 'verification-started', { verificationId: id, attempt }, now);
    this.db.exec('COMMIT');
    return this.loadVerification(id);
  } catch (error) {
    this.db.exec('ROLLBACK');
    throw error;
  }
}
```

需要 `import { randomUUID } from 'node:crypto'`（`sqlite.ts` 目前未导入）。

### 5.2 `claimVerification` / `startVerificationCheck` / `finishVerificationCheck`

```ts
async claimVerification(taskId, workerId) {
  const now = Date.now();
  this.db.exec('BEGIN IMMEDIATE');
  try {
    const task = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
    const free = task && task.status === 'verifying' &&
      (task.lease_owner === null || task.lease_until === null || task.lease_until <= now);
    if (!free) { this.db.exec('ROLLBACK'); return null; }
    const v = this.db.prepare(`
      SELECT * FROM task_verifications
      WHERE task_id = ? AND attempt = ?
      ORDER BY started_at DESC LIMIT 1
    `).get(taskId, task.attempt) as any;
    if (!v) { this.db.exec('ROLLBACK'); return null; }

    const leaseUntil = now + DEFAULT_TASK_LEASE_MS;
    const updated = this.db.prepare(`
      UPDATE tasks SET lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE id = ? AND status = 'verifying'
        AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until <= ?)
    `).run(workerId, leaseUntil, now, taskId, now) as any;
    if (Number(updated?.changes ?? 0) !== 1) { this.db.exec('ROLLBACK'); return null; }

    this.db.prepare(`
      UPDATE task_verifications SET status = 'running' WHERE id = ? AND status = 'interrupted'
    `).run(v.id);
    this.insertEvent(taskId, 'verification-claimed', { workerId, verificationId: v.id, attempt: task.attempt }, now);
    this.db.exec('COMMIT');
    return { task: this.fromRow(task), verification: this.loadVerification(v.id)! };
  } catch (error) {
    this.db.exec('ROLLBACK');
    throw error;
  }
}
```

`loadVerification` 返回的 task 需要重新读（lease 已更新），避免返回旧快照 —— 用 `this.getTask(taskId)!` 取代 `fromRow(task)`。

`startVerificationCheck` / `finishVerificationCheck` 共用 guard（抽一个私有 `assertVerifyOwner(verificationId, workerId, now): { taskId, attempt } | null`，**但必须在同一事务里 SELECT 后再 UPDATE**，不能先查后改跨事务）：

```ts
async startVerificationCheck(verificationId, index, workerId) {
  const now = Date.now();
  this.db.exec('BEGIN IMMEDIATE');
  try {
    const row = this.db.prepare(`
      SELECT t.id AS task_id, t.attempt, t.status AS task_status,
             t.lease_owner, t.lease_until, v.status AS v_status, v.attempt AS v_attempt
      FROM task_verifications v JOIN tasks t ON t.id = v.task_id
      WHERE v.id = ?
    `).get(verificationId) as any;
    if (!row || row.task_status !== 'verifying' || row.v_status !== 'running' ||
        row.lease_owner !== workerId || row.lease_until === null || row.lease_until <= now ||
        row.attempt !== row.v_attempt) {
      this.db.exec('ROLLBACK');
      return false;
    }
    const changed = this.db.prepare(`
      UPDATE task_verification_checks
      SET status = 'running', started_at = ?, error = NULL
      WHERE verification_id = ? AND idx = ?
        AND status IN ('pending','running','interrupted')
    `).run(now, verificationId, index) as any;
    if (Number(changed?.changes ?? 0) !== 1) { this.db.exec('ROLLBACK'); return false; }
    this.insertEvent(row.task_id, 'verification-check-started', { verificationId, index }, now);
    this.db.exec('COMMIT');
    return true;
  } catch (error) { this.db.exec('ROLLBACK'); throw error; }
}
```

`finishVerificationCheck`：同 guard；`UPDATE ... SET status=?, exit_code=?, output_ref=?, output_tail=?, duration_ms=?, error=?, finished_at=? WHERE verification_id=? AND idx=? AND status='running'`。

### 5.3 租约与恢复（G2/G3/G6/G7）

`renewLease` 的两处 SQL 都改成：

```sql
WHERE id = ? AND lease_owner = ? AND status IN ('running','verifying')
  AND attempt = ? AND lease_until > ?
```

`recoverExpiredTasks`：

```ts
const CLAIMABLE_STATUSES = ['queued', 'running', 'verifying'] as const;
```

循环内按状态分支：

```ts
if (row.status === 'verifying') {
  // 验证不是新一次执行：不清 attempt、不计 maxAttempts
  const updated = this.db.prepare(`
    UPDATE tasks SET lease_owner = NULL, lease_until = NULL, updated_at = ?
    WHERE id = ? AND status = 'verifying' AND lease_owner IS ? AND lease_until = ?
  `).run(now, row.id, row.lease_owner, row.lease_until) as any;
  if (Number(updated?.changes ?? 0) !== 1) continue;

  this.db.prepare(`
    UPDATE task_verification_checks
    SET status = 'interrupted', finished_at = ?
    WHERE verification_id IN (
      SELECT id FROM task_verifications
      WHERE task_id = ? AND attempt = ? AND status = 'running'
    ) AND status = 'running'
  `).run(now, row.id, row.attempt);
  this.db.prepare(`
    UPDATE task_verifications
    SET status = 'interrupted'
    WHERE task_id = ? AND attempt = ? AND status = 'running'
  `).run(row.id, row.attempt);
  this.insertEvent(row.id, 'verification-interrupted', { attempt: row.attempt }, now);
  recovered++;
  continue;
}
// 既有 queued/running 分支保持不变
```

同时把 `recoverExpiredTasks` 的初始 SELECT 从 `CLAIMABLE_STATUSES` 自动覆盖到 `verifying`（常量已含）。

`listRecoverableTasks` 增加：

```sql
OR (status = 'verifying' AND (lease_until IS NULL OR lease_until <= ?))
```

### 5.4 `concludeVerification`

```ts
async concludeVerification(verificationId, workerId, input) {
  const now = Date.now();
  this.db.exec('BEGIN IMMEDIATE');
  try {
    const row = this.db.prepare(`
      SELECT v.id, v.task_id, v.attempt AS v_attempt, v.status AS v_status,
             t.attempt, t.status AS task_status, t.lease_owner, t.lease_until
      FROM task_verifications v JOIN tasks t ON t.id = v.task_id
      WHERE v.id = ?
    `).get(verificationId) as any;
    if (!row || row.task_status !== 'verifying' ||
        !['running','interrupted'].includes(row.v_status) ||
        row.lease_owner !== workerId || row.lease_until === null || row.lease_until <= now ||
        row.attempt !== row.v_attempt) {
      this.db.exec('ROLLBACK');
      return null;
    }

    // 未跑完的检查标 skipped（失败收尾时）
    if (!input.passed) {
      this.db.prepare(`
        UPDATE task_verification_checks SET status = 'skipped', finished_at = ?
        WHERE verification_id = ? AND status IN ('pending','interrupted')
      `).run(now, verificationId);
    }

    this.db.prepare(`
      UPDATE task_verifications
      SET status = ?, changed_files_json = ?, diff_hash = ?, error = ?, finished_at = ?
      WHERE id = ?
    `).run(
      input.passed ? 'passed' : 'failed',
      encode(input.changedFiles),
      input.diffHash ?? null,
      input.error ?? null,
      now,
      verificationId,
    );

    const finalStatus = input.passed ? 'completed' : 'failed';
    const columns = ['status = ?', 'lease_owner = NULL', 'lease_until = NULL',
                     'finished_at = ?', 'updated_at = ?'];
    const values: unknown[] = [finalStatus, now, now];
    if (input.result !== undefined) {
      columns.push('result_json = ?');
      values.push(encode(input.result));
      const summary = summarizeResult(input.result);
      if (summary.resultSummary !== undefined) {
        columns.push('result_summary = ?');
        values.push(summary.resultSummary);
      }
    }
    if (input.error !== undefined) {
      columns.push('error = ?');
      values.push(input.error);
    }
    const updated = this.db.prepare(`
      UPDATE tasks SET ${columns.join(', ')}
      WHERE id = ? AND status = 'verifying' AND lease_owner = ? AND attempt = ?
    `).run(...values, row.task_id, workerId, row.attempt) as any;
    if (Number(updated?.changes ?? 0) !== 1) { this.db.exec('ROLLBACK'); return null; }

    this.insertEvent(row.task_id, 'status-changed', { from: 'verifying', to: finalStatus }, now);
    this.insertEvent(row.task_id, input.passed ? 'task-completed' : 'task-failed',
      input.passed ? { verificationId } : { verificationId, error: input.error ?? 'verification-failed' }, now);
    this.db.exec('COMMIT');
    return finalStatus;
  } catch (error) { this.db.exec('ROLLBACK'); throw error; }
}
```

### 5.5 完成守卫（D6）

在 `updateAttemptStatus` 里，`status === 'completed'` 分支前插入：

```ts
if (status === 'completed') {
  const task = this.getTaskSync(taskId); // 事务内 SELECT tasks.verification_json
  const required = task?.verification?.mode === 'required';
  if (required) {
    const passed = this.db.prepare(`
      SELECT 1 FROM task_verifications
      WHERE task_id = ? AND attempt = ? AND status = 'passed' LIMIT 1
    `).get(taskId, attempt);
    if (!passed) {
      this.insertEvent(taskId, 'completion-rejected',
        { reason: 'verification-required-but-not-passed', attempt }, Date.now());
      return false;
    }
  }
}
```

注意：该判断必须在 `BEGIN IMMEDIATE` 事务内、与 UPDATE 同一事务，否则存在检查后状态被改的窗口。实现上把这段放在 `this.db.exec('BEGIN IMMEDIATE')` 之后、构造 `columns` 之后、执行 UPDATE 之前。`completion-rejected` 事件在事务内插入；`return false` 前要 `ROLLBACK`（否则事件丢失）——**改为先写事件再 COMMIT 再 return false**，或直接 `COMMIT` 后 return false（该分支不改任何列）。

`cancelAttempt` 的 guard 放宽：

```sql
WHERE id = ? AND status IN ('running','verifying') AND lease_owner = ? AND attempt = ? AND lease_until > ?
```

并让 `updateAttemptStatus` 的 `canTransition` 使用实际 from 状态（从 SELECT 出的 `status` 读，而不是硬编码 `'running'`）。

### 5.6 Memory 等价实现

`MemoryTaskStore` 增加：

```ts
private verifications = new Map<string, TaskVerificationRecord>();
```

- 所有 guard 逻辑照抄 SQLite 的条件（状态/owner/attempt/lease），只是把 UPDATE 换成「先校验、再整体替换对象」；
- 事务等价：校验全部通过后再改 `tasks`/`verifications`，中途抛错不会留下半状态；
- `clear()` / `deleteTasksBySession()` 要同步清理 `verifications`（否则内存测试串数据）；
- `finishAttempt` 的完成守卫同样加在「校验阶段」。

一致性测试直接用 `test-task-store.ts` 的 `exerciseStore()` 模式，同一个脚本跑两种 store。

---

## 6. 状态机：`transitions.ts`

```ts
verifying: ['completed', 'running', 'failed', 'cancelled'],
```

---

## 7. 检查器执行：`domain/src/tasks/verification-runner.ts`

```ts
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { killTree, detachedIfPosix } from '../tools/process-kill';
import { createStreamDecoder } from '../tools/text-decode';
import { resolveShell } from '../tools/shell';
import type { VerificationCheck } from './verification';
import type { VerificationCheckOutcome } from './store';

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

export const runVerificationCheck: VerificationCheckRunner = async (check, ctx) => {
  switch (check.kind) {
    case 'command': return runCommand(check.command, { ...ctx, cwd: check.cwd ?? ctx.cwd, timeoutMs: check.timeoutMs ?? ctx.timeoutMs });
    case 'files-exist': return runFilesExist(check.paths, ctx.cwd);
    case 'git-diff': return runGitDiff(ctx, check.allowEmpty ?? false);
  }
};
```

`runCommand` 要求：

1. `resolveShell(cwd)` 拿 `{ binary }`，`spawn(binary, ['-c', command], { cwd, windowsHide: true, ...detachedIfPosix })`；
2. stdout/stderr 用 `createStreamDecoder()` 解码，同时 tee 到 `logPath`（`mkdirSync(dirname, {recursive:true})` + `createWriteStream`），内存只保留尾部 4KB（`tail` 滚动，别整段拼接）；
3. 超时与 abort 都用 `killTree(child)`，`outcome.error = 'timeout' | 'aborted'`，`status='failed'`；
4. `child.on('error')` → `status='failed'`, `exitCode=-1`, `error=err.message`；
5. `close` → `status = code === 0 ? 'passed' : 'failed'`，`exitCode: code`；
6. **永不抛异常**（`try/catch` 只包 spawn 本身，这是真实失败面）。

`runFilesExist`：

```ts
const missing = paths.filter(p => !existsSync(resolve(cwd, p)));
return missing.length === 0
  ? { status: 'passed', durationMs: 0 }
  : { status: 'failed', durationMs: 0, error: `missing: ${missing.join(', ')}` };
```

`runGitDiff`：spawn `git`，`['status', '--porcelain']` 取 changedFiles（首两列状态码 + 空格后路径，去重）；`['diff', '--no-color']` 取 diff 文本算 `sha256`。`allowEmpty=false` 时 `changedFiles.length > 0` 才算通过，`error='no-changes'`。

变更文件证据的采集统一由 flow 调一次 `collectGitEvidence(cwd)`（同样的 spawn，失败返回 `{ changedFiles: [], diffHash: undefined }`），**不要**把它做成检查项，避免「没配 git-diff 就没有 evidence」。

日志根目录约定（与 `jobs.ts` 一致）：

```text
<logRoot>/<taskId>/<verificationId>/<index>.log
```

`logRoot` 默认 `join(homedir(), '.plain-agent', 'tasks')`；测试注入 `tmpdir()` 派生目录。

---

## 8. 验证流程：`domain/src/tasks/verification-flow.ts`

```ts
export interface VerificationFlowDeps {
  store: TaskStore;
  runner: VerificationCheckRunner;
  workerId: string;
  workspaceRoot: string;
  logRoot: string;
  /** 写事件（TaskStore.appendEvent 已带持久化，emit 只是转发给编排器） */
  emit: (type: string, data: unknown) => Promise<void>;
  /** 每次检查开始前调用，用于续租/检测租约丢失；返回 false 中止 */
  keepAlive: () => Promise<boolean>;
  signal: AbortSignal;
  changedFilesCollector?: (cwd: string) => Promise<{ changedFiles: string[]; diffHash?: string }>;
}

export type VerificationFlowResult =
  | { status: 'skipped' }
  | { status: 'passed'; verificationId: string }
  | { status: 'failed'; verificationId: string; error: string }
  | { status: 'not-owner' };

export async function runVerificationFlow(
  deps: VerificationFlowDeps,
  input: { task: TaskRecord; attempt: number; output: string },
): Promise<VerificationFlowResult>;

export async function resumeVerificationFlow(
  deps: VerificationFlowDeps,
  input: { taskId: string },
): Promise<VerificationFlowResult>;
```

### 8.1 `runVerificationFlow`

```text
policy = task.verification
if (!policy || policy.mode === 'off'):
    emit('verification-skipped', { attempt })
    return { status: 'skipped' }

if (!policy.checks?.length):
    // 空策略是配置错误，不是自动通过
    return fail('verification-policy-has-no-checks')

seeds = policy.checks.map((c, i) => ({ index: i, name: c.name, kind: c.kind, command: 'command' in c ? c.command : undefined }))
v = await store.beginVerification(task.id, workerId, attempt, seeds)
if (!v) return { status: 'not-owner' }

evidence = await collectGitEvidence(cwd)
outcome = await executeChecks(deps, v, policy)
return conclude(deps, v.id, attempt, outcome, evidence, output)
```

### 8.2 `resumeVerificationFlow`

```text
claimed = await store.claimVerification(taskId, workerId)
if (!claimed) return { status: 'not-owner' }
policy = claimed.task.verification
if (!policy || policy.mode !== 'required') {
   // 状态不一致：verifying 但无策略。落 failed，给出可读原因，不要静默完成。
   return conclude(..., passed=false, error='verifying-without-policy')
}
evidence = await collectGitEvidence(cwd)
outcome = await executeChecks(deps, claimed.verification, policy)
return conclude(...)
```

### 8.3 `executeChecks` 核心逻辑

```ts
const deadline = Date.now() + (policy.totalTimeoutMs ?? 600_000);
const defaultTimeout = Math.min(Math.max(policy.timeoutMs ?? 120_000, 1_000), 600_000);
const failures: string[] = [];

for (const check of policy.checks) {
  const record = verification.checks.find(c => c.index === index)!;

  if (record.status === 'passed') continue;

  if (record.status === 'failed') { failures.push(describeCheck(record)); break; }

  if (record.status === 'running' || record.status === 'interrupted') {
    // 上一次进程被中断
    if (record.kind === 'command' && (check.rerunSafe === false)) {
      failures.push(`${check.name}: check-interrupted-unsafe-rerun`);
      break;
    }
    // files-exist / git-diff 天然可重跑
  }

  if (Date.now() >= deadline) { failures.push('verification-timeout'); break; }
  if (!(await deps.keepAlive())) return { status: 'not-owner' };

  const started = await store.startVerificationCheck(verification.id, index, deps.workerId);
  if (!started) return { status: 'not-owner' };

  const timeoutMs = Math.min(check.timeoutMs ?? defaultTimeout, Math.max(deadline - Date.now(), 1_000));
  const outcome = await deps.runner(check, {
    cwd: check.cwd ?? policy.cwd ?? deps.workspaceRoot,
    timeoutMs,
    signal: deps.signal,
    logPath: join(deps.logRoot, task.id, verification.id, `${index}.log`),
  });

  const saved = await store.finishVerificationCheck(verification.id, index, deps.workerId, outcome);
  if (!saved) return { status: 'not-owner' };
  await deps.emit('verification-check-completed', {
    verificationId: verification.id, index, name: check.name,
    status: outcome.status, exitCode: outcome.exitCode, durationMs: outcome.durationMs,
  });

  if (outcome.status === 'failed') {
    failures.push(`${check.name}: ${outcome.error ?? `exit ${outcome.exitCode}`}`);
    if (policy.stopOnFailure !== false) break;
  }
}

return failures.length === 0
  ? { passed: true }
  : { passed: false, error: failures.join('; ') };
```

### 8.4 `conclude`

```ts
const final = await store.concludeVerification(verificationId, deps.workerId, {
  passed, changedFiles: evidence.changedFiles, diffHash: evidence.diffHash,
  result: passed ? { output, summary: summarize(output), verificationId } : undefined,
  error: passed ? undefined : error,
});
if (!final) return { status: 'not-owner' };
await deps.emit(passed ? 'verification-completed' : 'verification-failed', { verificationId, error });
return passed ? { status: 'passed', verificationId } : { status: 'failed', verificationId, error };
```

---

## 9. 编排器改造：`domain/src/tasks/orchestrator.ts`

### 9.1 配置

```ts
export interface TaskOrchestratorConfig {
  // ...existing
  /** 验证命令的根目录；默认 process.cwd()。Desktop 用当前工作区 */
  workspaceRoot?: string;
  /** 验证日志根；默认 ~/.plain-agent/tasks */
  verificationLogRoot?: string;
  /** 注入检查器实现（测试用），默认 runVerificationCheck */
  verificationRunner?: VerificationCheckRunner;
}

export interface TaskRunOptions {
  verification?: TaskVerificationPolicy;
}
```

### 9.2 `createTask` / `run` 透传

- `createTask(sessionId, prompt, options)` 的 `options` 增加 `verification`，落到 `TaskRecord.verification`；
- `run(sessionId, prompt, taskId?, existingAgent?, options?: TaskRunOptions)`：仅在新建任务时把 `options.verification` 传给 `createTask`；已有 `taskId` 时忽略（策略以持久化记录为准，避免恢复时被调用方改写）。

### 9.3 完成路径（替换 `orchestrator.ts:403-429`）

```ts
if (this.activeAttempts.get(taskId) !== claimed.attempt) {
  throw leaseLostError(taskId, claimed.attempt);
}

const outcome = await runVerificationFlow(this.verificationDeps(taskId, claimed.attempt), {
  task: claimed,
  attempt: claimed.attempt,
  output,
});

if (outcome.status === 'not-owner') throw leaseLostError(taskId, claimed.attempt);

if (outcome.status === 'failed') {
  // concludeVerification 已把任务置为 failed
  this.emit('task-failed', { taskId, error: outcome.error });
  throw new Error(outcome.error); // 保持现有「任务失败 -> submit reject」语义
}

if (outcome.status === 'skipped') {
  // 无策略：沿用原 finishAttempt 完成路径
  const completed = await this.config.taskStore.finishAttempt(
    taskId, this.workerId, claimed.attempt, 'completed',
    { output, summary: summarize(output) },
  );
  if (!completed) { /* 沿用原有的 cancelled / lease-lost / 状态异常分支 */ }
  await this.appendTaskEvent(taskId, 'task-completed', { output, summary: summarize(output) });
  this.emit('task-completed', { taskId, result: { output, summary: summarize(output) } });
  return output;
}

// status === 'passed'：concludeVerification 已写 completed
this.emit('task-completed', { taskId, result: { output, summary: summarize(output) } });
return output;
```

注意：`concludeVerification` 已写 `task-completed` 事件，`orchestrator` 不要再 `appendTaskEvent` 一次；`skipped` 分支沿用旧写法。

### 9.4 `resume` 分支

```ts
async resume(taskId: string): Promise<string> {
  const task = await this.config.taskStore.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (TERMINAL.has(task.status)) return this.resultText(task);

  const current = this.active.get(taskId);
  if (current) return current;

  const execution = task.status === 'verifying'
    ? this.resumeVerification(taskId, task)
    : this.execute(taskId, undefined, true);
  // ...active map 注册逻辑保持不变
}
```

新增私有方法：

```ts
private async resumeVerification(taskId: string, task: TaskRecord): Promise<string> {
  const controller = new AbortController();
  this.activeVerifications.set(taskId, controller);
  try {
    const outcome = await resumeVerificationFlow(
      this.verificationDeps(taskId, task.attempt, controller.signal),
      { taskId },
    );
    if (outcome.status === 'not-owner') throw leaseLostError(taskId, task.attempt);
    if (outcome.status === 'failed') { this.emit('task-failed', { taskId, error: outcome.error }); throw new Error(outcome.error); }
    const latest = await this.config.taskStore.getTask(taskId);
    return latest?.status === 'completed' ? this.resultText(latest) : '';
  } finally {
    this.activeVerifications.delete(taskId);
  }
}
```

`verificationDeps(taskId, attempt, signal?)`：

```ts
private verificationDeps(taskId: string, attempt: number, signal?: AbortSignal): VerificationFlowDeps {
  const controller = signal ? { signal } : this.activeVerifications.get(taskId);
  return {
    store: this.config.taskStore,
    runner: this.config.verificationRunner ?? runVerificationCheck,
    workerId: this.workerId,
    workspaceRoot: this.config.workspaceRoot ?? process.cwd(),
    logRoot: this.config.verificationLogRoot ?? join(homedir(), '.plain-agent', 'tasks'),
    emit: (type, data) => this.appendTaskEvent(taskId, type, data),
    keepAlive: () => this.config.taskStore.renewLease(taskId, this.workerId, attempt),
    signal: controller?.signal ?? new AbortController().signal,
  };
}
```

`new AbortController().signal` 用于 `execute()` 路径（那里还不存在 controller）；不为它新建字段，保持最小面。取消时仍由 `cancel()` 走 `agent.stop()`；验证阶段加：

```ts
this.activeVerifications.get(taskId)?.abort();
```

### 9.5 `recover()`

```ts
const roots = allTasks.filter(task =>
  task.parentId === undefined &&
  (task.status === 'queued' ||
   task.status === 'waiting_child' ||
   task.status === 'waiting_process' ||
   task.status === 'verifying'),
);

// 循环内：
if (task.status === 'verifying') {
  if (!recoverable.has(task.id)) return 'deferred' as const;  // 租约未到期，交给定时器，不改状态
  await this.appendTaskEvent(task.id, 'task-recovery-started', { rootId: task.rootId, workerId: this.workerId });
  return this.resume(task.id);
}
```

返回值类型扩成 `'started' | 'blocked' | 'deferred'`，统计里 `deferred` 不计入 `started/blocked`，避免把「等租约」误报成恢复失败。

### 9.6 `scheduleLeaseRecovery`

```ts
.filter(task =>
  (task.status === 'running' || task.status === 'verifying') &&
  task.leaseUntil !== undefined &&
  !this.active.has(task.id),
)
```

`shutdown()` 里补 `for (const c of this.activeVerifications.values()) c.abort();`。

---

## 10. 入口接线

### 10.1 CLI（`cli/src/cli.tsx`）

`flagValue()` 只取一个值，新增：

```ts
const flagValues = (name: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[++i]);
    else if (arg.startsWith(`--${name}=`)) out.push(arg.slice(name.length + 3));
  }
  return out;
};

const verifyCommands = flagValues('verify');
const verification: TaskVerificationPolicy | undefined = verifyCommands.length === 0
  ? undefined
  : {
      mode: 'required',
      timeoutMs: Number(flagValue('verify-timeout') ?? 120_000),
      checks: verifyCommands.map((command, i) => ({
        kind: 'command' as const,
        name: `verify-${i + 1}`,
        command,
      })),
    };
```

`submitTask` 传第五个参数：

```ts
taskOrchestrator.run(agent.getSessionId(), task, undefined, agent, { verification })
```

`new TaskOrchestrator({ ... })` 增加 `workspaceRoot: process.cwd()`。

### 10.2 Desktop

`desktop/src/shared/desktop-api.ts`：

```ts
export interface VerificationSettings {
  mode: 'off' | 'required';
  checks: Array<{ name: string; command: string }>;
}

export interface AppSettings {
  // ...
  verification?: VerificationSettings;
}
```

`settings-store.ts` 的 `DEFAULT_SETTINGS`：

```ts
verification: { mode: 'off', checks: [] },
```

`agent-service.ts`：

```ts
this.taskOrchestrator = new TaskOrchestrator({
  // ...
  workspaceRoot: this.currentWorkspace?.path ?? process.cwd(),
});
```

`submit()` 里（`agent-service.ts:314-318`）：

```ts
const policy = this.settings.verification;
const verification = policy && policy.mode === 'required' && policy.checks.length > 0
  ? {
      mode: 'required' as const,
      checks: policy.checks.map((c, i) => ({ kind: 'command' as const, name: c.name || `verify-${i + 1}`, command: c.command })),
    }
  : undefined;
return this.taskOrchestrator.run(agent.getSessionId(), task, taskId, agent, { verification });
```

`workspaceRoot` 是构造时快照，`setWorkspace()` 之后要同步更新（给 orchestrator 一个 setter，或在 `verificationDeps` 里用 `() => this.currentWorkspace?.path` 的函数式注入）。**推荐把 config 字段改成 `workspaceRoot?: string | (() => string)`**，Desktop 传闭包，避免快照过期。

---

## 11. 测试

### 11.1 新文件 `domain/test/test-task-verification.ts`

沿用现有测试风格（自写 `assert`、`tsx` 直跑、临时目录、`MemoryStorage`/`SQLiteStorage` 双跑）。

公共夹具：

```ts
function makeTaskStub(overrides: Partial<TaskRecord> = {}): TaskRecord
function commandCheck(exitCode: number, opts: Partial<...> = {}): VerificationCheck
// 用 node 自身产生确定性结果，避免依赖 shell 内建：
//   passed: `node -e "process.exit(0)"`
//   failed: `node -e "console.error('boom'); process.exit(3)"`
```

用例清单（每条都写明断言）：

| # | 用例 | 关键操作 | 断言 |
|---|---|---|---|
| 1 | 全部通过 | orchestrator.run + `required` + 1 个 exit 0 检查 | 事件顺序含 `verification-started`→`verification-completed`→`task-completed`；任务 `completed`；`listVerifications` 有 1 条 passed |
| 2 | 检查失败 | exit 3 + stderr | 任务 `failed`；`verification.status='failed'`；check `exitCode===3`；`outputTail` 含 `boom`；无 `task-completed` 事件 |
| 3 | 多检查 + stopOnFailure | 3 项，第 2 项失败 | 第 3 项 `skipped`；`error` 含第 2 项名称 |
| 4 | 策略 off | 不传 verification | 有 `verification-skipped` 事件；任务 `completed`；`listVerifications` 为空 |
| 5 | 空检查 required | `mode:'required', checks: []` | 任务 `failed`，`error='verification-policy-has-no-checks'` |
| 6 | 验证崩溃后恢复 | 注入 runner：第 1 项通过后抛错/中止；随后 `recoverExpiredTasks` + `recover()` | Agent `runTurn` 调用次数为 1（用计数 FakeAgent）；第 1 项 runner 调用次数仍为 1；任务最终 `completed` |
| 7 | 不可重跑检查被中断 | `rerunSafe:false` + 手动把 verification/check 置 interrupted | 任务 `failed`，`error` 含 `check-interrupted-unsafe-rerun` |
| 8 | stale worker 收尾 | 用旧 attempt 调 `concludeVerification` | 返回 `null`，任务仍 `verifying` |
| 9 | 完成守卫 | `mode:'required'` 任务 claim 后直接 `finishAttempt('completed')` | 返回 `false`；有 `completion-rejected` 事件 |
| 10 | 取消 | 验证中 `cancel(taskId)` | 任务 `cancelled`；无 `task-failed`；验证行保持 `running/interrupted`（不做终态改写） |
| 11 | 旧库迁移 | 建库后 `DROP TABLE task_verification_checks; DROP TABLE task_verifications;` 重开 storage | 表重建成功；旧任务/消息可读 |
| 12 | Memory vs SQLite | 同一用例跑两种 store | 状态、事件类型序列、验证行字段一致 |

**用例 6 的实现要点**（最容易被写歪的地方）：

- 不要真的去 `process.exit()`；用注入 runner 模拟「检查跑完后进程消失」：
  ```ts
  const runner: VerificationCheckRunner = async (check, ctx) => {
    calls.push(check.name);
    if (check.name === 'verify-2') {
      // 模拟 worker 死亡：让租约过期，然后抛出一个不会被流程捕获的中断
      await store.updateTask(taskId, { leaseUntil: Date.now() - 1 });
      throw new Error('simulated-crash');
    }
    return { status: 'passed', durationMs: 1 };
  };
  ```
  flow 里 runner 抛错必须被 `executeChecks` 转成 `failed`/`not-owner`，不能把异常原样丢给编排器的 requeue 逻辑（否则会变成「重跑 Agent turn」——正是本阶段要避免的）。**实现要求：`runVerificationFlow` 对 runner 抛错做统一处理：`outcome = { status:'failed', error:'runner-crashed' }`，并尝试 `finishVerificationCheck`；若因租约丢失失败，返回 `not-owner`，不 requeue。**

- 恢复断言里要检查 `agent.runTurn` 的调用计数为 1，这是「不重跑 turn」的唯一硬证据。

### 11.2 需要改的既有测试

| 文件 | 改动 |
|---|---|
| `domain/test/test-task-orchestrator.ts` | 无策略任务应仍只出现旧事件；`FakeAgent` 走 `submit()` 兼容路径，新增断言「无 `verification-*` 事件，只有 `verification-skipped`」 |
| `domain/test/test-task-store.ts` | 增加 `verifying` 的 claim/renew/conclude 基础断言；`finishAttempt` 既有用例不受影响（任务无 policy） |
| `domain/test/test-task-recovery.ts` | 增加「verifying 任务租约过期 → 不清 attempt、状态仍 verifying」断言 |

### 11.3 脚本

`domain/package.json`：

```json
"test:verification": "tsx test/test-task-verification.ts",
"test:tasks": "tsx test/test-task-store.ts && ... && tsx test/test-task-verification.ts"
```

---

## 12. 实施顺序（每步可独立提交 + 可回滚）

| 步 | 内容 | 验收 | 回滚点 |
|---|---|---|---|
| S0 | `verification.ts` 类型 + `TaskRecord.verification` + 建表/迁移 + store 接口声明（实现先 `throw new Error('not-implemented')`？不要——直接在同一步把 Memory/SQLite 空实现补齐为返回 `null/false`，保持 typecheck 绿） | `domain typecheck`、`test:tasks` 全绿（旧行为） | 单提交回退 |
| S1 | Memory/SQLite 的 8 个方法 + transitions + `finishAttempt` 守卫 + 测试用例 9/11/12 | `test:tasks`、`test:verification` | 回退 S1 只影响新测试 |
| S2 | `verification-runner.ts` + 直接单测（临时目录、真实 `node -e` 命令、超时用 `node -e "setTimeout(()=>{},10000)"` + `timeoutMs:50`） | `test:verification` 中 runner 用例 | 独立模块，删文件即回退 |
| S3 | `verification-flow.ts` + 编排器完成路径 + CLI/Desktop 透传骨架（先不接 UI） | 用例 1/2/3/4/5 | 恢复 `orchestrator.ts:403-429` 原块 |
| S4 | 恢复/取消/续租改造（renewLease、recoverExpiredTasks、listRecoverableTasks、resume 分支、scheduleLeaseRecovery） | 用例 6/7/8/10 | 回退这 5 处 diff |
| S5 | CLI `--verify` + Desktop settings 接线 + 手工验证 | `cli typecheck`、`desktop typecheck`、手工 4 条 | 仅入口，不动 domain |
| S6 | 文档更新（`docs/long-task-persistence-next-plan.md` 的实施状态、本文件勾选）+ 全量回归 | §13 全部命令 | — |

建议提交粒度：

```text
feat(domain): 增加任务验证数据模型与 store 契约
feat(domain): 实现验证检查器与 verifying 状态推进
feat(domain): verifying 状态支持租约续期与崩溃恢复
feat(cli): 增加 --verify 参数
feat(desktop): 支持 settings.verification
test(domain): 覆盖验证闭环、崩溃恢复与完成守卫
docs: 更新验证闭环实施状态
```

---

## 13. 全量验收

```bash
pnpm --filter @plain-agent/domain typecheck
pnpm --filter @plain-agent/domain test:tasks
pnpm --filter @plain-agent/domain test:verification
pnpm --filter @plain-agent/domain test:subagent
pnpm --filter @plain-agent/domain test:loop
pnpm --filter @plain-agent/domain test:jobs
pnpm --filter @plain-agent/cli typecheck
pnpm --filter @plain-agent/desktop typecheck
pnpm --filter @plain-agent/desktop typecheck:web
pnpm --filter @plain-agent/server typecheck
```

手工：

1. `pnpm cli --verify "node -e \"process.exit(0)\""` → 完成且事件含验证阶段；
2. `pnpm cli --verify "node -e \"process.exit(1)\""` → 任务失败，报错含检查名与 exit code；
3. 验证中 `Ctrl+C`，重启 CLI（不带参数）→ 任务恢复完成，数据不重复；
4. Desktop 不配置 `verification` → 行为与 `2a20331` 完全一致（对比事件序列）。

---

## 14. 实现注意事项（踩坑清单）

1. **不要用 `claimTask` 做验证恢复**：它会把 `attempt + 1`，直接触发「重跑 Agent turn」。必须新增 `claimVerification`。
2. **`renewLease` 忘了放宽 `verifying`**：表现是验证跑到一半续租定时器 `onLost()` 把 Agent 停了，任务卡在 `verifying`。
3. **`recoverExpiredTasks` 忘了 `verifying` 分支**：任务永久卡住，且 `recover()` 拿不到它。
4. **`concludeVerification` 与 `finishAttempt` 双写**：只有 `conclude` 负责终态；编排器 `passed` 分支不要再调 `finishAttempt`。
5. **事件重复**：`conclude` 内已写 `task-completed`/`task-failed`，编排器只 `emit` 不再 `appendTaskEvent`。
6. **Memory store 漏删验证记录**：`deleteTasksBySession()` / `clear()` 必须清理 `verifications`，否则测试串数据。
7. **SQLite 参数顺序**：`createTask` 的 21 个占位符加 `verification_json` 后变 22 个，最容易错位；写完立刻跑 `test-task-store`。
8. **`updateAttemptStatus` 的 `canTransition` 硬编码**：改成从实际 `from` 状态判断，否则 `verifying -> cancelled` 永远被拒。
9. **不要把 runner 的异常漏到编排器的 requeue 分支**：那会把「验证失败」当成「执行失败」重试，等于重跑 turn。flow 内部吞掉并转成 outcome。
10. **`workspaceRoot` 用闭包**：Desktop 切换工作区后，快照值会指向旧目录，验证命令在错误目录执行。
11. **验证命令不要用登录 shell**：`resolveShell` 返回的是 `bash -c`，不读 `~/.bashrc`，环境变量依赖要靠宿主自己注入，文档里说明。
12. **日志目录不要写进仓库**：`logRoot` 默认在用户主目录，测试必须显式传 `tmpdir()`。

---

## 15. 完成定义（承接计划文档 §10）

- [x] `running -> verifying -> completed|failed` 单一路径，`completed` 前必有验证记录或 `verification-skipped`；
- [x] `task_verifications` / `task_verification_checks` 可查询，含 exitCode/输出尾部/日志路径/changedFiles/diffHash；
- [x] 崩溃恢复不重跑 Agent turn，已通过检查不重跑；
- [x] `rerunSafe:false` 的中断检查不自动重跑；
- [x] 租约在 `verifying` 期间可持续续期，`cancel` 可从 `verifying` 生效；
- [x] store 级完成守卫在 `mode:'required'` 下生效；
- [x] CLI `--verify`、Desktop `settings.verification` 可用，默认行为不变；
- [x] Memory/SQLite 行为一致，旧库可直接打开；
- [x] §13 全部命令通过。

### 15.1 实现备注（与本文档草案的差异）

1. **完成守卫位置**：SQLite 放在 `updateAttemptStatus` 事务内（含 `completion-rejected` 事件），Memory 放在 `finishAttempt` 校验段；两者都只对 `verification.mode='required'` 生效。
2. **事件持久化职责**：`beginVerification` / `concludeVerification` / check 起止都由 store 在同一事务里写事件；`VerificationFlowDeps.notify` 只做内存转发（编排器 `task-event`），不重复落库。`verification-skipped` 由 flow 直接 `appendEvent`。
3. **恢复不改 attempt**：`claimVerification` 只更新 `lease_owner/lease_until`；`recoverExpiredTasks` 对 `verifying` 清租约并把 `running` 的验证/检查行标 `interrupted`，不计入 `maxAttempts`。
4. **空策略**：`mode:'required'` + `checks: []` 在进入 `verifying` 前按配置错误失败（`verification-policy-has-no-checks`），不产生空的验证记录。
5. **`run()` 短路**：显式传入的 `taskId` 若已是 `verifying`，直接走 `resume()`，避免误用 `claimTask` 把 attempt 加一。
6. **检查器异常**：runner 抛错被 flow 转成一次 `failed` 检查结果；若此时租约已失效，落库失败返回 `not-owner`，不会进入编排器的 requeue 分支重跑 Agent turn。
7. **测试补充**：新增 `files-exist`、策略 JSON 往返、旧库删表重建、真实 git 仓库 `git-diff`（含 changedFiles/diffHash 证据）用例；`node:sqlite` 用 `createRequire` 加载，规避 `@types/node` 20 无类型声明。
8. **跨进程崩溃测试**：`test-task-verification-crash.ts` 用子进程持有真实 SQLite 库，跑到 `verifying` 的慢检查后 `taskkill /T /F`；父进程重开库、`recover()`，断言 `attempt` 仍为 1、Agent turn 未重跑、检查重跑后通过。租约在测试中手工提前过期（真实重启最多等 60s），其余路径都是真实进程与真实数据库。


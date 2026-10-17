import { randomUUID } from 'node:crypto';
import type { TaskEventRecord, TaskRecord, TaskStatus } from './types';
import type { TaskCheckpoint } from './checkpoints';
import type {
  TaskVerificationRecord,
  VerificationCheckOutcome,
  VerificationCheckSeed,
  VerificationStatus,
} from './verification';
import { canTransition, normalizeTaskStatus } from './transitions';
import type { TaskStore, TaskTerminalStatus } from './store';

export const DEFAULT_TASK_LEASE_MS = 60_000;
const CLAIMABLE_STATUSES = ['queued', 'running'] as const;
/** Lease expiry scans verifying too, but those rows are recovered without a new attempt. */
const RECOVERABLE_STATUSES = ['queued', 'running', 'verifying'] as const;

function encode(value: unknown): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

export class SQLiteTaskStore implements TaskStore {
  constructor(private readonly db: any) {
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        root_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 2,
        delegation_json TEXT,
        depth INTEGER,
        lease_owner TEXT,
        lease_until INTEGER,
        checkpoint_id TEXT,
        result_summary TEXT,
        result_ref TEXT,
        result_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        iteration INTEGER NOT NULL,
        transcript_cursor INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_claimable
        ON tasks(status, lease_until, updated_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_session
        ON tasks(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent
        ON tasks(parent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_task_events_task
        ON task_events(task_id, seq);
      CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task
        ON task_checkpoints(task_id, created_at);

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
    `);
    this.ensureColumn('delegation_json', 'TEXT');
    this.ensureColumn('depth', 'INTEGER');
    this.ensureColumn('verification_json', 'TEXT');
  }

  private ensureColumn(column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
    if (!columns.some(entry => entry.name === column)) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
    }
  }

  async createTask(task: TaskRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO tasks (
        id, parent_id, root_id, session_id, prompt, status,
        attempt, max_attempts, delegation_json, depth, lease_owner, lease_until,
        checkpoint_id, verification_json, result_summary, result_ref, result_json,
        error, created_at, started_at, finished_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.parentId ?? null,
      task.rootId,
      task.sessionId,
      task.prompt,
      task.status,
      task.attempt,
      task.maxAttempts,
      task.delegation === undefined ? null : encode(task.delegation),
      task.depth ?? null,
      task.leaseOwner ?? null,
      task.leaseUntil ?? null,
      task.checkpointId ?? null,
      task.verification === undefined ? null : encode(task.verification),
      task.resultSummary ?? null,
      task.resultRef ?? null,
      task.result === undefined ? null : encode(task.result),
      task.error ?? null,
      task.createdAt,
      task.startedAt ?? null,
      task.finishedAt ?? null,
      task.updatedAt,
    );
    await this.appendEvent(task.id, 'task-created', { status: task.status });
  }

  async saveTask(task: TaskRecord): Promise<void> {
    const existing = await this.getTask(task.id);
    if (!existing) {
      await this.createTask(task);
      return;
    }
    await this.updateTask(task.id, task);
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM tasks WHERE id = ?
    `).get(taskId) as any;
    return row ? this.fromRow(row) : null;
  }

  async listTasks(filter: {
    sessionId?: string;
    rootId?: string;
    parentId?: string;
    status?: TaskStatus | TaskStatus[];
  } = {}): Promise<TaskRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.sessionId) {
      where.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.rootId) {
      where.push('root_id = ?');
      params.push(filter.rootId);
    }
    if (filter.parentId !== undefined) {
      where.push('parent_id = ?');
      params.push(filter.parentId);
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at ASC
    `).all(...params) as any[];
    return rows.map(row => this.fromRow(row));
  }

  async updateTask(taskId: string, patch: Partial<TaskRecord>): Promise<boolean> {
    const columns: Array<[string, unknown]> = [];
    const add = (column: string, value: unknown) => columns.push([column, value]);
    if ('parentId' in patch) add('parent_id', patch.parentId ?? null);
    if ('rootId' in patch) add('root_id', patch.rootId);
    if ('sessionId' in patch) add('session_id', patch.sessionId);
    if ('prompt' in patch) add('prompt', patch.prompt);
    if ('status' in patch) add('status', patch.status);
    if ('attempt' in patch) add('attempt', patch.attempt);
    if ('maxAttempts' in patch) add('max_attempts', patch.maxAttempts);
    if ('delegation' in patch) {
      add('delegation_json', patch.delegation === undefined ? null : encode(patch.delegation));
    }
    if ('depth' in patch) add('depth', patch.depth ?? null);
    if ('leaseOwner' in patch) add('lease_owner', patch.leaseOwner ?? null);
    if ('leaseUntil' in patch) add('lease_until', patch.leaseUntil ?? null);
    if ('checkpointId' in patch) add('checkpoint_id', patch.checkpointId ?? null);
    if ('verification' in patch) {
      add('verification_json', patch.verification === undefined ? null : encode(patch.verification));
    }
    if ('resultSummary' in patch) add('result_summary', patch.resultSummary ?? null);
    if ('resultRef' in patch) add('result_ref', patch.resultRef ?? null);
    if ('result' in patch) add('result_json', patch.result === undefined ? null : encode(patch.result));
    if ('error' in patch) add('error', patch.error ?? null);
    if ('createdAt' in patch) add('created_at', patch.createdAt);
    if ('startedAt' in patch) add('started_at', patch.startedAt ?? null);
    if ('finishedAt' in patch) add('finished_at', patch.finishedAt ?? null);
    if (columns.length === 0) return Boolean(await this.getTask(taskId));

    add('updated_at', Date.now());
    const set = columns.map(([column]) => `${column} = ?`).join(', ');
    const result = this.db.prepare(`
      UPDATE tasks SET ${set} WHERE id = ?
    `).run(...columns.map(([, value]) => value), taskId) as any;
    return Number(result?.changes ?? 0) > 0;
  }

  async transition(
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
    patch: Partial<TaskRecord> = {},
  ): Promise<boolean> {
    if (!canTransition(from, to)) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = await this.getTask(taskId);
      if (!current || current.status !== from) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const changed = await this.updateTask(taskId, { ...patch, status: to });
      if (!changed) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.insertEvent(taskId, 'status-changed', { from, to }, Date.now());
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async finishAttempt(
    taskId: string,
    workerId: string,
    attempt: number,
    status: TaskTerminalStatus,
    result?: unknown,
  ): Promise<boolean> {
    return this.updateAttemptStatus(taskId, workerId, attempt, status, result);
  }

  async blockAttempt(
    taskId: string,
    workerId: string,
    attempt: number,
    error?: string,
  ): Promise<boolean> {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare(`
        UPDATE tasks
        SET status = 'blocked',
            error = COALESCE(?, error),
            lease_owner = NULL,
            lease_until = NULL,
            updated_at = ?
        WHERE id = ?
          AND status = 'running'
          AND lease_owner = ?
          AND attempt = ?
          AND lease_until > ?
      `).run(error ?? null, now, taskId, workerId, attempt, now) as any;
      if (Number(changed?.changes ?? 0) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.insertEvent(taskId, 'status-changed', {
        from: 'running',
        to: 'blocked',
      }, now);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async retryAttempt(
    taskId: string,
    workerId: string,
    attempt: number,
    error: string,
  ): Promise<boolean> {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`
        UPDATE tasks
        SET status = 'queued',
            error = ?,
            lease_owner = NULL,
            lease_until = NULL,
            updated_at = ?
        WHERE id = ?
          AND status = 'running'
          AND lease_owner = ?
          AND attempt = ?
          AND lease_until > ?
          AND attempt < max_attempts
      `).run(error, now, taskId, workerId, attempt, now) as any;
      if (Number(result?.changes ?? 0) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.insertEvent(taskId, 'status-changed', { from: 'running', to: 'queued' }, now);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async cancelAttempt(
    taskId: string,
    workerId: string,
    attempt: number,
    result?: unknown,
  ): Promise<boolean> {
    return this.updateAttemptStatus(taskId, workerId, attempt, 'cancelled', result, ['running', 'verifying']);
  }

  private async updateAttemptStatus(
    taskId: string,
    workerId: string,
    attempt: number,
    status: TaskTerminalStatus,
    result?: unknown,
    allowedFrom: TaskStatus[] = ['running'],
  ): Promise<boolean> {
    if (!allowedFrom.some(from => canTransition(from, status))) return false;

    const now = Date.now();
    const columns = ['status = ?', 'lease_owner = NULL', 'lease_until = NULL', 'finished_at = ?', 'updated_at = ?'];
    const values: unknown[] = [status, now, now];
    if (result !== undefined) {
      columns.push('result_json = ?');
      values.push(encode(result));
    }
    const resultFields = summarizeResult(result);
    if (resultFields.resultSummary !== undefined) {
      columns.push('result_summary = ?');
      values.push(resultFields.resultSummary);
    }
    if (resultFields.error !== undefined) {
      columns.push('error = ?');
      values.push(resultFields.error);
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare(`
        SELECT status, verification_json FROM tasks WHERE id = ?
      `).get(taskId) as any | undefined;
      if (!current) {
        this.db.exec('ROLLBACK');
        return false;
      }
      // Completion guard: tasks that opted into required verification can only
      // be completed by a passed verification for the same attempt.
      if (status === 'completed' && current.verification_json) {
        const policy = JSON.parse(current.verification_json) as { mode?: string };
        if (policy.mode === 'required') {
          const passed = this.db.prepare(`
            SELECT 1 FROM task_verifications
            WHERE task_id = ? AND attempt = ? AND status = 'passed'
            LIMIT 1
          `).get(taskId, attempt);
          if (!passed) {
            this.insertEvent(taskId, 'completion-rejected', {
              reason: 'verification-required-but-not-passed',
              attempt,
            }, now);
            this.db.exec('COMMIT');
            return false;
          }
        }
      }

      const fromClause = allowedFrom.map(() => '?').join(', ');
      const changed = this.db.prepare(`
        UPDATE tasks
        SET ${columns.join(', ')}
        WHERE id = ?
          AND status IN (${fromClause})
          AND lease_owner = ?
          AND attempt = ?
          AND lease_until > ?
      `).run(...values, taskId, ...allowedFrom, workerId, attempt, now) as any;
      if (Number(changed?.changes ?? 0) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.insertEvent(taskId, 'status-changed', {
        from: current.status,
        to: status,
      }, now);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async updateTaskStatus(taskId: string, status: TaskStatus, result?: unknown): Promise<boolean> {
    const current = await this.getTask(taskId);
    if (!current) return false;
    const normalized = normalizeTaskStatus(status);
    if (!canTransition(current.status, normalized)) return false;

    const patch: Partial<TaskRecord> = { status: normalized };
    if (result !== undefined) patch.result = result;
    if (typeof result === 'object' && result !== null) {
      const value = result as Record<string, unknown>;
      if (typeof value.summary === 'string') patch.resultSummary = value.summary;
      if (typeof value.output === 'string' && !patch.resultSummary) {
        patch.resultSummary = value.output.slice(0, 500);
      }
      if (typeof value.error === 'string') patch.error = value.error;
    }
    if (['completed', 'failed', 'cancelled'].includes(normalized)) {
      patch.finishedAt = Date.now();
      patch.leaseOwner = undefined;
      patch.leaseUntil = undefined;
    }
    return this.transition(taskId, current.status, normalized, patch);
  }

  async claimNext(workerId: string): Promise<TaskRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'queued'
         OR (
           status IN (${CLAIMABLE_STATUSES.map(() => '?').join(', ')})
           AND lease_until IS NOT NULL
           AND lease_until <= ?
         )
      ORDER BY created_at ASC
      LIMIT 1
    `).get(...CLAIMABLE_STATUSES, Date.now()) as any;
    return row ? this.claimRow(row.id, workerId) : null;
  }

  async claimTask(taskId: string, workerId: string): Promise<TaskRecord | null> {
    return this.claimRow(taskId, workerId);
  }

  private async claimRow(taskId: string, workerId: string): Promise<TaskRecord | null> {
    const now = Date.now();
    const leaseUntil = now + DEFAULT_TASK_LEASE_MS;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT * FROM tasks WHERE id = ?
      `).get(taskId) as any;
      if (!row) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const expired = row.lease_until !== null && row.lease_until <= now;
      const claimable = row.status === 'queued' ||
        (CLAIMABLE_STATUSES.includes(row.status) && expired);
      if (!claimable) {
        this.db.exec('ROLLBACK');
        return null;
      }
      if (row.attempt >= row.max_attempts) {
        this.db.prepare(`
          UPDATE tasks
          SET status = 'failed',
              error = COALESCE(error, ?),
              lease_owner = NULL,
              lease_until = NULL,
              finished_at = ?,
              updated_at = ?
          WHERE id = ?
        `).run(
          `Task exceeded maximum attempts (${row.max_attempts})`,
          now,
          now,
          taskId,
        );
        this.db.prepare(`
          INSERT INTO task_events (task_id, type, data, created_at)
          VALUES (?, 'task-failed', ?, ?)
        `).run(taskId, encode({
          reason: 'max-attempts-exceeded',
          attempt: row.attempt,
        }), now);
        this.db.exec('COMMIT');
        return null;
      }

      const result = this.db.prepare(`
        UPDATE tasks
        SET status = 'running',
            attempt = attempt + 1,
            lease_owner = ?,
            lease_until = ?,
            started_at = COALESCE(started_at, ?),
            updated_at = ?
        WHERE id = ?
      `).run(workerId, leaseUntil, now, now, taskId) as any;
      if (Number(result?.changes ?? 0) !== 1) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db.prepare(`
        INSERT INTO task_events (task_id, type, data, created_at)
        VALUES (?, 'task-claimed', ?, ?)
      `).run(taskId, encode({ workerId, attempt: row.attempt + 1 }), now);
      this.db.exec('COMMIT');
      return this.getTask(taskId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async renewLease(taskId: string, workerId: string, attempt?: number): Promise<boolean> {
    const now = Date.now();
    const attemptClause = attempt === undefined ? '' : 'AND attempt = ?';
    const params: unknown[] = [now + DEFAULT_TASK_LEASE_MS, now, taskId, workerId];
    if (attempt !== undefined) params.push(attempt);
    params.push(now);
    const result = this.db.prepare(`
      UPDATE tasks
      SET lease_until = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND status IN ('running', 'verifying')
        ${attemptClause}
        AND lease_until > ?
    `).run(...params) as any;
    return Number(result?.changes ?? 0) === 1;
  }

  async releaseLease(taskId: string, workerId: string, attempt?: number): Promise<boolean> {
    const attemptClause = attempt === undefined ? '' : 'AND attempt = ?';
    const params: unknown[] = [Date.now(), taskId, workerId];
    if (attempt !== undefined) params.push(attempt);
    const result = this.db.prepare(`
      UPDATE tasks
      SET lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND lease_owner = ? ${attemptClause}
    `).run(...params) as any;
    return Number(result?.changes ?? 0) === 1;
  }

  async recoverExpiredTasks(now = Date.now()): Promise<number> {
    const rows = this.db.prepare(`
      SELECT id, status, lease_owner, lease_until, attempt, max_attempts
      FROM tasks
      WHERE status IN (${RECOVERABLE_STATUSES.map(() => '?').join(', ')})
        AND lease_until IS NOT NULL
        AND lease_until <= ?
    `).all(...RECOVERABLE_STATUSES, now) as any[];
    let recovered = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        if (row.status === 'verifying') {
          // Verification is not a new attempt: keep status/attempt, only release the lease.
          const released = this.db.prepare(`
            UPDATE tasks
            SET lease_owner = NULL, lease_until = NULL, updated_at = ?
            WHERE id = ?
              AND status = 'verifying'
              AND lease_owner IS ?
              AND lease_until = ?
          `).run(now, row.id, row.lease_owner, row.lease_until) as any;
          if (Number(released?.changes ?? 0) !== 1) continue;

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

          recovered++;
          this.insertEvent(row.id, 'lease-expired', {
            recoveredAt: now,
            nextStatus: 'verifying',
          }, now);
          this.insertEvent(row.id, 'verification-interrupted', {
            attempt: row.attempt,
          }, now);
          continue;
        }

        const exhausted = row.attempt >= row.max_attempts;
        const nextStatus = exhausted ? 'failed' : 'queued';
        const values: unknown[] = [
          nextStatus,
          ...(exhausted ? [`Task exceeded maximum attempts (${row.max_attempts})`] : []),
          ...(exhausted ? [now] : []),
          now,
          row.id,
          row.status,
          row.lease_owner,
          row.lease_until,
        ];
        const columns = [
          'status = ?',
          ...(exhausted ? ['error = COALESCE(error, ?)', 'finished_at = ?'] : []),
          'lease_owner = NULL',
          'lease_until = NULL',
          'updated_at = ?',
        ];
        const changed = this.db.prepare(`
          UPDATE tasks
          SET ${columns.join(', ')}
          WHERE id = ?
            AND status = ?
            AND lease_owner IS ?
            AND lease_until = ?
        `).run(...values) as any;
        if (Number(changed?.changes ?? 0) !== 1) continue;

        recovered++;
        this.insertEvent(row.id, 'lease-expired', {
          recoveredAt: now,
          nextStatus,
        }, now);
        if (exhausted) {
          this.insertEvent(row.id, 'task-failed', {
            reason: 'max-attempts-exceeded',
            attempt: row.attempt,
          }, now);
        }
      }
      this.db.exec('COMMIT');
      return recovered;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async listRecoverableTasks(now = Date.now()): Promise<TaskRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'queued'
         OR (
           status = 'running'
           AND lease_until IS NOT NULL
           AND lease_until <= ?
         )
         OR (
           status = 'verifying'
           AND (lease_until IS NULL OR lease_until <= ?)
         )
      ORDER BY created_at ASC
    `).all(now, now) as any[];
    return rows.map(row => this.fromRow(row));
  }

  async listChildren(parentId: string): Promise<TaskRecord[]> {
    return this.listTasks({ parentId });
  }

  async recoverTaskTree(rootId: string, now = Date.now()): Promise<TaskRecord[]> {
    await this.recoverExpiredTasks(now);
    return this.listTasks({ rootId });
  }

  async createCheckpoint(checkpoint: TaskCheckpoint): Promise<void> {
    this.db.prepare(`
      INSERT INTO task_checkpoints (
        id, task_id, attempt, iteration, transcript_cursor,
        state_json, summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpoint.id,
      checkpoint.taskId,
      checkpoint.attempt,
      checkpoint.iteration,
      checkpoint.transcriptCursor,
      encode(checkpoint.state),
      checkpoint.summary,
      checkpoint.createdAt,
    );
  }

  async getCheckpoint(checkpointId: string): Promise<TaskCheckpoint | null> {
    const row = this.db.prepare(`
      SELECT * FROM task_checkpoints WHERE id = ?
    `).get(checkpointId) as any;
    return row ? this.checkpointFromRow(row) : null;
  }

  async getLatestCheckpoint(taskId: string): Promise<TaskCheckpoint | null> {
    const row = this.db.prepare(`
      SELECT * FROM task_checkpoints
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(taskId) as any;
    return row ? this.checkpointFromRow(row) : null;
  }

  async commitCheckpoint(
    taskId: string,
    checkpoint: TaskCheckpoint,
    event: { type: string; data: unknown },
    guard?: { workerId?: string; attempt?: number },
  ): Promise<boolean> {
    if (checkpoint.taskId !== taskId) return false;
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
      if (!task) {
        this.db.exec('ROLLBACK');
        return false;
      }
      if (
        guard?.attempt !== undefined &&
        (task.attempt !== guard.attempt ||
          task.status !== 'running' ||
          (guard.workerId !== undefined && task.lease_owner !== guard.workerId) ||
          task.lease_until === null ||
          task.lease_until <= now)
      ) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.prepare(`
        INSERT INTO task_checkpoints (
          id, task_id, attempt, iteration, transcript_cursor,
          state_json, summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkpoint.id,
        checkpoint.taskId,
        checkpoint.attempt,
        checkpoint.iteration,
        checkpoint.transcriptCursor,
        encode(checkpoint.state),
        checkpoint.summary,
        checkpoint.createdAt,
      );
      const updated = this.db.prepare(`
        UPDATE tasks
        SET checkpoint_id = ?, updated_at = ?
        WHERE id = ?
      `).run(checkpoint.id, now, taskId) as any;
      if (Number(updated?.changes ?? 0) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.insertEvent(taskId, event.type, event.data, now);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async beginVerification(
    taskId: string,
    workerId: string,
    attempt: number,
    checks: VerificationCheckSeed[],
  ): Promise<TaskVerificationRecord | null> {
    if (checks.length === 0) return null;
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
      if (
        !task ||
        task.status !== 'running' ||
        task.lease_owner !== workerId ||
        task.attempt !== attempt ||
        task.lease_until === null ||
        task.lease_until <= now
      ) {
        this.db.exec('ROLLBACK');
        return null;
      }

      const existing = this.db.prepare(`
        SELECT id FROM task_verifications
        WHERE task_id = ? AND attempt = ? AND status IN ('running', 'interrupted')
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

  async getVerification(verificationId: string): Promise<TaskVerificationRecord | null> {
    return this.loadVerification(verificationId);
  }

  async getLatestVerification(
    taskId: string,
    attempt?: number,
  ): Promise<TaskVerificationRecord | null> {
    const attemptClause = attempt === undefined ? '' : 'AND attempt = ?';
    const params: unknown[] = [taskId];
    if (attempt !== undefined) params.push(attempt);
    const row = this.db.prepare(`
      SELECT * FROM task_verifications
      WHERE task_id = ? ${attemptClause}
      ORDER BY started_at DESC
      LIMIT 1
    `).get(...params) as any;
    return row ? this.verificationFromRow(row) : null;
  }

  async listVerifications(taskId: string): Promise<TaskVerificationRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM task_verifications
      WHERE task_id = ?
      ORDER BY started_at ASC
    `).all(taskId) as any[];
    return rows.map(row => this.verificationFromRow(row));
  }

  async claimVerification(
    taskId: string,
    workerId: string,
  ): Promise<{ task: TaskRecord; verification: TaskVerificationRecord } | null> {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
      const free = task && task.status === 'verifying' &&
        (task.lease_owner === null || task.lease_until === null || task.lease_until <= now);
      if (!free) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const verification = this.db.prepare(`
        SELECT * FROM task_verifications
        WHERE task_id = ? AND attempt = ?
        ORDER BY started_at DESC LIMIT 1
      `).get(taskId, task.attempt) as any;
      if (!verification) {
        this.db.exec('ROLLBACK');
        return null;
      }

      const leaseUntil = now + DEFAULT_TASK_LEASE_MS;
      const updated = this.db.prepare(`
        UPDATE tasks
        SET lease_owner = ?, lease_until = ?, updated_at = ?
        WHERE id = ? AND status = 'verifying'
          AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until <= ?)
      `).run(workerId, leaseUntil, now, taskId, now) as any;
      if (Number(updated?.changes ?? 0) !== 1) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db.prepare(`
        UPDATE task_verifications SET status = 'running'
        WHERE id = ? AND status = 'interrupted'
      `).run(verification.id);
      this.insertEvent(taskId, 'verification-claimed', {
        workerId,
        verificationId: verification.id,
        attempt: task.attempt,
      }, now);
      this.db.exec('COMMIT');

      const claimedTask = await this.getTask(taskId);
      if (!claimedTask) return null;
      const claimedVerification = await this.loadVerification(verification.id);
      return claimedVerification ? { task: claimedTask, verification: claimedVerification } : null;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async startVerificationCheck(
    verificationId: string,
    index: number,
    workerId: string,
  ): Promise<boolean> {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.verificationGuardRow(verificationId);
      if (!this.canDriveVerification(row, workerId, now)) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const changed = this.db.prepare(`
        UPDATE task_verification_checks
        SET status = 'running', started_at = ?, error = NULL
        WHERE verification_id = ? AND idx = ?
          AND status IN ('pending', 'running', 'interrupted')
      `).run(now, verificationId, index) as any;
      if (Number(changed?.changes ?? 0) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.insertEvent(row.task_id, 'verification-check-started', {
        verificationId,
        index,
      }, now);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async finishVerificationCheck(
    verificationId: string,
    index: number,
    workerId: string,
    outcome: VerificationCheckOutcome,
  ): Promise<boolean> {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.verificationGuardRow(verificationId);
      if (!this.canDriveVerification(row, workerId, now)) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const changed = this.db.prepare(`
        UPDATE task_verification_checks
        SET status = ?, exit_code = ?, output_ref = ?, output_tail = ?,
            duration_ms = ?, error = ?, finished_at = ?
        WHERE verification_id = ? AND idx = ? AND status = 'running'
      `).run(
        outcome.status,
        outcome.exitCode ?? null,
        outcome.outputRef ?? null,
        outcome.outputTail ?? null,
        outcome.durationMs,
        outcome.error ?? null,
        now,
        verificationId,
        index,
      ) as any;
      if (Number(changed?.changes ?? 0) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.insertEvent(row.task_id, 'verification-check-completed', {
        verificationId,
        index,
        status: outcome.status,
        exitCode: outcome.exitCode ?? null,
      }, now);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async concludeVerification(
    verificationId: string,
    workerId: string,
    input: {
      passed: boolean;
      changedFiles: string[];
      diffHash?: string;
      result?: unknown;
      error?: string;
    },
  ): Promise<'completed' | 'failed' | null> {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.verificationGuardRow(verificationId);
      if (
        !row ||
        row.task_status !== 'verifying' ||
        !['running', 'interrupted'].includes(row.v_status) ||
        row.attempt !== row.v_attempt ||
        row.lease_owner !== workerId ||
        row.lease_until === null ||
        row.lease_until <= now
      ) {
        this.db.exec('ROLLBACK');
        return null;
      }

      if (!input.passed) {
        this.db.prepare(`
          UPDATE task_verification_checks
          SET status = 'skipped', finished_at = ?
          WHERE verification_id = ? AND status IN ('pending', 'interrupted')
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
      const columns = [
        'status = ?',
        'lease_owner = NULL',
        'lease_until = NULL',
        'finished_at = ?',
        'updated_at = ?',
      ];
      const values: unknown[] = [finalStatus, now, now];
      if (input.result !== undefined) {
        columns.push('result_json = ?');
        values.push(encode(input.result));
        const resultFields = summarizeResult(input.result);
        if (resultFields.resultSummary !== undefined) {
          columns.push('result_summary = ?');
          values.push(resultFields.resultSummary);
        }
      }
      if (input.error !== undefined) {
        columns.push('error = ?');
        values.push(input.error);
      }

      const updated = this.db.prepare(`
        UPDATE tasks
        SET ${columns.join(', ')}
        WHERE id = ? AND status = 'verifying' AND lease_owner = ? AND attempt = ?
      `).run(...values, row.task_id, workerId, row.attempt) as any;
      if (Number(updated?.changes ?? 0) !== 1) {
        this.db.exec('ROLLBACK');
        return null;
      }

      this.insertEvent(row.task_id, 'status-changed', {
        from: 'verifying',
        to: finalStatus,
      }, now);
      this.insertEvent(
        row.task_id,
        input.passed ? 'verification-completed' : 'verification-failed',
        input.passed
          ? { verificationId, changedFiles: input.changedFiles, diffHash: input.diffHash ?? null }
          : { verificationId, error: input.error ?? 'verification-failed' },
        now,
      );
      this.insertEvent(
        row.task_id,
        input.passed ? 'task-completed' : 'task-failed',
        input.passed ? { verificationId } : { verificationId, error: input.error ?? 'verification-failed' },
        now,
      );
      this.db.exec('COMMIT');
      return finalStatus;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private verificationGuardRow(verificationId: string): any | undefined {
    return this.db.prepare(`
      SELECT v.id, v.task_id, v.attempt AS v_attempt, v.status AS v_status,
             t.attempt, t.status AS task_status, t.lease_owner, t.lease_until
      FROM task_verifications v
      JOIN tasks t ON t.id = v.task_id
      WHERE v.id = ?
    `).get(verificationId) as any | undefined;
  }

  private canDriveVerification(row: any | undefined, workerId: string, now: number): boolean {
    return Boolean(
      row &&
      row.task_status === 'verifying' &&
      row.v_status === 'running' &&
      row.attempt === row.v_attempt &&
      row.lease_owner === workerId &&
      row.lease_until !== null &&
      row.lease_until > now,
    );
  }

  private loadVerification(verificationId: string): TaskVerificationRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM task_verifications WHERE id = ?
    `).get(verificationId) as any;
    return row ? this.verificationFromRow(row) : null;
  }

  private verificationFromRow(row: any): TaskVerificationRecord {
    const checks = this.db.prepare(`
      SELECT * FROM task_verification_checks
      WHERE verification_id = ?
      ORDER BY idx ASC
    `).all(row.id) as any[];
    return {
      id: row.id,
      taskId: row.task_id,
      attempt: row.attempt,
      status: row.status as VerificationStatus,
      checks: checks.map(check => ({
        index: check.idx,
        name: check.name,
        kind: check.kind,
        command: check.command ?? undefined,
        status: check.status,
        exitCode: check.exit_code ?? undefined,
        outputRef: check.output_ref ?? undefined,
        outputTail: check.output_tail ?? undefined,
        durationMs: check.duration_ms ?? undefined,
        error: check.error ?? undefined,
        startedAt: check.started_at ?? undefined,
        finishedAt: check.finished_at ?? undefined,
      })),
      changedFiles: row.changed_files_json ? JSON.parse(row.changed_files_json) : [],
      diffHash: row.diff_hash ?? undefined,
      error: row.error ?? undefined,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
    };
  }

  async appendEvent(taskId: string, type: string, data: unknown): Promise<TaskEventRecord> {
    const createdAt = Date.now();
    return this.insertEvent(taskId, type, data, createdAt);
  }

  private insertEvent(
    taskId: string,
    type: string,
    data: unknown,
    createdAt: number,
  ): TaskEventRecord {
    const result = this.db.prepare(`
      INSERT INTO task_events (task_id, type, data, created_at)
      VALUES (?, ?, ?, ?)
    `).run(taskId, type, encode(data), createdAt) as any;
    return {
      seq: Number(result.lastInsertRowid),
      taskId,
      type,
      data,
      createdAt,
    };
  }

  async listEvents(taskId: string, afterSeq = 0): Promise<TaskEventRecord[]> {
    const rows = this.db.prepare(`
      SELECT seq, task_id, type, data, created_at
      FROM task_events
      WHERE task_id = ? AND seq > ?
      ORDER BY seq ASC
    `).all(taskId, afterSeq) as any[];
    return rows.map(row => ({
      seq: row.seq,
      taskId: row.task_id,
      type: row.type,
      data: JSON.parse(row.data),
      createdAt: row.created_at,
    }));
  }

  async deleteTasksBySession(sessionId: string): Promise<void> {
    this.db.prepare(`
      DELETE FROM tasks
      WHERE session_id = ?
         OR root_id IN (
           SELECT root_id FROM tasks WHERE session_id = ?
         )
    `).run(sessionId, sessionId);
  }

  private fromRow(row: any): TaskRecord {
    return {
      id: row.id,
      parentId: row.parent_id ?? undefined,
      rootId: row.root_id,
      sessionId: row.session_id,
      prompt: row.prompt,
      status: row.status,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      delegation: row.delegation_json ? JSON.parse(row.delegation_json) : undefined,
      depth: row.depth ?? undefined,
      leaseOwner: row.lease_owner ?? undefined,
      leaseUntil: row.lease_until ?? undefined,
      checkpointId: row.checkpoint_id ?? undefined,
      verification: row.verification_json ? JSON.parse(row.verification_json) : undefined,
      resultSummary: row.result_summary ?? undefined,
      resultRef: row.result_ref ?? undefined,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  private checkpointFromRow(row: any): TaskCheckpoint {
    return {
      id: row.id,
      taskId: row.task_id,
      attempt: row.attempt,
      iteration: row.iteration,
      transcriptCursor: row.transcript_cursor,
      state: JSON.parse(row.state_json),
      summary: row.summary,
      createdAt: row.created_at,
    };
  }
}

function summarizeResult(result: unknown): {
  resultSummary?: string;
  error?: string;
} {
  if (typeof result !== 'object' || result === null) return {};
  const value = result as Record<string, unknown>;
  const resultSummary =
    typeof value.summary === 'string'
      ? value.summary
      : typeof value.output === 'string'
        ? value.output.slice(0, 500)
        : undefined;
  return {
    resultSummary,
    error: typeof value.error === 'string' ? value.error : undefined,
  };
}


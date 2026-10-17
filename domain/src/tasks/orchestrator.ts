import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PlainAgent } from '../agent';
import type { AgentEvent, SessionStorage } from '../types';
import type { TaskStore } from './store';
import type { TaskRecord, TaskStatus } from './types';
import type { TaskVerificationPolicy } from './verification';
import {
  runVerificationFlow,
  resumeVerificationFlow,
  type VerificationFlowDeps,
} from './verification-flow';
import { runVerificationCheck, type VerificationCheckRunner } from './verification-runner';

export interface TaskOrchestratorConfig {
  taskStore: TaskStore;
  sessionStorage?: SessionStorage;
  workerId?: string;
  maxAttempts?: number;
  leaseRenewIntervalMs?: number;
  /** Maximum ReAct iterations executed in one durable turn. */
  turnMaxIterations?: number;
  /** Root directory for verification commands; defaults to process.cwd(). */
  workspaceRoot?: string | (() => string);
  /** Root directory for verification logs; defaults to ~/.plain-agent/tasks. */
  verificationLogRoot?: string;
  /** Injectable check runner (tests / custom hosts); defaults to the built-in runner. */
  verificationRunner?: VerificationCheckRunner;
  createAgent: (sessionId: string) => PlainAgent;
  prepareAgent?: (agent: PlainAgent, sessionId: string, taskId: string) => Promise<void>;
}

export interface TaskRunOptions {
  /** Verification policy for a task created by this call. Ignored when taskId is given. */
  verification?: TaskVerificationPolicy;
}

export interface TaskRecoveryResult {
  expired: number;
  started: number;
  failed: number;
  blocked: number;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

const PERSISTED_AGENT_EVENTS = new Set<AgentEvent['type']>([
  'task-start',
  'task-end',
  'error',
  'done',
  'stopped',
  'tool_start',
  'tool_result',
  'subagent-created',
  'subagent-progress',
  'subagent-completed',
]);

export class TaskOrchestrator extends EventEmitter {
  private readonly workerId: string;
  private readonly maxAttempts: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly turnMaxIterations: number;
  private readonly active = new Map<string, Promise<string>>();
  private readonly activeAgents = new Map<string, PlainAgent>();
  private readonly activeAttempts = new Map<string, number>();
  private readonly activeVerifications = new Map<string, AbortController>();
  private readonly renewTimers = new Map<string, ReturnType<typeof setInterval>>();
  private recoveryTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly config: TaskOrchestratorConfig) {
    super();
    this.workerId = config.workerId ?? `worker-${randomUUID()}`;
    this.maxAttempts = config.maxAttempts ?? 2;
    this.leaseRenewIntervalMs = config.leaseRenewIntervalMs ?? 20_000;
    this.turnMaxIterations = config.turnMaxIterations ?? 10;
  }

  async createTask(
    sessionId: string,
    prompt: string,
    options: {
      taskId?: string;
      parentId?: string;
      rootId?: string;
      maxAttempts?: number;
      verification?: TaskVerificationPolicy;
    } = {},
  ): Promise<TaskRecord> {
    const now = Date.now();
    const task: TaskRecord = {
      id: options.taskId ?? randomUUID(),
      parentId: options.parentId,
      rootId: options.rootId ?? options.taskId ?? '',
      sessionId,
      prompt,
      status: 'queued',
      attempt: 0,
      maxAttempts: options.maxAttempts ?? this.maxAttempts,
      verification: options.verification,
      createdAt: now,
      updatedAt: now,
    };
    if (!task.rootId) task.rootId = task.id;

    await this.config.sessionStorage?.createSession(sessionId, 'Untitled');
    await this.config.taskStore.createTask(task);
    this.emit('task-created', task);
    return task;
  }

  async run(
    sessionId: string,
    prompt: string,
    taskId?: string,
    existingAgent?: PlainAgent,
    options: TaskRunOptions = {},
  ): Promise<string> {
    const task = taskId
      ? await this.config.taskStore.getTask(taskId)
      : await this.createTask(sessionId, prompt, { verification: options.verification });
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.sessionId !== sessionId) {
      throw new Error(`Task ${task.id} belongs to another session`);
    }
    if (!taskId && task.prompt !== prompt) {
      throw new Error(`Task ${task.id} prompt mismatch`);
    }
    // Verifying tasks are resumed, never re-executed: claiming would bump the attempt.
    if (task.status === 'verifying') return this.resume(task.id);

    const current = this.active.get(task.id);
    if (current) return current;

    const execution = this.execute(task.id, existingAgent, false);
    this.active.set(task.id, execution);
    const clearActive = () => {
      if (this.active.get(task.id) === execution) this.active.delete(task.id);
    };
    void execution.then(clearActive, clearActive);
    return execution;
  }

  async resume(taskId: string): Promise<string> {
    const task = await this.config.taskStore.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (TERMINAL.has(task.status)) {
      return this.resultText(task);
    }

    const current = this.active.get(taskId);
    if (current) return current;

    const execution = task.status === 'verifying'
      ? this.resumeVerification(taskId, task)
      : this.execute(taskId, undefined, true);
    this.active.set(taskId, execution);
    const clearActive = () => {
      if (this.active.get(taskId) === execution) this.active.delete(taskId);
    };
    void execution.then(clearActive, clearActive);
    return execution;
  }

  async recover(): Promise<TaskRecoveryResult> {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    const expired = await this.config.taskStore.recoverExpiredTasks();
    const allTasks = await this.config.taskStore.listTasks();
    const roots = allTasks.filter(task =>
      task.parentId === undefined &&
      (task.status === 'queued' ||
        task.status === 'waiting_child' ||
        task.status === 'waiting_process' ||
        task.status === 'verifying'),
    );
    const recoverable = new Set(
      (await this.config.taskStore.listRecoverableTasks()).map(task => task.id),
    );
    let started = 0;
    let failed = 0;
    let blocked = 0;

    const results = await Promise.allSettled(roots.map(async task => {
      try {
        if (task.status === 'verifying') {
          // A live lease means another worker is still verifying; the scheduled
          // lease recovery will pick it up once it expires.
          if (!recoverable.has(task.id)) return 'deferred' as const;
          await this.appendTaskEvent(task.id, 'task-recovery-started', {
            rootId: task.rootId,
            workerId: this.workerId,
            phase: 'verifying',
          });
          return this.resume(task.id);
        }

        const tree = await this.config.taskStore.recoverTaskTree(task.rootId);
        const waitingChild = tree.find(member => member.status === 'waiting_child');
        if (waitingChild || !recoverable.has(task.id)) {
          // P2 will use the checkpoint to resume the parent at the child-wait boundary.
          // Re-running the original prompt here could create duplicate children.
          const reason = waitingChild
            ? 'waiting-child-requires-checkpoint'
            : 'waiting-process-requires-external-wakeup';
          const changed = await this.config.taskStore.updateTaskStatus(task.id, 'blocked', {
            error: `Task recovery deferred: ${reason}`,
          });
          await this.appendTaskEvent(task.id, 'task-recovery-deferred', {
            reason,
            changed,
          });
          return 'blocked' as const;
        }
        await this.appendTaskEvent(task.id, 'task-recovery-started', {
          rootId: task.rootId,
          workerId: this.workerId,
        });
        return this.resume(task.id);
      } catch (error) {
        await this.appendTaskEvent(task.id, 'task-recovery-failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }));
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value === 'blocked') blocked++;
        else started++;
      } else {
        failed++;
      }
    }
    this.scheduleLeaseRecovery();
    return { expired, started, failed, blocked };
  }

  async cancel(taskId: string): Promise<boolean> {
    const task = await this.config.taskStore.getTask(taskId);
    if (!task || TERMINAL.has(task.status)) return false;

    const agent = this.activeAgents.get(taskId);
    agent?.stop(taskId);
    this.activeVerifications.get(taskId)?.abort();
    const attempt = this.activeAttempts.get(taskId);
    const changed = attempt === undefined
      ? await this.config.taskStore.updateTaskStatus(taskId, 'cancelled', {
        error: 'Task cancelled',
      })
      : await this.config.taskStore.cancelAttempt(
        taskId,
        this.workerId,
        attempt,
        { error: 'Task cancelled' },
      );
    if (changed) {
      await this.appendTaskEvent(taskId, 'task-cancelled', { workerId: this.workerId });
    }
    return changed;
  }

  async cancelSession(sessionId: string): Promise<void> {
    const roots = await this.config.taskStore.listTasks({ sessionId });
    const treeTasks = (
      await Promise.all(roots.map(root => this.config.taskStore.listTasks({ rootId: root.rootId })))
    ).flat();
    const tasks = [...new Map(treeTasks.map(task => [task.id, task])).values()];
    await Promise.all(tasks.filter(task => !TERMINAL.has(task.status)).map(task => this.cancel(task.id)));

    const activeRuns = tasks
      .map(task => this.active.get(task.id))
      .filter((run): run is Promise<string> => Boolean(run));
    await Promise.allSettled(activeRuns);
    await this.config.taskStore.deleteTasksBySession(sessionId);
  }

  getActiveTaskIds(): string[] {
    return [...this.active.keys()];
  }

  /** Stop lease renewals without changing task state, for process shutdown. */
  shutdown(): void {
    for (const taskId of this.renewTimers.keys()) {
      this.stopRenewal(taskId);
    }
    for (const controller of this.activeVerifications.values()) {
      controller.abort();
    }
    this.activeVerifications.clear();
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    return this.config.taskStore.getTask(taskId);
  }

  /**
   * Resume a task that is already in `verifying`. Claiming the verification only
   * takes over the lease — it must not start a new attempt or re-run the agent turn.
   */
  private async resumeVerification(taskId: string, task: TaskRecord): Promise<string> {
    const attempt = task.attempt;
    const controller = new AbortController();
    this.activeVerifications.set(taskId, controller);
    this.startRenewal(taskId, attempt, () => controller.abort());
    try {
      const outcome = await resumeVerificationFlow(
        this.verificationDeps(taskId, attempt, controller.signal),
        { taskId },
      );
      if (outcome.status === 'not-owner') throw leaseLostError(taskId, attempt);
      if (outcome.status === 'failed') {
        this.emit('task-failed', { taskId, error: outcome.error });
        throw new Error(outcome.error);
      }
      const latest = await this.config.taskStore.getTask(taskId);
      if (!latest) return '';
      return TERMINAL.has(latest.status) ? this.resultText(latest) : '';
    } finally {
      this.stopRenewal(taskId);
      this.activeVerifications.delete(taskId);
    }
  }

  private verificationDeps(
    taskId: string,
    attempt: number,
    signal?: AbortSignal,
  ): VerificationFlowDeps {
    const workspaceRoot = this.config.workspaceRoot;
    return {
      store: this.config.taskStore,
      runner: this.config.verificationRunner ?? runVerificationCheck,
      workerId: this.workerId,
      workspaceRoot: typeof workspaceRoot === 'function'
        ? workspaceRoot()
        : workspaceRoot ?? process.cwd(),
      logRoot: this.config.verificationLogRoot ?? join(homedir(), '.plain-agent', 'tasks'),
      notify: (type, data) => this.emit('task-event', { taskId, type, data }),
      keepAlive: () => this.config.taskStore.renewLease(taskId, this.workerId, attempt),
      signal: signal ?? this.activeVerifications.get(taskId)?.signal ?? new AbortController().signal,
    };
  }

  private async execute(
    taskId: string,
    preferredAgent: PlainAgent | undefined,
    recovering: boolean,
  ): Promise<string> {
    let agent = preferredAgent;
    let shouldPrepare = recovering;

    while (true) {
      const task = await this.config.taskStore.getTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.status === 'cancelled') throw abortError(`Task ${taskId} was cancelled`);
      if (TERMINAL.has(task.status)) return this.resultText(task);

      const claimed = await this.config.taskStore.claimTask(taskId, this.workerId);
      if (!claimed) {
        const current = await this.config.taskStore.getTask(taskId);
        if (current?.status === 'completed') return this.resultText(current);
        if (current?.status === 'cancelled') throw abortError(`Task ${taskId} was cancelled`);
        throw new Error(`Task ${taskId} could not be claimed`);
      }

      let runningAgent: PlainAgent | undefined;
      let onAgentEvent: ((event: AgentEvent) => void) | undefined;
      try {
        agent ??= this.config.createAgent(claimed.sessionId);
        if (!agent) throw new Error(`Unable to create agent for task ${taskId}`);
        runningAgent = agent;
        if (shouldPrepare) {
          await this.config.prepareAgent?.(runningAgent, claimed.sessionId, claimed.id);
          shouldPrepare = false;
        }

        onAgentEvent = (event: AgentEvent) => {
          this.emit('agent-event', { taskId, event });
          if (!PERSISTED_AGENT_EVENTS.has(event.type)) return;
          void this.appendTaskEvent(taskId, `agent-${event.type}`, event);
        };
        runningAgent.on('event', onAgentEvent);
        this.activeAgents.set(taskId, runningAgent);
        this.activeAttempts.set(taskId, claimed.attempt);
        let leaseLost = false;
        const onLeaseLost = () => {
          if (leaseLost) return;
          leaseLost = true;
          runningAgent?.stop(taskId);
        };
        this.startRenewal(taskId, claimed.attempt, onLeaseLost);
        await this.appendTaskEvent(taskId, 'task-started', {
          workerId: this.workerId,
          attempt: claimed.attempt,
        });
      } catch (error) {
        this.stopRenewal(taskId);
        if (runningAgent && onAgentEvent) runningAgent.off('event', onAgentEvent);
        if (this.activeAgents.get(taskId) === runningAgent) this.activeAgents.delete(taskId);
        if (this.activeAttempts.get(taskId) === claimed.attempt) this.activeAttempts.delete(taskId);
        const message = error instanceof Error ? error.message : String(error);
        if (await this.requeueAfterFailure(taskId, claimed.attempt, message)) {
          agent = undefined;
          shouldPrepare = true;
          continue;
        }
        throw error;
      }

      try {
        let output: string;
        const durableAgent = runningAgent as PlainAgent & {
          runTurn?: (
            taskId: string,
            prompt: string,
            options?: { maxIterations?: number },
          ) => Promise<{
            status: string;
            output?: string;
            checkpointId?: string;
            reason?: string;
            error?: { message: string };
          }>;
          resume?: (
            taskId: string,
            checkpointId?: string,
          ) => Promise<{
            status: string;
            output?: string;
            checkpointId?: string;
            reason?: string;
            error?: { message: string };
          }>;
        };

        if (typeof durableAgent.runTurn === 'function' && typeof durableAgent.resume === 'function') {
          await (runningAgent as any).recoverPendingSubagents?.(taskId);
          let turn = claimed.checkpointId
            ? await durableAgent.resume(claimed.id, claimed.checkpointId)
            : await durableAgent.runTurn(claimed.id, claimed.prompt, {
              maxIterations: this.turnMaxIterations,
            });

          while (turn.status === 'paused') {
            await this.appendTaskEvent(taskId, 'turn-continued', {
              checkpointId: turn.checkpointId,
              attempt: claimed.attempt,
            });
            const renewed = await this.config.taskStore.renewLease(
              taskId,
              this.workerId,
              claimed.attempt,
            );
            if (!renewed) {
              throw leaseLostError(taskId, claimed.attempt);
            }
            turn = await durableAgent.resume(claimed.id, turn.checkpointId);
          }

          if (turn.status === 'blocked') {
            const reason = turn.reason ?? 'Task blocked during recovery';
            const blocked = await this.config.taskStore.blockAttempt(
              taskId,
              this.workerId,
              claimed.attempt,
              reason,
            );
            if (blocked) {
              await this.appendTaskEvent(taskId, 'task-blocked', { reason });
              await this.config.taskStore.releaseLease(taskId, this.workerId, claimed.attempt);
              return reason;
            }
            throw leaseLostError(taskId, claimed.attempt);
          }
          if (turn.status !== 'completed') {
            throw new Error(turn.error?.message ?? turn.reason ?? `Task turn ended as ${turn.status}`);
          }
          output = turn.output ?? '';
        } else {
          // Compatibility path for lightweight agents and existing integrations.
          output = await runningAgent!.submit(claimed.prompt, claimed.id);
        }
        if (this.activeAttempts.get(taskId) !== claimed.attempt) {
          throw leaseLostError(taskId, claimed.attempt);
        }
        const result = {
          output,
          summary: summarize(output),
        };

        const controller = new AbortController();
        this.activeVerifications.set(taskId, controller);
        let verification;
        try {
          verification = await runVerificationFlow(
            this.verificationDeps(taskId, claimed.attempt, controller.signal),
            { task: claimed, attempt: claimed.attempt, output },
          );
        } finally {
          if (this.activeVerifications.get(taskId) === controller) {
            this.activeVerifications.delete(taskId);
          }
        }
        if (verification.status === 'not-owner') {
          throw leaseLostError(taskId, claimed.attempt);
        }
        if (verification.status === 'failed') {
          // When the flow owned the lease, concludeVerification already closed the
          // task as failed together with its evidence.
          if (!verification.verificationId) {
            await this.config.taskStore.finishAttempt(
              taskId,
              this.workerId,
              claimed.attempt,
              'failed',
              { error: verification.error, summary: verification.error },
            );
          }
          this.emit('task-failed', { taskId, error: verification.error });
          throw new Error(verification.error);
        }
        if (verification.status === 'skipped') {
          const completed = await this.config.taskStore.finishAttempt(
            taskId,
            this.workerId,
            claimed.attempt,
            'completed',
            result,
          );
          if (!completed) {
            const current = await this.config.taskStore.getTask(taskId);
            if (current?.status === 'cancelled') {
              throw abortError(`Task ${taskId} was cancelled`);
            }
            if (!ownsAttempt(current, this.workerId, claimed.attempt)) {
              throw leaseLostError(taskId, claimed.attempt);
            }
            throw new Error(`Task ${taskId} could not be completed from ${current?.status ?? 'missing'}`);
          }
          await this.appendTaskEvent(taskId, 'task-completed', result);
        }
        this.emit('task-completed', { taskId, result });
        return output;
      } catch (error) {
        const current = await this.config.taskStore.getTask(taskId);
        if (current?.status === 'cancelled') {
          await this.appendTaskEvent(taskId, 'task-cancelled', { workerId: this.workerId });
          throw abortError(`Task ${taskId} was cancelled`);
        }
        if (current && TERMINAL.has(current.status)) throw error;
        if (!ownsAttempt(current, this.workerId, claimed.attempt)) {
          throw leaseLostError(taskId, claimed.attempt);
        }

        const message = error instanceof Error ? error.message : String(error);
        if (await this.requeueAfterFailure(taskId, claimed.attempt, message)) {
          agent = undefined;
          shouldPrepare = true;
          continue;
        }
        throw error;
      } finally {
        this.stopRenewal(taskId);
        if (onAgentEvent) runningAgent!.off('event', onAgentEvent);
        if (this.activeAgents.get(taskId) === runningAgent) this.activeAgents.delete(taskId);
        if (this.activeAttempts.get(taskId) === claimed.attempt) this.activeAttempts.delete(taskId);
      }
    }
  }

  private async requeueAfterFailure(taskId: string, attempt: number, message: string): Promise<boolean> {
    const current = await this.config.taskStore.getTask(taskId);
    if (!ownsAttempt(current, this.workerId, attempt)) {
      return false;
    }
    if (!current) return false;
    if (current.attempt < current.maxAttempts) {
      const requeued = await this.config.taskStore.retryAttempt(
        taskId,
        this.workerId,
        attempt,
        message,
      );
      if (requeued) {
        await this.appendTaskEvent(taskId, 'task-retry', {
          error: message,
          nextAttempt: current.attempt + 1,
        });
        return true;
      }
    }

    const failed = await this.config.taskStore.finishAttempt(taskId, this.workerId, attempt, 'failed', {
      error: message,
      summary: message,
    });
    if (failed) {
      await this.appendTaskEvent(taskId, 'task-failed', { error: message });
      this.emit('task-failed', { taskId, error: message });
    }
    return false;
  }

  private startRenewal(taskId: string, attempt: number, onLost: () => void): void {
    this.stopRenewal(taskId);
    const timer = setInterval(() => {
      void this.config.taskStore.renewLease(taskId, this.workerId, attempt).then(renewed => {
        if (!renewed) {
          this.stopRenewal(taskId);
          onLost();
          return;
        }
        this.emit('lease-renewed', { taskId, workerId: this.workerId });
      }).catch(error => {
        this.emit('task-error', { taskId, error });
      });
    }, this.leaseRenewIntervalMs);
    const maybeUnref = timer as ReturnType<typeof setInterval> & { unref?: () => void };
    maybeUnref.unref?.();
    this.renewTimers.set(taskId, timer);
  }

  private stopRenewal(taskId: string): void {
    const timer = this.renewTimers.get(taskId);
    if (!timer) return;
    clearInterval(timer);
    this.renewTimers.delete(taskId);
  }

  private scheduleLeaseRecovery(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    void this.config.taskStore.listTasks().then(tasks => {
      const nextExpiry = tasks
        .filter(task =>
          (task.status === 'running' || task.status === 'verifying') &&
          task.leaseUntil !== undefined &&
          !this.active.has(task.id),
        )
        .reduce<number | undefined>(
          (nearest, task) => Math.min(nearest ?? Infinity, task.leaseUntil!),
          undefined,
        );
      if (nextExpiry === undefined) return;

      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = undefined;
        void this.recover().catch(error => this.emit('task-error', { error }));
      }, Math.max(1, nextExpiry - Date.now() + 1));
      const maybeUnref = this.recoveryTimer as ReturnType<typeof setTimeout> & { unref?: () => void };
      maybeUnref.unref?.();
    }).catch(error => this.emit('task-error', { error }));
  }

  private async appendTaskEvent(taskId: string, type: string, data: unknown): Promise<void> {
    try {
      await this.config.taskStore.appendEvent(taskId, type, data);
      this.emit('task-event', { taskId, type, data });
    } catch (error) {
      this.emit('task-error', { taskId, error });
    }
  }

  private resultText(task: TaskRecord): string {
    if (typeof task.result === 'string') return task.result;
    if (task.result && typeof task.result === 'object') {
      const output = (task.result as Record<string, unknown>).output;
      if (typeof output === 'string') return output;
    }
    return task.resultSummary ?? '';
  }
}

function summarize(output: string): string {
  return output.length <= 500 ? output : `${output.slice(0, 500)}... (truncated)`;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function ownsAttempt(
  task: TaskRecord | null,
  workerId: string,
  attempt: number,
): boolean {
  return Boolean(
    task &&
    task.status === 'running' &&
    task.leaseOwner === workerId &&
    task.attempt === attempt &&
    task.leaseUntil !== undefined &&
    task.leaseUntil > Date.now(),
  );
}

function leaseLostError(taskId: string, attempt: number): Error {
  const error = new Error(`Lease lost for task ${taskId} attempt ${attempt}`);
  error.name = 'LeaseLostError';
  return error;
}

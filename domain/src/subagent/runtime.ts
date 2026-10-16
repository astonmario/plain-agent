import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { PlainAgent } from '../agent';
import type { AgentConfig, AgentEvent, ChatMessage, Tool } from '../types';
import { MemoryTaskStore } from '../tasks/memory';
import type { TaskStore } from '../tasks/store';
import type { TaskRecord } from '../tasks/types';
import type {
  SubagentRequest,
  SubagentResult,
  SubagentStatus,
  SubagentRun,
  SubagentRuntime as ISubagentRuntime,
  ToolPolicy,
} from './types';

type SubagentEventName = 'progress' | 'tool_call' | 'completed' | 'error';
type RuntimeConfig = Required<SubagentRuntimeConfig>;

export interface SubagentRuntimeConfig {
  agentFactory: (config: AgentConfig) => PlainAgent;
  parentConfig: AgentConfig;
  toolPolicy?: ToolPolicy;
  taskStore?: TaskStore;
  maxConcurrency?: number;
  defaultTimeout?: number;
  maxDepth?: number;
}

const TERMINAL: ReadonlySet<SubagentStatus['status']> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

const SUMMARY_MAX_LENGTH = 500;

export class SubagentRuntime extends EventEmitter implements ISubagentRuntime {
  private readonly config: RuntimeConfig;
  private readonly runs = new Map<string, SubagentRun>();
  private readonly eventListeners = new Map<
    string,
    Map<SubagentEventName, Set<(data: any) => void>>
  >();
  private pendingSpawns = 0;

  constructor(config: SubagentRuntimeConfig) {
    super();
    const taskStore = config.taskStore ?? config.parentConfig.taskStore ?? new MemoryTaskStore();
    this.config = {
      agentFactory: config.agentFactory,
      parentConfig: { ...config.parentConfig, taskStore },
      toolPolicy: config.toolPolicy ?? new DefaultToolPolicy(),
      taskStore,
      maxConcurrency: config.maxConcurrency ?? 5,
      defaultTimeout: config.defaultTimeout ?? 300_000,
      maxDepth: config.maxDepth ?? 3,
    };
  }

  async spawn(request: SubagentRequest): Promise<{ runId: string }> {
    const activeCount = [...this.runs.values()].filter(run => !TERMINAL.has(run.status)).length;
    if (activeCount + this.pendingSpawns >= this.config.maxConcurrency) {
      throw new Error(
        `Maximum concurrent subagents (${this.config.maxConcurrency}) reached. ` +
        `Please wait for some tasks to complete.`,
      );
    }
    this.pendingSpawns++;
    let reservationHeld = true;
    const releaseReservation = () => {
      if (!reservationHeld) return;
      reservationHeld = false;
      this.pendingSpawns--;
    };

    try {
    const parentRun = this.runs.get(request.parentRunId);
    const parentTask = await this.config.taskStore.getTask(request.parentRunId);
    const depth = parentRun ? parentRun.depth + 1 : 0;
    if (depth >= this.config.maxDepth) {
      throw new Error(
        `Maximum recursion depth (${this.config.maxDepth}) exceeded. ` +
        `Current depth: ${depth}. Consider refactoring the task.`,
      );
    }

    const runId = randomUUID();
    const task: TaskRecord = {
      id: runId,
      parentId: parentTask?.id,
      rootId: parentTask?.rootId ?? runId,
      sessionId: runId,
      prompt: request.task,
      status: 'queued',
      attempt: 0,
      maxAttempts: 2,
      delegation: request,
      depth,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.config.parentConfig.storage?.createSession(runId, 'Subtask');
    await this.config.taskStore.createTask(task);

    const run = this.makeRun(runId, request, depth);
    this.runs.set(runId, run);
    releaseReservation();
    try {
      run.agent = this.createAgent(request, runId, depth);
    } catch (error: any) {
      await this.markStoredTaskFailed(runId, error?.message ?? String(error));
      this.finish(run, { status: 'failed', error: error?.message ?? String(error) });
      return { runId };
    }

    this.emit('subagent-created', {
      runId,
      task: request.task,
      depth,
      parentId: task.parentId,
    });
    void this.execute(run);
    return { runId };
    } catch (error) {
      releaseReservation();
      throw error;
    }
  }

  /**
   * Recreate in-memory runs for persisted unfinished child tasks.
   * The task ID is retained so parent links and event history remain stable.
   */
  async recoverPending(parentRunId: string): Promise<string[]> {
    await this.config.taskStore.recoverExpiredTasks();
    const tasks = await this.config.taskStore.listTasks({
      parentId: parentRunId,
      status: 'queued',
    });
    const resumed: string[] = [];
    for (const task of tasks) {
      if (this.runs.has(task.id)) continue;
      const request: SubagentRequest = {
        parentRunId: task.parentId ?? task.rootId,
        task: task.prompt,
      };
      const run = this.makeRun(task.id, request, 0);
      this.runs.set(task.id, run);
      try {
        run.agent = this.createAgent(request, task.sessionId, 0);
        void this.execute(run);
        resumed.push(task.id);
      } catch (error: any) {
        await this.markStoredTaskFailed(task.id, error?.message ?? String(error));
        this.finish(run, { status: 'failed', error: error?.message ?? String(error) });
      }
    }
    return resumed;
  }

  async wait(runId: string, timeout?: number): Promise<SubagentResult> {
    const run = this.runs.get(runId);
    if (run) {
      if (run.result) return run.result;

      const effectiveTimeout = timeout ?? this.config.defaultTimeout;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), effectiveTimeout);
      });
      const maybeUnref = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
      maybeUnref?.unref?.();

      try {
        const outcome = await Promise.race([run.promise, timeoutPromise]);
        if (outcome !== 'timeout') return outcome;

        // A timeout is an observation result only. The task keeps its lease and runs.
        return {
          runId,
          status: 'timeout',
          error: `Subagent ${runId} wait timed out after ${effectiveTimeout}ms`,
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // Fallback to TaskStore for persisted results
    const stored = await this.config.taskStore.getTask(runId);
    if (!stored) throw new Error(`Subagent ${runId} not found`);

    const mappedStatus = mapTaskStatus(stored.status);
    if (TERMINAL.has(mappedStatus) && stored.result) {
      // Return persisted result for completed tasks
      const result = stored.result as SubagentResult;
      return {
        runId,
        status: mappedStatus,
        output: result.output,
        error: result.error,
        summary: result.summary,
        stats: result.stats,
      };
    }

    // Non-terminal persisted task: return observational status without modifying the task
    return {
      runId,
      status: mappedStatus,
      error: `Subagent ${runId} is in non-terminal state: ${stored.status}`,
    };
  }

  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      const stored = await this.config.taskStore.getTask(runId);
      if (!stored || TERMINAL.has(mapTaskStatus(stored.status))) return;
      await this.config.taskStore.updateTaskStatus(runId, 'cancelled', {
        error: 'Subagent cancelled',
      });
      return;
    }
    if (TERMINAL.has(run.status)) return;

    run.status = 'cancelled';
    await this.config.taskStore.updateTaskStatus(runId, 'cancelled', {
      error: 'Subagent cancelled',
    });
    run.agent?.stop();
    this.finish(run, { status: 'cancelled', error: 'Subagent cancelled' });
    this.emit('subagent-cancelled', { runId });
  }

  async getStatus(runId: string): Promise<SubagentStatus> {
    const run = this.runs.get(runId);
    if (run) {
      return {
        runId,
        status: run.status,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      };
    }

    const stored = await this.config.taskStore.getTask(runId);
    if (!stored) throw new Error(`Subagent ${runId} not found`);
    return {
      runId,
      status: mapTaskStatus(stored.status),
      createdAt: stored.createdAt,
      startedAt: stored.startedAt,
      finishedAt: stored.finishedAt,
    };
  }

  subscribeSubagent(runId: string, event: SubagentEventName, listener: (data: any) => void): void {
    if (!this.eventListeners.has(runId)) {
      this.eventListeners.set(runId, new Map());
    }
    const listeners = this.eventListeners.get(runId)!;
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(listener);
  }

  unsubscribeSubagent(runId: string, event: SubagentEventName, listener: (data: any) => void): void {
    this.eventListeners.get(runId)?.get(event)?.delete(listener);
  }

  cleanup(runId: string): void {
    const run = this.runs.get(runId);
    if (run && !TERMINAL.has(run.status)) return;
    this.runs.delete(runId);
    this.eventListeners.delete(runId);
  }

  private makeRun(runId: string, request: SubagentRequest, depth: number): SubagentRun {
    let resolveDone!: (result: SubagentResult) => void;
    const promise = new Promise<SubagentResult>(resolve => {
      resolveDone = resolve;
    });
    return {
      runId,
      request,
      status: 'pending',
      promise,
      resolveDone,
      createdAt: Date.now(),
      depth,
    };
  }

  private createAgent(request: SubagentRequest, sessionId: string, depth: number): PlainAgent {
    const tools = this.config.toolPolicy.filterTools(this.config.parentConfig.tools, request.tools);
    const agentConfig: AgentConfig = {
      llm: this.config.parentConfig.llm,
      tools,
      maxIterations: request.config?.maxIterations ?? 50,
      sessionId,
      storage: this.config.parentConfig.storage,
      taskStore: this.config.taskStore,
      permissionMode: request.config?.permissionMode ?? this.config.parentConfig.permissionMode,
      historyManagement: this.config.parentConfig.historyManagement,
      systemPrompt: this.buildSystemPrompt(request),
      subagentRuntime: depth + 1 < this.config.maxDepth ? this : undefined,
    };
    return this.config.agentFactory(agentConfig);
  }

  private async execute(run: SubagentRun): Promise<void> {
    const agent: PlainAgent = run.agent!;
    if (run.result || TERMINAL.has(run.status)) {
      if (run.status === 'cancelled') {
        await this.config.taskStore.updateTaskStatus(run.runId, 'cancelled', {
          error: 'Subagent cancelled',
        });
      }
      return;
    }

    const task = await this.config.taskStore.claimTask(run.runId, `subagent-${run.runId}`);
    if (!task) {
      if (run.result || TERMINAL.has(run.status)) return;
      this.finish(run, { status: 'failed', error: `Unable to claim subagent ${run.runId}` });
      return;
    }
    if (run.result || TERMINAL.has(run.status)) {
      if (run.status === 'cancelled') {
        await this.config.taskStore.updateTaskStatus(run.runId, 'cancelled', {
          error: 'Subagent cancelled',
        });
      }
      return;
    }

    run.startedAt = task.startedAt ?? Date.now();
    run.status = 'running';
    const onAgentEvent = (event: AgentEvent) => {
      this.emit('subagent-progress', { runId: run.runId, event });
      if (event.type === 'tool_start') this.emitSubagentEvent(run.runId, 'tool_call', event);
      else this.emitSubagentEvent(run.runId, 'progress', event);
      void this.config.taskStore
        .appendEvent(run.runId, `agent-${event.type}`, event)
        .catch(error => console.error('Failed to persist subagent event:', error));
    };
    agent.on('event', onAgentEvent);

    try {
      await this.config.parentConfig.storage?.createSession(task.sessionId, 'Subtask');
      const output = await agent.submit(run.request.task, run.runId);
      const messages = agent.getMessages(true);
      this.finish(run, {
        status: 'completed',
        output,
        summary: summarize(output),
        iterations: messages.filter(message => message.role === 'assistant').length,
        toolCalls: countToolCalls(messages),
      });
    } catch (error: any) {
      this.finish(run, { status: 'failed', error: error?.message ?? String(error) });
    } finally {
      (agent as any).off?.('event', onAgentEvent);
      (agent as any).destroy?.();
    }
  }

  private finish(
    run: SubagentRun,
    outcome: {
      status: 'completed' | 'failed' | 'cancelled';
      output?: string;
      error?: string;
      summary?: string;
      iterations?: number;
      toolCalls?: number;
    },
  ): SubagentResult {
    if (run.result) return run.result;

    const finishedAt = Date.now();
    const startedAt = run.startedAt ?? run.createdAt;
    const result: SubagentResult = {
      runId: run.runId,
      status: outcome.status,
      output: outcome.output,
      error: outcome.error,
      summary: outcome.summary,
      stats: {
        startedAt,
        finishedAt,
        duration: finishedAt - startedAt,
        iterations: outcome.iterations ?? 0,
        toolCalls: outcome.toolCalls ?? 0,
      },
    };

    run.status = outcome.status;
    run.finishedAt = finishedAt;
    run.result = result;
    run.resolveDone(result);
    void this.config.taskStore.updateTaskStatus(run.runId, outcome.status, result)
      .catch(error => console.error('Failed to update subagent task:', error));

    if (outcome.status === 'completed') {
      this.emitSubagentEvent(run.runId, 'completed', result);
      this.emit('subagent-completed', { runId: run.runId, result });
    } else if (outcome.status === 'failed') {
      this.emitSubagentEvent(run.runId, 'error', { error: outcome.error });
      this.emit('subagent-failed', { runId: run.runId, error: outcome.error });
    }
    return result;
  }

  private async markStoredTaskFailed(runId: string, message: string): Promise<void> {
    const claimed = await this.config.taskStore.claimTask(runId, `subagent-${runId}`);
    if (claimed) {
      await this.config.taskStore.updateTaskStatus(runId, 'failed', { error: message });
    }
  }

  private getRun(runId: string): SubagentRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Subagent ${runId} not found`);
    return run;
  }

  private buildSystemPrompt(request: SubagentRequest): string {
    let prompt = 'You are a sub-agent delegated a specific subtask by a parent agent.\n\n';
    if (request.role) prompt += `Role: ${request.role}\n\n`;
    if (request.context?.summary) {
      prompt += `Context from parent agent:\n${request.context.summary}\n\n`;
    }
    if (request.context?.files?.length) {
      prompt += `Relevant files:\n${request.context.files.map(file => `- ${file}`).join('\n')}\n\n`;
    }
    prompt += 'Focus on completing this specific task efficiently. ';
    prompt += 'Avoid unnecessary exploration. ';
    prompt += 'When done, reply with a clear, self-contained summary of the result.';
    return prompt;
  }

  private emitSubagentEvent(runId: string, event: SubagentEventName, data: any): void {
    const listeners = this.eventListeners.get(runId)?.get(event);
    if (!listeners) return;
    listeners.forEach(listener => {
      try {
        listener(data);
      } catch (error) {
        console.error('Error in subagent event listener:', error);
      }
    });
  }
}

class DefaultToolPolicy implements ToolPolicy {
  filterTools(allTools: Tool[], allowedToolNames?: string[]): Tool[] {
    if (!allowedToolNames || allowedToolNames.length === 0) {
      return allTools.filter(tool => tool.meta?.readonly === true);
    }
    return allTools.filter(tool => allowedToolNames.includes(tool.name));
  }

  async checkToolCall(): Promise<boolean> {
    return true;
  }
}

function mapTaskStatus(status: TaskRecord['status']): SubagentStatus['status'] {
  if (status === 'queued' || status === 'paused') return 'pending';
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return status;
  return 'running';
}

function summarize(output: string): string {
  return output.length <= SUMMARY_MAX_LENGTH
    ? output
    : `${output.slice(0, SUMMARY_MAX_LENGTH)}... (truncated)`;
}

function countToolCalls(messages: ChatMessage[]): number {
  return messages.reduce((count, message) => count + (message.tool_calls?.length ?? 0), 0);
}

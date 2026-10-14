/**
 * Subagent Runtime 实现
 *
 * 职责：
 * - 创建和管理子 Agent 实例
 * - 独立状态隔离：子 Agent 有自己的会话与历史，不写父会话存储
 * - 生命周期控制（spawn/wait/cancel），终态只写一次（先到先得）
 * - 并发与递归深度限制
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { PlainAgent } from '../agent';
import type { AgentConfig, AgentEvent, Tool, ChatMessage } from '../types';
import type {
  SubagentRequest,
  SubagentResult,
  SubagentStatus,
  SubagentRun,
  SubagentRuntime as ISubagentRuntime,
  ToolPolicy,
  TaskStore,
} from './types';

type SubagentEventName = 'progress' | 'tool_call' | 'completed' | 'error';

export interface SubagentRuntimeConfig {
  /** Agent 工厂函数（用于创建子 Agent 实例） */
  agentFactory: (config: AgentConfig) => PlainAgent;

  /** 父 Agent 配置（复用 LLM 等）；tools 应为父 Agent 的基础工具，不含其自动追加的会话绑定工具 */
  parentConfig: AgentConfig;

  /** 可选的工具策略 */
  toolPolicy?: ToolPolicy;

  /** 可选的任务存储 */
  taskStore?: TaskStore;

  /** 最大并发子任务数（默认 5） */
  maxConcurrency?: number;

  /** 默认超时时间（毫秒，默认 5 分钟） */
  defaultTimeout?: number;

  /** 最大递归深度（默认 3） */
  maxDepth?: number;
}

const TERMINAL: ReadonlySet<SubagentStatus['status']> = new Set(['completed', 'failed', 'cancelled', 'timeout']);

/** 摘要截断长度（回注父 Agent 用） */
const SUMMARY_MAX_LENGTH = 500;

export class SubagentRuntime extends EventEmitter implements ISubagentRuntime {
  private config: Required<SubagentRuntimeConfig>;
  private runs = new Map<string, SubagentRun>();
  private eventListeners = new Map<string, Map<SubagentEventName, Set<(data: any) => void>>>();

  constructor(config: SubagentRuntimeConfig) {
    super();

    this.config = {
      agentFactory: config.agentFactory,
      parentConfig: config.parentConfig,
      toolPolicy: config.toolPolicy || new DefaultToolPolicy(),
      taskStore: config.taskStore || new MemoryTaskStore(),
      maxConcurrency: config.maxConcurrency ?? 5,
      defaultTimeout: config.defaultTimeout ?? 300000, // 5分钟
      maxDepth: config.maxDepth ?? 3,
    };
  }

  /**
   * 创建并启动子 Agent
   *
   * 校验与登记在同一同步段内完成（中间无 await），并发 spawn 不会越过上限。
   */
  async spawn(request: SubagentRequest): Promise<{ runId: string }> {
    // 父任务若是某个子 Agent（其 sessionId = runId），深度 = 父深度 + 1；否则为顶层
    const parent = this.runs.get(request.parentRunId);
    const depth = parent ? parent.depth + 1 : 0;
    if (depth >= this.config.maxDepth) {
      throw new Error(
        `Maximum recursion depth (${this.config.maxDepth}) exceeded. ` +
        `Current depth: ${depth}. Consider refactoring the task.`
      );
    }

    const activeCount = Array.from(this.runs.values()).filter(r => !TERMINAL.has(r.status)).length;
    if (activeCount >= this.config.maxConcurrency) {
      throw new Error(
        `Maximum concurrent subagents (${this.config.maxConcurrency}) reached. ` +
        `Please wait for some tasks to complete.`
      );
    }

    const runId = randomUUID();
    const tools = this.config.toolPolicy.filterTools(this.config.parentConfig.tools, request.tools);

    const agentConfig: AgentConfig = {
      llm: this.config.parentConfig.llm,
      tools,
      maxIterations: request.config?.maxIterations || 50,
      // sessionId = runId：子 Agent 再 spawn 时以此作为 parentRunId，深度可追溯
      sessionId: runId,
      // 不写父会话存储，避免在会话列表里产生孤立会话
      storage: undefined,
      // 不允许高于父 Agent 的权限
      permissionMode: request.config?.permissionMode ?? this.config.parentConfig.permissionMode,
      historyManagement: this.config.parentConfig.historyManagement,
      systemPrompt: this.buildSystemPrompt(request),
      // 下一层仍在深度限制内时共享本 runtime（并发/深度全局统一计算）
      subagentRuntime: depth + 1 < this.config.maxDepth ? this : undefined,
    };

    let resolveDone!: (r: SubagentResult) => void;
    const promise = new Promise<SubagentResult>((resolve) => { resolveDone = resolve; });

    const run: SubagentRun = {
      runId,
      request,
      status: 'pending',
      agent: undefined,
      promise,
      resolveDone,
      createdAt: Date.now(),
      depth,
    };
    this.runs.set(runId, run);

    try {
      run.agent = this.config.agentFactory(agentConfig);
    } catch (error: any) {
      this.finish(run, { status: 'failed', error: `Failed to create subagent: ${error.message}` });
      return { runId };
    }

    run.agent.on('event', (event: AgentEvent) => {
      this.emitSubagentEvent(runId, event.type === 'tool_start' ? 'tool_call' : 'progress', event);
    });

    this.config.taskStore.saveTask({
      runId,
      parentRunId: request.parentRunId,
      request,
      status: 'pending',
      createdAt: run.createdAt,
    }).catch(err => console.error('Failed to save subagent task:', err));

    this.emit('subagent-created', { runId, request, depth });

    void this.execute(run);

    return { runId };
  }

  /**
   * 等待子 Agent 完成；超时则终止子 Agent 并返回 timeout 结果
   */
  async wait(runId: string, timeout?: number): Promise<SubagentResult> {
    const run = this.getRun(runId);
    if (run.result) return run.result;

    const effectiveTimeout = timeout || this.config.defaultTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), effectiveTimeout);
    });

    try {
      const outcome = await Promise.race([run.promise, timeoutPromise]);
      if (outcome !== 'timeout') return outcome;

      run.agent?.stop();
      return this.finish(run, {
        status: 'timeout',
        error: `Subagent ${runId} timeout after ${effectiveTimeout}ms`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 取消子 Agent 执行（已结束则无操作）
   */
  async cancel(runId: string): Promise<void> {
    const run = this.getRun(runId);
    if (TERMINAL.has(run.status)) return;

    run.agent?.stop();
    this.finish(run, { status: 'cancelled' });
    this.emit('subagent-cancelled', { runId });
  }

  /**
   * 获取子 Agent 状态
   */
  async getStatus(runId: string): Promise<SubagentStatus> {
    const run = this.runs.get(runId);
    if (!run) {
      const stored = await this.config.taskStore.getTask(runId);
      if (stored) return stored;
      throw new Error(`Subagent ${runId} not found`);
    }

    return {
      runId,
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  }

  /**
   * 订阅子 Agent 事件（不复用 EventEmitter.on，避免签名冲突）
   */
  subscribeSubagent(runId: string, event: SubagentEventName, listener: (data: any) => void): void {
    if (!this.eventListeners.has(runId)) {
      this.eventListeners.set(runId, new Map());
    }
    const runListeners = this.eventListeners.get(runId)!;
    if (!runListeners.has(event)) {
      runListeners.set(event, new Set());
    }
    runListeners.get(event)!.add(listener);
  }

  /**
   * 取消订阅
   */
  unsubscribeSubagent(runId: string, event: SubagentEventName, listener: (data: any) => void): void {
    this.eventListeners.get(runId)?.get(event)?.delete(listener);
  }

  /**
   * 清理已结束的运行记录（内存管理用）
   */
  cleanup(runId: string): void {
    const run = this.runs.get(runId);
    if (run && !TERMINAL.has(run.status)) return;
    this.runs.delete(runId);
    this.eventListeners.delete(runId);
  }

  /**
   * 执行子 Agent。结束时若已被 cancel/timeout 抢先置为终态，finish 不会覆盖。
   */
  private async execute(run: SubagentRun): Promise<void> {
    const agent: PlainAgent = run.agent!;
    run.startedAt = Date.now();
    run.status = 'running';

    try {
      const output = await agent.submit(run.request.task);
      const messages = agent.getMessages(true);
      this.finish(run, {
        status: 'completed',
        output,
        summary: summarize(output),
        iterations: messages.filter(m => m.role === 'assistant').length,
        toolCalls: countToolCalls(messages),
      });
    } catch (error: any) {
      this.finish(run, { status: 'failed', error: error?.message ?? String(error) });
    } finally {
      agent.destroy();
    }
  }

  /**
   * 写入终态（只生效一次）并通知等待方
   */
  private finish(
    run: SubagentRun,
    outcome: {
      status: SubagentResult['status'];
      output?: string;
      error?: string;
      summary?: string;
      iterations?: number;
      toolCalls?: number;
    }
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

    this.config.taskStore.updateTaskStatus(run.runId, outcome.status, result)
      .catch(err => console.error('Failed to update subagent task:', err));

    if (outcome.status === 'completed') {
      this.emitSubagentEvent(run.runId, 'completed', result);
      this.emit('subagent-completed', { runId: run.runId, result });
    } else if (outcome.status === 'failed') {
      this.emitSubagentEvent(run.runId, 'error', { error: outcome.error });
      this.emit('subagent-failed', { runId: run.runId, error: outcome.error });
    }

    return result;
  }

  private getRun(runId: string): SubagentRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Subagent ${runId} not found`);
    return run;
  }

  /**
   * 构建子 Agent 的 system prompt（任务本身作为 user 消息提交，这里只放角色与上下文）
   */
  private buildSystemPrompt(request: SubagentRequest): string {
    let prompt = 'You are a sub-agent delegated a specific subtask by a parent agent.\n\n';

    if (request.role) {
      prompt += `Role: ${request.role}\n\n`;
    }

    if (request.context?.summary) {
      prompt += `Context from parent agent:\n${request.context.summary}\n\n`;
    }

    if (request.context?.files && request.context.files.length > 0) {
      prompt += `Relevant files:\n${request.context.files.map(f => `- ${f}`).join('\n')}\n\n`;
    }

    prompt += 'Focus on completing this specific task efficiently. ';
    prompt += 'Avoid unnecessary exploration. ';
    prompt += 'When done, reply with a clear, self-contained summary of the result — the parent agent only sees your final reply.';

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

function summarize(output: string): string {
  return output.length <= SUMMARY_MAX_LENGTH ? output : output.slice(0, SUMMARY_MAX_LENGTH) + '... (truncated)';
}

function countToolCalls(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + (m.tool_calls?.length ?? 0), 0);
}

// ============ 默认实现 ============

/**
 * 默认工具策略：基于白名单过滤；未指定白名单时只给显式标记为只读的工具
 */
class DefaultToolPolicy implements ToolPolicy {
  filterTools(allTools: Tool[], allowedToolNames?: string[]): Tool[] {
    if (!allowedToolNames || allowedToolNames.length === 0) {
      return allTools.filter(t => t.meta?.readonly === true);
    }
    return allTools.filter(t => allowedToolNames.includes(t.name));
  }

  async checkToolCall(): Promise<boolean> {
    return true;
  }
}

/**
 * 内存任务存储（简单实现）
 */
class MemoryTaskStore implements TaskStore {
  private tasks = new Map<string, any>();

  async saveTask(task: any): Promise<void> {
    this.tasks.set(task.runId, { ...task });
  }

  async updateTaskStatus(runId: string, status: string, result?: SubagentResult): Promise<void> {
    const task = this.tasks.get(runId);
    if (task) {
      task.status = status;
      task.result = result;
      task.startedAt = result?.stats?.startedAt;
      task.finishedAt = result?.stats?.finishedAt;
    }
  }

  async loadPendingTasks(parentRunId: string): Promise<SubagentRequest[]> {
    return Array.from(this.tasks.values())
      .filter(t => t.parentRunId === parentRunId && !TERMINAL.has(t.status))
      .map(t => t.request);
  }

  async getTaskHistory(parentRunId: string): Promise<SubagentResult[]> {
    return Array.from(this.tasks.values())
      .filter(t => t.parentRunId === parentRunId && t.result)
      .map(t => t.result);
  }

  async getTask(runId: string): Promise<SubagentStatus | null> {
    const task = this.tasks.get(runId);
    if (!task) return null;

    return {
      runId: task.runId,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
    };
  }
}

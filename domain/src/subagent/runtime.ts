/**
 * Subagent Runtime 实现
 *
 * 职责：
 * - 创建和管理子 Agent 实例
 * - 独立状态隔离
 * - 生命周期控制（spawn/wait/cancel）
 * - 事件传递和订阅
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { PlainAgent } from '../agent';
import type { AgentConfig, Tool, ChatMessage } from '../types';
import type {
  SubagentRequest,
  SubagentResult,
  SubagentStatus,
  SubagentRun,
  SubagentRuntime as ISubagentRuntime,
  ContextManager,
  ToolPolicy,
  TaskStore,
} from './types';

export interface SubagentRuntimeConfig {
  /** Agent 工厂函数（用于创建子 Agent 实例） */
  agentFactory: (config: AgentConfig) => PlainAgent;

  /** 父 Agent 配置（复用 LLM、存储等） */
  parentConfig: AgentConfig;

  /** 可选的上下文管理器 */
  contextManager?: ContextManager;

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

export class SubagentRuntime extends EventEmitter implements ISubagentRuntime {
  private config: Required<SubagentRuntimeConfig>;
  private runs = new Map<string, SubagentRun>();
  private eventListeners = new Map<string, Map<string, Set<Function>>>();

  constructor(config: SubagentRuntimeConfig) {
    super();

    this.config = {
      agentFactory: config.agentFactory,
      parentConfig: config.parentConfig,
      contextManager: config.contextManager || new DefaultContextManager(),
      toolPolicy: config.toolPolicy || new DefaultToolPolicy(),
      taskStore: config.taskStore || new MemoryTaskStore(),
      maxConcurrency: config.maxConcurrency ?? 5,
      defaultTimeout: config.defaultTimeout ?? 300000, // 5分钟
      maxDepth: config.maxDepth ?? 3,
    };
  }

  /**
   * 创建并启动子 Agent
   */
  async spawn(request: SubagentRequest): Promise<{ runId: string }> {
    const runId = randomUUID();

    // 计算递归深度
    const depth = await this.calculateDepth(request.parentRunId);
    if (depth >= this.config.maxDepth) {
      throw new Error(
        `Maximum recursion depth (${this.config.maxDepth}) exceeded. ` +
        `Current depth: ${depth}. Consider refactoring the task.`
      );
    }

    // 检查并发限制
    const runningCount = Array.from(this.runs.values()).filter(
      r => r.status === 'running'
    ).length;

    if (runningCount >= this.config.maxConcurrency) {
      throw new Error(
        `Maximum concurrent subagents (${this.config.maxConcurrency}) reached. ` +
        `Please wait for some tasks to complete.`
      );
    }

    // 准备子 Agent 的工具列表
    const tools = this.config.toolPolicy.filterTools(
      this.config.parentConfig.tools,
      request.tools
    );

    // 准备子 Agent 的上下文
    const context = await this.prepareContext(request);

    // 创建 AbortController
    const abortController = new AbortController();

    // 创建子 Agent 实例
    const agentConfig: AgentConfig = {
      llm: this.config.parentConfig.llm,
      tools,
      maxIterations: request.config?.maxIterations || 50,
      storage: this.config.parentConfig.storage,
      permissionMode: request.config?.permissionMode || 'standard',
      historyManagement: this.config.parentConfig.historyManagement,
      systemPrompt: this.buildSystemPrompt(request),
    };

    const agent = this.config.agentFactory(agentConfig);

    // 加载上下文到子 Agent
    if (context.length > 0) {
      // 直接注入准备好的上下文消息
      (agent as any).fullMessages = context;
    }

    // 订阅子 Agent 事件
    agent.on('event', (event) => {
      this.emitSubagentEvent(runId, event.type, event);
    });

    const createdAt = Date.now();

    // 创建执行 Promise
    const promise = this.executeSubagent(
      runId,
      agent,
      request,
      abortController,
      depth
    );

    // 保存运行状态
    const run: SubagentRun = {
      runId,
      request,
      status: 'pending',
      agent,
      abortController,
      promise,
      createdAt,
      depth,
    };

    this.runs.set(runId, run);

    // 持久化任务
    await this.config.taskStore.saveTask({
      runId,
      parentRunId: request.parentRunId,
      request,
      status: 'pending',
      createdAt,
    });

    // 发射创建事件
    this.emit('subagent-created', { runId, request, depth });

    return { runId };
  }

  /**
   * 等待子 Agent 完成
   */
  async wait(runId: string, timeout?: number): Promise<SubagentResult> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Subagent ${runId} not found`);
    }

    const effectiveTimeout = timeout || this.config.defaultTimeout;

    // 创建超时 Promise
    const timeoutPromise = new Promise<SubagentResult>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Subagent ${runId} timeout after ${effectiveTimeout}ms`));
      }, effectiveTimeout);
    });

    try {
      // 竞速：任务完成 vs 超时
      const result = await Promise.race([run.promise, timeoutPromise]);
      return result;
    } catch (error: any) {
      // 超时或其他错误
      if (error.message.includes('timeout')) {
        await this.cancel(runId);

        const result: SubagentResult = {
          runId,
          status: 'timeout',
          error: error.message,
          stats: {
            startedAt: run.startedAt || run.createdAt,
            finishedAt: Date.now(),
            duration: Date.now() - (run.startedAt || run.createdAt),
            iterations: 0,
            toolCalls: 0,
          },
        };

        run.result = result;
        run.status = 'timeout';

        await this.config.taskStore.updateTaskStatus(runId, 'timeout', result);

        return result;
      }

      throw error;
    }
  }

  /**
   * 取消子 Agent 执行
   */
  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Subagent ${runId} not found`);
    }

    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return; // 已结束，无需取消
    }

    // 触发中断
    run.abortController.abort();
    run.agent.stop();

    run.status = 'cancelled';
    run.finishedAt = Date.now();

    const result: SubagentResult = {
      runId,
      status: 'cancelled',
      stats: {
        startedAt: run.startedAt || run.createdAt,
        finishedAt: Date.now(),
        duration: Date.now() - (run.startedAt || run.createdAt),
        iterations: 0,
        toolCalls: 0,
      },
    };

    run.result = result;

    await this.config.taskStore.updateTaskStatus(runId, 'cancelled', result);

    this.emit('subagent-cancelled', { runId });
  }

  /**
   * 获取子 Agent 状态
   */
  async getStatus(runId: string): Promise<SubagentStatus> {
    const run = this.runs.get(runId);
    if (!run) {
      // 尝试从存储加载
      const stored = await this.config.taskStore.getTask(runId);
      if (stored) {
        return stored;
      }
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
   * 订阅子 Agent 事件（重命名以避免与 EventEmitter.on 冲突）
   */
  subscribeSubagent(
    runId: string,
    event: 'progress' | 'tool_call' | 'completed' | 'error',
    listener: (data: any) => void
  ): void {
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
   * 取消订阅（重命名以避免与 EventEmitter.off 冲突）
   */
  unsubscribeSubagent(
    runId: string,
    event: 'progress' | 'tool_call' | 'completed' | 'error',
    listener: (data: any) => void
  ): void {
    const runListeners = this.eventListeners.get(runId);
    if (!runListeners) return;

    const listeners = runListeners.get(event);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  /**
   * 执行子 Agent（内部方法）
   */
  private async executeSubagent(
    runId: string,
    agent: PlainAgent,
    request: SubagentRequest,
    abortController: AbortController,
    depth: number
  ): Promise<SubagentResult> {
    const run = this.runs.get(runId)!;
    const startedAt = Date.now();
    run.startedAt = startedAt;
    run.status = 'running';

    try {
      // 执行任务
      const output = await agent.submit(request.task);

      const finishedAt = Date.now();
      run.finishedAt = finishedAt;
      run.status = 'completed';

      // 获取执行统计
      const messages = agent.getMessages(true);
      const toolCalls = messages.filter(m => m.role === 'assistant' && m.tool_calls).length;

      // 生成摘要
      const summary = await this.generateSummary(output, messages);

      const result: SubagentResult = {
        runId,
        status: 'completed',
        output,
        summary,
        stats: {
          startedAt,
          finishedAt,
          duration: finishedAt - startedAt,
          iterations: messages.filter(m => m.role === 'assistant').length,
          toolCalls,
        },
      };

      run.result = result;

      // 持久化结果
      await this.config.taskStore.updateTaskStatus(runId, 'completed', result);

      // 发射完成事件
      this.emitSubagentEvent(runId, 'completed', result);
      this.emit('subagent-completed', { runId, result });

      // 清理
      agent.destroy();

      return result;
    } catch (error: any) {
      const finishedAt = Date.now();
      run.finishedAt = finishedAt;
      run.status = 'failed';
      run.error = error;

      const result: SubagentResult = {
        runId,
        status: 'failed',
        error: error.message,
        stats: {
          startedAt,
          finishedAt,
          duration: finishedAt - startedAt,
          iterations: 0,
          toolCalls: 0,
        },
      };

      run.result = result;

      // 持久化错误
      await this.config.taskStore.updateTaskStatus(runId, 'failed', result);

      // 发射错误事件
      this.emitSubagentEvent(runId, 'error', { error: error.message });
      this.emit('subagent-failed', { runId, error });

      // 清理
      agent.destroy();

      return result;
    }
  }

  /**
   * 准备子 Agent 上下文
   */
  private async prepareContext(request: SubagentRequest): Promise<ChatMessage[]> {
    // 获取父 Agent 的消息（如果需要）
    const parentMessages: ChatMessage[] = [];

    // 使用 ContextManager 准备上下文
    return await this.config.contextManager.prepareSubagentContext(
      parentMessages,
      request
    );
  }

  /**
   * 构建子 Agent 的 system prompt
   */
  private buildSystemPrompt(request: SubagentRequest): string {
    let prompt = 'You are an AI assistant helping with a specific subtask.\n\n';

    if (request.role) {
      prompt += `Role: ${request.role}\n\n`;
    }

    prompt += `Task: ${request.task}\n\n`;

    if (request.context?.summary) {
      prompt += `Context:\n${request.context.summary}\n\n`;
    }

    if (request.context?.files && request.context.files.length > 0) {
      prompt += `Relevant files:\n${request.context.files.map(f => `- ${f}`).join('\n')}\n\n`;
    }

    prompt += 'Focus on completing this specific task efficiently. ';
    prompt += 'Avoid unnecessary exploration. ';
    prompt += 'When done, provide a clear summary of what was accomplished.';

    return prompt;
  }

  /**
   * 生成执行摘要
   */
  private async generateSummary(output: string, messages: ChatMessage[]): Promise<string> {
    // 简单版本：截断输出
    const maxLength = 500;
    if (output.length <= maxLength) {
      return output;
    }

    return output.slice(0, maxLength) + '... (truncated)';
  }

  /**
   * 计算递归深度
   */
  private async calculateDepth(parentRunId: string): Promise<number> {
    let depth = 0;
    let currentId = parentRunId;

    // 向上追溯父任务链
    while (currentId) {
      const run = this.runs.get(currentId);
      if (!run) break;

      depth++;
      currentId = run.request.parentRunId;

      // 防止无限循环
      if (depth > 100) {
        throw new Error('Circular subagent dependency detected');
      }
    }

    return depth;
  }

  /**
   * 发射子 Agent 事件给订阅者
   */
  private emitSubagentEvent(runId: string, event: string, data: any): void {
    const runListeners = this.eventListeners.get(runId);
    if (!runListeners) return;

    const listeners = runListeners.get(event as any);
    if (!listeners) return;

    listeners.forEach(listener => {
      try {
        listener(data);
      } catch (error) {
        console.error(`Error in subagent event listener:`, error);
      }
    });
  }

  /**
   * 清理已完成的运行状态（可选，用于内存管理）
   */
  cleanup(runId: string): void {
    this.runs.delete(runId);
    this.eventListeners.delete(runId);
  }
}

// ============ 默认实现 ============

/**
 * 默认上下文管理器：简单传递
 */
class DefaultContextManager implements ContextManager {
  async prepareSubagentContext(
    parentMessages: any[],
    request: SubagentRequest
  ): Promise<any[]> {
    const messages: ChatMessage[] = [];

    // 添加 system prompt（由 Runtime 构建）
    // messages.push({
    //   role: 'system',
    //   content: '...' // 由 buildSystemPrompt 处理
    // });

    // 如果有上下文摘要，添加为 user 消息
    if (request.context?.summary) {
      messages.push({
        role: 'user',
        content: `Context: ${request.context.summary}`,
      });
    }

    return messages;
  }

  injectResult(parentMessages: any[], result: SubagentResult): any[] {
    // 简单追加结果
    const summary = result.summary || result.output || 'Task completed';

    parentMessages.push({
      role: 'user',
      content: `[Subagent ${result.runId}] ${summary}`,
    });

    return parentMessages;
  }
}

/**
 * 默认工具策略：基于白名单过滤
 */
class DefaultToolPolicy implements ToolPolicy {
  filterTools(allTools: Tool[], allowedToolNames?: string[]): Tool[] {
    if (!allowedToolNames || allowedToolNames.length === 0) {
      // 默认：只允许只读工具
      return allTools.filter(t => t.meta?.readonly !== false);
    }

    return allTools.filter(t => allowedToolNames.includes(t.name));
  }

  async checkToolCall(
    toolName: string,
    args: any,
    context: { parentRunId: string; depth: number }
  ): Promise<boolean> {
    // 默认：允许所有通过白名单的工具
    return true;
  }
}

/**
 * 内存任务存储（简单实现）
 */
class MemoryTaskStore implements TaskStore {
  private tasks = new Map<string, any>();

  async saveTask(task: any): Promise<void> {
    this.tasks.set(task.runId, task);
  }

  async updateTaskStatus(runId: string, status: string, result?: SubagentResult): Promise<void> {
    const task = this.tasks.get(runId);
    if (task) {
      task.status = status;
      task.result = result;
      task.updatedAt = Date.now();
    }
  }

  async loadPendingTasks(parentRunId: string): Promise<SubagentRequest[]> {
    return Array.from(this.tasks.values())
      .filter(t => t.parentRunId === parentRunId && t.status !== 'completed' && t.status !== 'failed')
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

/**
 * Agent 主类（事件发射器）
 *
 * 核心职责：
 * 1. 任务管理：接收任务提交，执行 ReAct 循环，返回结果
 * 2. 生命周期控制：支持多任务并发，按任务 ID 精确停止
 * 3. 事件发射：将执行过程中的事件（思考、工具调用、结果等）发射出去
 * 4. 权限管理：根据配置的权限模式检查工具执行权限
 * 5. 会话存储：可选地将消息和事件持久化到存储后端
 *
 * 设计特点：
 * - 完全独立于运行环境（不依赖 Electron、HTTP 等）
 * - 基于 Node.js EventEmitter 实现事件驱动
 * - 支持依赖注入（storage、tools 由外部提供）
 * - 使用 AbortController 实现可取消的任务执行
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { agentLoop } from './loop';
import { HistoryManager } from './history-manager';
import { createHistoryLookupTool, createHistorySearchTool } from './tools/history-lookup';
import { JobRegistry } from './tools/jobs';
import type {
  AgentConfig,
  AgentEvent,
  ChatMessage,
  SessionStorage,
  ToolContext,
  PermissionContext
} from './types';

export class PlainAgent extends EventEmitter {
  // 任务控制器映射：taskId -> AbortController
  // 用于多任务并发管理，每个任务有独立的取消控制
  private taskControllers = new Map<string, AbortController>();

  // 完整的消息历史（永不删除，用于追溯）
  private fullMessages: ChatMessage[] = [];

  // 用于发送给 LLM 的压缩版本（按需生成）
  private compressedMessages: ChatMessage[] | null = null;

  // 可选的存储后端（用于持久化消息和事件）
  private storage: SessionStorage | null;

  // 会话 ID（一个 Agent 实例对应一个会话）
  private sessionId: string;

  // Agent 配置（LLM、工具、最大迭代次数等）
  private config: AgentConfig;

  // 权限上下文（权限模式 + 会话级缓存）
  private permissionContext: PermissionContext;

  // 消息历史管理器
  private historyManager: HistoryManager;

  // bash 后台任务注册表
  private jobs = new JobRegistry();

  /**
   * 构造函数
   *
   * @param config Agent 配置对象
   *
   * 初始化流程：
   * 1. 设置配置（LLM、工具列表、最大迭代次数等）
   * 2. 初始化存储后端（可选）
   * 3. 生成或使用提供的会话 ID
   * 4. 初始化权限上下文（模式 + 缓存）
   * 5. 初始化消息历史管理器
   * 6. 自动注册历史追溯工具（如果启用了历史管理）
   *
   * 注意：构造函数不会自动加载历史消息，需要手动调用 loadHistory()
   */
  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.storage = config.storage || null;
    this.sessionId = config.sessionId || randomUUID();
    this.permissionContext = {
      mode: config.permissionMode || 'standard',
      sessionCache: new Set(), // 用于缓存已授权的工具调用
    };

    // 初始化历史管理器
    this.historyManager = new HistoryManager({
      enabled: config.historyManagement?.enabled ?? true,
      maxTokens: config.historyManagement?.maxTokens,
      maxToolOutputLength: config.historyManagement?.maxToolOutputLength,
      keepRecentMessages: config.historyManagement?.keepRecentMessages,
      compressionThreshold: config.historyManagement?.compressionThreshold,
      aggressiveThreshold: config.historyManagement?.aggressiveThreshold,
    });

    // 如果启用了历史管理，自动注册历史追溯工具
    if (this.historyManager && config.historyManagement?.enabled !== false) {
      const lookupTool = createHistoryLookupTool(() => this.fullMessages);
      const searchTool = createHistorySearchTool(() => this.fullMessages);

      // 添加到工具列表
      this.config.tools = [...this.config.tools, lookupTool, searchTool];
    }
  }

  /**
   * 从存储加载历史消息
   *
   * @returns Promise<number> 加载的消息数量
   *
   * 使用场景：
   * - 恢复之前的会话
   * - 应用重启后继续对话
   *
   * 注意：
   * - 加载的是完整历史（未压缩）
   * - 会清空当前的 fullMessages 和 compressedMessages
   * - 如果没有配置 storage，直接返回 0
   */
  async loadHistory(): Promise<number> {
    if (!this.storage) {
      return 0;
    }

    try {
      const messages = await this.storage.loadMessages(this.sessionId);
      this.fullMessages = messages;
      this.compressedMessages = null; // 清空压缩缓存
      return messages.length;
    } catch (error) {
      console.error('Failed to load history:', error);
      return 0;
    }
  }

  /**
   * 提交任务给 Agent 执行
   *
   * @param task 任务描述（用户的自然语言请求）
   * @param taskId 可选的任务 ID，不提供则自动生成 UUID
   * @returns Promise<string> 任务执行结果
   *
   * 执行流程：
   * 1. 生成或使用提供的任务 ID
   * 2. 创建该任务专属的 AbortController（支持多任务并发）
   * 3. 构建工具上下文（包含 signal、事件发射器、存储、权限检查）
   * 4. 发射 task-start 事件
   * 5. 调用 agentLoop 执行 ReAct 循环（LLM 推理 + 工具调用）
   * 6. 保存消息历史到存储（如果配置了 storage）
   * 7. 发射 task-end 事件
   * 8. 返回最终结果
   * 9. finally 块：清理该任务的 AbortController
   *
   * 异常处理：
   * - 捕获任何错误，序列化后发射 error 事件，然后重新抛出
   * - 调用者可以通过监听 'event' 事件来获取错误信息
   *
   * 多任务支持：
   * - 同一个 Agent 实例可以并发执行多个任务
   * - 每个任务有独立的 AbortController，互不干扰
   * - 可以通过 taskId 精确停止特定任务
   */
  async submit(task: string, taskId?: string): Promise<string> {
    // 生成任务 ID
    const id = taskId || randomUUID();

    // 创建该任务的中断控制器
    const abortController = new AbortController();
    this.taskControllers.set(id, abortController);

    // 构建工具上下文
    const ctx: ToolContext = {
      signal: abortController.signal, // 用于取消任务执行
      sessionId: this.sessionId,
      emitEvent: (event: AgentEvent) => this.emitEvent(event), // 事件发射器
      storage: this.storage || undefined,
      permissionCheck: async (tool, args) => {
        return await this.checkPermission(tool, args); // 权限检查回调
      },
      jobs: this.jobs, // bash 后台任务注册表
    };

    // 发射任务开始事件
    this.emitEvent({
      type: 'task-start',
      taskId: id,
      task,
      timestamp: Date.now()
    });

    try {
      // 准备发送给 LLM 的消息（可能是压缩版本）
      let messagesToSend = this.fullMessages;

      // 在执行前检查并压缩消息历史
      if (this.historyManager.shouldCompress(this.fullMessages)) {
        // 获取会话健康状况
        const health = this.historyManager.getSessionHealth(this.fullMessages);

        this.emitEvent({
          type: 'thinking',
          content: `检测到压缩触发条件：${health.reason.join('；')}`,
          timestamp: Date.now()
        });

        // 生成压缩版本（不修改 fullMessages）
        const result = await this.historyManager.compress(
          this.fullMessages,
          this.config.llm,
          abortController.signal
        );

        messagesToSend = result.compressed;
        this.compressedMessages = messagesToSend;

        // 发射压缩事件
        const usage = this.historyManager.getTokenUsage(messagesToSend);
        this.emitEvent({
          type: 'compression',
          level: result.level as 1 | 2 | 3,
          tokensBefore: result.health.tokenUsage,
          tokensAfter: usage.tokens,
          timestamp: Date.now()
        });

        // 检查退场警告
        if (result.warning === 'session-too-long') {
          this.emitEvent({
            type: 'session-warning',
            reason: 'too-long',
            suggestion: '会话过长，多次触发第三层压缩。建议：1) 开启新会话 2) 转人工处理 3) 拆分任务',
            timestamp: Date.now()
          });
        } else if (result.health.repetitionScore >= 0.4) {
          // 检测到严重重复行为
          this.emitEvent({
            type: 'session-warning',
            reason: 'frequent-compression',
            suggestion: `检测到重复行为（${(result.health.repetitionScore * 100).toFixed(0)}%），Agent 可能陷入困境。建议检查任务或转人工处理。`,
            timestamp: Date.now()
          });
        }

        this.emitEvent({
          type: 'thinking',
          content: `压缩完成（Level ${result.level}），当前 ${usage.tokens} tokens (${usage.percentage.toFixed(1)}%)`,
          timestamp: Date.now()
        });
      }

      // 执行 ReAct 循环（核心逻辑在 loop.ts）
      // 注意：messagesToSend 会被 agentLoop 修改，添加新消息
      const result = await agentLoop(
        task,
        messagesToSend,
        ctx,
        this.config.tools,
        this.config.maxIterations || 150
      );

      // 将新增的消息同步到 fullMessages
      // agentLoop 会在 messagesToSend 末尾添加新消息
      const newMessagesCount = messagesToSend.length - this.fullMessages.length;
      const newMessages: ChatMessage[] = [];

      if (newMessagesCount > 0) {
        const msgs = messagesToSend.slice(-newMessagesCount);
        this.fullMessages.push(...msgs);
        newMessages.push(...msgs);
      }

      // 使压缩缓存失效（因为有新消息了）
      this.compressedMessages = null;

      // 保存消息到存储（保存完整版本，不是压缩版本）
      if (this.storage && newMessages.length > 0) {
        for (const msg of newMessages) {
          await this.storage.saveMessage(this.sessionId, msg);
        }
      }

      // 发射任务完成事件
      this.emitEvent({
        type: 'task-end',
        taskId: id,
        timestamp: Date.now()
      });

      return result.result;
    } catch (error) {
      // 处理错误
      const serializedError = this.serializeError(error);
      this.emitEvent({
        type: 'error',
        error: serializedError,
        timestamp: Date.now()
      });
      throw error;
    } finally {
      // 清理该任务的控制器（无论成功、失败还是取消）
      this.taskControllers.delete(id);
    }
  }

  /**
   * 停止任务执行
   *
   * @param taskId 可选的任务 ID，不提供则停止所有任务
   *
   * 工作原理：
   * - 调用 AbortController.abort()，将对应的 signal.aborted 设为 true
   * - loop.ts 中会在多个检查点检测 signal.aborted
   * - 工具开发者需要在长时间操作中主动检查 ctx.signal.aborted
   *
   * 行为：
   * - 提供 taskId：仅停止该任务，其他任务继续运行
   * - 不提供 taskId：停止所有正在运行的任务
   *
   * 注意：
   * - 这是"请求取消"而非"强制杀死"
   * - 实际停止时机取决于代码中检查点的位置
   * - 同步密集计算或未检查 signal 的工具可能无法立即停止
   *
   * @see docs/cancellation-guide.md 取消机制详细说明
   */
  stop(taskId?: string): void {
    if (taskId) {
      // 停止特定任务
      const controller = this.taskControllers.get(taskId);
      if (controller) {
        controller.abort();
        this.taskControllers.delete(taskId);
      }
    } else {
      // 停止所有任务
      this.taskControllers.forEach(controller => controller.abort());
      this.taskControllers.clear();
    }
  }

  /**
   * 销毁 Agent（清理资源）
   *
   * 执行步骤：
   * 1. 调用 stop() 停止所有正在运行的任务
   * 2. 移除所有事件监听器（防止内存泄漏）
   *
   * 使用场景：
   * - 应用退出前清理资源
   * - 不再需要该 Agent 实例时
   *
   * 注意：
   * - 销毁后该实例不应再被使用
   * - 存储后端不会被关闭（由外部管理）
   */
  destroy(): void {
    this.stop(); // 停止所有任务
    this.jobs.killAll(); // 终止所有后台任务
    this.removeAllListeners();
  }

  /**
   * 获取当前运行的任务 ID 列表
   *
   * @returns string[] 正在运行的任务 ID 数组
   *
   * 用途：
   * - 监控 Agent 状态
   * - UI 显示当前任务列表
   * - 调试和日志记录
   */
  getRunningTasks(): string[] {
    return Array.from(this.taskControllers.keys());
  }

  /**
   * 获取当前会话 ID
   *
   * @returns string 会话 ID（UUID 格式）
   *
   * 用途：
   * - 跨组件传递会话标识
   * - 查询存储中的会话数据
   * - 日志记录和跟踪
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * 获取会话消息历史
   *
   * @param full 是否返回完整版本（默认 false，返回压缩版本）
   * @returns ChatMessage[] 消息数组的副本（防止外部修改）
   *
   * 消息类型：
   * - user: 用户输入
   * - assistant: LLM 响应
   * - tool: 工具执行结果
   * - system: 系统提示（如果有）
   *
   * 注意：
   * - 返回的是副本，修改不会影响内部状态
   * - full=false: 返回发送给 LLM 的版本（可能被压缩）
   * - full=true: 返回完整历史（用于追溯、调试）
   */
  getMessages(full = false): ChatMessage[] {
    if (full) {
      return [...this.fullMessages];
    }
    // 如果有压缩缓存，返回压缩版本；否则返回完整版本
    return [...(this.compressedMessages || this.fullMessages)];
  }

  /**
   * 获取消息历史的 token 使用情况
   *
   * @param useCompressed 是否基于压缩版本计算（默认 true）
   * @returns 包含 tokens、百分比、是否需要压缩等信息
   */
  getHistoryUsage(useCompressed = true) {
    const messages = useCompressed
      ? (this.compressedMessages || this.fullMessages)
      : this.fullMessages;
    return this.historyManager.getTokenUsage(messages);
  }

  /**
   * 手动触发消息历史压缩
   *
   * @param useQuickMode 是否使用快速模式（仅第一层，不调用 LLM）
   * @returns Promise<void>
   *
   * 使用场景：
   * - 用户主动要求清理历史
   * - 在长时间任务前预先压缩
   * - 测试压缩效果
   *
   * 注意：
   * - 压缩不会修改 fullMessages
   * - 仅更新 compressedMessages 缓存
   */
  async compressHistory(useQuickMode = false): Promise<void> {
    if (useQuickMode) {
      this.compressedMessages = this.historyManager.compressQuick(this.fullMessages);
    } else {
      const result = await this.historyManager.compress(
        this.fullMessages,
        this.config.llm
      );
      this.compressedMessages = result.compressed;
    }
  }

  /**
   * 获取特定消息的完整内容（追溯工具输出）
   *
   * @param index 消息在完整历史中的索引
   * @returns ChatMessage | undefined
   *
   * 使用场景：
   * - LLM 提到了某个工具调用的结果，但压缩版本中被截断
   * - 用户要求查看完整的日志、API 响应等
   * - 调试和审计
   */
  getFullMessage(index: number): ChatMessage | undefined {
    return this.fullMessages[index];
  }

  /**
   * 搜索完整历史中的工具输出
   *
   * @param toolName 工具名称
   * @param searchText 可选的搜索文本
   * @returns 匹配的消息及其索引
   */
  searchToolOutputs(toolName?: string, searchText?: string): Array<{ index: number; message: ChatMessage }> {
    const results: Array<{ index: number; message: ChatMessage }> = [];

    this.fullMessages.forEach((msg, index) => {
      if (msg.role !== 'tool') return;

      // 如果指定了工具名，需要从前一条 assistant 消息获取
      if (toolName) {
        const prevMsg = this.fullMessages[index - 1];
        if (!prevMsg?.tool_calls?.some(tc => tc.function.name === toolName)) {
          return;
        }
      }

      // 如果指定了搜索文本
      if (searchText && !msg.content?.includes(searchText)) {
        return;
      }

      results.push({ index, message: msg });
    });

    return results;
  }

  /**
   * 发射事件（类型安全）
   *
   * @param event AgentEvent 联合类型，包含所有可能的事件
   *
   * 事件类型：
   * - user: 用户消息
   * - task-start: 任务开始
   * - task-end: 任务完成
   * - iteration: ReAct 循环迭代
   * - thinking: LLM 思考中
   * - tool_start: 工具开始执行
   * - tool_result: 工具执行结果
   * - assistant: LLM 响应
   * - error: 错误发生
   * - done: 任务完成
   * - stopped: 任务被停止
   *
   * 执行流程：
   * 1. 如果配置了 storage，异步保存事件到存储
   * 2. 通过 EventEmitter 发射 'event' 事件
   *
   * 注意：
   * - 存储失败不会影响事件发射（仅打印错误）
   * - 外部通过 agent.on('event', handler) 监听
   */
  private emitEvent(event: AgentEvent): void {
    // 保存事件到存储
    if (this.storage) {
      this.storage.saveEvent(this.sessionId, event).catch(err => {
        console.error('Failed to save event:', err);
      });
    }

    // 发射事件
    this.emit('event', event);
  }

  /**
   * 权限检查
   *
   * @param tool 要执行的工具
   * @param args 工具参数
   * @returns Promise<boolean> true=允许执行，false=拒绝执行
   *
   * 权限模式：
   * 1. trust: 完全信任，所有工具无条件允许
   * 2. standard: 标准模式
   *    - 非危险工具：直接允许
   *    - 危险工具：进行简单检测（如 bash 命令中的危险关键词）
   * 3. ask: 询问模式
   *    - 危险工具需要外部确认（当前实现返回 false，TODO: 实现确认机制）
   *
   * 会话缓存：
   * - 已授权的工具调用会被缓存（工具名 + 参数的组合）
   * - 相同的调用在会话内只需授权一次
   * - 缓存的 key 格式："{toolName}:{JSON.stringify(args)}"
   *
   * 危险工具判断：
   * - 通过 tool.meta.dangerous 标记
   * - bash 工具额外检查命令中的危险关键词
   *
   * TODO:
   * - 实现更完善的权限确认机制（通过事件或回调）
   * - 支持更细粒度的权限规则配置
   * - 支持持久化的权限策略
   */
  private async checkPermission(tool: any, args: any): Promise<boolean> {
    const mode = this.permissionContext.mode;

    // trust 模式：全部允许
    if (mode === 'trust') {
      return true;
    }

    // 非危险操作：直接允许
    if (!tool.meta?.dangerous) {
      return true;
    }

    // 检查会话缓存
    const cacheKey = `${tool.name}:${JSON.stringify(args)}`;
    if (this.permissionContext.sessionCache.has(cacheKey)) {
      return true;
    }

    // ask 模式：需要询问用户（通过事件通知）
    if (mode === 'ask') {
      // 发射权限请求事件，外部适配器负责处理
      // 这里先返回 false，实际应该等待外部确认
      // TODO: 实现更完善的权限确认机制
      return false;
    }

    // standard 模式：危险命令需要确认
    if (tool.name === 'bash') {
      // 简单的危险命令检测
      const cmd = args.command || '';
      const dangerous = ['rm -rf', 'format', 'del /f', ':(){:|:&};:'];
      const isDangerous = dangerous.some(d => cmd.includes(d));

      if (isDangerous) {
        return false;
      }
    }

    return true;
  }

  /**
   * 序列化错误对象
   *
   * @param error 任意类型的错误（Error 对象或其他值）
   * @returns 序列化后的错误对象（包含 name, message, stack）
   *
   * 用途：
   * - 将错误转换为可 JSON 序列化的格式
   * - 用于事件发射和存储
   * - 保留堆栈信息用于调试
   *
   * 处理逻辑：
   * - Error 实例：提取 name, message, stack
   * - 其他类型：标记为 UnknownError，转字符串作为 message
   */
  private serializeError(error: unknown): { name: string; message: string; stack?: string } {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }
    return {
      name: 'UnknownError',
      message: String(error),
    };
  }

  /**
   * 类型安全的事件监听（重载 EventEmitter 方法）
   *
   * 限制事件名称为 'event'，listener 参数类型为 AgentEvent
   * 这样可以在编译时检查事件监听器的类型正确性
   *
   * 使用示例：
   * ```typescript
   * agent.on('event', (event) => {
   *   if (event.type === 'tool_start') {
   *     console.log(`工具 ${event.tool} 开始执行`);
   *   }
   * });
   * ```
   */
  on(event: 'event', listener: (event: AgentEvent) => void): this {
    return super.on(event, listener);
  }

  /**
   * 类型安全的一次性事件监听
   *
   * 监听器只会被触发一次，然后自动移除
   */
  once(event: 'event', listener: (event: AgentEvent) => void): this {
    return super.once(event, listener);
  }

  /**
   * 类型安全的事件监听器移除
   *
   * 移除指定的监听器函数
   */
  off(event: 'event', listener: (event: AgentEvent) => void): this {
    return super.off(event, listener);
  }
}

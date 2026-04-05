/**
 * Agent 主类（事件发射器）
 * 完全独立，基于 Node.js EventEmitter
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { agentLoop } from './loop';
import type {
  AgentConfig,
  AgentEvent,
  ChatMessage,
  SessionStorage,
  ToolContext,
  PermissionContext
} from './types';

export class PlainAgent extends EventEmitter {
  private abortController: AbortController | null = null;
  private messages: ChatMessage[] = [];
  private storage: SessionStorage | null;
  private sessionId: string;
  private config: AgentConfig;
  private permissionContext: PermissionContext;

  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.storage = config.storage || null;
    this.sessionId = config.sessionId || randomUUID();
    this.permissionContext = {
      mode: config.permissionMode || 'standard',
      sessionCache: new Set(),
    };
  }

  /**
   * 提交任务给 Agent 执行
   */
  async submit(task: string): Promise<string> {
    // 创建新的中断控制器
    this.abortController = new AbortController();

    // 构建工具上下文
    const ctx: ToolContext = {
      signal: this.abortController.signal,
      sessionId: this.sessionId,
      emitEvent: (event: AgentEvent) => this.emitEvent(event),
      storage: this.storage || undefined,
      permissionCheck: async (tool, args) => {
        return await this.checkPermission(tool, args);
      },
    };

    try {
      // 执行 ReAct 循环
      const result = await agentLoop(
        task,
        this.messages,
        ctx,
        this.config.tools,
        this.config.maxIterations || 150
      );

      // 保存消息到存储
      if (this.storage) {
        for (const msg of result.messages) {
          await this.storage.saveMessage(this.sessionId, msg);
        }
      }

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
    }
  }

  /**
   * 停止当前执行
   */
  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * 销毁 Agent（清理资源）
   */
  destroy(): void {
    this.stop();
    this.removeAllListeners();
  }

  /**
   * 获取当前会话 ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * 获取会话消息历史
   */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /**
   * 发射事件（类型安全）
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
   * 类型安全的事件监听
   */
  on(event: 'event', listener: (event: AgentEvent) => void): this {
    return super.on(event, listener);
  }

  once(event: 'event', listener: (event: AgentEvent) => void): this {
    return super.once(event, listener);
  }

  off(event: 'event', listener: (event: AgentEvent) => void): this {
    return super.off(event, listener);
  }
}

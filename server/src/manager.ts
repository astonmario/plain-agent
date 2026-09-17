/**
 * AgentManager —— 常驻 agent 注册表
 *
 * 架构对齐 any-code：agent 不随任务结束销毁，由 manager 常驻管理。
 * - 每个会话一份累积事件历史，seq 即数组下标，断线重连按 since 重放
 * - 事件先入历史再广播给订阅者，重放与订阅之间无 await 不漏帧
 * - 运行中再收到任务进队列，前一个任务结束自动执行下一个
 */

import type { AgentEvent, SessionStorage } from '@plain-agent/domain';
import { submitInteractionAnswer } from '@plain-agent/domain';

/** SSE 帧：seq 为会话累积事件历史下标，客户端用 since=seq 断线续传 */
export interface StreamFrame {
  seq: number;
  event: AgentEvent;
}

/** 运行终态：流收到这些事件后关闭 */
export const TERMINAL_EVENTS = new Set(['done', 'task-end', 'error', 'stopped']);

/** 与 PlainAgent 解耦的最小接口（测试可注入 fake） */
export interface AgentLike {
  on(event: 'event', listener: (e: AgentEvent) => void): unknown;
  off(event: 'event', listener: (e: AgentEvent) => void): unknown;
  submit(task: string): Promise<unknown>;
  stop(): void;
  destroy(): void;
  getSessionId(): string;
  getMessages(): { role: string; content?: unknown }[];
  compressHistory(): Promise<void>;
}

export interface ManagerDeps {
  storage: SessionStorage;
  createAgent: (sessionId: string) => AgentLike;
}

interface Entry {
  agent: AgentLike;
  /** 累积事件历史，seq = 下标；跨 run 不清空，续传语义最简单 */
  history: AgentEvent[];
  subs: Set<(frame: StreamFrame) => void>;
  record: (event: AgentEvent) => void;
  running: boolean;
  queue: string[];
}

export class AgentManager {
  private entries = new Map<string, Entry>();

  constructor(private deps: ManagerDeps) {}

  private ensureEntry(sessionId: string): Entry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      const agent = this.deps.createAgent(sessionId);
      entry = {
        agent,
        history: [],
        subs: new Set(),
        record: (event) => {
          const e = entry!;
          const frame: StreamFrame = { seq: e.history.length, event };
          e.history.push(event);
          for (const fn of e.subs) fn(frame);
        },
        running: false,
        queue: [],
      };
      agent.on('event', entry.record);
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** 会话完整事件历史（带 seq），供 since 重放 */
  frames(sessionId: string): StreamFrame[] {
    const entry = this.entries.get(sessionId);
    if (!entry) return [];
    return entry.history.map((event, seq) => ({ seq, event }));
  }

  /**
   * 提交任务。空闲立即执行；运行中则入队，前一任务终态后自动接续。
   * 返回 startSeq：本次 run 调用时的事件水位，run 流的回放起点。
   */
  run(sessionId: string, task: string): { status: 'started' | 'queued'; startSeq: number } {
    const entry = this.ensureEntry(sessionId);
    const startSeq = entry.history.length;
    if (entry.running) {
      entry.queue.push(task);
      return { status: 'queued', startSeq };
    }
    void this.exec(entry, task);
    return { status: 'started', startSeq };
  }

  private async exec(entry: Entry, task: string): Promise<void> {
    entry.running = true;
    try {
      await entry.agent.submit(task);
    } catch (err) {
      // 异常路径补发 error 事件（正常路径 agent 自己会发）
      entry.record({
        type: 'error',
        error: {
          name: err instanceof Error ? err.name : 'Error',
          message: err instanceof Error ? err.message : String(err),
        },
        timestamp: Date.now(),
      });
    }
    entry.running = false;
    const next = entry.queue.shift();
    if (next !== undefined) void this.exec(entry, next);
  }

  /** 订阅 live 帧；会话尚无 agent 时返回 null（调用方应 404） */
  subscribe(sessionId: string, fn: (frame: StreamFrame) => void): (() => void) | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    entry.subs.add(fn);
    return () => entry.subs.delete(fn);
  }

  stop(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    entry.queue = [];
    entry.agent.stop();
    return true;
  }

  async compact(sessionId: string): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    await entry.agent.compressHistory();
    return true;
  }

  /** ask_question 答案提交：domain 进程内挂起注册表直接唤醒 */
  interact(interactionId: string, answers: string[]): void {
    submitInteractionAnswer(interactionId, answers);
  }

  messages(sessionId: string): Promise<{ role: string; content?: unknown }[]> {
    const entry = this.entries.get(sessionId);
    if (entry) return Promise.resolve(entry.agent.getMessages());
    return this.deps.storage.loadMessages(sessionId) as Promise<
      { role: string; content?: unknown }[]
    >;
  }

  runningSessions(): string[] {
    return [...this.entries.entries()].filter(([, e]) => e.running).map(([id]) => id);
  }

  queuedTasks(sessionId: string): string[] {
    return this.entries.get(sessionId)?.queue.slice() ?? [];
  }

  destroy(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    entry.agent.destroy();
    this.entries.delete(sessionId);
    return true;
  }
}

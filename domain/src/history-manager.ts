/**
 * 消息历史管理器
 *
 * 三层策略：
 * 1. 第一层：清理冗长的 tool output（日志、API 返回、查询结果等）
 * 2. 第二层：将旧对话合并成 Anchor（结构化状态快照）
 * 3. 第三层：激进摘要（极端情况，丢弃细节保留核心）
 */

import type { ChatMessage, LLMConfig } from './types';
import { callLLM } from './llm';
import { AnchorManager, type ConversationAnchor } from './anchor';
import { CompressionTrigger, type SessionHealth } from './compression-trigger';

// ============ 配置 ============

export interface HistoryConfig {
  enabled?: boolean;               // 是否启用历史管理（默认 true）
  maxTokens?: number;              // 最大 token 数（默认 200000）
  maxToolOutputLength?: number;    // 单个工具输出最大长度（默认 1000 字符）
  keepRecentMessages?: number;     // 保留最近 N 条消息不压缩（默认 10）
  compressionThreshold?: number;   // 触发第二层压缩的阈值（默认 150000）
  aggressiveThreshold?: number;    // 触发第三层激进压缩的阈值（默认 180000）
}

const DEFAULT_CONFIG: Required<HistoryConfig> = {
  enabled: true,
  maxTokens: 200_000,
  maxToolOutputLength: 1000,
  keepRecentMessages: 10,
  compressionThreshold: 150_000,
  aggressiveThreshold: 180_000,
};

// ============ Token 估算 ============

/**
 * 粗略估算消息的 token 数
 * 规则：1 token ≈ 4 个字符（英文）或 1.5 个中文字符
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const content = msg.content || '';
    // 中文字符数
    const chineseChars = (content.match(/[一-龥]/g) || []).length;
    // 总字符数
    const totalChars = content.length;
    // 英文字符数
    const englishChars = totalChars - chineseChars;

    // 估算：中文 1.5 字符/token，英文 4 字符/token
    total += Math.ceil(chineseChars / 1.5 + englishChars / 4);

    // tool_calls 的 token
    if (msg.tool_calls) {
      total += msg.tool_calls.length * 50; // 每个 tool call 约 50 tokens
    }
  }
  return total;
}

// ============ 第一层：清理冗长输出 ============

/**
 * 检测内容类型
 */
function detectContentType(content: string): 'log' | 'json' | 'code' | 'query-result' | 'normal' {
  // 日志特征：时间戳、日志级别、堆栈跟踪
  if (/(\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|INFO|ERROR|DEBUG|WARN)/i.test(content)) {
    return 'log';
  }

  // JSON 数据
  if ((content.trim().startsWith('{') && content.trim().endsWith('}')) ||
      (content.trim().startsWith('[') && content.trim().endsWith(']'))) {
    try {
      JSON.parse(content);
      return 'json';
    } catch {
      // 不是有效 JSON
    }
  }

  // 代码特征：多行且包含常见语法
  if (content.includes('\n') && /\b(function|class|const|let|var|import|export|def|async)\b/.test(content)) {
    return 'code';
  }

  // 查询结果：表格、多行数据
  if (content.includes('|') || /\n.+\n.+\n/.test(content)) {
    return 'query-result';
  }

  return 'normal';
}

/**
 * 截断内容并添加说明
 */
function truncateContent(
  content: string,
  maxLength: number,
  type: 'log' | 'json' | 'code' | 'query-result' | 'normal'
): string {
  if (content.length <= maxLength) {
    return content;
  }

  const truncated = content.slice(0, maxLength);
  const remaining = content.length - maxLength;

  const typeDescriptions: Record<string, string> = {
    log: '日志',
    json: 'JSON 数据',
    code: '代码',
    'query-result': '查询结果',
    normal: '内容',
  };

  return `${truncated}\n\n[${typeDescriptions[type]}已截断，省略 ${remaining} 字符]`;
}

/**
 * 第一层压缩：清理冗长的 tool output
 */
export function compressToolOutputs(messages: ChatMessage[], config: HistoryConfig = {}): ChatMessage[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'tool' && msg.content) {
      const type = detectContentType(msg.content);
      const compressed = truncateContent(msg.content, cfg.maxToolOutputLength, type);

      result.push({
        ...msg,
        content: compressed,
      });
    } else {
      result.push(msg);
    }
  }

  return result;
}

// ============ 第二层：对话状态 Anchor ============

/**
 * 第二层压缩：将旧对话合并成 Anchor（结构化状态）
 */
export async function compressWithAnchor(
  messages: ChatMessage[],
  llmConfig: LLMConfig,
  config: HistoryConfig = {},
  signal?: AbortSignal
): Promise<ChatMessage[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // 如果消息数不多，不需要压缩
  if (messages.length <= cfg.keepRecentMessages) {
    return messages;
  }

  // 检查 token 数
  const tokens = estimateTokens(messages);
  if (tokens < cfg.compressionThreshold) {
    return messages;
  }

  const anchorManager = new AnchorManager();

  // 保留最近的消息
  const recentMessages = messages.slice(-cfg.keepRecentMessages);
  const oldMessages = messages.slice(0, -cfg.keepRecentMessages);

  // 查找系统消息（保留）
  const systemMessages = oldMessages.filter(msg => msg.role === 'system');
  const nonSystemMessages = oldMessages.filter(msg => msg.role !== 'system');

  // 如果旧消息不多，直接返回
  if (nonSystemMessages.length === 0) {
    return messages;
  }

  // 检查是否已有 Anchor
  const existingAnchorMsg = systemMessages.find(msg =>
    msg.content?.includes('[对话状态 v')
  );

  let anchorMessage: ChatMessage;

  if (existingAnchorMsg) {
    // 提取现有 Anchor
    const existingAnchor = anchorManager.extractAnchorFromMessage(existingAnchorMsg);

    if (existingAnchor) {
      // 计算需要更新的新消息
      const newMessagesStart = existingAnchor.metadata.coverRange.endIndex;
      const newMessagesToCompress = messages.slice(newMessagesStart, -cfg.keepRecentMessages);

      if (newMessagesToCompress.length > 5) {
        // 有足够的新消息，执行增量更新
        const updatedAnchor = await anchorManager.updateAnchor(
          existingAnchor,
          newMessagesToCompress,
          newMessagesStart,
          messages.length - cfg.keepRecentMessages,
          llmConfig,
          signal
        );
        anchorMessage = anchorManager.anchorToSystemMessage(updatedAnchor);
      } else {
        // 新消息太少，复用旧 Anchor
        anchorMessage = existingAnchorMsg;
      }
    } else {
      // 解析失败，重新生成
      const anchor = await anchorManager.createAnchor(
        nonSystemMessages,
        0,
        nonSystemMessages.length,
        llmConfig,
        signal
      );
      anchorMessage = anchorManager.anchorToSystemMessage(anchor);
    }
  } else {
    // 首次生成 Anchor
    const anchor = await anchorManager.createAnchor(
      nonSystemMessages,
      0,
      nonSystemMessages.length,
      llmConfig,
      signal
    );
    anchorMessage = anchorManager.anchorToSystemMessage(anchor);
  }

  // 构建新的消息历史
  const otherSystemMessages = systemMessages.filter(
    msg => !msg.content?.includes('[对话状态 v')
  );

  return [
    ...otherSystemMessages,    // 其他系统消息
    anchorMessage,             // Anchor 消息
    ...recentMessages,         // 最近的消息
  ];
}

// ============ 第三层：激进摘要（极端情况）============

/**
 * 第三层压缩：激进摘要
 *
 * 触发条件：Anchor 压缩后仍然超过 aggressiveThreshold
 *
 * 策略：
 * - 将 Anchor 进一步压缩为超简化摘要
 * - 只保留最核心的信息
 * - 减少 keepRecentMessages 数量
 */
export async function compressAggressively(
  messages: ChatMessage[],
  llmConfig: LLMConfig,
  config: HistoryConfig = {},
  signal?: AbortSignal
): Promise<ChatMessage[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // 提取 Anchor
  const anchorMsg = messages.find(msg =>
    msg.role === 'system' && msg.content?.includes('[对话状态 v')
  );

  if (!anchorMsg || !anchorMsg.content) {
    // 没有 Anchor，直接保留最近消息
    const keep = Math.max(3, Math.floor(cfg.keepRecentMessages / 2));
    return messages.slice(-keep);
  }

  // 使用 LLM 压缩 Anchor 为超简化摘要
  const prompt = `将以下对话状态压缩为超简化摘要（不超过 300 字）。

原始状态：
${anchorMsg.content}

要求：
1. 只保留最关键的信息
2. 用户意图：一句话
3. 已排除方案：列举（这个最重要，不能丢）
4. 当前状态：一句话
5. 下一步：一句话

输出格式：
[极简摘要]
意图: xxx
已排除: xxx, xxx
状态: xxx
下一步: xxx`;

  const response = await callLLM(
    llmConfig,
    [
      { role: 'system', content: '你是摘要压缩专家，擅长提取核心信息。' },
      { role: 'user', content: prompt }
    ],
    [],
    signal
  );

  const summary = response.content || '[压缩失败]';

  // 构建极简消息历史
  const systemMessages = messages.filter(
    msg => msg.role === 'system' && !msg.content?.includes('[对话状态 v')
  );

  // 只保留最近 3-5 条消息
  const keepRecent = Math.max(3, Math.floor(cfg.keepRecentMessages / 2));
  const recentMessages = messages.slice(-keepRecent);

  return [
    ...systemMessages,
    { role: 'system', content: summary },
    ...recentMessages
  ];
}

// ============ 统一管理接口 ============

export class HistoryManager {
  private config: Required<HistoryConfig>;
  private compressionHistory: Array<{ level: number; timestamp: number }> = [];
  private trigger: CompressionTrigger;

  constructor(config: HistoryConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.trigger = new CompressionTrigger(this.config.maxTokens);
  }

  /**
   * 检查是否需要压缩（智能判断）
   */
  shouldCompress(messages: ChatMessage[]): boolean {
    const health = this.trigger.evaluate(messages);
    return health.shouldCompress;
  }

  /**
   * 获取会话健康状况
   */
  getSessionHealth(messages: ChatMessage[]): SessionHealth {
    return this.trigger.evaluate(messages);
  }

  /**
   * 获取当前 token 使用情况
   */
  getTokenUsage(messages: ChatMessage[]): {
    tokens: number;
    maxTokens: number;
    percentage: number;
    needsCompression: boolean;
  } {
    const tokens = estimateTokens(messages);
    return {
      tokens,
      maxTokens: this.config.maxTokens,
      percentage: (tokens / this.config.maxTokens) * 100,
      needsCompression: tokens >= this.config.compressionThreshold,
    };
  }

  /**
   * 执行三层压缩（智能决策）
   *
   * 策略：
   * 1. 评估会话健康状况
   * 2. 根据紧急程度和具体问题决定压缩层级
   * 3. 执行相应的压缩策略
   *
   * @returns { compressed, level, health, warning? } 压缩结果、层级、健康状况、可选警告
   */
  async compress(
    messages: ChatMessage[],
    llmConfig: LLMConfig,
    signal?: AbortSignal
  ): Promise<{
    compressed: ChatMessage[];
    level: number;
    health: SessionHealth;
    warning?: string;
  }> {
    // 评估会话健康
    const health = this.trigger.evaluate(messages);

    if (!health.shouldCompress) {
      return {
        compressed: messages,
        level: 0,
        health
      };
    }

    const originalTokens = estimateTokens(messages);
    let compressed = messages;
    let level = 0;
    let warning: string | undefined;

    // 根据健康状况决定层级
    const targetLevel = this.trigger.decideLevel(health);

    // 第一层：总是执行
    compressed = compressToolOutputs(messages, this.config);
    level = 1;

    // 如果需要更高层级
    if (targetLevel >= 2) {
      // 第二层：Anchor 状态快照
      compressed = await compressWithAnchor(compressed, llmConfig, this.config, signal);
      level = 2;
    }

    if (targetLevel >= 3) {
      // 第三层：激进摘要
      compressed = await compressAggressively(compressed, llmConfig, this.config, signal);
      level = 3;

      // 记录第三层触发
      this.compressionHistory.push({ level: 3, timestamp: Date.now() });

      // 检查是否频繁触发第三层（退场信号）
      const recentLevel3 = this.compressionHistory.filter(
        h => h.level === 3 && Date.now() - h.timestamp < 300000 // 最近 5 分钟
      );

      if (recentLevel3.length >= 2) {
        warning = 'session-too-long';
      }
    }

    return {
      compressed,
      level,
      health,
      warning
    };
  }

  /**
   * 仅执行第一层压缩（快速，不需要 LLM）
   */
  compressQuick(messages: ChatMessage[]): ChatMessage[] {
    return compressToolOutputs(messages, this.config);
  }
}

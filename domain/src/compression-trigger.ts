/**
 * 智能压缩触发器
 *
 * 不只看 token 数，综合判断是否需要压缩
 */

import type { ChatMessage } from './types';
import { estimateTokens } from './history-manager';

// ============ 会话健康指标 ============

export interface SessionHealth {
  // 基础指标
  messageCount: number;            // 消息总数
  roundCount: number;              // 对话轮数（user-assistant 配对）
  tokenUsage: number;              // Token 使用量
  tokenPercentage: number;         // Token 使用率 (%)

  // 行为指标
  toolResultSize: number;          // 工具结果累积大小
  largeOutputCount: number;        // 大型输出数量（> 2000 字符）
  repetitionScore: number;         // 重复度（0-1，越高越重复）

  // 压缩建议
  shouldCompress: boolean;
  reason: string[];
  urgency: 'low' | 'medium' | 'high';
}

// ============ 重复检测 ============

/**
 * 检测 Agent 是否在重复行为
 */
function detectRepetition(messages: ChatMessage[]): number {
  if (messages.length < 10) return 0;

  // 提取最近的 assistant 消息和工具调用
  const recentMessages = messages.slice(-20);
  const assistantContents: string[] = [];
  const toolNames: string[] = [];

  for (const msg of recentMessages) {
    if (msg.role === 'assistant') {
      if (msg.content) {
        assistantContents.push(msg.content.toLowerCase());
      }
      if (msg.tool_calls) {
        toolNames.push(...msg.tool_calls.map(tc => tc.function.name));
      }
    }
  }

  let repetitionCount = 0;
  const totalChecks = assistantContents.length + toolNames.length;

  // 检查文本重复
  const contentSet = new Set<string>();
  for (const content of assistantContents) {
    const normalized = content.slice(0, 100); // 前 100 字符
    if (contentSet.has(normalized)) {
      repetitionCount++;
    }
    contentSet.add(normalized);
  }

  // 检查工具调用重复
  const toolWindow = 5; // 最近 5 次工具调用
  for (let i = toolWindow; i < toolNames.length; i++) {
    const currentTool = toolNames[i];
    const recentTools = toolNames.slice(i - toolWindow, i);
    if (recentTools.filter(t => t === currentTool).length >= 2) {
      repetitionCount++;
    }
  }

  return totalChecks > 0 ? repetitionCount / totalChecks : 0;
}

// ============ 工具结果分析 ============

/**
 * 分析工具结果的累积情况
 */
function analyzeToolResults(messages: ChatMessage[]): {
  totalSize: number;
  largeCount: number;
  hasLogs: boolean;
  hasTests: boolean;
  hasDiffs: boolean;
} {
  let totalSize = 0;
  let largeCount = 0;
  let hasLogs = false;
  let hasTests = false;
  let hasDiffs = false;

  for (const msg of messages) {
    if (msg.role === 'tool' && msg.content) {
      const size = msg.content.length;
      totalSize += size;

      if (size > 2000) {
        largeCount++;
      }

      // 检测特定类型的输出
      const content = msg.content.toLowerCase();
      if (/\b(info|debug|error|warn|trace)\b/.test(content)) {
        hasLogs = true;
      }
      if (/\b(test|spec|passed|failed|assert)\b/.test(content)) {
        hasTests = true;
      }
      if (/^(\+\+\+|---|diff|@@ )/.test(content)) {
        hasDiffs = true;
      }
    }
  }

  return { totalSize, largeCount, hasLogs, hasTests, hasDiffs };
}

// ============ 对话轮数计算 ============

/**
 * 计算对话轮数（user-assistant 配对）
 */
function countRounds(messages: ChatMessage[]): number {
  let rounds = 0;
  let expectingAssistant = false;

  for (const msg of messages) {
    if (msg.role === 'user') {
      expectingAssistant = true;
    } else if (msg.role === 'assistant' && expectingAssistant) {
      rounds++;
      expectingAssistant = false;
    }
  }

  return rounds;
}

// ============ 智能触发器 ============

export class CompressionTrigger {
  private maxTokens: number;

  constructor(maxTokens: number = 200_000) {
    this.maxTokens = maxTokens;
  }

  /**
   * 评估会话健康状况
   */
  evaluate(messages: ChatMessage[]): SessionHealth {
    // 基础指标
    const messageCount = messages.length;
    const roundCount = countRounds(messages);
    const tokenUsage = estimateTokens(messages);
    const tokenPercentage = (tokenUsage / this.maxTokens) * 100;

    // 工具结果分析
    const toolAnalysis = analyzeToolResults(messages);

    // 重复检测
    const repetitionScore = detectRepetition(messages);

    // 综合判断
    const reasons: string[] = [];
    let urgency: 'low' | 'medium' | 'high' = 'low';

    // 判断 1：对话轮数过多
    if (roundCount >= 30) {
      reasons.push(`对话已进行 ${roundCount} 轮，接近长任务状态`);
      urgency = 'high';
    } else if (roundCount >= 20) {
      reasons.push(`对话已进行 ${roundCount} 轮，建议压缩`);
      urgency = 'medium';
    }

    // 判断 2：Token 使用率
    if (tokenPercentage >= 75) {
      reasons.push(`Token 使用率 ${tokenPercentage.toFixed(1)}%，接近上限`);
      urgency = 'high';
    } else if (tokenPercentage >= 60) {
      reasons.push(`Token 使用率 ${tokenPercentage.toFixed(1)}%，建议压缩`);
      urgency = urgency === 'high' ? 'high' : 'medium';
    }

    // 判断 3：工具结果堆积
    if (toolAnalysis.largeCount >= 5) {
      reasons.push(`大型工具输出堆积（${toolAnalysis.largeCount} 个），占用大量 token`);
      urgency = urgency === 'low' ? 'medium' : urgency;
    }

    if (toolAnalysis.hasLogs && toolAnalysis.totalSize > 10000) {
      reasons.push('日志输出大量堆积，需要清理');
      urgency = urgency === 'low' ? 'medium' : urgency;
    }

    if (toolAnalysis.hasTests && toolAnalysis.totalSize > 8000) {
      reasons.push('测试输出大量堆积，需要清理');
      urgency = urgency === 'low' ? 'medium' : urgency;
    }

    if (toolAnalysis.hasDiffs && toolAnalysis.totalSize > 6000) {
      reasons.push('代码 diff 大量堆积，需要清理');
      urgency = urgency === 'low' ? 'medium' : urgency;
    }

    // 判断 4：重复行为
    if (repetitionScore >= 0.4) {
      reasons.push(`检测到重复行为（${(repetitionScore * 100).toFixed(0)}%），Agent 可能陷入困境`);
      urgency = 'high';
    } else if (repetitionScore >= 0.25) {
      reasons.push(`检测到一些重复行为（${(repetitionScore * 100).toFixed(0)}%）`);
      urgency = urgency === 'low' ? 'medium' : urgency;
    }

    // 判断 5：消息数量暴增
    if (messageCount >= 100) {
      reasons.push(`消息数量 ${messageCount}，远超正常范围`);
      urgency = 'high';
    } else if (messageCount >= 60) {
      reasons.push(`消息数量 ${messageCount}，偏多`);
      urgency = urgency === 'low' ? 'medium' : urgency;
    }

    // 最终决策
    const shouldCompress = reasons.length > 0;

    return {
      messageCount,
      roundCount,
      tokenUsage,
      tokenPercentage,
      toolResultSize: toolAnalysis.totalSize,
      largeOutputCount: toolAnalysis.largeCount,
      repetitionScore,
      shouldCompress,
      reason: reasons,
      urgency
    };
  }

  /**
   * 决定使用哪个压缩层级
   */
  decideLevel(health: SessionHealth): 1 | 2 | 3 {
    // Level 1：基础清理（总是执行）
    if (!health.shouldCompress || health.urgency === 'low') {
      return 1;
    }

    // Level 3：紧急情况
    if (health.urgency === 'high' && (
      health.tokenPercentage >= 90 ||
      health.repetitionScore >= 0.4 ||
      health.messageCount >= 100
    )) {
      return 3;
    }

    // Level 2：标准压缩
    return 2;
  }

  /**
   * 生成压缩建议
   */
  getSuggestion(health: SessionHealth): string {
    if (!health.shouldCompress) {
      return '会话状态良好，暂不需要压缩';
    }

    const level = this.decideLevel(health);
    const reasons = health.reason.join('；');

    return `建议执行 Level ${level} 压缩。原因：${reasons}`;
  }
}

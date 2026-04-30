/**
 * 对话状态 Anchor（锚点）
 *
 * 用于结构化地记录对话状态，避免信息丢失
 */

import type { ChatMessage, LLMConfig } from './types';
import { callLLM } from './llm';

// ============ Anchor 数据结构 ============

export interface ConversationAnchor {
  // 1. 用户意图
  intent: {
    primary: string;           // 主要目标
    secondary?: string[];      // 次要目标
  };

  // 2. 已做改动
  changesMade: Array<{
    type: 'file_created' | 'file_modified' | 'file_deleted' | 'command_executed' | 'api_called' | 'other';
    target: string;            // 文件路径、命令、API 端点
    summary: string;           // 简短描述
    timestamp?: number;        // 可选时间戳
  }>;

  // 3. 已做决策
  decisionsTaken: Array<{
    decision: string;          // 决策内容
    reason: string;            // 决策原因
    context?: string;          // 决策背景
  }>;

  // 4. 已排除方案（防止重复尝试）
  excludedApproaches: Array<{
    approach: string;          // 方案描述
    reason: string;            // 排除原因
    triedAt?: number;          // 尝试时的消息索引
  }>;

  // 5. 下一步计划
  nextSteps: Array<{
    action: string;            // 行动描述
    priority: 'high' | 'medium' | 'low';
    blockedBy?: string;        // 阻塞原因
  }>;

  // 元数据
  metadata: {
    anchorVersion: number;     // Anchor 版本号
    coverRange: {              // 覆盖的消息范围
      startIndex: number;
      endIndex: number;
    };
    createdAt: number;
    tokensSaved: number;       // 估算节省的 token 数
  };
}

// ============ Anchor 管理器 ============

export class AnchorManager {
  /**
   * 将消息转换为文本
   */
  private messagesToText(messages: ChatMessage[]): string {
    return messages
      .map(msg => {
        const role = msg.role === 'assistant' ? 'AI' :
                     msg.role === 'user' ? '用户' :
                     msg.role === 'tool' ? '工具' : '系统';

        let content = msg.content || '';

        // 如果是 assistant 消息且有 tool_calls，说明正在调用工具
        if (msg.role === 'assistant' && msg.tool_calls) {
          const toolNames = msg.tool_calls.map(tc => tc.function.name).join(', ');
          content = `[调用工具: ${toolNames}]`;
        }

        // 截断过长内容
        if (content.length > 500) {
          content = content.slice(0, 500) + '...';
        }

        return `[${role}] ${content}`;
      })
      .join('\n\n');
  }

  /**
   * 估算节省的 token 数
   */
  private estimateTokensSaved(originalMessages: ChatMessage[], anchor: ConversationAnchor): number {
    // 粗略估算：原消息 vs Anchor 系统消息
    let originalTokens = 0;
    for (const msg of originalMessages) {
      const content = msg.content || '';
      originalTokens += Math.ceil(content.length / 4);
    }

    const anchorText = JSON.stringify(anchor);
    const anchorTokens = Math.ceil(anchorText.length / 4);

    return Math.max(0, originalTokens - anchorTokens);
  }

  /**
   * 构建初始生成 Prompt
   */
  private buildInitialPrompt(conversationText: string): string {
    return `分析以下对话，提取结构化状态信息。

对话内容：
${conversationText}

请按以下 JSON 格式输出（严格 JSON，不要额外文字）：
{
  "intent": {
    "primary": "主要目标（一句话）",
    "secondary": ["次要目标1", "次要目标2"]
  },
  "changesMade": [
    {
      "type": "file_created|file_modified|file_deleted|command_executed|api_called|other",
      "target": "具体目标（文件路径、命令等）",
      "summary": "简短描述做了什么"
    }
  ],
  "decisionsTaken": [
    {
      "decision": "决策内容",
      "reason": "为什么这样决策",
      "context": "决策的背景或约束"
    }
  ],
  "excludedApproaches": [
    {
      "approach": "被排除的方案",
      "reason": "为什么排除（尝试失败、不适用、用户拒绝等）"
    }
  ],
  "nextSteps": [
    {
      "action": "下一步要做什么",
      "priority": "high|medium|low"
    }
  ]
}

提取规则：
1. changesMade: 只记录关键操作，忽略琐碎细节
2. excludedApproaches: **非常重要**，记录所有失败尝试、被拒绝的方案
3. decisionsTaken: 必须包含"为什么"，不只是"做了什么"
4. nextSteps: 按优先级排序，只保留未完成的
5. 如果某个字段为空，返回空数组 []

输出纯 JSON：`;
  }

  /**
   * 构建增量更新 Prompt
   */
  private buildUpdatePrompt(currentAnchor: ConversationAnchor, newConversationText: string): string {
    return `基于现有状态和新对话，更新结构化状态。

现有状态（Anchor v${currentAnchor.metadata.anchorVersion}）：
${JSON.stringify(currentAnchor, null, 2)}

新增对话：
${newConversationText}

请输出更新后的完整状态（JSON 格式，不要额外文字）。

更新规则：
1. intent: 如果用户目标变化，更新 primary 或添加到 secondary
2. changesMade: 追加新的改动，保留重要的旧改动（最多保留最近 10 条）
3. decisionsTaken: 追加新决策，保留所有旧决策
4. excludedApproaches: **必须保留所有已排除方案**，追加新的排除
5. nextSteps: 更新为当前的下一步，已完成的移除

输出纯 JSON：`;
  }

  /**
   * 生成初始 Anchor
   */
  async createAnchor(
    messages: ChatMessage[],
    startIndex: number,
    endIndex: number,
    llmConfig: LLMConfig,
    signal?: AbortSignal
  ): Promise<ConversationAnchor> {
    const conversationText = this.messagesToText(messages.slice(startIndex, endIndex));
    const prompt = this.buildInitialPrompt(conversationText);

    const response = await callLLM(
      llmConfig,
      [
        { role: 'system', content: '你是对话状态提取器，只输出 JSON，不要其他内容。' },
        { role: 'user', content: prompt }
      ],
      [],
      signal
    );

    let anchorData: Partial<ConversationAnchor>;
    try {
      const content = response.content || '{}';
      // 尝试提取 JSON（可能包含 markdown 代码块）
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      anchorData = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    } catch (error) {
      console.warn('Failed to parse anchor JSON, using empty anchor:', error);
      anchorData = {
        intent: { primary: '未知目标' },
        changesMade: [],
        decisionsTaken: [],
        excludedApproaches: [],
        nextSteps: []
      };
    }

    return {
      intent: anchorData.intent || { primary: '未知目标' },
      changesMade: anchorData.changesMade || [],
      decisionsTaken: anchorData.decisionsTaken || [],
      excludedApproaches: anchorData.excludedApproaches || [],
      nextSteps: anchorData.nextSteps || [],
      metadata: {
        anchorVersion: 1,
        coverRange: { startIndex, endIndex },
        createdAt: Date.now(),
        tokensSaved: this.estimateTokensSaved(messages.slice(startIndex, endIndex), anchorData as ConversationAnchor)
      }
    };
  }

  /**
   * 增量更新 Anchor
   */
  async updateAnchor(
    currentAnchor: ConversationAnchor,
    newMessages: ChatMessage[],
    newStartIndex: number,
    newEndIndex: number,
    llmConfig: LLMConfig,
    signal?: AbortSignal
  ): Promise<ConversationAnchor> {
    const newConversationText = this.messagesToText(newMessages);
    const prompt = this.buildUpdatePrompt(currentAnchor, newConversationText);

    const response = await callLLM(
      llmConfig,
      [
        { role: 'system', content: '你是对话状态更新器，只输出 JSON，不要其他内容。' },
        { role: 'user', content: prompt }
      ],
      [],
      signal
    );

    let updatedData: Partial<ConversationAnchor>;
    try {
      const content = response.content || '{}';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      updatedData = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    } catch (error) {
      console.warn('Failed to parse updated anchor JSON, keeping current:', error);
      updatedData = currentAnchor;
    }

    return {
      intent: updatedData.intent || currentAnchor.intent,
      changesMade: updatedData.changesMade || currentAnchor.changesMade,
      decisionsTaken: updatedData.decisionsTaken || currentAnchor.decisionsTaken,
      excludedApproaches: updatedData.excludedApproaches || currentAnchor.excludedApproaches,
      nextSteps: updatedData.nextSteps || currentAnchor.nextSteps,
      metadata: {
        anchorVersion: currentAnchor.metadata.anchorVersion + 1,
        coverRange: {
          startIndex: currentAnchor.metadata.coverRange.startIndex,
          endIndex: newEndIndex
        },
        createdAt: Date.now(),
        tokensSaved: this.estimateTokensSaved(newMessages, updatedData as ConversationAnchor)
      }
    };
  }

  /**
   * 将 Anchor 转换为系统消息
   */
  anchorToSystemMessage(anchor: ConversationAnchor): ChatMessage {
    const sections: string[] = [];

    sections.push(`[对话状态 v${anchor.metadata.anchorVersion}]`);
    sections.push('');

    // 1. 用户意图
    sections.push('📋 用户意图');
    sections.push(`主要目标: ${anchor.intent.primary}`);
    if (anchor.intent.secondary && anchor.intent.secondary.length > 0) {
      sections.push(`次要目标: ${anchor.intent.secondary.join(', ')}`);
    }
    sections.push('');

    // 2. 已完成改动
    if (anchor.changesMade.length > 0) {
      sections.push('✅ 已完成改动');
      anchor.changesMade.forEach(c => {
        sections.push(`- [${c.type}] ${c.target}: ${c.summary}`);
      });
      sections.push('');
    }

    // 3. 已做决策
    if (anchor.decisionsTaken.length > 0) {
      sections.push('🎯 已做决策');
      anchor.decisionsTaken.forEach(d => {
        sections.push(`- ${d.decision}`);
        sections.push(`  原因: ${d.reason}`);
        if (d.context) {
          sections.push(`  背景: ${d.context}`);
        }
      });
      sections.push('');
    }

    // 4. 已排除方案
    if (anchor.excludedApproaches.length > 0) {
      sections.push('❌ 已排除方案（不要再尝试）');
      anchor.excludedApproaches.forEach(e => {
        sections.push(`- ${e.approach}`);
        sections.push(`  原因: ${e.reason}`);
      });
      sections.push('');
    }

    // 5. 下一步
    if (anchor.nextSteps.length > 0) {
      sections.push('⏭️ 下一步');
      anchor.nextSteps.forEach(s => {
        const blocked = s.blockedBy ? ` (等待: ${s.blockedBy})` : '';
        sections.push(`- [${s.priority}] ${s.action}${blocked}`);
      });
      sections.push('');
    }

    sections.push('[状态结束，以下是最近的对话]');

    return {
      role: 'system',
      content: sections.join('\n')
    };
  }

  /**
   * 从系统消息中提取 Anchor
   */
  extractAnchorFromMessage(message: ChatMessage): ConversationAnchor | null {
    if (message.role !== 'system' || !message.content) {
      return null;
    }

    // 检查是否是 Anchor 消息
    const match = message.content.match(/\[对话状态 v(\d+)\]/);
    if (!match) {
      return null;
    }

    const version = parseInt(match[1], 10);

    // 简单解析（生产环境应该序列化完整的 Anchor 到消息中）
    // 这里只是为了兼容性，实际使用时应该在 metadata 中存储完整 JSON
    return {
      intent: { primary: '已有状态' },
      changesMade: [],
      decisionsTaken: [],
      excludedApproaches: [],
      nextSteps: [],
      metadata: {
        anchorVersion: version,
        coverRange: { startIndex: 0, endIndex: 0 },
        createdAt: Date.now(),
        tokensSaved: 0
      }
    };
  }
}

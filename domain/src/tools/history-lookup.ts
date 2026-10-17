/**
 * 历史追溯工具
 *
 * 当 LLM 需要查看被压缩的工具输出时，可以使用这个工具
 */

import type { Tool, ToolContext, ChatMessage } from '../types.js';

/**
 * 创建历史追溯工具
 *
 * @param getFullMessages 获取完整消息历史的回调
 * @returns Tool
 */
export function createHistoryLookupTool(
  getFullMessages: (taskId?: string) => ChatMessage[]
): Tool {
  return {
    name: 'lookup_history',
    description: '查看被压缩的历史工具输出。当你看到工具输出被截断（如"[日志已截断，省略 N 字符]"），可以用这个工具查看完整内容。',
    schema: {
      type: 'function',
      function: {
        name: 'lookup_history',
        description: '查看被压缩的历史工具输出完整内容',
        parameters: {
          type: 'object',
          properties: {
            tool_name: {
              type: 'string',
              description: '要查看输出的工具名称（如 read_file, bash）',
            },
            search_text: {
              type: 'string',
              description: '可选：在工具输出中搜索的文本（如文件名、错误信息）',
            },
            max_results: {
              type: 'number',
              description: '返回最多 N 个结果（默认 3）',
            }
          },
          required: ['tool_name'],
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const { tool_name, search_text, max_results = 3 } = args;

      const fullMessages = getFullMessages(ctx.taskId);
      const results: Array<{ index: number; preview: string; full: string }> = [];

      // 遍历历史消息，查找匹配的工具输出
      for (let i = 0; i < fullMessages.length; i++) {
        const msg = fullMessages[i];

        // 检查是否是工具消息
        if (msg.role !== 'tool' || !msg.content) continue;

        // 找到对应的 assistant 消息（包含 tool_calls）
        const prevMsg = fullMessages[i - 1];
        if (!prevMsg || prevMsg.role !== 'assistant' || !prevMsg.tool_calls) {
          continue;
        }

        // 检查工具名是否匹配
        const toolCall = prevMsg.tool_calls.find(tc => tc.function.name === tool_name);
        if (!toolCall) continue;

        // 如果指定了搜索文本，检查是否包含
        if (search_text && !msg.content.includes(search_text)) {
          continue;
        }

        // 添加到结果
        const preview = msg.content.slice(0, 200);
        results.push({
          index: i,
          preview: preview + (msg.content.length > 200 ? '...' : ''),
          full: msg.content,
        });

        // 限制结果数量
        if (results.length >= max_results) break;
      }

      if (results.length === 0) {
        return `未找到工具 "${tool_name}" 的输出${search_text ? `（包含 "${search_text}"）` : ''}`;
      }

      // 格式化输出
      let output = `找到 ${results.length} 个匹配的工具输出：\n\n`;

      for (const result of results) {
        output += `--- 历史消息 #${result.index} ---\n`;
        output += `工具: ${tool_name}\n`;
        output += `完整输出:\n${result.full}\n\n`;
      }

      return output;
    },
    meta: {
      readonly: true,
      concurrent: true,
      dangerous: false,
    },
  };
}

/**
 * 创建历史搜索工具（更灵活的搜索）
 */
export function createHistorySearchTool(
  getFullMessages: (taskId?: string) => ChatMessage[]
): Tool {
  return {
    name: 'search_history',
    description: '在完整的对话历史中搜索内容。可以搜索用户消息、AI 回复、工具输出等。',
    schema: {
      type: 'function',
      function: {
        name: 'search_history',
        description: '在完整对话历史中搜索',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词',
            },
            message_type: {
              type: 'string',
              enum: ['user', 'assistant', 'tool', 'system', 'all'],
              description: '消息类型（默认 all）',
            },
            max_results: {
              type: 'number',
              description: '最多返回 N 个结果（默认 5）',
            }
          },
          required: ['query'],
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const { query, message_type = 'all', max_results = 5 } = args;

      const fullMessages = getFullMessages(ctx.taskId);
      const results: Array<{ index: number; role: string; content: string }> = [];

      for (let i = 0; i < fullMessages.length; i++) {
        const msg = fullMessages[i];

        // 类型过滤
        if (message_type !== 'all' && msg.role !== message_type) {
          continue;
        }

        // 搜索内容
        const content = msg.content || '';
        if (!content.includes(query)) continue;

        // 添加结果
        results.push({
          index: i,
          role: msg.role,
          content,
        });

        if (results.length >= max_results) break;
      }

      if (results.length === 0) {
        return `未找到包含 "${query}" 的消息`;
      }

      let output = `找到 ${results.length} 条匹配的消息：\n\n`;

      for (const result of results) {
        // 高亮匹配的文本
        const preview = result.content.slice(0, 300);
        const highlighted = preview.replace(
          new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
          (match) => `**${match}**`
        );

        output += `[#${result.index}] [${result.role}]: ${highlighted}`;
        output += result.content.length > 300 ? '...\n\n' : '\n\n';
      }

      return output;
    },
    meta: {
      readonly: true,
      concurrent: true,
      dangerous: false,
    },
  };
}

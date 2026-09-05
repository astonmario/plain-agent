/**
 * update_memory 工具（搬运自 any-code）
 * LLM 在 agentLoop 内主动调用，自主决定记什么、记到哪一层。
 */

import type { Tool } from '../types';
import { saveMemory, rewriteMemory, type MemoryScope } from './memory';

export const updateMemoryTool: Tool = {
  name: 'update_memory',
  description: '写入/更新长期记忆。append 模式追加条目，rewrite 模式全量重写（蒸馏整理）。',
  schema: {
    type: 'function',
    function: {
      name: 'update_memory',
      description: '写入长期记忆',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '要记忆的内容',
          },
          scope: {
            type: 'string',
            enum: ['project', 'global'],
            description: '记忆层级（默认 project）',
          },
          mode: {
            type: 'string',
            enum: ['append', 'rewrite'],
            description: 'append 追加 / rewrite 全量重写（默认 append）',
          },
        },
        required: ['content'],
      },
    },
  },
  handler: async (args) => {
    const content = (args?.content ?? '').trim();
    if (!content) return 'Error: content is required';
    const scope: MemoryScope = args?.scope === 'global' ? 'global' : 'project';
    try {
      if (args?.mode === 'rewrite') {
        rewriteMemory(process.cwd(), content, scope);
        return `Rewrote ${scope} memory (${content.length} chars).`;
      }
      saveMemory(process.cwd(), content, scope);
      return `Saved to ${scope} memory (${content.length} chars).`;
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  meta: {
    readonly: false,
    concurrent: false,
    dangerous: false,
  },
};

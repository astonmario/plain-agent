/**
 * 会话偏好工具
 *
 * 模型只在用户明确表达长期偏好时调用；写入后由 agent 在下一轮请求的
 * system prompt 中注入，因此不需要把偏好写进对话消息。
 */

import type { Tool, ToolContext } from '../types';
import { describePreferences, mergeSessionPreferences } from '../session-preferences';

export const setSessionPreferencesTool: Tool = {
  name: 'set_session_preferences',
  description:
    '记录本会话的长期偏好：助手自称、对用户的称呼、回答语气、回复语言、解释深度。' +
    '仅当用户明确表达这类偏好时调用，例如「你叫大肥鱼」→ assistantName，「以后叫我老板」→ address，' +
    '「回答简洁点」→ tone，「用英文回复」→ language。不要根据一次任务的语气自行推测，也不要在每轮重复调用。',
  schema: {
    type: 'function',
    function: {
      name: 'set_session_preferences',
      description: '保存会话级长期偏好（只传发生变化的字段）',
      parameters: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: '用户本人希望被如何称呼，例如「老板」「王工」；不要写用户给助手起的名字（那是 assistantName）；传空字符串表示清除',
          },
          assistantName: {
            type: 'string',
            description: '用户给助手起的名字，例如「你叫大肥鱼」「以后你就叫小鱼」；助手指代自己时使用；传空字符串表示清除',
          },
          tone: {
            type: 'string',
            enum: ['concise', 'warm', 'humorous', 'formal'],
            description: '回答语气：简洁直接 / 温和耐心 / 轻松幽默 / 严谨专业',
          },
          language: {
            type: 'string',
            enum: ['zh', 'en', 'follow'],
            description: '回复语言：中文 / 英文 / 跟随用户当前语言',
          },
          depth: {
            type: 'string',
            enum: ['brief', 'balanced', 'detailed'],
            description: '解释深度：结论优先 / 结论+必要说明 / 教学式',
          },
          clear: {
            type: 'array',
            items: { type: 'string', enum: ['address', 'assistantName', 'tone', 'language', 'depth'] },
            description: '要清除的偏好项',
          },
        },
      },
    },
  },
  handler: async (args, ctx: ToolContext) => {
    const storage = ctx.storage;
    if (!storage?.getSessionPreferences || !storage.saveSessionPreferences) {
      return 'Error: 当前存储后端不支持会话偏好，未修改任何内容。';
    }

    const current = await storage.getSessionPreferences(ctx.sessionId);
    let next;
    try {
      next = mergeSessionPreferences(current, args);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}（未修改任何偏好）`;
    }

    await storage.saveSessionPreferences(ctx.sessionId, next);
    const summary = describePreferences(next);
    return next.address || next.assistantName || next.tone || next.language || next.depth
      ? `已更新会话偏好：${summary}\n（从下一轮回答开始生效）`
      : `已清除全部会话偏好\n（从下一轮回答开始恢复默认风格）`;
  },
  meta: {
    readonly: false,
    concurrent: false,
    dangerous: false,
  },
};

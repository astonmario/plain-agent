/**
 * ask_question 工具（搬运自 any-code domain/src/tools/functions/askQuestion.ts）
 * 阻塞 agent loop 等 human 答案：
 * 注册 pending → 发 interaction 事件 → Promise.race([answers, abort, timeout])。
 *  - 答案到达：返回 "Q: <question>\nA: <answer>" 多行（多选 join ", "）
 *  - 超时：返回 sentinel（LLM 自行定夺继续）
 *  - signal abort（stop）：返回 abort sentinel（不 reject——loop 下轮检测 aborted 干净停止）
 * 答案作 tool_result 回灌（非合成 user 消息）。
 *
 * 适配 plain-agent：事件走 ctx.emitEvent 的 interaction 类型（any-code 用独立 eventStream）。
 */

import { randomUUID } from 'node:crypto';
import type { InteractionQuestion, Tool } from '../types';
import { registerInteraction, unregisterInteraction } from '../interactions';

export const ASK_TIMEOUT_MS = 10 * 60 * 1000;
const TIMEOUT_SENTINEL =
  'The user did not respond within the time limit. Use your best judgment to proceed.';
const ABORT_SENTINEL = '[stopped: user stopped before answering]';

function formatAnswers(questions: InteractionQuestion[], answers: string[]): string {
  return questions
    .map((q, i) => `Q: ${q.question}\nA: ${answers[i] ?? '(no answer)'}`)
    .join('\n\n');
}

export const askQuestionTool: Tool = {
  name: 'ask_question',
  description:
    '向用户提问并等待回答（阻塞执行，10 分钟超时）。用于关键决策点：目标不明确、多种方案待选、风险操作需确认。支持单选/多选选项或开放式文本。问题要具体、给出推荐选项。',
  schema: {
    type: 'function',
    function: {
      name: 'ask_question',
      description:
        'Ask the user questions and wait for answers (blocks up to 10 min). Use at key decision points: unclear goals, multiple candidate approaches, risky actions needing confirmation. Supports single/multi-select options or free text. Ask concrete questions with recommended options.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '问题列表（1-5 个）',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: '问题正文' },
                header: { type: 'string', description: '短标题（选项上方显示）' },
                options: {
                  type: 'array',
                  description: '可选项（提供后用户点选，不给则自由文本回答）',
                  items: { type: 'string' },
                },
                multiSelect: { type: 'boolean', description: '是否多选（默认单选）' },
              },
              required: ['question'],
            },
          },
        },
        required: ['questions'],
      },
    },
  },
  handler: async (args: { questions?: InteractionQuestion[] }, ctx): Promise<string> => {
    const items = args?.questions ?? [];
    if (items.length === 0) return '[Error] ask_question requires at least one question';

    const id = randomUUID();
    const questions = items.map((q) => ({
      question: q.question,
      header: q.header,
      options: q.options,
      multiSelect: q.multiSelect,
    }));

    const answersPromise = new Promise<string[]>((resolve) => {
      registerInteraction(id, { resolve });
    });
    const abortPromise = new Promise<'aborted'>((resolve) => {
      if (ctx.signal.aborted) return resolve('aborted');
      ctx.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), ASK_TIMEOUT_MS);
    });

    // 发 interaction 事件（桌面端据此弹模态）
    ctx.emitEvent({
      type: 'interaction',
      id,
      questions,
      timestamp: Date.now(),
    });

    const outcome = await Promise.race([
      answersPromise.then((answers) => ({ kind: 'answered' as const, answers })),
      abortPromise.then(() => ({ kind: 'aborted' as const })),
      timeoutPromise.then(() => ({ kind: 'timeout' as const })),
    ]);

    // 落败方（timeout/abort）清自己的注册，防泄漏 + 防迟到的提交唤醒 stale resolve
    if (outcome.kind !== 'answered') {
      unregisterInteraction(id);
    }

    if (outcome.kind === 'answered') return formatAnswers(questions, outcome.answers);
    if (outcome.kind === 'timeout') return TIMEOUT_SENTINEL;
    return ABORT_SENTINEL;
  },
  meta: { readonly: true, concurrent: false },
};

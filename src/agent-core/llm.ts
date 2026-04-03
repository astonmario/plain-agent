/**
 * LLM 调用封装（OpenAI 兼容）
 * 参考 plaincode/src/llm.ts 的简洁实现
 */

import type { ChatMessage, LLMConfig, ToolSchema } from './types';

// ============ 响应类型 ============

export interface LLMResponse {
  role: 'assistant';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface StreamChunk {
  text?: string;
  toolCall?: {
    index: number;
    id?: string;
    name?: string;
    argsDelta?: string;
  };
  finishReason?: string;
}

// ============ 错误处理 ============

const RETRYABLE_STATUS = new Set([429, 500, 503]);
const MAX_RETRIES = 3;

export class LLMError extends Error {
  constructor(public status: number, message: string) {
    super(`LLM 请求失败 [${status}]: ${message}`);
    this.name = 'LLMError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ 核心请求函数 ============

async function request(
  config: LLMConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  stream: boolean,
  signal?: AbortSignal
): Promise<Response> {
  const baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  const url = `${baseUrl}/chat/completions`;

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          stream,
          max_tokens: config.maxTokens,
        }),
        signal,
      });

      if (res.ok) return res;

      const body = await res.text();

      // 不可重试的错误直接抛出
      if (!RETRYABLE_STATUS.has(res.status) || attempt >= MAX_RETRIES) {
        throw new LLMError(res.status, body);
      }

      // 指数退避重试
      await sleep(Math.min(500 * 2 ** attempt, 4000));
    } catch (error) {
      // AbortError 直接抛出，不重试
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }

      // 其他错误重试
      if (attempt >= MAX_RETRIES) {
        throw error;
      }

      await sleep(Math.min(500 * 2 ** attempt, 4000));
    }
  }
}

// ============ 导出函数 ============

/**
 * 非流式调用（返回完整响应）
 */
export async function callLLM(
  config: LLMConfig,
  messages: ChatMessage[],
  tools: ToolSchema[] = [],
  signal?: AbortSignal
): Promise<LLMResponse> {
  const res = await request(config, messages, tools, false, signal);
  const data = await res.json();

  const choice = data.choices?.[0];
  if (!choice) {
    throw new LLMError(500, 'No choices in response');
  }

  return {
    role: 'assistant',
    content: choice.message?.content || null,
    tool_calls: choice.message?.tool_calls,
  };
}

/**
 * 流式调用（返回异步生成器）
 */
export async function* streamLLM(
  config: LLMConfig,
  messages: ChatMessage[],
  tools: ToolSchema[] = [],
  signal?: AbortSignal
): AsyncGenerator<StreamChunk> {
  const res = await request(config, messages, tools, true, signal);

  if (!res.body) {
    throw new LLMError(500, '响应没有 body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;

        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta;

          if (!delta) continue;

          // 文本内容
          if (delta.content) {
            yield { text: delta.content };
          }

          // 工具调用
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              yield {
                toolCall: {
                  index: tc.index,
                  id: tc.id,
                  name: tc.function?.name,
                  argsDelta: tc.function?.arguments,
                },
              };
            }
          }

          // 结束原因
          if (json.choices?.[0]?.finish_reason) {
            yield { finishReason: json.choices[0].finish_reason };
          }
        } catch (e) {
          // 解析失败跳过这一行
          console.warn('Failed to parse SSE line:', line);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 工具调用累加器（将流式 delta 累加成完整的 tool_calls）
 */
export class ToolCallAccumulator {
  private calls: Map<number, {
    id?: string;
    name?: string;
    args: string;
  }> = new Map();

  add(chunk: StreamChunk): void {
    if (!chunk.toolCall) return;

    const { index, id, name, argsDelta } = chunk.toolCall;

    if (!this.calls.has(index)) {
      this.calls.set(index, { id, name, args: '' });
    }

    const call = this.calls.get(index)!;
    if (id) call.id = id;
    if (name) call.name = name;
    if (argsDelta) call.args += argsDelta;
  }

  getToolCalls(): Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> {
    const result: Array<any> = [];

    for (const [_, call] of this.calls) {
      if (call.id && call.name) {
        result.push({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: call.args,
          },
        });
      }
    }

    return result;
  }

  hasToolCalls(): boolean {
    return this.calls.size > 0;
  }
}

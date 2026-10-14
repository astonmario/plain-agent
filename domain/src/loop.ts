/**
 * ReAct 循环引擎

 */

import { streamLLM, ToolCallAccumulator } from './llm';
import type {
  ChatMessage,
  LLMConfig,
  ToolContext,
  Tool,
  AgentLoopResult,
  ToolCall
} from './types';

const CANCELLED_RESULT = '[已取消]';

/**
 * 工具能否与同轮其他工具并发执行：显式 meta.concurrent 优先，否则只读即可并发
 */
function isConcurrent(tool: Tool | undefined): boolean {
  if (!tool) return true; // 工具未找到只返回错误串，无副作用
  return tool.meta?.concurrent ?? tool.meta?.readonly ?? false;
}

/**
 * 把同一轮的 tool_calls 切成批次：连续的可并发调用合为一批并行执行，
 * 不可并发的调用单独成批。批次之间串行，保证有副作用的工具按 LLM 给出的顺序执行。
 */
function planBatches(calls: ToolCall[], tools: Tool[]): ToolCall[][] {
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  for (const call of calls) {
    if (isConcurrent(tools.find(t => t.name === call.function.name))) {
      current.push(call);
    } else {
      if (current.length > 0) batches.push(current);
      batches.push([call]);
      current = [];
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Agent 主循环：ReAct 范式
 * LLM → tool call → tool result → LLM ... 直到完成
 */
export async function agentLoop(
  task: string,
  messages: ChatMessage[],
  ctx: ToolContext,
  tools: Tool[],
  llmConfig: LLMConfig,
  maxIterations: number = 150
): Promise<AgentLoopResult> {

  // 添加用户消息
  const userMsg: ChatMessage = {
    role: 'user',
    content: task,
  };
  messages.push(userMsg);

  // 发射用户事件
  ctx.emitEvent({
    type: 'user',
    message: task,
    timestamp: Date.now(),
  });

  // 构建工具 schema
  const toolSchemas = tools.map(t => t.schema);

  // ReAct 主循环
  for (let i = 0; i < maxIterations; i++) {
    // 检查中断信号
    if (ctx.signal.aborted) {
      ctx.emitEvent({
        type: 'stopped',
        timestamp: Date.now(),
      });
      return {
        result: '[stopped]',
        messages,
        stopReason: 'stopped',
      };
    }

    // 发射迭代事件
    ctx.emitEvent({
      type: 'iteration',
      index: i + 1,
      timestamp: Date.now(),
    });

    // 调用 LLM
    ctx.emitEvent({
      type: 'thinking',
      content: '思考中...',
      timestamp: Date.now(),
    });

    let responseContent = '';
    let responseToolCalls: ToolCall[] | undefined;
    try {
      // 流式调用 LLM，边接收边发射文本增量
      const accumulator = new ToolCallAccumulator();
      for await (const chunk of streamLLM(llmConfig, messages, toolSchemas, ctx.signal)) {
        if (chunk.text) {
          responseContent += chunk.text;
          ctx.emitEvent({
            type: 'text_delta',
            delta: chunk.text,
            timestamp: Date.now(),
          });
        } else if (chunk.toolCall) {
          accumulator.add(chunk);
        }
      }

      const toolCalls = accumulator.getToolCalls();
      if (toolCalls.length > 0) {
        responseToolCalls = toolCalls as ToolCall[];
      }
    } catch (error) {
      // LLM 调用失败
      if (error instanceof Error && error.name === 'AbortError') {
        ctx.emitEvent({
          type: 'stopped',
          timestamp: Date.now(),
        });
        return {
          result: '[stopped]',
          messages,
          stopReason: 'stopped',
        };
      }
      throw error;
    }

    const response = {
      role: 'assistant' as const,
      content: responseContent,
      tool_calls: responseToolCalls,
    };

    // 将 LLM 响应添加到消息历史
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: response.content,
      tool_calls: response.tool_calls,
    };
    messages.push(assistantMsg);

    // 处理响应
    if (response.tool_calls && response.tool_calls.length > 0) {
      // 有工具调用：按批次执行（批内并发、批间串行），结果按 tool_calls 原顺序入历史
      const results = new Map<string, string>();
      let stopped = false;

      for (const batch of planBatches(response.tool_calls, tools)) {
        // 每批执行前检查取消状态
        if (ctx.signal.aborted) {
          stopped = true;
          break;
        }
        const batchResults = await Promise.all(batch.map(call => executeToolCall(call, tools, ctx)));
        batch.forEach((call, j) => results.set(call.id, batchResults[j]));
      }

      // 每个 tool_call 都必须有对应的 tool 消息，否则下次请求会被 API 拒绝；
      // 中断时未执行的调用补"已取消"
      for (const call of response.tool_calls) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: results.get(call.id) ?? CANCELLED_RESULT,
        });
      }

      if (stopped) {
        ctx.emitEvent({
          type: 'stopped',
          timestamp: Date.now(),
        });
        return {
          result: '[stopped]',
          messages,
          stopReason: 'stopped',
        };
      }
    } else {
      // 没有工具调用：认为是最终回答
      const answer = response.content || '';

      ctx.emitEvent({
        type: 'assistant',
        message: answer,
        timestamp: Date.now(),
      });

      ctx.emitEvent({
        type: 'done',
        result: answer,
        timestamp: Date.now(),
      });

      return {
        result: answer,
        messages,
        stopReason: 'completed',
      };
    }
  }

  // 达到最大迭代次数
  const finalMessage = `达到最大迭代次数 ${maxIterations}，任务未完成`;

  ctx.emitEvent({
    type: 'assistant',
    message: finalMessage,
    timestamp: Date.now(),
  });

  return {
    result: finalMessage,
    messages,
    stopReason: 'max_iterations',
  };
}

/**
 * 执行单个工具调用
 */
async function executeToolCall(
  call: ToolCall,
  tools: Tool[],
  ctx: ToolContext
): Promise<string> {
  const startTime = Date.now();
  const callId = call.id;

  const emitResult = (tool: string, result: string): string => {
    ctx.emitEvent({
      type: 'tool_result',
      tool,
      result: result.slice(0, 500), // 截断过长的结果
      duration: Date.now() - startTime,
      callId,
      timestamp: Date.now(),
    });
    return result;
  };

  // 查找工具
  const tool = tools.find(t => t.name === call.function.name);

  if (!tool) {
    return emitResult(call.function.name, `工具未找到: ${call.function.name}`);
  }

  // 解析参数
  let args: any;
  try {
    args = JSON.parse(call.function.arguments);
  } catch (error) {
    return emitResult(tool.name, `参数解析失败: ${call.function.arguments}`);
  }

  // 权限检查
  if (ctx.permissionCheck) {
    const allowed = await ctx.permissionCheck(tool, args);
    if (!allowed) {
      return emitResult(tool.name, `[权限拒绝] 工具 ${tool.name} 需要用户授权`);
    }
  }

  // 执行前再次检查取消状态
  if (ctx.signal.aborted) {
    return emitResult(tool.name, CANCELLED_RESULT);
  }

  // 发射工具开始事件
  ctx.emitEvent({
    type: 'tool_start',
    tool: tool.name,
    args,
    callId,
    timestamp: Date.now(),
  });

  // 执行工具
  try {
    return emitResult(tool.name, await tool.handler(args, ctx));
  } catch (error) {
    const errorMsg = error instanceof Error
      ? `工具执行失败: ${error.message}`
      : `工具执行失败: ${String(error)}`;
    return emitResult(tool.name, errorMsg);
  }
}

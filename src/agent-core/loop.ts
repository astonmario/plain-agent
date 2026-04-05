/**
 * ReAct 循环引擎
 * 参考 anycode/domain/src/core.ts 的实现
 */

import { callLLM } from './llm';
import type {
  ChatMessage,
  ToolContext,
  Tool,
  AgentLoopResult,
  ToolCall
} from './types';

/**
 * Agent 主循环：ReAct 范式
 * LLM → tool call → tool result → LLM ... 直到完成
 */
export async function agentLoop(
  task: string,
  messages: ChatMessage[],
  ctx: ToolContext,
  tools: Tool[],
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

    let response;
    try {
      response = await callLLM(
        {
          provider: 'openai',
          apiKey: process.env.OPENAI_API_KEY || '',
          model: process.env.MODEL || 'gpt-4',
          baseUrl: process.env.BASE_URL,
        },
        messages,
        toolSchemas,
        ctx.signal
      );
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

    // 将 LLM 响应添加到消息历史
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: response.content,
      tool_calls: response.tool_calls,
    };
    messages.push(assistantMsg);

    // 处理响应
    if (response.tool_calls && response.tool_calls.length > 0) {
      // 有工具调用：执行工具
      for (const call of response.tool_calls) {
        const result = await executeToolCall(call, tools, ctx);

        // 将工具结果添加到消息历史
        const toolMsg: ChatMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: result,
        };
        messages.push(toolMsg);
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

  // 查找工具
  const tool = tools.find(t => t.name === call.function.name);

  if (!tool) {
    const errorMsg = `工具未找到: ${call.function.name}`;
    ctx.emitEvent({
      type: 'tool_result',
      tool: call.function.name,
      result: errorMsg,
      duration: Date.now() - startTime,
      timestamp: Date.now(),
    });
    return errorMsg;
  }

  // 解析参数
  let args: any;
  try {
    args = JSON.parse(call.function.arguments);
  } catch (error) {
    const errorMsg = `参数解析失败: ${call.function.arguments}`;
    ctx.emitEvent({
      type: 'tool_result',
      tool: tool.name,
      result: errorMsg,
      duration: Date.now() - startTime,
      timestamp: Date.now(),
    });
    return errorMsg;
  }

  // 权限检查
  if (ctx.permissionCheck) {
    const allowed = await ctx.permissionCheck(tool, args);
    if (!allowed) {
      const errorMsg = `[权限拒绝] 工具 ${tool.name} 需要用户授权`;
      ctx.emitEvent({
        type: 'tool_result',
        tool: tool.name,
        result: errorMsg,
        duration: Date.now() - startTime,
        timestamp: Date.now(),
      });
      return errorMsg;
    }
  }

  // 发射工具开始事件
  ctx.emitEvent({
    type: 'tool_start',
    tool: tool.name,
    args,
    timestamp: Date.now(),
  });

  // 执行工具
  try {
    const result = await tool.handler(args, ctx);

    // 发射工具结果事件
    ctx.emitEvent({
      type: 'tool_result',
      tool: tool.name,
      result: result.slice(0, 500), // 截断过长的结果
      duration: Date.now() - startTime,
      timestamp: Date.now(),
    });

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error
      ? `工具执行失败: ${error.message}`
      : `工具执行失败: ${String(error)}`;

    ctx.emitEvent({
      type: 'tool_result',
      tool: tool.name,
      result: errorMsg,
      duration: Date.now() - startTime,
      timestamp: Date.now(),
    });

    return errorMsg;
  }
}

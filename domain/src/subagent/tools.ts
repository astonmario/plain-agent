/**
 * Subagent 工具实现
 *
 * 提供给 Agent 使用的子任务工具：
 * - spawn_subagent: 创建子任务
 * - wait_subagent: 等待子任务完成
 * - cancel_subagent: 取消子任务
 * - get_subagent_status: 查询子任务状态
 */

import type { Tool } from '../types';
import type { SubagentRuntime } from './runtime';
import type { SubagentResult } from './types';

/**
 * 等待子任务；父任务被停止时一并取消子任务，避免子 Agent 在后台继续运行
 */
async function waitFollowingParent(
  runtime: SubagentRuntime,
  runId: string,
  signal: AbortSignal,
  timeout?: number
): Promise<SubagentResult> {
  const onAbort = () => { runtime.cancel(runId).catch(() => {}); };
  if (signal.aborted) onAbort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await runtime.wait(runId, timeout);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 创建子任务工具
 */
export function createSpawnSubagentTool(): Tool {
  return {
    name: 'spawn_subagent',
    description: 'Create and start a subtask using a sub-agent. Use this to delegate independent work or parallelize tasks.',
    schema: {
      type: 'function',
      function: {
        name: 'spawn_subagent',
        description: 'Create and start a subtask using a sub-agent',
        parameters: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: 'Clear description of the subtask to accomplish',
            },
            role: {
              type: 'string',
              description: 'Optional role for the sub-agent (e.g., "code reviewer", "test generator")',
            },
            context_summary: {
              type: 'string',
              description: 'Brief context summary to pass to the sub-agent (avoid full conversation history)',
            },
            relevant_files: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of file paths relevant to this subtask',
            },
            allowed_tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool whitelist for the sub-agent. If not specified, only read-only tools are allowed.',
            },
            max_iterations: {
              type: 'number',
              description: 'Maximum iterations for the sub-agent (default: 50)',
            },
            wait: {
              type: 'boolean',
              description: 'Whether to wait for completion before returning (default: false)',
            },
          },
          required: ['task'],
        },
      },
    },
    handler: async (args, ctx) => {
      const runtime = (ctx as any).subagentRuntime as SubagentRuntime | undefined;

      if (!runtime) {
        return 'Error: Subagent runtime not available. This feature may not be enabled.';
      }

      try {
        const { runId } = await runtime.spawn({
          parentRunId: ctx.sessionId, // 使用 sessionId 作为父任务 ID
          task: args.task,
          role: args.role,
          context: {
            summary: args.context_summary,
            files: args.relevant_files || [],
          },
          tools: args.allowed_tools,
          config: {
            maxIterations: args.max_iterations || 50,
          },
        });

        if (args.wait) {
          // 等待完成
          const result = await waitFollowingParent(runtime, runId, ctx.signal);

          if (result.status === 'completed') {
            return `Subtask completed successfully.\n\nRun ID: ${runId}\n\nResult:\n${result.output}\n\nStats: ${result.stats?.iterations} iterations, ${result.stats?.toolCalls} tool calls, ${result.stats?.duration}ms`;
          } else {
            return `Subtask failed.\n\nRun ID: ${runId}\nStatus: ${result.status}\nError: ${result.error || 'Unknown error'}`;
          }
        } else {
          // 异步创建，返回 runId
          return `Subtask created and started in background.\n\nRun ID: ${runId}\n\nUse wait_subagent tool to check completion or retrieve results.`;
        }
      } catch (error: any) {
        return `Error spawning subagent: ${error.message}`;
      }
    },
    meta: {
      dangerous: false,
      readonly: false,
      // 子 Agent 各自隔离，并发上限由 runtime 控制：同轮多个 spawn 可并行
      concurrent: true,
      tags: ['subagent', 'delegation'],
    },
  };
}

/**
 * 等待子任务完成工具
 */
export function createWaitSubagentTool(): Tool {
  return {
    name: 'wait_subagent',
    description: 'Wait for a sub-agent task to complete and retrieve its results',
    schema: {
      type: 'function',
      function: {
        name: 'wait_subagent',
        description: 'Wait for a sub-agent task to complete',
        parameters: {
          type: 'object',
          properties: {
            run_id: {
              type: 'string',
              description: 'The run ID returned by spawn_subagent',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds (default: 300000 = 5 minutes)',
            },
          },
          required: ['run_id'],
        },
      },
    },
    handler: async (args, ctx) => {
      const runtime = (ctx as any).subagentRuntime as SubagentRuntime | undefined;

      if (!runtime) {
        return 'Error: Subagent runtime not available.';
      }

      try {
        const result = await waitFollowingParent(runtime, args.run_id, ctx.signal, args.timeout);

        if (result.status === 'completed') {
          let output = `Subtask ${args.run_id} completed successfully.\n\n`;
          output += `Result:\n${result.output}\n\n`;

          if (result.summary) {
            output += `Summary:\n${result.summary}\n\n`;
          }

          if (result.artifacts && result.artifacts.length > 0) {
            output += `Artifacts (${result.artifacts.length}):\n`;
            result.artifacts.forEach((a, i) => {
              output += `${i + 1}. ${a.type}: ${a.path || 'inline'}\n`;
            });
            output += '\n';
          }

          if (result.stats) {
            output += `Stats: ${result.stats.iterations} iterations, ${result.stats.toolCalls} tool calls, ${result.stats.duration}ms`;
          }

          return output;
        } else {
          return `Subtask ${args.run_id} ${result.status}.\nError: ${result.error || 'Unknown error'}`;
        }
      } catch (error: any) {
        return `Error waiting for subagent: ${error.message}`;
      }
    },
    meta: {
      dangerous: false,
      readonly: true,
      tags: ['subagent'],
    },
  };
}

/**
 * 取消子任务工具
 */
export function createCancelSubagentTool(): Tool {
  return {
    name: 'cancel_subagent',
    description: 'Cancel a running sub-agent task',
    schema: {
      type: 'function',
      function: {
        name: 'cancel_subagent',
        description: 'Cancel a running sub-agent task',
        parameters: {
          type: 'object',
          properties: {
            run_id: {
              type: 'string',
              description: 'The run ID of the sub-agent to cancel',
            },
          },
          required: ['run_id'],
        },
      },
    },
    handler: async (args, ctx) => {
      const runtime = (ctx as any).subagentRuntime as SubagentRuntime | undefined;

      if (!runtime) {
        return 'Error: Subagent runtime not available.';
      }

      try {
        await runtime.cancel(args.run_id);
        return `Subtask ${args.run_id} cancelled successfully.`;
      } catch (error: any) {
        return `Error cancelling subagent: ${error.message}`;
      }
    },
    meta: {
      dangerous: false,
      readonly: false,
      concurrent: true,
      tags: ['subagent'],
    },
  };
}

/**
 * 查询子任务状态工具
 */
export function createGetSubagentStatusTool(): Tool {
  return {
    name: 'get_subagent_status',
    description: 'Get the current status of a sub-agent task (non-blocking)',
    schema: {
      type: 'function',
      function: {
        name: 'get_subagent_status',
        description: 'Get the current status of a sub-agent task',
        parameters: {
          type: 'object',
          properties: {
            run_id: {
              type: 'string',
              description: 'The run ID of the sub-agent to check',
            },
          },
          required: ['run_id'],
        },
      },
    },
    handler: async (args, ctx) => {
      const runtime = (ctx as any).subagentRuntime as SubagentRuntime | undefined;

      if (!runtime) {
        return 'Error: Subagent runtime not available.';
      }

      try {
        const status = await runtime.getStatus(args.run_id);

        let output = `Subtask ${args.run_id} status: ${status.status}\n\n`;
        output += `Created: ${new Date(status.createdAt).toISOString()}\n`;

        if (status.startedAt) {
          output += `Started: ${new Date(status.startedAt).toISOString()}\n`;
        }

        if (status.finishedAt) {
          output += `Finished: ${new Date(status.finishedAt).toISOString()}\n`;
          const duration = status.finishedAt - (status.startedAt || status.createdAt);
          output += `Duration: ${duration}ms\n`;
        }

        if (status.progress) {
          output += `\nProgress: ${status.progress}`;
        }

        return output;
      } catch (error: any) {
        return `Error getting subagent status: ${error.message}`;
      }
    },
    meta: {
      dangerous: false,
      readonly: true,
      tags: ['subagent'],
    },
  };
}

/**
 * 获取所有子任务工具
 */
export function getSubagentTools(): Tool[] {
  return [
    createSpawnSubagentTool(),
    createWaitSubagentTool(),
    createCancelSubagentTool(),
    createGetSubagentStatusTool(),
  ];
}

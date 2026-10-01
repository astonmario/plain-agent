/**
 * 后台任务查询/终止工具（搬运自 any-code）
 * job_output：查询单个任务输出或列出全部
 * job_kill：终止后台任务
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import type { Tool, ToolContext } from '../types';
import type { JobRegistry } from './jobs';

function getJobs(ctx: ToolContext): JobRegistry | undefined {
  return (ctx as any).jobs as JobRegistry | undefined;
}

export const jobOutputTool: Tool = {
  name: 'job_output',
  description: '查询后台任务输出。带 id 读单个任务输出/状态，不带 id 列出全部任务。',
  schema: {
    type: 'function',
    function: {
      name: 'job_output',
      description: '查询后台任务输出',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: '任务 id（不带则列出全部）',
          },
        },
      },
    },
  },
  handler: async (args, ctx: ToolContext) => {
    const jobs = getJobs(ctx);
    if (!jobs) return 'Error: 后台任务不可用（当前环境未启用任务注册表）';

    if (args.id) {
      const jobId = args.id.trim();
      const job = jobs.get(jobId);

      // 内存中有任务记录
      if (job) {
        const status = job.done ? `已完成（exit code ${job.exitCode}）` : '运行中';
        return `[${job.id}] ${status}\n命令：${job.command}\n输出：\n${job.output || '（暂无输出）'}`;
      }

      // 内存中没有（可能已过期或应用重启），尝试从日志文件读取
      try {
        const logPath = join(homedir(), '.plain-agent', 'sessions', ctx.sessionId, 'jobs', `${jobId}.log`);
        if (existsSync(logPath)) {
          const content = readFileSync(logPath, 'utf-8');
          return `[${jobId}] 已完成（从日志文件恢复）\n输出：\n${content || '（无输出）'}`;
        }
      } catch (err) {
        // 文件读取失败，继续走错误提示
      }

      // 既无内存记录又无日志文件
      const all = jobs.list().map((j) => j.id).join(', ');
      return `Error: job ${jobId} 不存在。${all ? `现有任务：${all}` : '当前无后台任务。'}`;
    }

    const all = jobs.list();
    if (all.length === 0) return '当前无后台任务。';
    return all
      .map((j) => `[${j.id}] ${j.done ? `已完成（exit ${j.exitCode}）` : '运行中'} · ${j.command.slice(0, 60)}`)
      .join('\n');
  },
  meta: {
    readonly: true,
    concurrent: true,
    dangerous: false,
  },
};

export const jobKillTool: Tool = {
  name: 'job_kill',
  description: '终止后台任务（SIGTERM）。',
  schema: {
    type: 'function',
    function: {
      name: 'job_kill',
      description: '终止后台任务',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: '要终止的任务 id',
          },
        },
        required: ['id'],
      },
    },
  },
  handler: async (args, ctx: ToolContext) => {
    const jobs = getJobs(ctx);
    if (!jobs) return 'Error: 后台任务不可用';
    const id = args.id?.trim();
    if (!id) return 'Error: 需要 id 参数';
    const ok = jobs.kill(id);
    if (!ok) return `Error: job ${id} 不存在`;
    return `后台任务 ${id} 已终止（SIGTERM）`;
  },
  meta: {
    readonly: false,
    concurrent: false,
    dangerous: true,
  },
};

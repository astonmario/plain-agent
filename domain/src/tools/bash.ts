/**
 * Bash 命令执行工具（搬运自 any-code，含后台任务）
 * 前台：spawn + 超时 + 输出截断 + GBK 解码
 * 后台：run_in_background → JobRegistry（job_output 查询、job_kill 终止）
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Tool, ToolContext } from '../types';
import { killTree, detachedIfPosix } from './process-kill';
import { createStreamDecoder } from './text-decode';
import { resolveShell } from './shell';
import type { JobRegistry } from './jobs';

const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
const OUTPUT_MAX_LINES = 2000;
const OUTPUT_MAX_BYTES = 40_000;

/** 危险命令检测（简单安全层） */
function isDangerousCommand(command: string): boolean {
  const dangerous = [
    'rm -rf /',
    'rm -rf *',
    'format',
    'del /f /s /q',
    ':(){:|:&};:',
    'dd if=/dev/zero',
    'mkfs.',
    '> /dev/sda',
  ];
  const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim();
  return dangerous.some((p) => normalized.includes(p.toLowerCase()));
}

/** 后台符逃逸检测：尾部 & / nohup / & disown 应改用 run_in_background。 */
function detectBackgroundEscape(command: string): string | null {
  const stripped = command.replace(/"[^"]*"|'[^']*'/g, '""').trim();
  if (/^nohup\s/.test(stripped) || /^setsid\s/.test(stripped)) return 'nohup/setsid';
  if (/\s&\s*disown\b/.test(stripped)) return '& disown';
  if (/&\s*$/.test(stripped)) return '尾部的 &';
  return null;
}

/** 超限输出落盘，返回 spill 文件路径。 */
function spillOutput(out: string): string | null {
  try {
    const file = join(tmpdir(), `plain-agent-bash-${randomBytes(6).toString('hex')}.log`);
    writeFileSync(file, out, 'utf-8');
    return file;
  } catch {
    return null;
  }
}

/** 双限截断：保留头部，附截断标记。 */
function capBashOutput(out: string): { text: string; truncated: boolean; spillFile?: string } {
  const lines = out.split('\n');
  const truncated =
    lines.length > OUTPUT_MAX_LINES || Buffer.byteLength(out, 'utf-8') > OUTPUT_MAX_BYTES;
  if (!truncated) return { text: out, truncated: false };

  let kept = out;
  if (Buffer.byteLength(kept, 'utf-8') > OUTPUT_MAX_BYTES) {
    let end = OUTPUT_MAX_BYTES;
    while (end > 0 && (out.charCodeAt(end) & 0xc0) === 0x80) end--;
    kept = out.slice(0, end);
    kept = kept.split('\n').slice(0, OUTPUT_MAX_LINES).join('\n');
  } else {
    kept = lines.slice(0, OUTPUT_MAX_LINES).join('\n');
  }
  const spillFile = spillOutput(out) ?? undefined;
  const spillNote = spillFile ? `\n[完整输出已写入文件：${spillFile}（可用 read 工具分段查看）]` : '';
  const text =
    `${kept}\n[输出截断：共 ${lines.length} 行 / ${Buffer.byteLength(out, 'utf-8')} 字节，仅保留前 ${kept.split('\n').length} 行]${spillNote}`;
  return { text, truncated: true, spillFile };
}

function resolveTimeoutMs(timeoutMs?: number): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return BASH_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.round(timeoutMs), 1000), BASH_MAX_TIMEOUT_MS);
}

export const bashTool: Tool = {
  name: 'bash',
  description: '执行 shell 命令。支持后台执行（run_in_background），超时和输出截断。',
  schema: {
    type: 'function',
    function: {
      name: 'bash',
      description: '执行 shell 命令',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 shell 命令',
          },
          timeout_ms: {
            type: 'number',
            description: '超时毫秒（1s-600s，默认 120s）',
          },
          run_in_background: {
            type: 'boolean',
            description: '后台执行（立即返回 job id，用 job_output 查询输出）',
          },
          intent: {
            type: 'string',
            description: '一句意图描述（可选）',
          },
        },
        required: ['command'],
      },
    },
  },
  handler: async (args, ctx: ToolContext) => {
    const command = args.command;

    if (isDangerousCommand(command)) {
      return `[安全拒绝] 检测到危险命令，拒绝执行: ${command}`;
    }

    // 后台符逃逸检测
    if (args.run_in_background !== true) {
      const escape = detectBackgroundEscape(command);
      if (escape) {
        return `Error: 检测到 shell 后台符（${escape}）。需要后台运行时，请改用 run_in_background 参数。`;
      }
    }

    const intent = typeof args.intent === 'string' && args.intent.trim()
      ? args.intent.trim().slice(0, 60)
      : undefined;

    // 后台执行
    if (args.run_in_background) {
      const jobs = (ctx as any).jobs as JobRegistry | undefined;
      if (!jobs) return 'Error: 后台任务不可用';
      try {
        const { binary, cwd } = resolveShell(process.cwd(), (ctx as any).gitBashPath);
        const id = jobs.launch(binary, ['-c', command], cwd, intent, ctx.sessionId);
        return `后台任务已启动：job_id=${id}\n用 job_output 工具查看输出（参数 id="${id}"），完成后用 job_kill 终止（如需）。`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    }

    // 前台执行
    return new Promise<string>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (value: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };

      let child;
      try {
        const { binary, cwd } = resolveShell(process.cwd(), (ctx as any).gitBashPath);
        child = spawn(binary, ['-c', command], {
          cwd,
          signal: ctx.signal,
          windowsHide: true,
          ...detachedIfPosix,
        });
      } catch (err) {
        finish(`Error: ${(err as Error).message}`);
        return;
      }

      timer = setTimeout(() => killTree(child), resolveTimeoutMs(args.timeout_ms));

      const decOut = createStreamDecoder();
      const decErr = createStreamDecoder();
      child.stdout?.on('data', (c: Buffer) => { stdout += decOut.decode(c); });
      child.stderr?.on('data', (c: Buffer) => { stderr += decErr.decode(c); });

      child.on('error', (err: Error) => finish(`Error: ${err.message}`));
      child.on('close', (code: number | null, signal: string | null) => {
        const raw = `${stdout}${stderr}`.trim();
        const timedOut = signal === 'SIGTERM';
        const cap = capBashOutput(raw);
        const content = timedOut
          ? `[Timed out after ${resolveTimeoutMs(args.timeout_ms)}ms]\n${cap.text}`
          : code !== 0
            ? cap.text || `Error: exit code ${code}`
            : cap.text;
        finish(content);
      });
    });
  },
  meta: {
    readonly: false,
    concurrent: false,
    dangerous: true,
  },
};

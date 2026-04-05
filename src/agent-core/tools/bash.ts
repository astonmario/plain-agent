/**
 * Bash 命令执行工具
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { Tool } from '../types';

const execAsync = promisify(exec);

/**
 * 危险命令检测
 */
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

  return dangerous.some(pattern => {
    const normalizedPattern = pattern.toLowerCase();
    return normalized.includes(normalizedPattern);
  });
}

/**
 * Bash 命令执行工具
 */
export const bashTool: Tool = {
  name: 'bash',
  description: '执行 shell 命令。可以运行各种命令行程序，查看文件、列出目录、运行脚本等。',
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
        },
        required: ['command'],
      },
    },
  },
  handler: async (args, ctx) => {
    const command = args.command;

    // 危险命令检测
    if (isDangerousCommand(command)) {
      return `[安全拒绝] 检测到危险命令，拒绝执行: ${command}`;
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: 30000, // 30 秒超时
        maxBuffer: 10 * 1024 * 1024, // 10MB 缓冲区
        signal: ctx.signal, // 支持中断
      });

      // 返回结果
      let result = '';
      if (stdout) {
        result += `stdout:\n${stdout}`;
      }
      if (stderr) {
        if (result) result += '\n\n';
        result += `stderr:\n${stderr}`;
      }

      return result || '[命令执行完成，无输出]';
    } catch (error) {
      if (error instanceof Error) {
        // 检查是否是中断错误
        if (error.name === 'AbortError') {
          return '[命令执行被中断]';
        }

        return `命令执行失败: ${error.message}`;
      }
      return `命令执行失败: ${String(error)}`;
    }
  },
  meta: {
    readonly: false,
    concurrent: false,
    dangerous: true,
  },
};

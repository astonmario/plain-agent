/**
 * 实用工具集
 */

import type { Tool } from '../types.js';

/**
 * 列出目录内容
 */
export const listDirectoryTool: Tool = {
  name: 'list_directory',
  description: '列出指定目录下的文件和子目录',
  schema: {
    type: 'function',
    function: {
      name: 'list_directory',
      description: '列出指定目录下的文件和子目录',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '目录路径，默认为当前目录',
          },
        },
      },
    },
  },

  handler: async (args) => {
    const { path = '.' } = args as { path?: string };
    const { readdirSync, statSync } = await import('fs');
    const { join } = await import('path');

    try {
      const items = readdirSync(path);
      const result = items.map(item => {
        try {
          const fullPath = join(path, item);
          const stats = statSync(fullPath);
          return {
            name: item,
            type: stats.isDirectory() ? 'directory' : 'file',
            size: stats.isFile() ? stats.size : undefined,
          };
        } catch {
          return { name: item, type: 'unknown' };
        }
      });

      return JSON.stringify(result, null, 2);
    } catch (error) {
      throw new Error(`无法读取目录: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  meta: {
    tags: ['directory', 'ls', 'files'],
  },
};

/**
 * 计算器工具
 */
export const calculatorTool: Tool = {
  name: 'calculator',
  description: '执行数学计算。支持基本运算、三角函数、对数等',
  schema: {
    type: 'function',
    function: {
      name: 'calculator',
      description: '执行数学计算。支持基本运算、三角函数、对数等',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '数学表达式，例如: "2 + 3 * 4", "Math.sin(Math.PI/2)", "Math.sqrt(16)"',
          },
        },
        required: ['expression'],
      },
    },
  },

  handler: async (args) => {
    const { expression } = args as { expression: string };

    try {
      // 安全检查：只允许数学表达式
      const dangerousPatterns = [
        /require/i,
        /import/i,
        /eval/i,
        /function/i,
        /=>/,
        /\bprocess\b/,
        /\bglobal\b/,
        /\bconsole\b/,
      ];

      for (const pattern of dangerousPatterns) {
        if (pattern.test(expression)) {
          throw new Error('表达式包含不允许的关键字');
        }
      }

      // 使用 Function 构造器安全执行
      const result = new Function(`return ${expression}`)();

      return typeof result === 'number'
        ? result.toString()
        : JSON.stringify(result);
    } catch (error) {
      throw new Error(`计算失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  meta: {
    tags: ['math', 'calculation'],
  },
};

/**
 * 当前时间工具
 */
export const datetimeTool: Tool = {
  name: 'get_datetime',
  description: '获取当前日期和时间',
  schema: {
    type: 'function',
    function: {
      name: 'get_datetime',
      description: '获取当前日期和时间',
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            description: '时间格式: "iso"（ISO 8601）或 "readable"（可读格式）',
            enum: ['iso', 'readable'],
          },
        },
      },
    },
  },

  handler: async (args) => {
    const { format = 'readable' } = args as { format?: 'iso' | 'readable' };
    const now = new Date();

    if (format === 'iso') {
      return now.toISOString();
    } else {
      return now.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    }
  },

  meta: {
    tags: ['time', 'date'],
  },
};

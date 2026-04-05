/**
 * 工具系统基础定义和导出
 */

export type { Tool, ToolSchema, ToolContext, ToolMeta } from '../types';

// 内置工具
export { readFileTool } from './file';
export { writeFileTool } from './file';
export { bashTool } from './bash';

// 工具注册表
import { readFileTool, writeFileTool } from './file';
import { bashTool } from './bash';
import type { Tool } from '../types';

/**
 * 获取所有内置工具
 */
export function getBuiltinTools(): Tool[] {
  return [
    readFileTool,
    writeFileTool,
    bashTool,
  ];
}

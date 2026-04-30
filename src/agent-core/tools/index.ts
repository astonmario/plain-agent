/**
 * 工具系统基础定义和导出
 */

export type { Tool, ToolSchema, ToolContext, ToolMeta } from '../types';

// 内置工具
export { readFileTool, writeFileTool } from './file';
export { bashTool } from './bash';
export { httpGetTool } from './network';
export { listDirectoryTool, calculatorTool, datetimeTool } from './utility';
export { createHistoryLookupTool, createHistorySearchTool } from './history-lookup';

// 工具注册表
import { readFileTool, writeFileTool } from './file';
import { bashTool } from './bash';
import { httpGetTool } from './network';
import { listDirectoryTool, calculatorTool, datetimeTool } from './utility';
import type { Tool } from '../types';

/**
 * 获取所有内置工具
 */
export function getBuiltinTools(): Tool[] {
  return [
    readFileTool,
    writeFileTool,
    bashTool,
    httpGetTool,
    listDirectoryTool,
    calculatorTool,
    datetimeTool,
  ];
}

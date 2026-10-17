/**
 * 工具系统基础定义和导出
 */

export type { Tool, ToolSchema, ToolContext, ToolMeta } from '../types';

// 内置工具
export { readFileTool, writeFileTool, editFileTool, applyEdit } from './file';
export { bashTool } from './bash';
export { httpGetTool } from './network';
export { listDirectoryTool, calculatorTool, datetimeTool } from './utility';
export { exploreTool, globTool, grepTool } from './search';
export { jobOutputTool, jobKillTool } from './job-tools';
export { JobRegistry } from './jobs';
export { updateMemoryTool } from './memory-tool';
export { setSessionPreferencesTool } from './session-preferences';
export { createHistoryLookupTool, createHistorySearchTool } from './history-lookup';
export { webFetchTool, webSearchTool, htmlToMarkdown } from './web';
export { browserUseTool } from './browser';
export { askQuestionTool, ASK_TIMEOUT_MS } from './ask';
export { useSkillTool, createSkillTool } from './skill';

// 工具注册表
import { readFileTool, writeFileTool, editFileTool } from './file';
import { bashTool } from './bash';
import { httpGetTool } from './network';
import { listDirectoryTool, calculatorTool, datetimeTool } from './utility';
import { exploreTool, globTool, grepTool } from './search';
import { jobOutputTool, jobKillTool } from './job-tools';
import { updateMemoryTool } from './memory-tool';
import { setSessionPreferencesTool } from './session-preferences';
import { webFetchTool, webSearchTool } from './web';
import { browserUseTool } from './browser';
import { askQuestionTool } from './ask';
import { useSkillTool, createSkillTool } from './skill';
import type { Tool } from '../types';

/**
 * 获取所有内置工具
 */
export function getBuiltinTools(): Tool[] {
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    bashTool,
    httpGetTool,
    globTool,
    grepTool,
    exploreTool,
    listDirectoryTool,
    calculatorTool,
    datetimeTool,
    jobOutputTool,
    jobKillTool,
    updateMemoryTool,
    setSessionPreferencesTool,
    webFetchTool,
    webSearchTool,
    browserUseTool,
    askQuestionTool,
    useSkillTool,
    createSkillTool,
  ];
}

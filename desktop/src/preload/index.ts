/**
 * Preload 脚本
 * 通过 contextBridge 将主进程能力安全地暴露给渲染进程
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent } from '@plain-agent/domain';
import type { DesktopAPI } from '../shared/desktop-api.js';

const api: DesktopAPI = {
  submit: (task, taskId) => ipcRenderer.invoke('agent:submit', task, taskId),
  stop: (taskId) => ipcRenderer.invoke('agent:stop', taskId),
  getRunningTasks: () => ipcRenderer.invoke('agent:getRunningTasks'),
  answerInteraction: (id, answers) => ipcRenderer.invoke('agent:answerInteraction', id, answers),

  getSessionId: () => ipcRenderer.invoke('agent:getSessionId'),
  listSessions: () => ipcRenderer.invoke('agent:listSessions'),
  createSession: (title) => ipcRenderer.invoke('agent:createSession', title),
  switchSession: (sessionId) => ipcRenderer.invoke('agent:switchSession', sessionId),
  renameSession: (sessionId, newTitle) => ipcRenderer.invoke('agent:renameSession', sessionId, newTitle),
  deleteSession: (sessionId) => ipcRenderer.invoke('agent:deleteSession', sessionId),
  getMessages: (full) => ipcRenderer.invoke('agent:getMessages', full),
  getHistoryUsage: () => ipcRenderer.invoke('agent:getHistoryUsage'),
  loadHistory: () => ipcRenderer.invoke('agent:loadHistory'),
  compressHistory: (quick) => ipcRenderer.invoke('agent:compressHistory', quick),

  getConfig: () => ipcRenderer.invoke('agent:getConfig'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),

  getMcpConfig: () => ipcRenderer.invoke('mcp:getConfig'),
  saveMcpConfig: (config) => ipcRenderer.invoke('mcp:saveConfig', config),
  reloadMcp: () => ipcRenderer.invoke('mcp:reload'),
  getMcpTools: () => ipcRenderer.invoke('mcp:getTools'),
  getMcpToolCount: () => ipcRenderer.invoke('mcp:getToolCount'),

  listSkills: () => ipcRenderer.invoke('skills:list'),
  readSkill: (name) => ipcRenderer.invoke('skills:read', name),
  saveSkill: (input) => ipcRenderer.invoke('skills:save', input),
  deleteSkill: (name) => ipcRenderer.invoke('skills:delete', name),

  onEvent: (callback) => {
    const listener = (_e: Electron.IpcRendererEvent, event: AgentEvent) => {
      callback(event);
    };
    ipcRenderer.on('agent:event', listener);
    return () => {
      ipcRenderer.removeListener('agent:event', listener);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);

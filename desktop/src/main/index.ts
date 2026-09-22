/**
 * Electron 主进程入口
 * 创建窗口、注册 IPC、管理 Agent 服务
 */

import { app, shell, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import {
  createUserSkill,
  deleteUserSkill,
  listUserSkills,
  readUserSkill,
  submitInteractionAnswer,
  updateUserSkill,
} from '@plain-agent/domain';
import { AgentService } from './agent-service.js';

let mainWindow: BrowserWindow | null = null;
let agentService: AgentService | null = null;

/**
 * 创建主窗口
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Plain Agent',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // 开发环境加载 dev server，生产环境加载打包文件
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 注册所有 IPC handlers
 */
function registerIpcHandlers(): void {
  if (!agentService) return;

  // 任务相关
  ipcMain.handle('agent:submit', async (_e, task: string, taskId?: string) => {
    return agentService!.submit(task, taskId);
  });

  ipcMain.handle('agent:stop', (_e, taskId?: string) => {
    agentService!.stop(taskId);
  });

  ipcMain.handle('agent:getRunningTasks', () => {
    return agentService!.getRunningTasks();
  });

  // ask_question 回答：直接调 domain 的 pending 注册表（进程级单例，与 agent 实例共享）
  ipcMain.handle('agent:answerInteraction', (_e, id: string, answers: string[]) => {
    submitInteractionAnswer(id, answers);
  });

  // 会话相关
  ipcMain.handle('agent:getSessionId', () => {
    return agentService!.getSessionId();
  });

  ipcMain.handle('agent:listSessions', async () => {
    return agentService!.listSessions();
  });

  ipcMain.handle('agent:createSession', async (_e, title: string) => {
    return agentService!.createSession(title);
  });

  ipcMain.handle('agent:switchSession', async (_e, sessionId: string) => {
    return agentService!.switchSession(sessionId);
  });

  ipcMain.handle('agent:renameSession', async (_e, sessionId: string, newTitle: string) => {
    return agentService!.renameSession(sessionId, newTitle);
  });

  ipcMain.handle('agent:deleteSession', async (_e, sessionId: string) => {
    return agentService!.deleteSession(sessionId);
  });

  ipcMain.handle('agent:getMessages', (_e, full?: boolean) => {
    return agentService!.getMessages(full);
  });

  ipcMain.handle('agent:getHistoryUsage', () => {
    return agentService!.getHistoryUsage();
  });

  ipcMain.handle('agent:loadHistory', async () => {
    return agentService!.loadHistory();
  });

  ipcMain.handle('agent:compressHistory', async (_e, quick?: boolean) => {
    await agentService!.compressHistory(quick);
  });

  // 配置相关
  ipcMain.handle('agent:getConfig', () => {
    return agentService!.getConfig();
  });

  ipcMain.handle('settings:get', () => {
    return agentService!.getSettings();
  });

  ipcMain.handle('settings:update', async (_e, settings: any) => {
    await agentService!.updateSettings(settings);
  });

  // MCP 相关
  ipcMain.handle('mcp:getConfig', () => {
    return agentService!.getMcpConfig();
  });

  ipcMain.handle('mcp:saveConfig', async (_e, config) => {
    await agentService!.saveMcpConfig(config);
  });

  ipcMain.handle('mcp:reload', async () => {
    await agentService!.reloadMcp();
  });

  ipcMain.handle('mcp:getTools', () => {
    return agentService!.getMcpTools();
  });

  ipcMain.handle('mcp:getToolCount', () => {
    return agentService!.getMcpToolCount();
  });

  // 技能管理：只操作用户全局技能目录（~/.plain-agent/skills），不暴露磁盘路径给渲染端
  ipcMain.handle('skills:list', () => {
    return listUserSkills().map(({ name, description }) => ({ name, description }));
  });

  ipcMain.handle('skills:read', (_e, name: string) => {
    const skill = readUserSkill(name);
    return skill ? { name: skill.name, description: skill.description, content: skill.content } : null;
  });

  // 存在则更新、不存在则新建（upsert，由主进程裁决，避免渲染端先查再写的竞态）
  ipcMain.handle('skills:save', (_e, input: { name: string; description: string; content: string }) => {
    if (readUserSkill(input.name)) {
      return updateUserSkill(input.name, { description: input.description, content: input.content });
    }
    return createUserSkill(input);
  });

  ipcMain.handle('skills:delete', (_e, name: string) => {
    return deleteUserSkill(name);
  });

  // 事件转发：将 agent 事件推送到渲染进程
  agentService.onEvent((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:event', event);
    }
  });
}

/**
 * 应用启动
 */
app.whenReady().then(() => {
  // 初始化 Agent 服务
  agentService = new AgentService();

  // 注册 IPC
  registerIpcHandlers();

  // 创建窗口
  createWindow();

  app.on('activate', () => {
    // macOS：点击 dock 图标时重新创建窗口
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 应用退出前清理
app.on('before-quit', () => {
  agentService?.destroy();
  agentService = null;
});

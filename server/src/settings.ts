/**
 * 设置存储（server 端版本）
 * 将用户配置持久化到 ~/.plain-agent/settings.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface AppSettings {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens?: number;
  permissionMode: 'trust' | 'standard' | 'strict';
}

const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com',
  maxTokens: undefined,
  permissionMode: 'standard',
};

export class SettingsStore {
  private filePath: string;
  private configDir: string;

  constructor() {
    this.configDir = join(homedir(), '.plain-agent');
    this.filePath = join(this.configDir, 'settings.json');
  }

  /**
   * 加载配置
   * 优先级：settings.json > .env > 默认值
   */
  load(): AppSettings {
    // 从 .env 读取（作为中间 fallback 层）
    const envSettings: Partial<AppSettings> = {};
    if (process.env.API_KEY) envSettings.apiKey = process.env.API_KEY;
    if (process.env.MODEL) envSettings.model = process.env.MODEL;
    if (process.env.BASE_URL) envSettings.baseUrl = process.env.BASE_URL;
    if (process.env.PERMISSION_MODE) envSettings.permissionMode = process.env.PERMISSION_MODE as AppSettings['permissionMode'];
    if (process.env.MAX_TOKENS) envSettings.maxTokens = parseInt(process.env.MAX_TOKENS, 10);

    // 从 settings.json 读取（最高优先级）
    let fileSettings: Partial<AppSettings> = {};
    try {
      if (existsSync(this.filePath)) {
        const content = readFileSync(this.filePath, 'utf-8');
        fileSettings = JSON.parse(content);
      }
    } catch (error) {
      console.error('读取 settings.json 失败:', error);
    }

    // 合并：file > env > defaults
    const cleanFileSettings = Object.fromEntries(
      Object.entries(fileSettings).filter(([, v]) => v !== '' && v !== null && v !== undefined),
    );
    return {
      ...DEFAULT_SETTINGS,
      ...envSettings,
      ...cleanFileSettings,
    };
  }

  /**
   * 保存配置到 settings.json
   */
  save(settings: AppSettings): void {
    // 确保目录存在
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(settings, null, 2), 'utf-8');
  }
}

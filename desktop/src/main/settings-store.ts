/**
 * 配置存储
 * 将用户配置持久化到 userData/settings.json
 * 优先级：settings.json > .env > 默认值
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AppSettings } from '../shared/desktop-api.js';

const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com',
  maxTokens: undefined,
  permissionMode: 'standard',
  verification: { mode: 'off', checks: [] },
};

export class SettingsStore {
  private filePath: string;

  constructor(userDataDir: string) {
    this.filePath = join(userDataDir, 'settings.json');
  }

  /**
   * 加载配置
   * 优先级：settings.json > .env（已加载到 process.env）> 默认值
   */
  load(): AppSettings {
    // 从 .env 读取（作为中间 fallback 层），过滤 undefined
    const envSettings: Partial<AppSettings> = {};
    if (process.env.API_KEY) envSettings.apiKey = process.env.API_KEY;
    if (process.env.MODEL) envSettings.model = process.env.MODEL;
    if (process.env.BASE_URL) envSettings.baseUrl = process.env.BASE_URL;
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
    // 过滤 settings.json 中的空字符串，避免空值覆盖 .env 的有效配置
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
    writeFileSync(this.filePath, JSON.stringify(settings, null, 2), 'utf-8');
  }
}

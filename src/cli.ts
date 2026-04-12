#!/usr/bin/env node
/**
 * CLI 入口文件
 */

import { CLIAdapter } from './adapters/cli/index.js';

const cli = new CLIAdapter();
cli.start().catch((error) => {
  console.error('CLI 启动失败:', error);
  process.exit(1);
});

/**
 * electron-vite 构建配置
 * 三个构建目标：main（主进程）、preload（预加载）、renderer（渲染进程）
 */

import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  // 主进程：运行在 Node 环境
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@agent-core': resolve('src/agent-core'),
      },
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },

  // 预加载脚本：运行在受限的渲染进程环境，可访问 Node API
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },

  // 渲染进程：React SPA
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    build: {
      outDir: 'out/renderer',
    },
  },
});

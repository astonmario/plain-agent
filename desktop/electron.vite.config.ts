/**
 * electron-vite 构建配置
 * 三个构建目标：main（主进程）、preload（预加载）、renderer（渲染进程）
 *
 * 注意：@plain-agent/domain 是 workspace 内的 TS 源码包，
 * 必须从 externalize 中排除让其被打包进主进程产物。
 */

import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  // 主进程：运行在 Node 环境
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@plain-agent/domain'] })],
    define: {
      // 注入环境标识，用于区分开发和生产的 userData 目录
      'process.env.ELECTRON_IS_DEV': JSON.stringify(process.env.NODE_ENV !== 'production'),
    },
    resolve: {
      alias: {
        '@plain-agent/domain': resolve('../domain/src/index.ts'),
      },
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        // kerberos 是 playwright-core 的可选依赖（仅 Negotiate 代理认证时动态加载），
        // 不打进 bundle，保持运行时惰性 require
        external: ['kerberos'],
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },

  // 预加载脚本：运行在受限的渲染进程环境，可访问 Node API
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@plain-agent/domain'] })],
    resolve: {
      alias: {
        '@plain-agent/domain': resolve('../domain/src/index.ts'),
      },
    },
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
        // 注意顺序：更具体的子路径别名必须排在前面
        '@plain-agent/domain/types': resolve('../domain/src/types.ts'),
        '@plain-agent/domain': resolve('../domain/src/index.ts'),
      },
    },
    build: {
      outDir: 'out/renderer',
    },
  },
});

/**
 * HTTP Server Adapter - 基于 Hono 的 Web API
 * 将 Agent Core 适配到 HTTP 环境，支持 SSE 流式响应
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { PlainAgent, MemoryStorage, getBuiltinTools } from '../../agent-core/index.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentEvent } from '../../agent-core/types.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// 加载 .env 文件
function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), '.env');
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...values] = trimmed.split('=');
      if (key && values.length > 0) {
        process.env[key.trim()] = values.join('=').trim();
      }
    }
  } catch (error) {
    // .env 文件不存在，使用系统环境变量
  }
}

export class HttpAdapter {
  private app: Hono;
  private agents = new Map<string, PlainAgent>();
  private storage: MemoryStorage;

  constructor() {
    loadEnv();

    // 检查配置
    if (!process.env.API_KEY) {
      console.error('❌ 错误: 请设置 API_KEY 环境变量');
      process.exit(1);
    }

    this.app = new Hono();
    this.storage = new MemoryStorage();

    // 中间件
    this.app.use('/*', cors());

    // 静态文件服务（简单实现）
    this.app.get('/', (c) => {
      const htmlPath = join(process.cwd(), 'public', 'index.html');
      if (existsSync(htmlPath)) {
        const html = readFileSync(htmlPath, 'utf-8');
        return c.html(html);
      }
      return c.text('Welcome to Plain Agent API Server\n\nAPI Endpoints:\n  GET  /health\n  GET  /api/config\n  POST /api/submit\n  GET  /api/sessions\n');
    });

    // 注册路由
    this.registerRoutes();
  }

  private registerRoutes() {
    // 健康检查
    this.app.get('/health', (c) => {
      return c.json({
        status: 'ok',
        timestamp: Date.now(),
        version: '0.1.0',
      });
    });

    // 获取配置信息
    this.app.get('/api/config', (c) => {
      return c.json({
        model: process.env.MODEL || 'deepseek-chat',
        baseUrl: process.env.BASE_URL,
        tools: getBuiltinTools().length,
      });
    });

    // 提交任务（SSE 流式响应）
    this.app.post('/api/submit', async (c) => {
      const { task, sessionId } = await c.req.json();

      if (!task || typeof task !== 'string') {
        return c.json({ error: 'Missing or invalid task' }, 400);
      }

      const sid = sessionId || `session-${Date.now()}`;

      // 创建 Agent
      const agent = new PlainAgent({
        llm: {
          provider: 'openai',
          apiKey: process.env.API_KEY!,
          model: process.env.MODEL || 'deepseek-chat',
          baseUrl: process.env.BASE_URL,
        },
        tools: getBuiltinTools(),
        storage: this.storage,
        sessionId: sid,
        permissionMode: 'trust',
      });

      this.agents.set(sid, agent);

      // SSE 响应
      return c.stream(async (stream) => {
        // 设置 SSE 头
        c.header('Content-Type', 'text/event-stream');
        c.header('Cache-Control', 'no-cache');
        c.header('Connection', 'keep-alive');

        // 监听事件
        const eventHandler = (event: AgentEvent) => {
          stream.write(`data: ${JSON.stringify(event)}\n\n`);
        };

        agent.on('event', eventHandler);

        try {
          // 执行任务
          await agent.submit(task);

          // 发送完成信号
          await stream.write('data: [DONE]\n\n');
        } catch (error) {
          // 发送错误
          const errorEvent: AgentEvent = {
            type: 'error',
            error: {
              name: error instanceof Error ? error.name : 'Error',
              message: error instanceof Error ? error.message : String(error),
            },
            timestamp: Date.now(),
          };
          await stream.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
        } finally {
          // 清理
          agent.off('event', eventHandler);
          this.agents.delete(sid);
          agent.destroy();
        }
      });
    });

    // 停止任务
    this.app.post('/api/stop/:sessionId', (c) => {
      const sessionId = c.req.param('sessionId');
      const agent = this.agents.get(sessionId);

      if (!agent) {
        return c.json({ error: 'Session not found' }, 404);
      }

      agent.stop();
      return c.json({ ok: true });
    });

    // 获取会话列表
    this.app.get('/api/sessions', async (c) => {
      const sessions = await this.storage.listSessions();
      return c.json({ sessions });
    });

    // 获取会话消息
    this.app.get('/api/sessions/:sessionId/messages', async (c) => {
      const sessionId = c.req.param('sessionId');
      const messages = await this.storage.loadMessages(sessionId);
      return c.json({ messages });
    });

    // 获取会话事件
    this.app.get('/api/sessions/:sessionId/events', async (c) => {
      const sessionId = c.req.param('sessionId');
      const events = await this.storage.loadEvents(sessionId);
      return c.json({ events });
    });

    // 404 处理
    this.app.notFound((c) => {
      return c.json({ error: 'Not Found' }, 404);
    });

    // 错误处理
    this.app.onError((err, c) => {
      console.error('Server error:', err);
      return c.json({
        error: 'Internal Server Error',
        message: err.message,
      }, 500);
    });
  }

  listen(port: number = 3000, hostname: string = '127.0.0.1') {
    console.log(`\n🚀 Plain Agent HTTP Server`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📍 地址: http://${hostname}:${port}`);
    console.log(`📊 配置: ${process.env.MODEL || 'deepseek-chat'}`);
    console.log(`🔧 工具: ${getBuiltinTools().length} 个`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    console.log(`📖 API 端点:`);
    console.log(`  GET  /health                          - 健康检查`);
    console.log(`  GET  /api/config                      - 获取配置`);
    console.log(`  POST /api/submit                      - 提交任务（SSE）`);
    console.log(`  POST /api/stop/:sessionId             - 停止任务`);
    console.log(`  GET  /api/sessions                    - 会话列表`);
    console.log(`  GET  /api/sessions/:id/messages       - 会话消息`);
    console.log(`  GET  /api/sessions/:id/events         - 会话事件`);
    console.log(`\n按 Ctrl+C 停止服务器\n`);

    return this.app;
  }

  getApp() {
    return this.app;
  }
}

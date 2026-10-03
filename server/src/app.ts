/**
 * HTTP 路由 —— Hono + SSE
 *
 * 事件流（对齐 any-code 的成熟做法）：
 * - POST /api/sessions/:id/run    提交任务，响应即 SSE 流（回放本 run 起点之后的事件 + 订阅 live）
 * - GET  /api/sessions/:id/stream?since=N  重挂续传：重放 seq>N 的历史帧 + 续订 live
 * - 帧格式 {seq, event}，seq 为会话累积事件历史下标
 * - 重放时过滤已回答的 interaction 事件，避免重挂重复弹窗
 * - 15s keepalive 注释帧；终态帧后关闭流；客户端 abort 清理
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { stream } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import type { SessionStorage } from '@plain-agent/domain';
import { hasPendingInteraction } from '@plain-agent/domain';
import { AgentManager, TERMINAL_EVENTS } from './manager';
import type { StreamFrame } from './manager';
import { SettingsStore } from './settings';

export interface AppInfo {
  model: string;
  baseUrl?: string;
  toolCount: number;
  persisted: boolean;
  project?: string;
}

export interface AppDeps {
  manager: AgentManager;
  storage: SessionStorage;
  info: AppInfo;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** 重放时丢弃已不再 pending 的 interaction 事件 */
function replayable(frame: StreamFrame): boolean {
  if (frame.event.type === 'interaction') {
    return hasPendingInteraction(frame.event.id);
  }
  return true;
}

export function buildApp(deps: AppDeps): Hono {
  const { manager, storage, info } = deps;
  const app = new Hono();
  const settingsStore = new SettingsStore();

  app.use('/*', cors());

  app.get('/health', (c) =>
    c.json({ status: 'ok', timestamp: Date.now(), version: '0.2.0' }),
  );

  app.get('/api/config', (c) =>
    c.json({ model: info.model, baseUrl: info.baseUrl, tools: info.toolCount, project: info.project }),
  );

  // ---- 会话管理 ----

  app.post('/api/sessions', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sessionId = randomUUID();
    await storage.createSession(sessionId, typeof body?.title === 'string' ? body.title : '');
    return c.json({ sessionId }, 201);
  });

  app.get('/api/sessions', async (c) => {
    const sessions = await storage.listSessions();
    return c.json({ sessions });
  });

  app.patch('/api/sessions/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.title !== 'string') return c.json({ error: 'Missing title' }, 400);
    await storage.renameSession(sessionId, body.title);
    return c.json({ ok: true });
  });

  app.delete('/api/sessions/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');
    manager.destroy(sessionId);
    await storage.deleteSession(sessionId);
    return c.json({ ok: true });
  });

  app.get('/api/sessions/:sessionId/messages', async (c) => {
    const messages = await manager.messages(c.req.param('sessionId'));
    return c.json({ messages });
  });

  app.get('/api/sessions/:sessionId/events', async (c) => {
    const sessionId = c.req.param('sessionId');
    // agent 活着用内存全量（含未落库的最新事件），否则读存储
    const events = manager.has(sessionId)
      ? manager.frames(sessionId).map((f) => f.event)
      : await storage.loadEvents(sessionId);
    return c.json({ events });
  });

  // ---- 任务执行 ----

  // POST /api/sessions/:id/run —— 提交任务，SSE 流式响应
  app.post('/api/sessions/:sessionId/run', async (c) => {
    const sessionId = c.req.param('sessionId');
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.task !== 'string' || !body.task.trim()) {
      return c.json({ error: 'Missing or invalid task' }, 400);
    }

    const { startSeq } = manager.run(sessionId, body.task.trim());

    return stream(c, async (s) => {
      for (const [k, v] of Object.entries(SSE_HEADERS)) c.header(k, v);
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unsub?.();
      };
      const send = (frame: StreamFrame) => {
        if (closed) return;
        void s.write(`data: ${JSON.stringify(frame)}\n\n`).then(() => {
          if (TERMINAL_EVENTS.has(frame.event.type)) finish();
        });
      };
      const keepalive = setInterval(() => {
        if (!closed) void s.write(': keepalive\n\n');
      }, 15000);
      c.req.raw.signal.addEventListener('abort', finish, { once: true });

      // 先订阅再重放（中间无 await），startSeq 之后到的帧都在历史里，不漏不重
      const unsub = manager.subscribe(sessionId, send);
      if (unsub === null) {
        finish();
        return;
      }
      for (const frame of manager.frames(sessionId)) {
        if (frame.seq >= startSeq && replayable(frame)) send(frame);
      }
    });
  });

  // GET /api/sessions/:id/stream?since=N —— 重挂续传
  app.get('/api/sessions/:sessionId/stream', (c) => {
    const sessionId = c.req.param('sessionId');
    if (!manager.has(sessionId)) {
      return c.json({ error: 'session not running' }, 404);
    }
    const sinceRaw = c.req.query('since');
    const since = sinceRaw === undefined || sinceRaw === '' ? -1 : Number(sinceRaw);

    return stream(c, async (s) => {
      for (const [k, v] of Object.entries(SSE_HEADERS)) c.header(k, v);
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unsub?.();
      };
      const send = (frame: StreamFrame) => {
        if (closed) return;
        void s.write(`data: ${JSON.stringify(frame)}\n\n`).then(() => {
          if (TERMINAL_EVENTS.has(frame.event.type)) finish();
        });
      };
      const keepalive = setInterval(() => {
        if (!closed) void s.write(': keepalive\n\n');
      }, 15000);
      c.req.raw.signal.addEventListener('abort', finish, { once: true });

      // 同步重放 + 订阅之间无 await，不会漏帧
      const unsub = manager.subscribe(sessionId, send);
      const start = Number.isFinite(since) ? Math.max(0, Math.floor(since) + 1) : 0;
      for (const frame of manager.frames(sessionId)) {
        if (frame.seq >= start && replayable(frame)) send(frame);
      }
    });
  });

  app.post('/api/sessions/:sessionId/stop', (c) => {
    const ok = manager.stop(c.req.param('sessionId'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'Session not found' }, 404);
  });

  app.post('/api/sessions/:sessionId/queue', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.task !== 'string' || !body.task.trim()) {
      return c.json({ error: 'Missing or invalid task' }, 400);
    }
    const { status, startSeq } = manager.run(c.req.param('sessionId'), body.task.trim());
    return c.json({ status, startSeq });
  });

  app.get('/api/sessions/:sessionId/queue', (c) => {
    return c.json({ queued: manager.queuedTasks(c.req.param('sessionId')) });
  });

  app.post('/api/sessions/:sessionId/compact', async (c) => {
    const ok = await manager.compact(c.req.param('sessionId'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'Session not found' }, 404);
  });

  app.post('/api/sessions/:sessionId/interact', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.interactionId !== 'string') {
      return c.json({ error: 'Missing interactionId' }, 400);
    }
    manager.interact(body.interactionId, Array.isArray(body.answers) ? body.answers : []);
    return c.json({ ok: true });
  });

  app.get('/api/running', (c) => c.json({ running: manager.runningSessions() }));

  // ---- 设置管理 ----

  app.get('/api/settings', (c) => {
    const settings = settingsStore.load();
    return c.json(settings);
  });

  app.patch('/api/settings', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const currentSettings = settingsStore.load();

    // 合并更新
    const updatedSettings = {
      ...currentSettings,
      ...body,
    };

    // 验证必填字段
    if (typeof updatedSettings.apiKey !== 'string' ||
        typeof updatedSettings.model !== 'string' ||
        typeof updatedSettings.baseUrl !== 'string') {
      return c.json({ error: '缺少必填字段' }, 400);
    }

    settingsStore.save(updatedSettings);
    return c.json({ message: '设置已保存' });
  });

  app.notFound((c) => c.json({ error: 'Not Found' }, 404));
  app.onError((err, c) => {
    console.error('Server error:', err);
    return c.json({ error: 'Internal Server Error', message: err.message }, 500);
  });

  return app;
}

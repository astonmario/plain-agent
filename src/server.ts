#!/usr/bin/env node
/**
 * HTTP Server 入口文件
 */

import { serve } from '@hono/node-server';
import { HttpAdapter } from './adapters/http/index.js';

const adapter = new HttpAdapter();
const app = adapter.listen(3000, '127.0.0.1');

serve({
  fetch: app.fetch,
  port: 3000,
  hostname: '127.0.0.1',
});

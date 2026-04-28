/**
 * 网络工具 - HTTP 请求
 */

import type { Tool } from '../types.js';

export const httpGetTool: Tool = {
  name: 'http_get',
  description: '发送 HTTP GET 请求获取网页内容或 API 数据',
  schema: {
    type: 'function',
    function: {
      name: 'http_get',
      description: '发送 HTTP GET 请求获取网页内容或 API 数据',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'HTTP URL 地址',
          },
          headers: {
            type: 'object',
            description: '可选的 HTTP 请求头',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['url'],
      },
    },
  },

  handler: async (args) => {
    const { url, headers = {} } = args as { url: string; headers?: Record<string, string> };

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Plain-Agent/0.1.0',
          ...headers,
        },
      });

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        const data = await response.json();
        return JSON.stringify(data, null, 2);
      } else {
        const text = await response.text();
        // 限制返回长度
        return text.length > 5000 ? text.slice(0, 5000) + '\n...(truncated)' : text;
      }
    } catch (error) {
      throw new Error(`HTTP 请求失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  meta: {
    tags: ['http', 'web', 'api'],
  },
};

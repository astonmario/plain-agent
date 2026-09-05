/**
 * 消息历史管理测试
 */

import { pathToFileURL } from 'node:url';
import { HistoryManager, estimateTokens } from '../src/history-manager';
import type { ChatMessage, LLMConfig } from '../src/types';

// ============ 测试数据 ============

// 模拟长日志输出
const longLogOutput = `
[2024-01-15 10:23:45] INFO: Starting server on port 3000
[2024-01-15 10:23:45] DEBUG: Loading configuration from config.json
[2024-01-15 10:23:45] DEBUG: Database connection established
[2024-01-15 10:23:46] INFO: Middleware loaded: cors, helmet, compression
[2024-01-15 10:23:46] INFO: Routes registered: /api/users, /api/posts, /api/comments
[2024-01-15 10:23:46] INFO: Server started successfully
[2024-01-15 10:23:47] DEBUG: Received request GET /api/users
[2024-01-15 10:23:47] DEBUG: Query executed: SELECT * FROM users LIMIT 10
[2024-01-15 10:23:47] DEBUG: Response sent: 200 OK
[2024-01-15 10:23:48] DEBUG: Received request POST /api/posts
[2024-01-15 10:23:48] DEBUG: Validation passed for request body
[2024-01-15 10:23:48] DEBUG: Query executed: INSERT INTO posts...
[2024-01-15 10:23:48] DEBUG: Response sent: 201 Created
`.repeat(10); // 重复10次，模拟超长日志

// 模拟大型 JSON 响应
const largeJsonOutput = JSON.stringify({
  status: 'success',
  data: Array(100).fill(null).map((_, i) => ({
    id: i,
    name: `User ${i}`,
    email: `user${i}@example.com`,
    profile: {
      bio: 'This is a long bio text that contains a lot of information about the user...',
      followers: Math.floor(Math.random() * 10000),
      following: Math.floor(Math.random() * 1000),
    }
  })),
  meta: {
    total: 100,
    page: 1,
    pageSize: 100,
  }
}, null, 2);

// ============ 测试函数 ============

async function testLayer1Compression() {
  console.log('\n========== 测试第一层：清理工具输出 ==========\n');

  const messages: ChatMessage[] = [
    { role: 'user', content: '请读取服务器日志' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"server.log"}' } }
    ]},
    { role: 'tool', content: longLogOutput, tool_call_id: 'call_1' },
    { role: 'assistant', content: '日志已读取，发现服务器运行正常' },
    { role: 'user', content: '获取用户列表' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_2', type: 'function', function: { name: 'api_call', arguments: '{"url":"/api/users"}' } }
    ]},
    { role: 'tool', content: largeJsonOutput, tool_call_id: 'call_2' },
  ];

  console.log('压缩前:');
  console.log(`- 消息数: ${messages.length}`);
  console.log(`- 估算 tokens: ${estimateTokens(messages)}`);
  console.log(`- 工具输出1长度: ${messages[2].content?.length || 0} 字符`);
  console.log(`- 工具输出2长度: ${messages[6].content?.length || 0} 字符`);

  const manager = new HistoryManager({
    maxToolOutputLength: 500,
  });

  const compressed = manager.compressQuick(messages);

  console.log('\n压缩后:');
  console.log(`- 消息数: ${compressed.length}`);
  console.log(`- 估算 tokens: ${estimateTokens(compressed)}`);
  console.log(`- 工具输出1长度: ${compressed[2].content?.length || 0} 字符`);
  console.log(`- 工具输出2长度: ${compressed[6].content?.length || 0} 字符`);

  console.log('\n压缩后的工具输出示例:');
  console.log(compressed[2].content?.slice(0, 200) + '...');
}

async function testLayer2Compression() {
  console.log('\n========== 测试第二层：对话摘要 ==========\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: '你是一个代码助手' },
    { role: 'user', content: '帮我创建一个 Express 服务器' },
    { role: 'assistant', content: '好的，我来帮你创建一个基础的 Express 服务器' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"server.js"}' } }
    ]},
    { role: 'tool', content: '文件已创建', tool_call_id: 'call_1' },
    { role: 'user', content: '添加 CORS 支持' },
    { role: 'assistant', content: '我来添加 CORS 中间件' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_2', type: 'function', function: { name: 'edit_file', arguments: '{"path":"server.js"}' } }
    ]},
    { role: 'tool', content: '文件已更新', tool_call_id: 'call_2' },
    { role: 'user', content: '创建用户路由' },
    { role: 'assistant', content: '好的，我来创建用户相关的路由' },
  ];

  console.log('压缩前:');
  console.log(`- 消息数: ${messages.length}`);
  console.log(`- 估算 tokens: ${estimateTokens(messages)}`);

  const manager = new HistoryManager({
    keepRecentMessages: 3, // 只保留最近3条
    compressionThreshold: 0, // 强制触发压缩（测试用）
  });

  // 注意：这个测试需要实际的 LLM 配置才能运行
  // 这里只是演示 API
  const llmConfig: LLMConfig = {
    provider: 'openai',
    apiKey: process.env.API_KEY || '',
    model: 'deepseek-chat',
    baseUrl: process.env.BASE_URL || 'https://api.deepseek.com',
  };

  try {
    const result = await manager.compress(messages, llmConfig);
    const compressed = result.compressed;

    console.log('\n压缩后:');
    console.log(`- 消息数: ${compressed.length}`);
    console.log(`- 估算 tokens: ${estimateTokens(compressed)}`);
    console.log(`- 压缩层级: Level ${result.level}`);
    console.log('\n摘要消息:');
    console.log(compressed.find(m => m.content?.includes('[对话状态'))?.content);
  } catch (error) {
    console.log('\n⚠️  第二层压缩需要 LLM API，跳过测试');
    console.log('错误:', error instanceof Error ? error.message : error);
  }
}

async function testTokenEstimation() {
  console.log('\n========== 测试 Token 估算 ==========\n');

  const testCases = [
    { role: 'user', content: 'Hello, how are you?' },
    { role: 'assistant', content: '你好，我很好，谢谢！' },
    { role: 'user', content: 'This is a mix of English and 中文 characters' },
  ] as ChatMessage[];

  for (const msg of testCases) {
    const tokens = estimateTokens([msg]);
    console.log(`内容: "${msg.content}"`);
    console.log(`字符数: ${msg.content?.length || 0}`);
    console.log(`估算 tokens: ${tokens}\n`);
  }
}

async function testHistoryManager() {
  console.log('\n========== 测试 HistoryManager API ==========\n');

  const messages: ChatMessage[] = [
    { role: 'user', content: '开始任务' },
    { role: 'assistant', content: '好的' },
  ];

  const manager = new HistoryManager({
    maxTokens: 1000,
    compressionThreshold: 50,
  });

  // 添加很多消息
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'user', content: `步骤 ${i}` });
    messages.push({ role: 'assistant', content: `完成步骤 ${i}` });
  }

  console.log('初始状态:');
  const usage1 = manager.getTokenUsage(messages);
  console.log(`- Tokens: ${usage1.tokens}/${usage1.maxTokens}`);
  console.log(`- 使用率: ${usage1.percentage.toFixed(1)}%`);
  console.log(`- 需要压缩: ${usage1.needsCompression ? '是' : '否'}`);

  const compressed = manager.compressQuick(messages);

  console.log('\n压缩后:');
  const usage2 = manager.getTokenUsage(compressed);
  console.log(`- Tokens: ${usage2.tokens}/${usage2.maxTokens}`);
  console.log(`- 使用率: ${usage2.percentage.toFixed(1)}%`);
  console.log(`- 需要压缩: ${usage2.needsCompression ? '是' : '否'}`);
}

// ============ 运行测试 ============

async function main() {
  console.log('🧪 消息历史管理测试\n');

  await testTokenEstimation();
  await testLayer1Compression();
  await testHistoryManager();
  await testLayer2Compression();

  console.log('\n✅ 测试完成');
}

// 允许直接运行
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(console.error);
}

export { main as testHistoryManager };

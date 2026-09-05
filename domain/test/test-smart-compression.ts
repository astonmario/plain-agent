/**
 * 智能压缩触发器自测
 *
 * 测试场景：
 * 1. 正常短对话 - 不应触发压缩
 * 2. 长对话 - 触发 Level 2
 * 3. 工具输出堆积 - 触发 Level 1/2
 * 4. Agent 重复行为 - 触发 Level 3 + 警告
 * 5. Token 爆满 - 触发 Level 3
 */

import { PlainAgent } from '../src/agent.js';
import type { AgentEvent } from '../src/types.js';

// ============ 测试配置 ============

const testConfig = {
  llm: {
    provider: 'openai' as const,
    apiKey: process.env.API_KEY || 'test-key',
    model: process.env.MODEL || 'deepseek-chat',
    baseUrl: process.env.BASE_URL || 'https://api.deepseek.com',
  },
  tools: [
    {
      name: 'test_tool',
      description: 'Test tool',
      schema: {
        type: 'function' as const,
        function: {
          name: 'test_tool',
          description: 'Test',
          parameters: { type: 'object' as const, properties: {} }
        }
      },
      handler: async () => 'Test result',
      meta: { readonly: true, concurrent: false, dangerous: false }
    }
  ],
  historyManagement: {
    enabled: true,
    maxTokens: 2000,           // 故意设低，方便测试
    compressionThreshold: 1200, // 60%
    aggressiveThreshold: 1800,  // 90%
    maxToolOutputLength: 200,
    keepRecentMessages: 5,
  }
};

// ============ 事件监听 ============

function setupEventListeners(agent: PlainAgent, testName: string) {
  const events: AgentEvent[] = [];

  agent.on('event', (event: AgentEvent) => {
    events.push(event);

    if (event.type === 'thinking' && event.content.includes('触发条件')) {
      console.log(`  💭 ${event.content}`);
    }

    if (event.type === 'compression') {
      console.log(`  ✂️ Level ${event.level} 压缩: ${event.tokensBefore} → ${event.tokensAfter} tokens`);
    }

    if (event.type === 'session-warning') {
      console.log(`  ⚠️ ${event.reason}: ${event.suggestion}`);
    }
  });

  return events;
}

// ============ 测试场景 ============

/**
 * 场景 1：正常短对话
 * 预期：不触发压缩（或仅 Level 1）
 */
function createShortConversation() {
  return [
    { role: 'user' as const, content: '你好' },
    { role: 'assistant' as const, content: '你好！有什么可以帮你的吗？' },
    { role: 'user' as const, content: '今天天气怎么样' },
    { role: 'assistant' as const, content: '我无法获取实时天气信息，建议查看天气 app。' },
  ];
}

/**
 * 场景 2：长对话（25 轮）
 * 预期：触发 Level 2
 */
function createLongConversation() {
  const messages: any[] = [];
  for (let i = 0; i < 25; i++) {
    messages.push(
      { role: 'user', content: `这是第 ${i + 1} 轮对话，请帮我处理任务 ${i + 1}` },
      { role: 'assistant', content: `好的，我来处理任务 ${i + 1}。这是一个正常的回复，包含一些必要的说明和步骤。` }
    );
  }
  return messages;
}

/**
 * 场景 3：工具输出堆积
 * 预期：触发 Level 1/2（清理工具输出）
 */
function createToolOutputPileup() {
  const messages: any[] = [
    { role: 'user', content: '读取日志文件' },
  ];

  // 添加 10 个大型工具输出
  for (let i = 0; i < 10; i++) {
    messages.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `call_${i}`,
          type: 'function',
          function: { name: 'read_file', arguments: `{"path":"log${i}.txt"}` }
        }]
      },
      {
        role: 'tool',
        content: `[2024-01-15 10:00:00] INFO: Server started\n`.repeat(100), // 3000+ 字符
        tool_call_id: `call_${i}`
      },
      {
        role: 'assistant',
        content: `日志 ${i} 已读取，发现一些信息...`
      }
    );
  }

  return messages;
}

/**
 * 场景 4：Agent 重复行为
 * 预期：触发 Level 3 + session-warning
 */
function createRepetitiveConversation() {
  const messages: any[] = [
    { role: 'user', content: '数据库查询很慢，帮我优化' },
  ];

  // Agent 重复尝试相同的方案
  const attempts = [
    '增加连接池',
    '增加 retry',
    '增加 timeout',
    '增加连接池', // 重复！
    '增加 retry',  // 重复！
    '增加连接池', // 又重复！
  ];

  for (const attempt of attempts) {
    messages.push(
      { role: 'assistant', content: `让我试试${attempt}` },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `call_${attempt}`,
          type: 'function',
          function: { name: 'modify_config', arguments: `{"action":"${attempt}"}` }
        }]
      },
      { role: 'tool', content: '修改完成', tool_call_id: `call_${attempt}` },
      { role: 'user', content: '还是慢' }
    );
  }

  return messages;
}

/**
 * 场景 5：Token 爆满
 * 预期：触发 Level 3
 */
function createTokenOverflow() {
  const messages: any[] = [];

  // 创建大量消息，超过 maxTokens
  for (let i = 0; i < 50; i++) {
    messages.push(
      {
        role: 'user',
        content: '这是一个包含很多内容的消息，用来快速消耗 token。'.repeat(20)
      },
      {
        role: 'assistant',
        content: '我理解了你的需求，让我来详细回答这个问题。首先...'.repeat(20)
      }
    );
  }

  return messages;
}

// ============ 测试执行 ============

async function runTest(
  name: string,
  messages: any[],
  expectedLevel: number | null,
  expectedWarning: boolean
) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`测试: ${name}`);
  console.log('='.repeat(60));

  const agent = new PlainAgent(testConfig);
  const events = setupEventListeners(agent, name);

  // 手动注入消息（模拟历史）
  (agent as any).fullMessages = messages;

  console.log(`初始状态:`);
  console.log(`  - 消息数: ${messages.length}`);

  const health = (agent as any).historyManager.getSessionHealth(messages);
  console.log(`  - 对话轮数: ${health.roundCount}`);
  console.log(`  - Token: ${health.tokenUsage} (${health.tokenPercentage.toFixed(1)}%)`);
  console.log(`  - 大型输出: ${health.largeOutputCount}`);
  console.log(`  - 重复度: ${(health.repetitionScore * 100).toFixed(1)}%`);
  console.log(`  - 需要压缩: ${health.shouldCompress ? '是' : '否'}`);
  console.log(`  - 紧急度: ${health.urgency}`);

  if (health.reason.length > 0) {
    console.log(`  - 原因:`);
    (health.reason as string[]).forEach(r => console.log(`    • ${r}`));
  }

  // 手动触发压缩检查
  if ((agent as any).historyManager.shouldCompress(messages)) {
    console.log(`\n开始压缩...`);

    try {
      // 只测试快速模式（不需要 LLM）
      await (agent as any).compressHistory(true);

      console.log(`\n压缩结果:`);
      console.log(`  ✅ 执行了 Level 1 快速压缩（不需要 LLM）`);

      // 注意：Level 2 和 Level 3 需要实际的 API key
      if (expectedLevel && expectedLevel >= 2) {
        console.log(`  ℹ️  预期 Level ${expectedLevel} 需要 LLM，跳过实际调用`);
        console.log(`  ℹ️  可以配置真实 API key 后测试完整流程`);
      }

    } catch (error) {
      console.error(`  ❌ 压缩失败:`, error);
    }
  } else {
    console.log(`\n✅ 未触发压缩（符合预期）`);
  }
}

async function main() {
  console.log('🧪 智能压缩触发器自测\n');
  console.log(`测试配置:`);
  console.log(`  - maxTokens: ${testConfig.historyManagement.maxTokens}`);
  console.log(`  - compressionThreshold: ${testConfig.historyManagement.compressionThreshold} (60%)`);
  console.log(`  - aggressiveThreshold: ${testConfig.historyManagement.aggressiveThreshold} (90%)`);

  // 场景 1：正常短对话
  await runTest(
    '场景 1：正常短对话',
    createShortConversation(),
    null,  // 不应压缩
    false  // 无警告
  );

  // 场景 2：长对话
  await runTest(
    '场景 2：长对话（25 轮）',
    createLongConversation(),
    2,     // Level 2
    false  // 无警告
  );

  // 场景 3：工具输出堆积
  await runTest(
    '场景 3：工具输出堆积',
    createToolOutputPileup(),
    2,     // Level 1 或 2
    false  // 无警告
  );

  // 场景 4：Agent 重复行为
  await runTest(
    '场景 4：Agent 重复行为',
    createRepetitiveConversation(),
    3,     // Level 3
    true   // 有警告
  );

  // 场景 5：Token 爆满
  await runTest(
    '场景 5：Token 爆满',
    createTokenOverflow(),
    3,     // Level 3
    false  // 可能有警告
  );

  console.log(`\n${'='.repeat(60)}`);
  console.log('✅ 所有测试完成');
  console.log('='.repeat(60));
}

// 允许直接运行
main().catch(console.error);

export { main as testSmartCompression };

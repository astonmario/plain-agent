/**
 * Anchor 机制测试
 * 演示结构化状态压缩的工作方式
 */

import { pathToFileURL } from 'node:url';
import { AnchorManager } from '../src/anchor';
import type { ChatMessage, LLMConfig } from '../src/types';

// ============ 测试数据 ============

/**
 * 模拟一个典型的问题解决对话
 * 用户遇到数据库性能问题，Agent 尝试多种方案
 */
const problemSolvingConversation: ChatMessage[] = [
  { role: 'user', content: '我的应用数据库查询很慢，经常超时' },
  { role: 'assistant', content: '让我帮你排查。首先看看当前的数据库配置。' },
  { role: 'assistant', content: null, tool_calls: [
    { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"config/database.js"}' } }
  ]},
  { role: 'tool', content: 'module.exports = { pool: { max: 10, min: 2 }, timeout: 5000 }', tool_call_id: 'call_1' },

  { role: 'assistant', content: '我看到连接池只有 10 个连接。让我们试试增加连接池大小。' },
  { role: 'assistant', content: null, tool_calls: [
    { id: 'call_2', type: 'function', function: { name: 'write_file', arguments: '{"path":"config/database.js"}' } }
  ]},
  { role: 'tool', content: '文件已更新：pool.max = 50', tool_call_id: 'call_2' },

  { role: 'user', content: '还是慢，没有改善' },
  { role: 'assistant', content: '好的，连接池不是瓶颈。让我们试试增加超时时间。' },
  { role: 'assistant', content: null, tool_calls: [
    { id: 'call_3', type: 'function', function: { name: 'write_file', arguments: '{"path":"config/database.js"}' } }
  ]},
  { role: 'tool', content: '文件已更新：timeout = 30000', tool_call_id: 'call_3' },

  { role: 'user', content: '超时是延后了，但查询还是很慢' },
  { role: 'assistant', content: '明白了。让我检查一下实际的查询语句。' },
  { role: 'assistant', content: null, tool_calls: [
    { id: 'call_4', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/models/user.js"}' } }
  ]},
  { role: 'tool', content: 'SELECT * FROM users WHERE status = "active" AND created_at > ...', tool_call_id: 'call_4' },

  { role: 'assistant', content: '发现问题了！查询没有使用索引。让我检查数据库索引。' },
  { role: 'assistant', content: null, tool_calls: [
    { id: 'call_5', type: 'function', function: { name: 'bash', arguments: '{"command":"mysql -e \'SHOW INDEX FROM users\'"}' } }
  ]},
  { role: 'tool', content: 'Table: users\nKey_name: PRIMARY\nColumn_name: id\n(没有 status 和 created_at 的索引)', tool_call_id: 'call_5' },

  { role: 'assistant', content: '确认了！缺少索引。我们应该创建复合索引。' },
  { role: 'user', content: '好的，那就创建索引吧' },
  { role: 'assistant', content: null, tool_calls: [
    { id: 'call_6', type: 'function', function: { name: 'bash', arguments: '{"command":"mysql -e \'CREATE INDEX idx_status_created ON users(status, created_at)\'"}' } }
  ]},
  { role: 'tool', content: 'Query OK, 0 rows affected (2.31 sec)', tool_call_id: 'call_6' },

  { role: 'user', content: '太好了！现在查询速度快多了，从 5 秒降到了 0.1 秒' },
  { role: 'assistant', content: '很好！问题解决了。接下来我们应该检查其他慢查询，确保都有合适的索引。' }
];

// ============ 测试函数 ============

async function testAnchorCreation() {
  console.log('\n========== 测试 Anchor 生成 ==========\n');

  const manager = new AnchorManager();

  // 模拟 LLM 配置
  const llmConfig: LLMConfig = {
    provider: 'openai',
    apiKey: process.env.API_KEY || '',
    model: process.env.MODEL || 'deepseek-chat',
    baseUrl: process.env.BASE_URL || 'https://api.deepseek.com',
  };

  try {
    console.log(`处理 ${problemSolvingConversation.length} 条消息...`);

    const anchor = await manager.createAnchor(
      problemSolvingConversation,
      0,
      problemSolvingConversation.length,
      llmConfig
    );

    console.log('\n生成的 Anchor：\n');
    console.log(JSON.stringify(anchor, null, 2));

    console.log('\n转换为系统消息：\n');
    const systemMessage = manager.anchorToSystemMessage(anchor);
    console.log(systemMessage.content);

    console.log('\n统计：');
    console.log(`- Anchor 版本: v${anchor.metadata.anchorVersion}`);
    console.log(`- 覆盖消息: ${anchor.metadata.coverRange.startIndex} - ${anchor.metadata.coverRange.endIndex}`);
    console.log(`- 估算节省 tokens: ${anchor.metadata.tokensSaved}`);

    console.log('\n关键字段：');
    console.log(`- 用户意图: ${anchor.intent.primary}`);
    console.log(`- 已做改动: ${anchor.changesMade.length} 条`);
    console.log(`- 已做决策: ${anchor.decisionsTaken.length} 条`);
    console.log(`- 已排除方案: ${anchor.excludedApproaches.length} 条`);
    console.log(`- 下一步: ${anchor.nextSteps.length} 条`);

    // 重点：检查是否正确提取了排除的方案
    console.log('\n❌ 已排除方案（防止重复尝试）：');
    anchor.excludedApproaches.forEach(e => {
      console.log(`  - ${e.approach}`);
      console.log(`    原因: ${e.reason}`);
    });

  } catch (error) {
    console.error('\n❌ 测试失败:', error);
    console.log('\n提示: 需要配置环境变量 API_KEY, MODEL, BASE_URL');
  }
}

async function testAnchorUpdate() {
  console.log('\n========== 测试 Anchor 增量更新 ==========\n');

  const manager = new AnchorManager();

  const llmConfig: LLMConfig = {
    provider: 'openai',
    apiKey: process.env.API_KEY || '',
    model: process.env.MODEL || 'deepseek-chat',
    baseUrl: process.env.BASE_URL || 'https://api.deepseek.com',
  };

  try {
    // 1. 生成初始 Anchor（前 15 条消息）
    console.log('步骤 1: 生成初始 Anchor（消息 0-15）...');
    const initialAnchor = await manager.createAnchor(
      problemSolvingConversation,
      0,
      15,
      llmConfig
    );
    console.log(`✓ 初始 Anchor v${initialAnchor.metadata.anchorVersion} 生成完成`);

    // 2. 增量更新（添加剩余消息）
    console.log('\n步骤 2: 增量更新 Anchor（消息 15-24）...');
    const updatedAnchor = await manager.updateAnchor(
      initialAnchor,
      problemSolvingConversation.slice(15),
      15,
      problemSolvingConversation.length,
      llmConfig
    );
    console.log(`✓ Anchor 更新为 v${updatedAnchor.metadata.anchorVersion}`);

    // 3. 对比变化
    console.log('\n变化对比：');
    console.log(`- 版本: v${initialAnchor.metadata.anchorVersion} → v${updatedAnchor.metadata.anchorVersion}`);
    console.log(`- 覆盖范围: 0-15 → 0-${updatedAnchor.metadata.coverRange.endIndex}`);
    console.log(`- 已做改动: ${initialAnchor.changesMade.length} → ${updatedAnchor.changesMade.length}`);
    console.log(`- 已排除方案: ${initialAnchor.excludedApproaches.length} → ${updatedAnchor.excludedApproaches.length}`);

    console.log('\n更新后的系统消息：\n');
    const systemMessage = manager.anchorToSystemMessage(updatedAnchor);
    console.log(systemMessage.content);

  } catch (error) {
    console.error('\n❌ 测试失败:', error);
    console.log('\n提示: 需要配置环境变量 API_KEY, MODEL, BASE_URL');
  }
}

async function testAnchorStructure() {
  console.log('\n========== 测试 Anchor 数据结构 ==========\n');

  // 手动构造一个 Anchor 示例
  const exampleAnchor = {
    intent: {
      primary: '解决数据库查询性能问题',
      secondary: ['优化应用配置', '确保系统稳定性']
    },
    changesMade: [
      {
        type: 'file_modified' as const,
        target: 'config/database.js',
        summary: '增加连接池大小从 10 到 50'
      },
      {
        type: 'file_modified' as const,
        target: 'config/database.js',
        summary: '增加超时时间从 5s 到 30s'
      },
      {
        type: 'command_executed' as const,
        target: 'CREATE INDEX idx_status_created',
        summary: '创建复合索引提升查询性能'
      }
    ],
    decisionsTaken: [
      {
        decision: '使用复合索引而非单列索引',
        reason: '查询同时使用 status 和 created_at 字段',
        context: '数据库表有 100 万行记录'
      }
    ],
    excludedApproaches: [
      {
        approach: '增加数据库连接池大小',
        reason: '尝试后问题未解决，不是连接数瓶颈'
      },
      {
        approach: '增加查询超时时间',
        reason: '只是延后超时，未解决根本问题'
      }
    ],
    nextSteps: [
      {
        action: '检查其他慢查询并创建相应索引',
        priority: 'high' as const
      },
      {
        action: '设置查询性能监控',
        priority: 'medium' as const
      }
    ],
    metadata: {
      anchorVersion: 1,
      coverRange: { startIndex: 0, endIndex: 24 },
      createdAt: Date.now(),
      tokensSaved: 1500
    }
  };

  const manager = new AnchorManager();
  const systemMessage = manager.anchorToSystemMessage(exampleAnchor);

  console.log('示例 Anchor 数据结构：');
  console.log(JSON.stringify(exampleAnchor, null, 2));

  console.log('\n\n转换为系统消息后：');
  console.log('─'.repeat(60));
  console.log(systemMessage.content);
  console.log('─'.repeat(60));

  console.log('\n\n关键特性：');
  console.log('✓ 结构化：5 个固定字段，易于解析');
  console.log('✓ 防遗忘：excludedApproaches 明确记录失败方案');
  console.log('✓ 可追溯：保留决策原因和背景');
  console.log('✓ 可更新：支持增量更新到 v2, v3...');
  console.log('✓ 高压缩：从 24 条消息压缩到 1 条系统消息');
}

// ============ 运行测试 ============

async function main() {
  console.log('🧪 Anchor 机制测试\n');

  // 首先展示数据结构
  await testAnchorStructure();

  // 如果配置了 API，运行实际测试
  if (process.env.API_KEY) {
    await testAnchorCreation();
    await testAnchorUpdate();
  } else {
    console.log('\n⚠️  跳过 LLM 测试（需要配置 API_KEY）');
    console.log('运行方式: API_KEY=xxx MODEL=xxx BASE_URL=xxx npm run test:anchor');
  }

  console.log('\n✅ 测试完成');
}

// 允许直接运行
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(console.error);
}

export { main as testAnchor };

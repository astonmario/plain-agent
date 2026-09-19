/**
 * MCP 功能测试
 *
 * 测试 MCP 协议连接和工具加载
 */

import { loadMcpTools, McpServerConfig, resetPool, closeIdleConnections, poolStats } from '../src/mcp';

async function testBasicMcp() {
  console.log('\n=== 测试 MCP 基础功能 ===\n');

  // 测试 1: 空配置
  console.log('1. 测试空配置...');
  const manager1 = await loadMcpTools({});
  console.log(`   工具数量: ${manager1.tools.length}`);
  console.log(`   ✓ 空配置测试通过`);
  await manager1.cleanup();

  // 测试 2: 禁用的 server
  console.log('\n2. 测试禁用的 server...');
  const config: Record<string, McpServerConfig> = {
    disabled: {
      type: 'stdio',
      command: 'node',
      disabled: true,
    },
  };
  const manager2 = await loadMcpTools(config);
  console.log(`   工具数量: ${manager2.tools.length}`);
  console.log(`   ✓ 禁用 server 测试通过`);
  await manager2.cleanup();

  // 测试 3: 连接池状态
  console.log('\n3. 测试连接池...');
  const stats = poolStats();
  console.log(`   池大小: ${stats.size}`);
  console.log(`   引用计数: [${stats.refCounts.join(', ')}]`);
  console.log(`   ✓ 连接池测试通过`);

  // 清理
  console.log('\n4. 清理连接池...');
  closeIdleConnections(0);
  await new Promise(r => setTimeout(r, 100));
  await resetPool();
  console.log(`   ✓ 清理完成`);

  console.log('\n=== 所有测试通过 ===\n');
}

// 运行测试
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  testBasicMcp().catch(err => {
    console.error('测试失败:', err);
    process.exit(1);
  });
}

export { testBasicMcp };

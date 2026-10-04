#!/usr/bin/env node
/**
 * MCP 和技能包集成自测脚本
 * 测试 CLI 和桌面端的 MCP 工具和技能包集成情况
 */

import { PlainAgent, SQLiteStorage, getBuiltinTools, discoverSkills } from '@plain-agent/domain';
import { join } from 'path';
import { homedir } from 'os';

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🧪 MCP 和技能包集成自测');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// 1. 测试技能发现
console.log('📦 测试 1: 技能包发现');
console.log('──────────────────────────────');
const cwd = process.cwd();
const skills = discoverSkills(cwd);

console.log(`✓ 发现 ${skills.size} 个技能：`);
for (const [name, skill] of skills.entries()) {
  console.log(`  - ${name} (${skill.origin})`);
  console.log(`    ${skill.description}`);
}
console.log();

// 2. 测试内置工具
console.log('🔧 测试 2: 内置工具加载');
console.log('──────────────────────────────');
const builtinTools = getBuiltinTools();
console.log(`✓ 加载 ${builtinTools.length} 个内置工具：`);
builtinTools.forEach((tool) => {
  console.log(`  - ${tool.name}`);
});
console.log();

// 3. 测试 MCP 配置
console.log('🔌 测试 3: MCP 配置检查');
console.log('──────────────────────────────');
const mcpConfigPath = join(homedir(), '.plain-agent', 'mcp_config.json');
const { existsSync, readFileSync } = await import('fs');

if (existsSync(mcpConfigPath)) {
  try {
    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
    const serverCount = Object.keys(mcpConfig.mcpServers || {}).length;
    console.log(`✓ MCP 配置文件存在`);
    console.log(`✓ 配置了 ${serverCount} 个 MCP 服务器`);
    if (serverCount > 0) {
      Object.keys(mcpConfig.mcpServers).forEach(name => {
        console.log(`  - ${name}`);
      });
    }
  } catch (e) {
    console.log(`✗ MCP 配置文件解析失败: ${e.message}`);
  }
} else {
  console.log('⚠ MCP 配置文件不存在');
  console.log(`  预期位置: ${mcpConfigPath}`);
}
console.log();

// 4. 测试 Agent 创建
console.log('🤖 测试 4: Agent 创建');
console.log('──────────────────────────────');
try {
  const storage = new SQLiteStorage(join(homedir(), '.plain-agent', 'test-agent.db'));
  const agent = new PlainAgent({
    llm: {
      provider: 'openai',
      apiKey: process.env.API_KEY || 'test-key',
      model: process.env.MODEL || 'deepseek-chat',
      baseUrl: process.env.BASE_URL || 'https://api.deepseek.com',
    },
    tools: builtinTools,
    storage,
    sessionId: 'test-session',
    permissionMode: 'trust',
  });

  console.log('✓ Agent 创建成功');
  console.log(`✓ 会话 ID: test-session`);
  console.log(`✓ 工具数量: ${builtinTools.length}`);
  console.log(`✓ 技能数量: ${skills.size}`);
} catch (e) {
  console.log(`✗ Agent 创建失败: ${e.message}`);
}
console.log();

// 总结
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📊 自测总结');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`✓ 技能包系统: ${skills.size > 0 ? '正常' : '无技能'}`);
console.log(`✓ 内置工具: ${builtinTools.length} 个`);
console.log(`✓ MCP 集成: ${existsSync(mcpConfigPath) ? '已配置' : '未配置'}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

#!/usr/bin/env node
/**
 * MCP 和技能包集成自测脚本
 * 直接使用 Node.js API 测试文件系统中的配置
 */

const { existsSync, readdirSync, readFileSync, statSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🧪 MCP 和技能包集成自测');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// 1. 测试技能发现
console.log('📦 测试 1: 技能包发现');
console.log('──────────────────────────────');

const skillsDirs = [
  join(process.cwd(), '.plain-agent', 'skills'),
  join(homedir(), '.plain-agent', 'skills'),
  join(homedir(), '.claude', 'skills'),
];

let totalSkills = 0;
skillsDirs.forEach((dir, index) => {
  const label = index === 0 ? 'project' : index === 1 ? 'global' : 'claude';
  console.log(`\n检查 ${label} 技能目录: ${dir}`);

  if (!existsSync(dir)) {
    console.log('  ⚠ 目录不存在');
    return;
  }

  try {
    const entries = readdirSync(dir);
    const skills = entries.filter(entry => {
      const skillDir = join(dir, entry);
      if (!statSync(skillDir).isDirectory()) return false;
      return existsSync(join(skillDir, 'SKILL.md'));
    });

    console.log(`  ✓ 发现 ${skills.length} 个技能`);
    skills.forEach(skill => {
      console.log(`    - ${skill}`);
      totalSkills++;
    });

    if (skills.length === 0) {
      console.log('  (无技能)');
    }
  } catch (e) {
    console.log(`  ✗ 读取失败: ${e.message}`);
  }
});

console.log(`\n总计: ${totalSkills} 个技能\n`);

// 2. 测试 MCP 配置
console.log('🔌 测试 2: MCP 配置检查');
console.log('──────────────────────────────');

const mcpConfigPath = join(homedir(), '.plain-agent', 'mcp_config.json');
console.log(`配置文件路径: ${mcpConfigPath}\n`);

if (existsSync(mcpConfigPath)) {
  try {
    const content = readFileSync(mcpConfigPath, 'utf-8');
    const mcpConfig = JSON.parse(content);
    const serverCount = Object.keys(mcpConfig.mcpServers || {}).length;

    console.log(`✓ MCP 配置文件存在`);
    console.log(`✓ 配置了 ${serverCount} 个 MCP 服务器\n`);

    if (serverCount > 0) {
      console.log('MCP 服务器列表:');
      Object.entries(mcpConfig.mcpServers).forEach(([name, config]) => {
        console.log(`  - ${name}`);
        if (config.command) {
          console.log(`    命令: ${config.command}`);
        }
      });
    } else {
      console.log('(未配置 MCP 服务器)');
    }
  } catch (e) {
    console.log(`✗ MCP 配置文件解析失败: ${e.message}`);
  }
} else {
  console.log('⚠ MCP 配置文件不存在');
  console.log('\n创建示例配置:');
  console.log(JSON.stringify({
    mcpServers: {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/directory"]
      }
    }
  }, null, 2));
}

console.log();

// 3. 测试设置配置
console.log('⚙️  测试 3: 应用设置检查');
console.log('──────────────────────────────');

const settingsPath = join(homedir(), '.plain-agent', 'settings.json');
console.log(`设置文件路径: ${settingsPath}\n`);

if (existsSync(settingsPath)) {
  try {
    const content = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    console.log(`✓ 设置文件存在`);
    console.log(`  - Model: ${settings.model || '(未设置)'}`);
    console.log(`  - Base URL: ${settings.baseUrl || '(未设置)'}`);
    console.log(`  - API Key: ${settings.apiKey ? '***' + settings.apiKey.slice(-4) : '(未设置)'}`);
    console.log(`  - Permission Mode: ${settings.permissionMode || '(未设置)'}`);
  } catch (e) {
    console.log(`✗ 设置文件解析失败: ${e.message}`);
  }
} else {
  console.log('⚠ 设置文件不存在 (将使用 .env 或默认值)');
}

console.log();

// 总结
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📊 自测总结');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`✓ 技能包系统: ${totalSkills} 个技能`);
console.log(`✓ MCP 集成: ${existsSync(mcpConfigPath) ? '已配置' : '未配置'}`);
console.log(`✓ 应用设置: ${existsSync(settingsPath) ? '已配置' : '使用默认值'}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

console.log('💡 建议测试步骤:');
console.log('1. 运行 CLI: pnpm --filter @plain-agent/cli start');
console.log('2. 测试技能: 在对话中输入 "/test-skill"');
console.log('3. 启动桌面端: pnpm --filter @plain-agent/desktop dev');
console.log('4. 在桌面端测试相同功能\n');

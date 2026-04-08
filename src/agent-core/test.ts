/**
 * Agent Core 测试脚本
 * 用于验证核心功能是否正常工作
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PlainAgent, MemoryStorage, getBuiltinTools } from './index.js';

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

loadEnv();

async function test() {
  console.log('🚀 Plain Agent Core 测试\n');

  // 检查环境变量
  if (!process.env.API_KEY) {
    console.error('❌ 错误: 请设置 API_KEY 环境变量');
    console.log('\n提示: 创建 .env 文件并添加:');
    console.log('API_KEY=your-api-key');
    console.log('MODEL=deepseek-chat');
    console.log('BASE_URL=https://api.deepseek.com');
    process.exit(1);
  }

  // 创建 Agent
  const agent = new PlainAgent({
    llm: {
      provider: 'openai',
      apiKey: process.env.API_KEY!,
      model: process.env.MODEL || 'deepseek-chat',
      baseUrl: process.env.BASE_URL,
    },
    tools: getBuiltinTools(),
    storage: new MemoryStorage(),
    permissionMode: 'trust',
  });

  // 监听事件
  agent.on('event', (event) => {
    switch (event.type) {
      case 'user':
        console.log(`\n👤 用户: ${event.message}`);
        break;
      case 'iteration':
        console.log(`\n🔄 迭代 ${event.index}`);
        break;
      case 'thinking':
        console.log(`💭 ${event.content}`);
        break;
      case 'tool_start':
        console.log(`🔧 调用工具: ${event.tool}(${JSON.stringify(event.args)})`);
        break;
      case 'tool_result':
        const result = event.result.slice(0, 100);
        console.log(`✅ 工具结果: ${result}${event.result.length > 100 ? '...' : ''} (${event.duration}ms)`);
        break;
      case 'assistant':
        console.log(`\n🤖 Agent: ${event.message}`);
        break;
      case 'done':
        console.log(`\n✅ 完成`);
        break;
      case 'error':
        console.log(`\n❌ 错误: ${event.error.message}`);
        break;
      case 'stopped':
        console.log(`\n⏹️  已停止`);
        break;
    }
  });

  try {
    // 测试任务
    const task = '请读取当前目录的 package.json 文件，告诉我项目名称和版本';
    console.log(`📝 任务: ${task}\n`);
    console.log('─'.repeat(60));

    const result = await agent.submit(task);

    console.log('\n' + '═'.repeat(60));
    console.log('📊 最终结果:');
    console.log(result);
    console.log('═'.repeat(60));

    // 获取会话 ID
    console.log(`\n📋 会话 ID: ${agent.getSessionId()}`);
    console.log(`📨 消息数量: ${agent.getMessages().length}`);

  } catch (error) {
    console.error('\n❌ 测试失败:', error);
    process.exit(1);
  } finally {
    agent.destroy();
  }

  console.log('\n✨ 测试完成！');
}

// 运行测试
test().catch(console.error);

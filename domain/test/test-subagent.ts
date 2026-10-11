/**
 * Subagent 功能测试
 *
 * 测试场景：
 * 1. 基础用法：创建子任务并等待完成
 * 2. 并发任务：同时运行多个子任务
 * 3. 工具白名单：限制子 Agent 可用工具
 * 4. 递归深度：测试嵌套子任务
 */

import { PlainAgent, MemoryStorage, getBuiltinTools, AgentEvent } from '../src/index';

// 简单的环境变量加载
function loadEnv() {
  try {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(__dirname, '../../.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      content.split('\n').forEach((line: string) => {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
          process.env[match[1]] = match[2];
        }
      });
    }
  } catch (error) {
    // Ignore
  }
}

loadEnv();

async function testBasicSubagent() {
  console.log('\n========== 测试 1: 基础子任务 ==========\n');

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
    enableSubagents: true, // 启用子 Agent
    subagentConfig: {
      maxConcurrency: 3,
      defaultTimeout: 60000,
      maxDepth: 2,
    },
  });

  // 监听事件
  agent.on('event', (event: AgentEvent) => {
    if (event.type === 'thinking') {
      console.log('🤔', event.content);
    } else if (event.type === 'tool_start') {
      console.log('🔧', event.tool, JSON.stringify(event.args, null, 2));
    } else if (event.type === 'assistant') {
      console.log('🤖', event.message);
    }
  });

  try {
    const result = await agent.submit(
      '请帮我完成以下任务：\n' +
      '1. 读取当前目录的 package.json 文件\n' +
      '2. 创建一个子任务来分析文件内容，提取项目名称和版本号\n' +
      '使用 spawn_subagent 工具，并设置 wait=true 等待完成'
    );

    console.log('\n✅ 最终结果：\n', result);
  } catch (error: any) {
    console.error('❌ 错误：', error.message);
  } finally {
    agent.destroy();
  }
}

async function testParallelSubagents() {
  console.log('\n========== 测试 2: 并发子任务 ==========\n');

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
    enableSubagents: true,
    subagentConfig: {
      maxConcurrency: 5,
    },
  });

  agent.on('event', (event) => {
    if (event.type === 'thinking') {
      console.log('🤔', event.content);
    } else if (event.type === 'tool_start') {
      console.log('🔧', event.tool);
    }
  });

  try {
    const result = await agent.submit(
      '创建 3 个并发子任务：\n' +
      '1. 子任务 A：读取 package.json\n' +
      '2. 子任务 B：读取 tsconfig.json\n' +
      '3. 子任务 C：读取 README.md\n' +
      '使用 spawn_subagent 创建它们（wait=false），然后使用 wait_subagent 等待所有任务完成'
    );

    console.log('\n✅ 最终结果：\n', result);
  } catch (error: any) {
    console.error('❌ 错误：', error.message);
  } finally {
    agent.destroy();
  }
}

async function testToolWhitelist() {
  console.log('\n========== 测试 3: 工具白名单 ==========\n');

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
    enableSubagents: true,
  });

  agent.on('event', (event) => {
    if (event.type === 'thinking') {
      console.log('🤔', event.content);
    } else if (event.type === 'tool_start') {
      console.log('🔧', event.tool);
    }
  });

  try {
    const result = await agent.submit(
      '创建一个只读子任务：\n' +
      '任务：分析 domain/src/agent.ts 文件的结构\n' +
      '限制：只能使用 read_file 和 grep 工具（设置 allowed_tools）\n' +
      '使用 spawn_subagent，wait=true'
    );

    console.log('\n✅ 最终结果：\n', result);
  } catch (error: any) {
    console.error('❌ 错误：', error.message);
  } finally {
    agent.destroy();
  }
}

async function testRecursiveDepth() {
  console.log('\n========== 测试 4: 递归深度限制 ==========\n');

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
    enableSubagents: true,
    subagentConfig: {
      maxDepth: 2, // 最多 2 层
    },
  });

  agent.on('event', (event) => {
    if (event.type === 'thinking') {
      console.log('🤔', event.content);
    } else if (event.type === 'tool_start' && event.tool === 'spawn_subagent') {
      console.log('🔧 spawn_subagent:', event.args.task);
    } else if (event.type === 'assistant') {
      console.log('🤖', event.message.slice(0, 100));
    }
  });

  try {
    const result = await agent.submit(
      '测试递归深度限制：\n' +
      '创建一个子任务 A，A 中再创建子任务 B，B 中再尝试创建子任务 C\n' +
      '预期：C 会因为超过最大深度（2）而失败'
    );

    console.log('\n✅ 最终结果：\n', result);
  } catch (error: any) {
    console.error('❌ 错误：', error.message);
  } finally {
    agent.destroy();
  }
}

async function main() {
  console.log('======================================');
  console.log('    Subagent 功能测试套件');
  console.log('======================================');

  try {
    // 测试 1: 基础子任务
    await testBasicSubagent();

    // 等待一会儿
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 测试 2: 并发子任务
    await testParallelSubagents();

    // 等待一会儿
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 测试 3: 工具白名单
    await testToolWhitelist();

    // 等待一会儿
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 测试 4: 递归深度
    await testRecursiveDepth();

    console.log('\n======================================');
    console.log('✅ 所有测试完成');
    console.log('======================================');
  } catch (error: any) {
    console.error('\n❌ 测试失败：', error.message);
    console.error(error.stack);
  }
}

// 运行测试
main().catch(console.error);

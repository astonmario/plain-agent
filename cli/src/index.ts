/**
 * CLI Adapter - 命令行交互式界面
 * 将 Agent Core 适配到命令行环境
 */

import * as readline from 'readline';
import { PlainAgent, MemoryStorage, getBuiltinTools } from '@plain-agent/domain';
import type { AgentEvent } from '@plain-agent/domain';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function colorize(color: keyof typeof colors, text: string): string {
  return `${colors[color]}${text}${colors.reset}`;
}

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

export class CLIAdapter {
  private agent: PlainAgent;
  private rl: readline.Interface;
  private isProcessing = false;

  constructor() {
    // 加载环境变量
    loadEnv();

    // 检查配置
    if (!process.env.API_KEY) {
      console.error(colorize('red', '❌ 错误: 请设置 API_KEY 环境变量'));
      console.log('\n提示: 创建 .env 文件并添加:');
      console.log('API_KEY=your-api-key');
      console.log('MODEL=deepseek-chat');
      console.log('BASE_URL=https://api.deepseek.com\n');
      process.exit(1);
    }

    // 创建 Agent
    this.agent = new PlainAgent({
      llm: {
        provider: 'openai',
        apiKey: process.env.API_KEY!,
        model: process.env.MODEL || 'deepseek-chat',
        baseUrl: process.env.BASE_URL,
      },
      tools: getBuiltinTools(),
      storage: new MemoryStorage(),
      permissionMode: 'trust', // CLI 模式默认信任
    });

    // 创建 readline 接口
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: colorize('cyan', '\n💬 你: '),
    });

    // 监听 Agent 事件
    this.agent.on('event', (event) => this.handleEvent(event));

    // 处理退出
    this.rl.on('close', () => {
      console.log(colorize('yellow', '\n\n👋 再见！'));
      this.agent.destroy();
      process.exit(0);
    });

    // 处理 Ctrl+C
    process.on('SIGINT', () => {
      if (this.isProcessing) {
        console.log(colorize('yellow', '\n\n⏹️  正在停止...'));
        this.agent.stop();
        this.isProcessing = false;
      } else {
        this.rl.close();
      }
    });
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'user':
        // 用户消息已经在输入时显示，跳过
        break;

      case 'iteration':
        process.stdout.write(colorize('gray', `\n[迭代 ${event.index}] `));
        break;

      case 'thinking':
        process.stdout.write(colorize('dim', '💭 思考中...'));
        break;

      case 'tool_start':
        console.log(
          colorize('blue', `\n🔧 调用工具: ${event.tool}`) +
          colorize('dim', `(${JSON.stringify(event.args)})`)
        );
        break;

      case 'tool_result':
        const truncated = event.result.length > 200
          ? event.result.slice(0, 200) + '...'
          : event.result;
        console.log(
          colorize('green', `✅ 结果: `) +
          colorize('dim', truncated) +
          colorize('gray', ` (${event.duration}ms)`)
        );
        break;

      case 'assistant':
        console.log(
          colorize('magenta', '\n🤖 Agent: ') +
          event.message
        );
        break;

      case 'done':
        console.log(colorize('green', '\n✅ 完成'));
        break;

      case 'error':
        console.log(
          colorize('red', '\n❌ 错误: ') +
          event.error.message
        );
        break;

      case 'stopped':
        console.log(colorize('yellow', '\n⏹️  已停止'));
        break;
    }
  }

  async start(): Promise<void> {
    // 打印欢迎信息
    console.log(colorize('bright', '\n╔════════════════════════════════════════╗'));
    console.log(colorize('bright', '║     Plain Agent CLI - 交互式界面       ║'));
    console.log(colorize('bright', '╚════════════════════════════════════════╝'));
    console.log();
    console.log(colorize('cyan', '📋 可用命令:'));
    console.log(colorize('dim', '  - 输入任务，Agent 将自动执行'));
    console.log(colorize('dim', '  - Ctrl+C 停止当前任务'));
    console.log(colorize('dim', '  - 输入 "exit" 或 "quit" 退出'));
    console.log(colorize('dim', '  - 输入 "help" 查看帮助'));
    console.log();
    console.log(colorize('gray', `📊 配置: ${process.env.MODEL} @ ${process.env.BASE_URL}`));
    console.log(colorize('gray', `🔧 工具: ${getBuiltinTools().length} 个内置工具`));

    // 开始监听输入
    this.rl.prompt();

    this.rl.on('line', async (input) => {
      const trimmed = input.trim();

      // 处理特殊命令
      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      if (trimmed === 'exit' || trimmed === 'quit') {
        this.rl.close();
        return;
      }

      if (trimmed === 'help') {
        this.showHelp();
        this.rl.prompt();
        return;
      }

      if (trimmed === 'clear') {
        console.clear();
        this.rl.prompt();
        return;
      }

      if (trimmed === 'session') {
        this.showSession();
        this.rl.prompt();
        return;
      }

      // 执行任务
      this.isProcessing = true;
      try {
        await this.agent.submit(trimmed);
      } catch (error) {
        if (error instanceof Error && error.name !== 'AbortError') {
          console.error(colorize('red', `\n❌ 执行失败: ${error.message}`));
        }
      } finally {
        this.isProcessing = false;
        this.rl.prompt();
      }
    });
  }

  private showHelp(): void {
    console.log();
    console.log(colorize('cyan', '📖 帮助信息:'));
    console.log();
    console.log(colorize('bright', '基本用法:'));
    console.log('  直接输入任务描述，Agent 将自动执行');
    console.log();
    console.log(colorize('bright', '示例任务:'));
    console.log(colorize('dim', '  - 读取当前目录的 package.json 文件'));
    console.log(colorize('dim', '  - 列出所有 .ts 文件'));
    console.log(colorize('dim', '  - 创建一个 test.txt 文件，内容是 Hello World'));
    console.log();
    console.log(colorize('bright', '特殊命令:'));
    console.log(colorize('dim', '  help     - 显示此帮助'));
    console.log(colorize('dim', '  session  - 显示会话信息'));
    console.log(colorize('dim', '  clear    - 清屏'));
    console.log(colorize('dim', '  exit     - 退出程序'));
    console.log();
    console.log(colorize('bright', '快捷键:'));
    console.log(colorize('dim', '  Ctrl+C   - 停止当前任务（再按一次退出）'));
    console.log();
  }

  private showSession(): void {
    console.log();
    console.log(colorize('cyan', '📋 会话信息:'));
    console.log(colorize('dim', `  会话 ID: ${this.agent.getSessionId()}`));
    console.log(colorize('dim', `  消息数量: ${this.agent.getMessages().length}`));
    console.log();
  }
}

// ============ 入口 ============
const cli = new CLIAdapter();
cli.start().catch((error) => {
  console.error('CLI 启动失败:', error);
  process.exit(1);
});

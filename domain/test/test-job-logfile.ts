/**
 * 后台任务日志文件与 detached 模式测试
 *
 * 验证 P2+P4：
 * 1. 日志双写到文件（完整输出无截断）
 * 2. job_output 工具 fallback 读文件（内存过期后仍可读）
 * 3. setKillOnExit(false) 后 killAll() 不终止任务
 */

import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { JobRegistry } from '../src/tools/jobs';
import { jobOutputTool } from '../src/tools/job-tools';
import type { ToolContext } from '../src/types';

const SESSION_ID = 'test-session';
const LOG_DIR = join(tmpdir(), `plain-agent-test-logs-${Date.now()}`);

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testLogFile(): Promise<void> {
  console.log('\n[日志文件双写]');
  const jobs = new JobRegistry();

  // 启动任务，传 sessionId 触发日志写入（路径由 JobRegistry 内部构建）
  // 但 JobRegistry 内部用 homedir()，我们需要让它指向测试目录
  // 简化方案：直接用真实路径，测试后清理
  const realLogDir = join(homedir(), '.plain-agent', 'sessions', SESSION_ID, 'jobs');
  mkdirSync(realLogDir, { recursive: true });

  try {
    const id = jobs.launch('node', ['-e', 'console.log("hello"); console.error("world")'], process.cwd(), undefined, SESSION_ID);

    // 等待任务完成
    await sleep(500);

    const job = jobs.get(id);
    assert(job !== null && job.done === true, '任务已完成');
    assert(job?.output.includes('hello') && job?.output.includes('world'), '内存输出包含 stdout+stderr');

    // 检查日志文件
    const logPath = join(realLogDir, `${id}.log`);
    assert(existsSync(logPath), `日志文件已创建：${logPath}`);

    const logContent = readFileSync(logPath, 'utf-8');
    assert(logContent.includes('hello') && logContent.includes('world'), '日志文件包含完整输出');

    console.log(`  · 日志文件路径：${logPath}`);
  } finally {
    // 清理测试日志
    rmSync(join(homedir(), '.plain-agent', 'sessions', SESSION_ID), { recursive: true, force: true });
  }
}

async function testJobOutputFallback(): Promise<void> {
  console.log('\n[job_output fallback 读文件]');

  // 模拟一个"已过期"的任务（内存没有，文件有）
  const fakeJobId = 'deadbeef';
  const realLogDir = join(homedir(), '.plain-agent', 'sessions', SESSION_ID, 'jobs');
  mkdirSync(realLogDir, { recursive: true });
  const logPath = join(realLogDir, `${fakeJobId}.log`);
  writeFileSync(logPath, 'task output from previous run\nexit 0');

  const emptyJobs = new JobRegistry();
  const ctx: ToolContext = {
    signal: new AbortController().signal,
    sessionId: SESSION_ID,
    emitEvent: () => {},
    jobs: emptyJobs,
  };

  try {
    const result = await jobOutputTool.handler({ id: fakeJobId }, ctx);
    assert(typeof result === 'string' && result.includes('task output from previous run'), 'fallback 读到文件内容');
    assert(result.includes('从日志文件恢复'), '提示词正确');
  } finally {
    rmSync(join(homedir(), '.plain-agent', 'sessions', SESSION_ID), { recursive: true, force: true });
  }
}

async function testDetachedMode(): Promise<void> {
  console.log('\n[detached 模式（killOnExit=false）]');
  const jobs = new JobRegistry();

  // 启动一个长时间任务
  const id = jobs.launch('node', ['-e', 'setTimeout(() => console.log("done"), 5000)'], process.cwd());
  await sleep(200); // 确保任务启动

  const before = jobs.get(id);
  assert(before !== null && before.done === false, '任务运行中');

  // 默认模式：killAll() 会终止
  jobs.killAll();
  await sleep(200); // 等待进程真正退出
  const afterKill = jobs.get(id);
  // killAll 只终止进程，不删记录；检查 done 标志或 exitCode
  assert(afterKill !== null && (afterKill.done === true || afterKill.exitCode !== null), '默认模式下任务被终止');

  // detached 模式：killAll() 不终止
  const jobs2 = new JobRegistry();
  jobs2.setKillOnExit(false);
  const id2 = jobs2.launch('node', ['-e', 'setTimeout(() => console.log("done"), 5000)'], process.cwd());
  await sleep(200);

  jobs2.killAll(); // 应该跳过
  await sleep(100);
  const stillRunning = jobs2.get(id2);
  assert(stillRunning !== null && stillRunning.done === false, 'detached 模式下任务仍在运行');

  // 清理
  jobs2.kill(id2);
}

async function main(): Promise<void> {
  try {
    await testLogFile();
    await testJobOutputFallback();
    await testDetachedMode();
  } catch (err) {
    console.error('测试异常:', err);
    failed++;
  }
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

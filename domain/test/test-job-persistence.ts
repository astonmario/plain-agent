/**
 * 后台任务结果持久化 + 回注预算自测
 *
 * 验证 P1 闭环：
 * 1. saveJob → loadPendingJobs 能读回（待回注）
 * 2. markJobConsumed 幂等（重复调用无副作用）
 * 3. 消费后 loadPendingJobs 为空
 * 4. 超预算注入降级为指针（通过 PlainAgent 内部逻辑无法直接调，这里验证存储层）
 * 5. 输出超 50KB 截断入库
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SQLiteStorage } from '../src/storage/sqlite';
import { MemoryStorage } from '../src/storage/memory';
import type { PersistedJob } from '../src/types';

const DB_PATH = join(tmpdir(), `plain-agent-test-jobs-${Date.now()}.db`);

function makeJob(id: string, overrides: Partial<PersistedJob> = {}): PersistedJob {
  return {
    id,
    command: 'npm test',
    status: 'done',
    exitCode: 0,
    output: 'all tests passed',
    truncated: false,
    startedAt: Date.now() - 5000,
    finishedAt: Date.now(),
    ...overrides,
  };
}

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

async function testSQLite(): Promise<void> {
  console.log('\n[SQLiteStorage]');
  const storage = new SQLiteStorage(DB_PATH);
  const sid = 'session-1';

  // 1. 保存后读回
  await storage.saveJob(sid, makeJob('job-1'));
  await storage.saveJob(sid, makeJob('job-2', { command: 'npm run build', exitCode: 1, status: 'error', output: 'build failed' }));
  const pending = await storage.loadPendingJobs(sid);
  assert(pending.length === 2, `保存 2 条后可读回 ${pending.length} 条`);
  assert(pending.find(j => j.id === 'job-2')?.command === 'npm run build', '字段完整（command）');
  assert(pending.find(j => j.id === 'job-2')?.exitCode === 1, '字段完整（exitCode）');

  // 2. 会话隔离
  const other = await storage.loadPendingJobs('session-2');
  assert(other.length === 0, '会话隔离：其他 session 读不到');

  // 3. 标记消费 + 幂等
  await storage.markJobConsumed(sid, 'job-1');
  const t1 = (await storage.loadPendingJobs(sid)).length;
  await storage.markJobConsumed(sid, 'job-1'); // 重复调用
  await storage.markJobConsumed(sid, 'job-1'); // 再调一次
  const t2 = (await storage.loadPendingJobs(sid)).length;
  assert(t1 === 1 && t2 === 1, `markJobConsumed 幂等（pending 稳定为 ${t2}）`);

  // 4. UPSERT：重复保存不重置 consumed_at
  await storage.saveJob(sid, makeJob('job-1'));
  const after = await storage.loadPendingJobs(sid);
  assert(after.length === 1 && after[0].id === 'job-2', 'UPSERT 不重置已消费状态');

  // 5. 输出截断（>50KB）
  const bigOutput = 'x'.repeat(60 * 1024);
  await storage.saveJob(sid, makeJob('job-big', { output: bigOutput }));
  const big = (await storage.loadPendingJobs(sid)).find(j => j.id === 'job-big');
  assert(big !== undefined && big.output.length < 55 * 1024, `60KB 输出入库截断为 ${((big?.output.length ?? 0) / 1024).toFixed(1)}KB`);
  assert(big?.truncated === true, 'truncated 标记正确');

  // 6. 删除会话级联清理
  await storage.deleteSession(sid);
  const afterDelete = await storage.loadPendingJobs(sid);
  assert(afterDelete.length === 0, 'deleteSession 级联删除任务');

  storage.close();
}

async function testMemory(): Promise<void> {
  console.log('\n[MemoryStorage]');
  const storage = new MemoryStorage();
  const sid = 'mem-1';

  await storage.saveJob(sid, makeJob('m-1'));
  await storage.saveJob(sid, makeJob('m-2'));
  assert((await storage.loadPendingJobs(sid)).length === 2, '保存 2 条读回 2 条');

  await storage.markJobConsumed(sid, 'm-1');
  await storage.markJobConsumed(sid, 'm-1');
  const pending = await storage.loadPendingJobs(sid);
  assert(pending.length === 1 && pending[0].id === 'm-2', '幂等消费后剩 1 条');

  await storage.saveJob(sid, makeJob('m-1')); // 重存不重置
  assert((await storage.loadPendingJobs(sid)).length === 1, '重存不重置 consumedAt');
}

async function main(): Promise<void> {
  try {
    await testSQLite();
    await testMemory();
  } finally {
    rmSync(DB_PATH, { force: true });
  }
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

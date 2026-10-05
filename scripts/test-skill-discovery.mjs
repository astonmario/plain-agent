#!/usr/bin/env node
/**
 * Skill Discovery 集成测试
 * 测试技能发现、搜索、详情和安装功能
 */

import { createSkillDiscovery, installRemoteSkill } from '../domain/src/skill-discovery.js';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

console.log('🧪 Skill Discovery 集成测试\n');

async function runTests() {
  const results = {
    passed: 0,
    failed: 0,
    tests: [],
  };

  function test(name, fn) {
    return async () => {
      try {
        await fn();
        console.log(`✅ ${name}`);
        results.passed++;
        results.tests.push({ name, status: 'passed' });
      } catch (error) {
        console.error(`❌ ${name}`);
        console.error(`   ${error.message}`);
        results.failed++;
        results.tests.push({ name, status: 'failed', error: error.message });
      }
    };
  }

  // ============ 测试 1: 本地官方索引搜索 ============
  await test('本地官方索引 - 搜索技能', async () => {
    const client = createSkillDiscovery();
    const result = await client.search('browser', { limit: 5 });

    if (result.skills.length === 0) {
      throw new Error('未找到任何技能');
    }

    console.log(`   找到 ${result.skills.length} 个技能`);
    console.log(`   来源: ${result.source}`);

    // 验证技能结构
    const skill = result.skills[0];
    if (!skill.id || !skill.name || !skill.description) {
      throw new Error('技能数据结构不完整');
    }
  })();

  // ============ 测试 2: 获取技能详情 ============
  await test('本地官方索引 - 获取技能详情', async () => {
    const client = createSkillDiscovery();
    const result = await client.search('browser', { limit: 1 });

    if (result.skills.length === 0) {
      throw new Error('未找到技能');
    }

    const detail = await client.getDetail(result.skills[0].id);

    if (!detail.id || !detail.name || !detail.readme) {
      throw new Error('详情数据不完整');
    }

    console.log(`   技能: ${detail.name}`);
    console.log(`   作者: ${detail.author}`);
    console.log(`   来源: ${detail.source}`);
  })();

  // ============ 测试 3: GitHub API 搜索（如果有 token）============
  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken) {
    await test('GitHub API - 搜索技能', async () => {
      const client = createSkillDiscovery(githubToken);
      const result = await client.search('skill', { limit: 5 });

      console.log(`   找到 ${result.skills.length} 个技能`);
      console.log(`   来源: ${result.source}`);

      if (result.skills.length > 0) {
        const skill = result.skills[0];
        console.log(`   示例: ${skill.name} (${skill.author})`);
      }
    })();
  } else {
    console.log('⏭️  GitHub API - 搜索技能 (跳过，未设置 GITHUB_TOKEN)');
  }

  // ============ 测试 4: 过滤器 ============
  await test('搜索过滤器 - 官方技能', async () => {
    const client = createSkillDiscovery();
    const result = await client.search('skill', { source: 'official', limit: 10 });

    // 验证所有结果都是官方技能
    const allOfficial = result.skills.every(s => s.source === 'official');
    if (!allOfficial) {
      throw new Error('过滤器失败，包含非官方技能');
    }

    console.log(`   找到 ${result.skills.length} 个官方技能`);
  })();

  // ============ 测试 5: 技能安装（模拟）============
  await test('技能安装 - 数据验证', async () => {
    const client = createSkillDiscovery();
    const result = await client.search('browser', { limit: 1 });

    if (result.skills.length === 0) {
      throw new Error('未找到技能');
    }

    const detail = await client.getDetail(result.skills[0].id);

    // 验证可安装性
    console.log(`   技能: ${detail.name}`);
    console.log(`   可安装: ${detail.installable ? '是' : '否'}`);

    if (!detail.installable) {
      console.log('   （跳过安装测试，技能不可安装）');
      return;
    }

    // 注意：不实际安装，避免污染用户环境
    console.log('   （安装测试跳过，避免修改用户目录）');
  })();

  // ============ 测试 6: CLI 命令验证 ============
  await test('CLI 命令 - 导入检查', async () => {
    const { handleSkillCommand } = await import('../cli/src/commands/skill.js');

    if (typeof handleSkillCommand !== 'function') {
      throw new Error('handleSkillCommand 不是函数');
    }

    console.log('   CLI 命令模块加载成功');
  })();

  // ============ 输出测试结果 ============
  console.log('\n' + '='.repeat(50));
  console.log('📊 测试结果');
  console.log('='.repeat(50));
  console.log(`✅ 通过: ${results.passed}`);
  console.log(`❌ 失败: ${results.failed}`);
  console.log(`📈 通过率: ${((results.passed / (results.passed + results.failed)) * 100).toFixed(1)}%`);

  if (results.failed > 0) {
    console.log('\n失败的测试:');
    results.tests
      .filter(t => t.status === 'failed')
      .forEach(t => console.log(`  - ${t.name}: ${t.error}`));
    process.exit(1);
  } else {
    console.log('\n🎉 所有测试通过！');
  }
}

runTests().catch(error => {
  console.error('\n💥 测试运行失败:', error);
  process.exit(1);
});

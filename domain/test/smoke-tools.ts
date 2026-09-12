/**
 * 新搬运工具的冒烟测试（不依赖 LLM / Electron）
 * 运行：node ../node_modules/tsx/dist/cli.mjs test/smoke-tools.ts
 */
import { getBuiltinTools, webFetchTool } from '../src/tools/index';
import { discoverSkills, skillsCatalogPrompt, globalSkillsDir } from '../src/skills';
import { useSkillTool, createSkillTool } from '../src/tools/skill';
import { submitInteractionAnswer, registerInteraction, unregisterInteraction, pendingInteractionCount } from '../src/interactions';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

(async () => {
  // 1. 注册表包含全部新工具
  const names = getBuiltinTools().map(t => t.name);
  console.log('工具列表:', names.join(', '));
  for (const n of ['web_fetch', 'web_search', 'browser_use', 'ask_question', 'use_skill', 'create_skill']) {
    check(`注册 ${n}`, names.includes(n));
  }

  // 2. 技能发现 + 目录（用临时 HOME 隔离全局目录）
  const fakeHome = mkdtempSync(join(tmpdir(), 'pa-skills-'));
  const gdir = join(fakeHome, '.plain-agent', 'skills');
  mkdirSync(join(gdir, 'pdf-merge'), { recursive: true });
  writeFileSync(join(gdir, 'pdf-merge', 'SKILL.md'), '---\nname: pdf-merge\ndescription: 合并 PDF\n---\n\n1. 用 qpdf\n');
  const skills = discoverSkills(fakeHome); // cwd 参数在真实实现是 cwd；这里传 fakeHome 当“项目根”会找 fakeHome/.plain-agent/skills
  check('发现技能', skills.has('pdf-merge'), `got: ${[...skills.keys()].join(',')}`);
  const catalog = skillsCatalogPrompt(skills);
  check('目录含技能名', catalog.includes('pdf-merge') && catalog.includes('合并 PDF'));
  check('无技能目录为空串', skillsCatalogPrompt(new Map()) === '');

  // 3. use_skill / create_skill handler
  const ctxSkills = { skills } as any;
  const used = await useSkillTool.handler({ name: 'pdf-merge' }, ctxSkills);
  check('use_skill 返回全文', used.includes('<skill_content>') && used.includes('qpdf'));
  const missing = await useSkillTool.handler({ name: 'nope' }, ctxSkills);
  check('use_skill 未知名报错', missing.startsWith('Error'));
  // create_skill project scope 相对 process.cwd()：chdir 到临时目录隔离
  const prevCwd = process.cwd();
  process.chdir(fakeHome);
  const created = await createSkillTool.handler(
    { name: 'img-resize', description: '缩放图片', content: '用 sharp', scope: 'project' },
    { skills } as any,
  );
  process.chdir(prevCwd);
  check('create_skill 落盘', created.includes('已创建') && existsSync(join(fakeHome, '.plain-agent', 'skills', 'img-resize', 'SKILL.md')));
  process.chdir(fakeHome);
  const dup = await createSkillTool.handler(
    { name: 'img-resize', description: 'x', content: 'y', scope: 'project' },
    { skills } as any,
  );
  process.chdir(prevCwd);
  check('create_skill 拒绝覆盖', dup.includes('[Error]'));
  const bad = await createSkillTool.handler({ name: 'Bad Name!', description: 'x', content: 'y' }, { skills } as any);
  check('create_skill 名字校验', bad.includes('[Error]'));
  rmSync(fakeHome, { recursive: true, force: true });

  // 4. interactions 注册表
  const answers = await new Promise<string[]>(resolve => {
    registerInteraction('t1', { resolve });
    check('挂起计数', pendingInteractionCount() === 1);
    submitInteractionAnswer('t1', ['a', 'b']);
  });
  check('答案送达', answers.join(',') === 'a,b');
  check('自动注销', pendingInteractionCount() === 0);
  submitInteractionAnswer('unknown', ['x']); // 静默不抛
  check('未知 id 静默', pendingInteractionCount() === 0);
  registerInteraction('t2', { resolve: () => {} });
  unregisterInteraction('t2');
  check('手动注销', pendingInteractionCount() === 0);

  // 5. web_fetch 真实网络（例子站点，失败不致命——可能是代理环境）
  try {
    const r = await webFetchTool.handler({ url: 'https://example.com' }, {} as any);
    check('web_fetch 抓取', r.includes('Example Domain') || r.includes('DOCTYPE'), r.slice(0, 80));
  } catch (e) {
    console.log('  ??  web_fetch 网络不可达（跳过）:', String(e).slice(0, 60));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

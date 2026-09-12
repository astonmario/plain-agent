/**
 * 技能 CRUD 冒烟测试（显式传 root，隔离真实全局目录）
 * 运行：node ../node_modules/tsx/dist/cli.mjs test/test-skills-crud.ts
 */
import {
  SKILL_NAME_RE,
  createUserSkill,
  deleteUserSkill,
  listUserSkills,
  readUserSkill,
  updateUserSkill,
} from '../src/skills';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

const root = mkdtempSync(join(tmpdir(), 'pa-crud-'));

// 名字正则
check('合法名', SKILL_NAME_RE.test('pdf-merge') && SKILL_NAME_RE.test('a1'));
check('拒绝非法名', !SKILL_NAME_RE.test('Bad Name') && !SKILL_NAME_RE.test('../x') && !SKILL_NAME_RE.test('-lead'));

// 创建
const c1 = createUserSkill({ name: 'pdf-merge', description: '合并 PDF', content: '用 qpdf' }, root);
check('创建成功', c1.ok, c1.message);
const c2 = createUserSkill({ name: 'pdf-merge', description: 'x', content: 'y' }, root);
check('重名拒绝', !c2.ok && c2.message.includes('已存在'));
check('空描述拒绝', !createUserSkill({ name: 'a', description: ' ', content: 'x' }, root).ok);
check('空正文拒绝', !createUserSkill({ name: 'a', description: 'd', content: ' ' }, root).ok);
check('路径逃逸拒绝', !createUserSkill({ name: '../escape', description: 'd', content: 'x' }, root).ok);

// 读取
const r1 = readUserSkill('pdf-merge', root);
check('读回内容', r1?.content === '用 qpdf' && r1?.description === '合并 PDF' && r1?.name === 'pdf-merge');
check('读不存在返回 null', readUserSkill('nope', root) === null);
check('读非法名返回 null', readUserSkill('../x', root) === null);

// 更新
const u1 = updateUserSkill('pdf-merge', { description: '合并/拆分 PDF', content: '用 qpdf 2' }, root);
check('更新成功', u1.ok, u1.message);
const r2 = readUserSkill('pdf-merge', root);
check('更新生效', r2?.description === '合并/拆分 PDF' && r2?.content === '用 qpdf 2');
check('更新不存在失败', !updateUserSkill('nope', { content: 'x' }, root).ok);
check('清空正文拒绝', !updateUserSkill('pdf-merge', { content: ' ' }, root).ok);

// 部分更新：只改描述，正文保留
updateUserSkill('pdf-merge', { description: '只改描述' }, root);
const r3 = readUserSkill('pdf-merge', root);
check('部分更新保留正文', r3?.description === '只改描述' && r3?.content === '用 qpdf 2');

// 列表
createUserSkill({ name: 'img-resize', description: '缩放图片', content: 'sharp' }, root);
const list = listUserSkills(root);
check('列表数量', list.length === 2, `got ${list.length}`);
check('列表按名包含', list.some(s => s.name === 'pdf-merge') && list.some(s => s.name === 'img-resize'));
// 无 frontmatter 的目录不算技能
mkdirSync(join(root, 'broken'), { recursive: true });
writeFileSync(join(root, 'broken', 'SKILL.md'), 'no frontmatter');
check('坏文件不入列', listUserSkills(root).length === 2);

// 删除
const d1 = deleteUserSkill('img-resize', root);
check('删除成功', d1.ok, d1.message);
check('删除后消失', readUserSkill('img-resize', root) === null && listUserSkills(root).length === 1);
check('删除不存在失败', !deleteUserSkill('nope', root).ok);
check('删除路径逃逸拒绝', !deleteUserSkill('../x', root).ok);

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

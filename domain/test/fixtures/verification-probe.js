/**
 * 验证检查用探针：第一次运行会挂起（等待被 kill），
 * 第二次运行看到 marker 立即成功——用于模拟「检查跑到一半进程被杀」。
 */
const fs = require('fs');
const path = require('path');

const marker = path.join(__dirname, 'probe.marker');
if (fs.existsSync(marker)) {
  process.exit(0);
}
fs.writeFileSync(marker, String(process.pid));
setTimeout(() => {}, 30_000);

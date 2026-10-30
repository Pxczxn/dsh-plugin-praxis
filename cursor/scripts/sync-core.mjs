// Cursor 插件不复制引擎源码到仓库里：dsh/src 是唯一事实来源，
// 安装/测试前把它生成到 server/core/（不提交）。
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '..', '..', 'dsh', 'src');
const target = resolve(here, '..', 'server', 'core');

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

let copied = 0;
for (const entry of readdirSync(source, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
  copyFileSync(join(source, entry.name), join(target, entry.name));
  copied += 1;
}

if (copied === 0) {
  console.error(`[praxis] 没有找到引擎源码：${source}`);
  process.exit(1);
}
console.log(`[praxis] core synced: ${copied} file(s) -> ${target}`);

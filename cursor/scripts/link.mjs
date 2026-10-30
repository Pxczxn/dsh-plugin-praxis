// 把 cursor/ 这个 Cursor Plugin 安装到 ~/.cursor/plugins/local/praxis。
//
// Cursor 只加载 ~/.cursor/plugins/local 内部目录里的插件；指向仓库外部的符号
// 链接会被跳过，所以这里用复制而不是 link。重复安装会整体替换旧副本。
//
// 用法：
//   node scripts/link.mjs install [--dest <dir>] [--dry-run] [--skip-sync]
//   node scripts/link.mjs uninstall [--dest <dir>] [--dry-run]
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = 'praxis';
const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const syncScript = join(pluginRoot, 'scripts', 'sync-core.mjs');

const EXCLUDED_DIRS = new Set(['node_modules', 'test', 'test-support', '.git', '.github']);
const REQUIRED_FILES = [
  '.cursor-plugin/plugin.json',
  'mcp.json',
  'hooks/hooks.json',
  'hooks/session-start.mjs',
  'hooks/post-tool-use.mjs',
  'hooks/after-file-edit.mjs',
  'hooks/stop.mjs',
  'server/index.js',
  'rules/praxis.mdc',
  'skills/praxis/SKILL.md',
];
const CORE_ENTRY = 'server/core/store.js';

function parseArgs(argv) {
  const options = {
    mode: null,
    dest: join(homedir(), '.cursor', 'plugins', 'local', PLUGIN_NAME),
    dryRun: false,
    skipSync: false,
    help: false,
  };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === 'install' || arg === 'uninstall') options.mode = arg;
    else if (arg === '--dest') options.dest = rest.shift() ?? '';
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--skip-sync') options.skipSync = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!options.mode) options.mode = 'install';
  if (!options.dest) throw new Error('--dest 需要一个目录');
  options.dest = resolve(options.dest);
  return options;
}

function usage() {
  return [
    '用法：node scripts/link.mjs <install|uninstall> [选项]',
    '',
    '  --dest <dir>   安装目录；默认 ~/.cursor/plugins/local/praxis',
    '  --dry-run      只打印将要做出的改动，不复制文件',
    "  --skip-sync    不重新生成 server/core（默认先用 dsh/src 生成）",
  ].join('\n');
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function readManifest() {
  const file = join(pluginRoot, '.cursor-plugin', 'plugin.json');
  if (!existsSync(file)) throw new Error(`插件清单不存在：${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function validate({ requireCore }) {
  const manifest = readManifest();
  if (manifest.name !== PLUGIN_NAME) {
    throw new Error(`插件名不是 ${PLUGIN_NAME}：${manifest.name ?? '(空)'}`);
  }
  for (const relative of REQUIRED_FILES) {
    const file = join(pluginRoot, relative);
    if (!existsSync(file)) throw new Error(`缺少插件文件：${file}`);
  }
  if (requireCore && !existsSync(join(pluginRoot, CORE_ENTRY))) {
    throw new Error(
      `引擎副本不存在：${join(pluginRoot, CORE_ENTRY)}\n先执行 node scripts/sync-core.mjs（install 默认会自动执行）。`,
    );
  }
  return manifest;
}

function runSync() {
  const result = spawnSync(process.execPath, [syncScript], {
    cwd: pluginRoot,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error('生成 server/core 失败；请先在仓库根确认 dsh/src 存在。');
  }
}

function assertOutsideRepo(dest) {
  const root = pluginRoot.endsWith(sep) ? pluginRoot : `${pluginRoot}${sep}`;
  if (dest === pluginRoot || dest.startsWith(root)) {
    throw new Error(`--dest 不能指向插件仓库内部：${dest}`);
  }
}

function keep(source) {
  const name = basename(source);
  if (EXCLUDED_DIRS.has(name)) return false;
  if (name === '.DS_Store' || name === 'Thumbs.db' || name.endsWith('.log')) return false;
  if (name.startsWith('.tmp')) return false;
  return true;
}

function install(options) {
  assertOutsideRepo(options.dest);
  const manifest = validate({ requireCore: !options.dryRun });

  console.log(`[praxis] source    ${pluginRoot}`);
  console.log(`[praxis] dest      ${options.dest}`);
  console.log(`[praxis] version   ${manifest.version ?? '(未标注)'}`);

  if (options.dryRun) {
    console.log('[praxis] --dry-run：未生成 server/core，未复制文件。');
    return;
  }

  if (!options.skipSync) runSync();

  const tmp = `${options.dest}.tmp-${timestamp()}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(dirname(options.dest), { recursive: true });
  cpSync(pluginRoot, tmp, { recursive: true, filter: keep });

  const hadPrevious = existsSync(options.dest);
  if (hadPrevious) rmSync(options.dest, { recursive: true, force: true });
  try {
    renameSync(tmp, options.dest);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(
      `写入安装目录失败：${error.message}\n如果 Cursor 正在运行，先退出 Cursor 再重试。`,
    );
  }

  console.log(`[praxis] 已${hadPrevious ? '更新' : '安装'}  ${options.dest}`);
  console.log('[praxis] 重启 Cursor（或执行 Developer: Reload Window），在 Customize 里确认');
  console.log('[praxis] praxis 的 MCP server、Hooks、Rules、Skills 已加载；MCP 首次调用需要批准。');
}

function uninstall(options) {
  assertOutsideRepo(options.dest);
  if (!existsSync(options.dest)) {
    console.log(`[praxis] 安装目录不存在，无需卸载：${options.dest}`);
    return;
  }
  if (options.dryRun) {
    console.log(`[praxis] --dry-run：将删除 ${options.dest}`);
    return;
  }
  rmSync(options.dest, { recursive: true, force: true });
  console.log(`[praxis] 已卸载  ${options.dest}`);
  console.log('[praxis] 数据目录未删除：~/.cursor/praxis（任务、经验、会话指针）。');
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[praxis] ${error.message}`);
    console.error(usage());
    process.exit(2);
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    if (options.mode === 'install') install(options);
    else uninstall(options);
  } catch (error) {
    console.error(`[praxis] ${error.message}`);
    process.exit(1);
  }
}

main();

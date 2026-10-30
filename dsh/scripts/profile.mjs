// 把 dsh/ 这个 Cordis bundle 挂到一个 DSH profile 上。
//
// 只做三件事：备份 profile 的 package.json、写入 link 依赖和 bundle 名、
// 在 profile 目录里跑 pnpm install。重复执行是安全的。
//
// 用法：
//   node scripts/profile.mjs install [--profile <dir>] [--plugin <dir>] [--dry-run] [--skip-install]
//   node scripts/profile.mjs uninstall [--profile <dir>] [--plugin <dir>] [--dry-run] [--skip-install]

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = 'dsh-plugin-praxis';
const here = dirname(fileURLToPath(import.meta.url));
const defaultPluginDir = resolve(here, '..');
const defaultPluginEntry = 'index.js';

function parseArgs(argv) {
  const options = {
    mode: null,
    profile: null,
    plugin: defaultPluginDir,
    dryRun: false,
    skipInstall: false,
    help: false,
  };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === 'install' || arg === 'uninstall') options.mode = arg;
    else if (arg === '--profile') options.profile = rest.shift() ?? '';
    else if (arg === '--plugin') options.plugin = rest.shift() ?? '';
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--skip-install') options.skipInstall = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!options.mode) options.mode = 'install';
  options.plugin = resolve(options.plugin || defaultPluginDir);
  return options;
}

function usage() {
  return [
    '用法：node scripts/profile.mjs <install|uninstall> [选项]',
    '',
    '  --profile <dir>    DSH profile 目录；省略时自动查找',
    '  --plugin <dir>     插件目录；默认是本仓库的 dsh/',
    '  --dry-run          只打印将要做出的改动，不写文件、不装依赖',
    '  --skip-install     只改 package.json，不跑 pnpm install',
    '',
    '自动查找顺序：DSH_PROFILE_DIR -> ~/.dsh/profiles/workbench',
    '             -> %APPDATA%/@deepseek-ai/dsh-desktop/dsh/profiles/workbench',
    '             -> 上述 profiles 目录下的第一个 profile。',
  ].join('\n');
}

function profileCandidates(explicit) {
  if (explicit) return [resolve(explicit)];
  const roots = [];
  const configured = process.env.DSH_PROFILE_DIR;
  if (configured && configured.trim()) roots.push(resolve(configured.trim()));
  const home = homedir();
  roots.push(join(home, '.dsh', 'profiles', 'workbench'));
  if (process.env.APPDATA) {
    roots.push(join(process.env.APPDATA, '@deepseek-ai', 'dsh-desktop', 'dsh', 'profiles', 'workbench'));
  }
  // 再扫一遍同级的其它 profile，作为兜底。
  const profilesDirs = [
    join(home, '.dsh', 'profiles'),
    process.env.APPDATA
      ? join(process.env.APPDATA, '@deepseek-ai', 'dsh-desktop', 'dsh', 'profiles')
      : null,
  ].filter(Boolean);
  for (const dir of profilesDirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.isDirectory()) roots.push(join(dir, name.name));
    }
  }
  return roots;
}

function findProfile(explicit) {
  const seen = new Set();
  const candidates = profileCandidates(explicit);
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  throw new Error(
    [
      '找不到 DSH profile（需要包含 package.json 的目录）。',
      '请用 --profile <dir> 指定，或设置 DSH_PROFILE_DIR。',
      `已检查：${[...seen].join('、') || '(无)'}`,
    ].join('\n'),
  );
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function linkSpec(profileDir, pluginDir) {
  const rel = relative(profileDir, pluginDir);
  // 跨盘符时 path.relative 返回绝对路径（C: -> D:），pnpm 接受绝对 link。
  if (rel === '' || isAbsolute(rel)) {
    return `link:${resolve(pluginDir).split(sep).join('/')}`;
  }
  const portable = rel.split(sep).join('/');
  return `link:${portable.startsWith('.') ? portable : `./${portable}`}`;
}

function installInto(profileDir, pluginDir, { dryRun, skipInstall }) {
  const file = join(profileDir, 'package.json');
  const pkg = readJson(file);
  const spec = linkSpec(profileDir, pluginDir);
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  pkg.dependencies[PLUGIN_NAME] = spec;
  pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME);
  pkg.dsh.profile.bundles = bundles;

  console.log(`[praxis] profile   ${profileDir}`);
  console.log(`[praxis] plugin    ${pluginDir}`);
  console.log(`[praxis] dependency ${PLUGIN_NAME} -> ${spec}`);
  console.log(`[praxis] bundles   ${bundles.join(', ')}`);

  if (dryRun) {
    console.log('[praxis] --dry-run：未写入 package.json，未执行 pnpm install。');
    return;
  }

  const backup = `${file}.bak-${timestamp()}`;
  copyFileSync(file, backup);
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`[praxis] 已备份  ${backup}`);

  if (skipInstall) {
    console.log('[praxis] --skip-install：请稍后自己在 profile 目录执行 pnpm install。');
  } else {
    const pnpm = spawnSync('pnpm', ['install', '--no-frozen-lockfile'], {
      cwd: profileDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (pnpm.error || pnpm.status !== 0) {
      throw new Error(
        'pnpm install 失败。请在 profile 目录手动执行 `pnpm install`，或确认已安装 pnpm。',
      );
    }
  }
  console.log('[praxis] 安装完成。重启 DeepSeek Harness（或重新装配 profile）后生效。');
}

function uninstallFrom(profileDir, { dryRun, skipInstall }) {
  const file = join(profileDir, 'package.json');
  const pkg = readJson(file);
  const hadDependency = Boolean(pkg.dependencies && PLUGIN_NAME in pkg.dependencies);
  const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  const hadBundle = bundles.includes(PLUGIN_NAME);
  if (pkg.dependencies) delete pkg.dependencies[PLUGIN_NAME];
  if (Array.isArray(pkg.dsh?.profile?.bundles)) {
    pkg.dsh.profile.bundles = bundles.filter((name) => name !== PLUGIN_NAME);
  }

  console.log(`[praxis] profile   ${profileDir}`);
  console.log(`[praxis] dependency ${hadDependency ? '已移除' : '不存在'}`);
  console.log(`[praxis] bundle     ${hadBundle ? '已移除' : '不存在'}`);
  if (dryRun) {
    console.log('[praxis] --dry-run：未写入 package.json，未执行 pnpm install。');
    return;
  }
  if (!hadDependency && !hadBundle) {
    console.log('[praxis] profile 里没有 praxis，无需改动。');
    return;
  }

  const backup = `${file}.bak-${timestamp()}`;
  copyFileSync(file, backup);
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`[praxis] 已备份  ${backup}`);

  if (!skipInstall) {
    const pnpm = spawnSync('pnpm', ['install', '--no-frozen-lockfile'], {
      cwd: profileDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (pnpm.error || pnpm.status !== 0) {
      throw new Error('pnpm install 失败；package.json 已改回无 praxis 的状态，请手动执行 pnpm install。');
    }
  }
  console.log('[praxis] 已卸载。重启 DeepSeek Harness 后生效。');
}

function checkPlugin(pluginDir) {
  const entry = join(pluginDir, defaultPluginEntry);
  if (!existsSync(entry)) {
    throw new Error(`插件入口不存在：${entry}\n请用 --plugin <dir> 指向仓库的 dsh/ 目录。`);
  }
  const pkgFile = join(pluginDir, 'package.json');
  if (!existsSync(pkgFile)) throw new Error(`插件 package.json 不存在：${pkgFile}`);
  const pkg = readJson(pkgFile);
  if (pkg.name !== PLUGIN_NAME) {
    throw new Error(`插件名不是 ${PLUGIN_NAME}：${pkg.name ?? '(空)'}`);
  }
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
    checkPlugin(options.plugin);
    const profileDir = findProfile(options.profile);
    if (options.mode === 'install') {
      installInto(profileDir, options.plugin, options);
    } else {
      uninstallFrom(profileDir, options);
    }
  } catch (error) {
    console.error(`[praxis] ${error.message}`);
    process.exit(1);
  }
}

main();

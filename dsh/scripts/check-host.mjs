// 宿主适配检查：praxis 依赖的那些宿主接缝，在本机这份 DSH 里还是不是原来那个形态。
//
// 为什么单独一个脚本、而不是并进 npm test：它读的是**本机装好的发行体**
// （Electron 的 app.asar 或解包目录），依赖外部环境；而 test/ 全部用自建假 ctx，
// 宿主改事件名或改 payload 时那些用例照样全绿。升级 DSH 之后跑一次
// `npm run check:host` 就知道还适不适配，不必再人工解包读源码。
//
// 判定取舍：找不到的包/文件一律报 UNVERIFIED（不是 FAIL），因为发行方式可能变
// （macOS 的 .app、解包目录、未来换打包器）。只有"文件在、但接缝不见了"才 FAIL。

import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCOPE = '@deepseek-ai';

/** 每条检查：某个包里必须同时出现这些片段，否则插件依赖的形态已经变了。 */
export const CHECKS = [
  {
    id: 'tools.register',
    pkg: 'dsh-tools',
    title: 'tools.register 仍要求 output { schema, render }',
    must: [/must declare output \{ schema, render/],
    why: 'index.js 注册的 output 只有 schema + render；宿主改成别的字段名就会装配失败。',
  },
  {
    id: 'tools.result',
    pkg: 'dsh-tools',
    title: 'tools/result 仍是工具结果观测事件',
    must: [/"tools\/result"/],
    why: 'observer.js 靠它在每次工具调用后落观察。',
  },
  {
    id: 'agent/pre-step.payload',
    pkg: 'dsh-agent-loop',
    title: 'agent/pre-step 的 payload 仍带 turn 与 step',
    must: [/preStep\(target, \{\s*turn,\s*step,?\s*\}\)/],
    why: 'lifecycle.js 用 payload.turn 做「每轮只提示一次」的去重键，缺 turn 会静默不再提示。',
  },
  {
    id: 'agent/pre-step.enter',
    pkg: 'dsh-agent-loop',
    title: 'agent/pre-step 的放行返回值仍是 { kind: "enter", messages }',
    must: [/kind: "enter",\s*messages:/],
    why: 'lifecycle.js 每个分支都以 next() 收尾，语义就是取宿主默认放行。',
  },
  {
    id: 'agent.event-subject',
    pkg: 'dsh-agent',
    title: 'agent 事件分发仍把 agent 注入 payload',
    must: [/fused\(payload\)/],
    why: 'pre-step / turn-stopping 的 payload 里没有 agent 字段，靠分发器注入；lifecycle.js 读 payload.agent.id。',
  },
  {
    id: 'agent.turn-stopping',
    pkg: 'dsh-agent-loop',
    title: 'agent/turn-stopping 仍在轮次收尾时触发',
    must: [/"agent\/turn-stopping"/],
    why: 'lifecycle.js 在这里记录闭环缺口，下一轮开头才有提醒。',
  },
  {
    id: 'agent.created',
    pkg: 'dsh-agent',
    title: 'agent/created 的 payload 带 agent',
    must: [/"agent\/created",\s*\{\s*agent: entry\.agent/],
    why: 'scoped praxis:hint 上下文要在 created 时按 agent.ctx 注册。',
  },
  {
    id: 'agent.disposed',
    pkg: 'dsh-agent',
    title: 'agent/disposed 的 payload 带 agent',
    must: [/agent\/disposed/, /agent: entry\.agent/],
    why: 'unregisterAgent 只撤掉属于该 agent 对象的注册，不能误伤同 id 的新 agent。',
  },
  {
    id: 'agents.list',
    pkg: 'dsh-agent',
    title: 'agents.list() 仍可列举活着的 agent',
    must: [/\blist\(\) \{/],
    why: '热加载后补注册 scoped 上下文靠它，否则已有会话这一轮拿不到提示。',
  },
  {
    id: 'sessions.get',
    pkg: 'dsh-session',
    title: 'sessions.get(id) 仍返回 session',
    must: [/get\(id\) \{\s*return this\.store\.get\(id\)\?\.session/],
    why: 'context.js 从 session.header.cwd 推工作目录与 projectKey。',
  },
  {
    id: 'session.header.cwd',
    pkg: 'dsh-session',
    title: 'session header 仍带绝对路径 cwd',
    must: [/cwd must be a string/, /record\.cwd/],
    why: 'cmd 影响分级与 projectKey 都依赖 cwd；子会话继承目录的判定也用它。',
  },
  {
    id: 'cordis.global-hooks',
    pkg: 'cordis',
    title: 'ctx.on(..., { global: true }) 仍是合法选项',
    must: [/hook\.global/],
    why: 'trust.js 用全局监听收 user-question-reply，否则受保护验收项一律拒绝。',
  },
  {
    id: 'systemPrompt.section',
    pkg: 'dsh-system-prompt',
    title: 'systemPrompt.section() 仍在',
    must: [/section\(section\) \{/],
    why: 'GUIDANCE 段落靠它进系统提示。',
  },
  {
    id: 'systemPrompt.context',
    pkg: 'dsh-system-prompt',
    title: 'systemPrompt.context() 仍在',
    must: [/context\(context\) \{/],
    why: 'praxis:hint 走运行时上下文通道，不改消息列表。',
  },
  {
    id: 'systemPrompt.interpolate',
    pkg: 'dsh-system-prompt',
    title: 'context 仍支持 interpolate: false',
    must: [/interpolate === false/],
    why: '插件文本里带 {{ 之类字符时不能被当成提示变量插值。',
  },
  {
    id: 'user-question-reply.event',
    pkg: 'dsh-user-questions',
    title: '宿主仍生成 kind=user-question-reply 且 outcome=answered 的用户消息',
    must: [/kind: "user-question-reply"/, /outcome: "answered"/],
    why: 'trust.js 只认这一种来源，其它答复一律不算授权。',
  },
  {
    id: 'user-question-reply.type',
    pkg: 'dsh-user-questions',
    title: '消息来源类型仍声明 callId + outcome',
    must: [/'user-question-reply': \{ kind: 'user-question-reply'; callId: ToolCallId; outcome: 'answered'/],
    why: '授权核对要按 callId 精确配对，并且只接受 answered。',
  },
];

async function exists(path) {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 最小 asar 读取：8 字节头 → JSON 索引 → 按偏移取文件。够用且不引第三方依赖。 */
export class AsarReader {
  constructor(archive, index, baseOffset) {
    this.archive = archive;
    this.index = index;
    this.baseOffset = baseOffset;
    this.entries = [];
    this.collect(index, '', this.entries);
  }

  collect(node, prefix, out) {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.files) this.collect(child, path, out);
      else out.push({ path, size: child.size ?? 0, offset: child.offset, unpacked: child.unpacked === true });
    }
  }

  static async open(archive) {
    const handle = await fs.open(archive, 'r');
    try {
      const head = Buffer.alloc(8);
      await handle.read(head, 0, 8, 0);
      const size = head.readUInt32LE(4);
      const header = Buffer.alloc(size);
      await handle.read(header, 0, size, 8);
      const jsonLength = header.readUInt32LE(4);
      const index = JSON.parse(header.subarray(8, 8 + jsonLength).toString('utf8'));
      return new AsarReader(archive, index, 8 + size);
    } finally {
      await handle.close();
    }
  }

  async readAt(entry) {
    const handle = await fs.open(this.archive, 'r');
    try {
      const buffer = Buffer.alloc(entry.size);
      await handle.read(buffer, 0, entry.size, this.baseOffset + Number(entry.offset));
      return buffer;
    } finally {
      await handle.close();
    }
  }
}

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.json']);
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** relativePath 是相对包目录的路径，嵌套 node_modules 与超大文件不参与匹配。 */
function isTextEntry(relativePath, size) {
  if (size > MAX_FILE_BYTES) return false;
  const dot = relativePath.lastIndexOf('.');
  if (dot < 0) return false;
  if (!TEXT_EXTENSIONS.has(relativePath.slice(dot).toLowerCase())) return false;
  return !relativePath.includes('node_modules/');
}

/** 把某个包下所有文本拼接起来，供片段匹配（够快：单包几十到几百 KB）。 */
async function packageTextAsar(reader, pkg) {
  const prefix = `dsh/node_modules/${SCOPE}/${pkg}/`;
  const entries = reader.entries.filter(
    (entry) =>
      entry.path.startsWith(prefix) && !entry.unpacked && isTextEntry(entry.path.slice(prefix.length), entry.size),
  );
  if (entries.length === 0) return null;
  const parts = [];
  for (const entry of entries) parts.push((await reader.readAt(entry)).toString('utf8'));
  return parts.join('\n');
}

async function walk(dir, out) {
  let items;
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === 'node_modules') continue;
      await walk(path, out);
    } else if (item.isFile()) {
      out.push(path);
    }
  }
  return out;
}

async function packageTextDir(root, pkg) {
  const dir = join(root, 'node_modules', SCOPE, pkg);
  if (!(await exists(dir))) return null;
  const parts = [];
  for (const file of await walk(dir, [])) {
    const stat = await fs.stat(file);
    const relative = file.slice(dir.length + 1).replace(/\\/g, '/');
    if (!isTextEntry(relative, stat.size)) continue;
    parts.push(await fs.readFile(file, 'utf8'));
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/** 解析目标路径，识别 asar 与解包目录两种发行形态。 */
export async function openHost(target) {
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) return null;

  if (stat.isFile() && target.toLowerCase().endsWith('.asar')) {
    const reader = await AsarReader.open(target);
    const manifest = reader.entries.find((entry) => entry.path === `dsh/node_modules/${SCOPE}/dsh/package.json`);
    const version = manifest
      ? JSON.parse((await reader.readAt(manifest)).toString('utf8')).version ?? null
      : null;
    return { kind: 'asar', label: target, version, text: (pkg) => packageTextAsar(reader, pkg) };
  }

  if (stat.isDirectory()) {
    // 允许直接给装机根目录、resources 目录，或 app.asar 所在目录。
    for (const nested of [join(target, 'app.asar'), join(target, 'resources', 'app.asar')]) {
      if (await exists(nested)) return openHost(nested);
    }
    const root = (await exists(join(target, 'node_modules', SCOPE)))
      ? target
      : (await exists(join(target, 'dsh', 'node_modules', SCOPE)))
        ? join(target, 'dsh')
        : null;
    if (!root) return null;
    const manifest = join(root, 'node_modules', SCOPE, 'dsh', 'package.json');
    const version = (await exists(manifest))
      ? JSON.parse(await fs.readFile(manifest, 'utf8')).version ?? null
      : null;
    return { kind: 'dir', label: root, version, text: (pkg) => packageTextDir(root, pkg) };
  }

  return null;
}

export async function discoverHost(explicit) {
  const candidates = [
    explicit,
    process.env.DSH_HOST_ASAR,
    process.env.DSH_HOST_DIR,
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
      : null,
  ].filter((value) => typeof value === 'string' && value.trim() !== '');
  for (const candidate of candidates) {
    if (await exists(candidate)) return resolve(candidate);
  }
  return null;
}

export async function readPluginManifest() {
  return JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
}

/**
 * 跑全部检查。返回结构化的结果，供 CLI、测试与将来的 CI 共用。
 * @param {{ hostPath: string, plugin?: object, checks?: Array }} options
 */
export async function checkHost({ hostPath, plugin = null, checks = CHECKS }) {
  const host = await openHost(hostPath);
  if (!host) throw new Error(`无法识别宿主形态：${hostPath}`);
  const texts = new Map();
  const load = async (pkg) => {
    if (!texts.has(pkg)) texts.set(pkg, await host.text(pkg));
    return texts.get(pkg);
  };

  const results = [];
  for (const check of checks) {
    const text = await load(check.pkg);
    if (text === null) {
      results.push({ ...check, status: 'UNVERIFIED', detail: `找不到包 ${SCOPE}/${check.pkg}` });
      continue;
    }
    const missing = check.must.filter((pattern) => !pattern.test(text)).map((pattern) => String(pattern));
    results.push(
      missing.length === 0
        ? { ...check, status: 'PASS', detail: `${check.must.length} 个片段全部命中` }
        : { ...check, status: 'FAIL', detail: `缺少：${missing.join(' ; ')}` },
    );
  }

  const passed = results.filter((item) => item.status === 'PASS').length;
  const failed = results.filter((item) => item.status === 'FAIL').length;
  const unverified = results.filter((item) => item.status === 'UNVERIFIED').length;
  return {
    host: { kind: host.kind, path: host.label, dshVersion: host.version },
    plugin: plugin ? { name: plugin.name, version: plugin.version, engines: plugin.engines ?? {} } : null,
    results,
    summary: {
      passed,
      failed,
      unverified,
      verdict: failed > 0 ? 'INCOMPATIBLE' : unverified > 0 ? 'PARTIAL' : 'COMPATIBLE',
    },
  };
}

function pad(value, width) {
  return String(value).padEnd(width);
}

async function main() {
  const args = process.argv.slice(2);
  const hostArg = args.indexOf('--host');
  const explicitHost = hostArg >= 0 ? args[hostArg + 1] : null;
  const asJson = args.includes('--json');

  const hostPath = await discoverHost(explicitHost);
  if (!hostPath) {
    console.error('未找到本机 DSH 发行体。');
    console.error('请用 --host <app.asar|解包目录> 或环境变量 DSH_HOST_DIR / DSH_HOST_ASAR 指定。');
    process.exit(2);
  }

  const plugin = await readPluginManifest();
  let report;
  try {
    report = await checkHost({ hostPath, plugin });
  } catch (error) {
    console.error(error.message);
    console.error('期望 Electron 的 app.asar，或含 node_modules/@deepseek-ai 的解包目录。');
    process.exit(2);
  }

  const { host, results, summary } = report;
  if (asJson) {
    console.log(JSON.stringify({ ...report, checks: results.map(({ why, ...rest }) => rest) }, null, 2));
  } else {
    console.log('praxis 宿主适配检查');
    console.log(`  宿主      ${host.path}  (${host.kind})`);
    console.log(`  宿主版本  ${SCOPE}/dsh ${host.dshVersion ?? '未知'}`);
    console.log(`  插件版本  ${plugin.name} ${plugin.version}  engines.dsh ${plugin.engines?.dsh ?? '未声明'}`);
    console.log('');
    const width = Math.max(...results.map((item) => item.id.length));
    for (const item of results) {
      const mark = item.status === 'PASS' ? 'PASS' : item.status === 'FAIL' ? 'FAIL' : '----';
      console.log(`  [${mark}] ${pad(item.id, width)}  ${item.title}`);
      if (item.status !== 'PASS') console.log(`         ${item.detail}`);
    }
    console.log('');
    console.log(
      `  ${summary.passed} passed, ${summary.failed} failed, ${summary.unverified} unverified → ${summary.verdict}`,
    );
    const failedChecks = results.filter((item) => item.status === 'FAIL');
    if (failedChecks.length > 0) {
      console.log('');
      console.log('  失败的条目意味着宿主接缝已经变了，插件按旧形态会静默降级或失效：');
      for (const item of failedChecks) console.log(`  - ${item.id}: ${item.why}`);
    }
  }

  process.exit(summary.failed > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

// 宿主适配检查器自身的回归测试：夹具宿主里逐条摆好接缝，看判定与退出语义对不对。
//
// 真实宿主当然更重要（`npm run check:host`），但那是环境相关的；这里要保证的是
// 检查器本身不会坏：包能读、片段能匹配、缺口气时能准确指出是哪一条。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { CHECKS, checkHost } from '../scripts/check-host.mjs';

const SCOPE = '@deepseek-ai';

/** 夹具内容照抄宿主对应位置的形态（见 docs/host-compat.md 的对照表）。 */
const FIXTURES = {
  'dsh/package.json': JSON.stringify({ name: `${SCOPE}/dsh`, version: '9.9.9-fixture' }),

  'dsh-tools/lib/index.js': `
register(definition, options = {}) {
  const output = definition.output;
  if (output === void 0) throw new TypeError(\`tool "\${name}" must declare output { schema, render, presentationMeta? }\`);
}
ctx.on("tools/result", (exec, result) => { record(exec, result); });
`,

  'dsh-agent-loop/lib/index.js': `
const decision = await this.dispatch.waterfall("agent/pre-step", {
  messages: claimed,
  ...position,
  signal
}, () => Promise.resolve({
  kind: "enter",
  messages: claimed
}));
await this.dispatch.serial("agent/turn-stopping", { turn, signal });
const decision2 = await this.preStep(target, {
  turn,
  step
});
`,

  'dsh-agent/lib/index.js': `
async serial(name, payload) {
  return await serial(carrier, name, fused(payload));
}
await this.ctx.serial(entry.carrier, "agent/created", {
  agent: entry.agent,
  source
});
this.ctx.emit("agent/disposed", { agent: entry.agent });
list() {
  return [...this.entries.values()];
}
`,

  'dsh-session/lib/index.js': `
get(id) {
  return this.store.get(id)?.session;
}
if (typeof record.cwd !== "string") throw new Error(\`session header cwd must be a string, got "\${record.cwd}"\`);
`,

  'cordis/lib/index.js': `
return [thisArg, (this._hooks[name] || []).filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx)).map((hook) => hook.callback)];
`,

  'dsh-system-prompt/lib/index.js': `
section(section) {
  return this.layers.effect(this.ctx, (layer) => layer.sections.insert(section.name, section), {});
}
context(context) {
  return this.layers.effect(this.ctx, (layer) => layer.contexts.insert(context.name, context), {});
}
text: context.interpolate === false ? context.text : interpolate(context, assembly.variables, "context")
`,

  'dsh-user-questions/lib/index.js': `
source: {
  kind: "user-question-reply",
  callId,
  outcome: "answered"
},
`,

  'dsh-user-questions/lib/typert.host.js': `
"declaration": "user: { kind: 'user'; }; 'user-question-reply': { kind: 'user-question-reply'; callId: ToolCallId; outcome: 'answered'; };"
`,
};

async function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, ...relative.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

/** 夹具里的路径统一按发行体内部布局：dsh/node_modules/@deepseek-ai/<pkg>/... */
function hostFiles() {
  const files = {};
  for (const [relative, content] of Object.entries(FIXTURES)) {
    files[relative === 'dsh/package.json' ? `dsh/node_modules/${SCOPE}/dsh/package.json` : `dsh/node_modules/${SCOPE}/${relative}`] = content;
  }
  return files;
}

async function makeHost() {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-host-'));
  await writeTree(dir, hostFiles());
  return dir;
}

/** 最小 asar 写入器，只为了验证读取器（发行体的真实形态）。 */
function buildAsar(files) {
  const tree = { files: {} };
  const blobs = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const buffer = Buffer.from(content, 'utf8');
    const segments = path.split('/');
    let node = tree.files;
    for (const segment of segments.slice(0, -1)) {
      node[segment] ??= { files: {} };
      node = node[segment].files;
    }
    node[segments.at(-1)] = { size: buffer.length, offset: String(offset) };
    blobs.push(buffer);
    offset += buffer.length;
  }
  const json = Buffer.from(JSON.stringify(tree), 'utf8');
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4)]);
  const header = Buffer.alloc(8 + padded.length);
  header.writeUInt32LE(4 + padded.length, 0);
  header.writeUInt32LE(json.length, 4);
  padded.copy(header, 8);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(header.length, 4);
  return Buffer.concat([head, header, ...blobs]);
}

test('解包目录：全部接缝在位时判 COMPATIBLE', async () => {
  const dir = await makeHost();
  try {
    const report = await checkHost({ hostPath: dir });
    assert.equal(report.host.kind, 'dir');
    assert.equal(report.host.dshVersion, '9.9.9-fixture');
    assert.equal(report.summary.failed, 0, JSON.stringify(report.results.filter((r) => r.status !== 'PASS')));
    assert.equal(report.summary.unverified, 0);
    assert.equal(report.summary.passed, CHECKS.length);
    assert.equal(report.summary.verdict, 'COMPATIBLE');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('接缝消失时报 FAIL，并指出缺哪一段', async () => {
  const dir = await makeHost();
  try {
    // 宿主把 agent 注入 payload 的实现换掉：agent/* 事件不再带 subject。
    await writeFile(
      join(dir, 'dsh', 'node_modules', SCOPE, 'dsh-agent', 'lib', 'index.js'),
      'async serial(name, payload) { return await serial(carrier, name, payload); }\n',
      'utf8',
    );
    const report = await checkHost({ hostPath: dir });
    const failed = report.results.filter((item) => item.status === 'FAIL').map((item) => item.id);
    assert.deepEqual(failed.sort(), ['agent.created', 'agent.disposed', 'agent.event-subject', 'agents.list']);
    assert.equal(report.summary.verdict, 'INCOMPATIBLE');
    for (const item of report.results.filter((entry) => entry.status === 'FAIL')) {
      assert.match(item.detail, /缺少：/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缺包时报 UNVERIFIED 而不是 FAIL：发行方式不同不等于不适配', async () => {
  const dir = await makeHost();
  try {
    await rm(join(dir, 'dsh', 'node_modules', SCOPE, 'cordis'), { recursive: true, force: true });
    await rm(join(dir, 'dsh', 'node_modules', SCOPE, 'dsh-user-questions'), { recursive: true, force: true });
    const report = await checkHost({ hostPath: dir });
    const unverified = report.results.filter((item) => item.status === 'UNVERIFIED').map((item) => item.id);
    assert.deepEqual(unverified.sort(), ['cordis.global-hooks', 'user-question-reply.event', 'user-question-reply.type']);
    assert.equal(report.summary.failed, 0);
    assert.equal(report.summary.verdict, 'PARTIAL');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('asar 发行体也能读：索引、偏移与包内文本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-asar-'));
  const asarPath = join(dir, 'app.asar');
  try {
    const files = hostFiles();
    await writeFile(asarPath, buildAsar(files));

    const report = await checkHost({ hostPath: asarPath });
    assert.equal(report.host.kind, 'asar');
    assert.equal(report.host.dshVersion, '9.9.9-fixture');
    assert.equal(report.summary.failed, 0, JSON.stringify(report.results.filter((r) => r.status !== 'PASS')));
    assert.equal(report.summary.verdict, 'COMPATIBLE');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('给装机根目录时自动下探到 resources/app.asar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-root-'));
  try {
    const files = hostFiles();
    const nested = join(dir, 'resources');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'app.asar'), buildAsar(files));

    const report = await checkHost({ hostPath: dir });
    assert.equal(report.host.kind, 'asar');
    assert.equal(report.summary.verdict, 'COMPATIBLE');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('宿主形态无法识别时明确报错，而不是假装通过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-empty-'));
  try {
    await assert.rejects(() => checkHost({ hostPath: dir }), /无法识别宿主形态/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

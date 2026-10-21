import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function mount() {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-plugin-'));
  process.env.DSH_PRAXIS_DATA_DIR = dir;
  const plugin = await import('../index.js');

  const registered = [];
  const sections = [];
  const contexts = [];
  const listeners = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    sessions: { get: () => ({ header: { cwd: dir } }) },
    get(name) {
      return name === 'sessions' ? { get: () => ({ header: { cwd: dir } }) } : undefined;
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
      context(provider) {
        contexts.push(provider);
        return () => {};
      },
    },
    on(event, handler) {
      listeners.push({ event, handler });
      return () => {};
    },
  };

  const dispose = plugin.apply(ctx);
  const exec = { agent: { id: 'session-1' }, callId: 'call-1' };
  return {
    dir,
    plugin,
    registered,
    sections,
    contexts,
    listeners,
    exec,
    dispose,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('apply 注册两个工具并符合宿主工具契约', async () => {
  const { plugin, registered, cleanup } = await mount();
  try {
    assert.equal(plugin.name, 'dsh-plugin-praxis');
    assert.deepEqual(plugin.inject, ['tools']);
    assert.deepEqual(registered.map((item) => item.name), ['praxis_task', 'praxis_lesson']);
    for (const item of registered) {
      assert.equal(typeof item.description, 'string');
      assert.ok(item.description.length > 40);
      assert.equal(item.parameters.type, 'object');
      assert.equal(item.parameters.additionalProperties, false);
      assert.ok(item.parameters.required.includes('action'));
      assert.ok(Array.isArray(item.parameters.anyOf) || item.parameters.properties.action.enum.length >= 4);
      assert.equal(item.output.schema.type, 'object');
      assert.equal(typeof item.output.render, 'function');
      assert.equal(typeof item.execute, 'function');
    }
  } finally {
    await cleanup();
  }
});

test('apply 挂载观察者、生命周期提示段与回合提醒', async () => {
  const { sections, contexts, listeners, cleanup } = await mount();
  try {
    assert.equal(sections.length, 1);
    assert.equal(sections[0].name, 'praxis');
    assert.equal(sections[0].order, 9500);
    assert.equal(typeof sections[0].text, 'string');
    assert.match(sections[0].text, /praxis/);

    // 动态提示走宿主的运行时上下文通道：不占消息位，按会话求值。
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].name, 'praxis:hint');
    assert.equal(contexts[0].order, 150);
    assert.equal(contexts[0].interpolate, false);
    assert.equal(contexts[0].text({ agent: { session: 'session-1' } }), '');
    assert.equal(contexts[0].text({ agent: undefined }), '');

    const events = listeners.map((item) => item.event);
    // 观察者只需要工具结果事件；pre-execute 不是必需通道。
    assert.ok(events.includes('tools/result'));
    // 生命周期钩子：会话级提示注册、清理与每轮提醒。
    assert.ok(events.includes('agent/created'));
    assert.ok(events.includes('agent/disposed'));
    assert.ok(events.includes('agent/pre-step'));
    assert.ok(events.includes('agent/turn-stopping'));
  } finally {
    await cleanup();
  }
});

test('execute 走到引擎并返回可渲染的 JSON 文本', async () => {
  const { registered, exec, cleanup } = await mount();
  try {
    const [task, lesson] = registered;
    const started = await task.execute({ action: 'start', goal: '把插件接进 profile' }, exec);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.match(started.data.task_id, /^[0-9a-f-]{36}$/);
    assert.equal(started.data.task.phase, 'understand');

    const refused = await lesson.execute(
      {
        action: 'save',
        scope: 'global',
        trigger: '触发器',
        lesson: '结论',
        evidence: '我试过了，应该可以',
        reusable_because: '会再遇到',
      },
      exec,
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'weak-evidence');
    assert.equal(typeof refused.hint, 'string');

    const blocks = task.output.render({}, started);
    assert.equal(blocks[0].type, 'text');
    assert.match(blocks[0].text, /把插件接进 profile/);
  } finally {
    await cleanup();
  }
});

test('未知工具字段被拒绝，避免静默忽略', async () => {
  const { registered, exec, cleanup } = await mount();
  try {
    const [task] = registered;
    // 宿主的 additionalProperties:false 会先拦一层；工具自身也必须拒绝而不是忽略。
    await assert.rejects(
      () => task.execute({ action: 'start', goal: 'x', unexpected: true }, exec),
      (error) => error.code === 'bad-action' && /unexpected/.test(error.message),
    );
  } finally {
    await cleanup();
  }
});

test('dispose 可重复调用且不抛错', async () => {
  const { dispose, cleanup } = await mount();
  try {
    assert.equal(typeof dispose, 'function');
    dispose();
    assert.doesNotThrow(() => dispose());
  } finally {
    await cleanup();
  }
});

test('config.dataDir 覆盖默认目录，便于隔离验证', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-config-'));
  const envDir = await mkdtemp(join(tmpdir(), 'praxis-env-'));
  const previous = process.env.DSH_PRAXIS_DATA_DIR;
  process.env.DSH_PRAXIS_DATA_DIR = envDir;
  const plugin = await import('../index.js');
  const registered = [];
  const ctx = {
    tools: { register: (definition) => (registered.push(definition), () => {}) },
    on: () => () => {},
  };
  try {
    const dispose = plugin.apply(ctx, { dataDir: dir });
    const started = await registered[0].execute(
      { action: 'start', goal: '隔离数据目录' },
      { agent: { id: 'session-9' }, callId: 'call-9' },
    );
    assert.equal(started.ok, true, JSON.stringify(started));

    const written = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(written.tasks.length, 1);
    assert.equal(written.tasks[0].goal, '隔离数据目录');
    // 环境变量指向的目录必须保持干净：配置优先，而不是两边都写。
    await assert.rejects(() => readFile(join(envDir, 'state.json'), 'utf8'), /ENOENT/);
    dispose();
  } finally {
    if (previous === undefined) delete process.env.DSH_PRAXIS_DATA_DIR;
    else process.env.DSH_PRAXIS_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
    await rm(envDir, { recursive: true, force: true });
  }
});

test('没有 systemPrompt 与事件总线时降级为手动工具模式', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-degraded-'));
  process.env.DSH_PRAXIS_DATA_DIR = dir;
  const plugin = await import('../index.js');
  const registered = [];
  const warnings = [];
  const ctx = {
    tools: { register: (definition) => (registered.push(definition), () => {}) },
    logger: { warn: (message) => warnings.push(message) },
  };
  try {
    const dispose = plugin.apply(ctx);
    assert.equal(registered.length, 2);
    assert.ok(warnings.some((message) => /degraded/.test(message)));
    assert.doesNotThrow(() => dispose());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

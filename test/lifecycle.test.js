import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GUIDANCE,
  HINT_CONTEXT_NAME,
  HINT_CONTEXT_ORDER,
  REMINDER,
  attachLifecycle,
  classifyRequest,
  matchingLessons,
} from '../src/lifecycle.js';
import { createEngine, readinessOf } from '../src/engine.js';
import { emptyState } from '../src/store.js';

function makeStore() {
  const state = emptyState();
  return {
    state,
    read() {
      return state;
    },
    async load() {
      return state;
    },
    async mutate(fn) {
      const result = await fn(state);
      return result ?? state;
    },
  };
}

function makePrompt() {
  return {
    sections: [],
    contexts: [],
    section(section) {
      this.sections.push(section);
      return () => {};
    },
    context(provider) {
      this.contexts.push(provider);
      return () => {
        this.contexts = this.contexts.filter((item) => item !== provider);
      };
    },
  };
}

/**
 * 模拟宿主的装配契约：
 * - 插件 ctx 上的 systemPrompt 是全局注册；
 * - 每个 agent 有自己的 agent.ctx，通过它注册的 provider 只在该 agent 的 scope 求值；
 * - agent/created 在 agent.ctx 就绪后触发。
 *
 * 这里刻意把 agent.session 建模成 Session 对象（宿主真实形状），而不是字符串；
 * 之前的测试把它当字符串，掩盖了 state.sessions[Session] 永远取不到提示的缺陷。
 */
function makeContext() {
  const listeners = new Map();
  const prompt = makePrompt();
  const liveAgents = [];
  const ctx = {
    prompt,
    sections: prompt.sections,
    contexts: prompt.contexts,
    listeners,
    liveAgents,
    systemPrompt: prompt,
    get(name) {
      if (name === 'systemPrompt') return prompt;
      if (name === 'agents') return { list: () => liveAgents };
      return undefined;
    },
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    createAgent(id) {
      const scoped = makePrompt();
      const agent = {
        id,
        session: { id },
        ctx: {
          systemPrompt: scoped,
          get(name) {
            return name === 'systemPrompt' ? scoped : undefined;
          },
        },
        scoped,
      };
      liveAgents.push(agent);
      listeners.get('agent/created')?.({ agent });
      return agent;
    },
    disposeAgent(agent) {
      const index = liveAgents.indexOf(agent);
      if (index >= 0) liveAgents.splice(index, 1);
      listeners.get('agent/disposed')?.({ agent });
    },
    hintText(id) {
      const agent = liveAgents.find((item) => item.id === id);
      const scoped = agent?.scoped.contexts.find((item) => item.name === HINT_CONTEXT_NAME);
      if (scoped) return scoped.text({ agent, scope: agent });
      const global = prompt.contexts.find((item) => item.name === HINT_CONTEXT_NAME);
      if (!global) return '';
      return global.text({ agent: agent ?? { id }, scope: agent ?? { id } });
    },
  };
  return ctx;
}

function mount(store = makeStore()) {
  const ctx = makeContext();
  const dispose = attachLifecycle(ctx, store);
  return { ctx, store, dispose };
}

const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const next = async () => ({ kind: 'allow' });

test('指引段落与提醒文本都是稳定静态内容', () => {
  assert.match(GUIDANCE, /praxis_task/);
  assert.match(GUIDANCE, /验收/);
  assert.match(GUIDANCE, /经验/);
  assert.match(REMINDER, /praxis_task/);
  assert.ok(GUIDANCE.length > REMINDER.length);
});

test('挂载时注册 order 9500 的静态段落，并注册全局兜底上下文', () => {
  const { ctx, dispose } = mount();
  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.sections[0].name, 'praxis');
  assert.equal(ctx.sections[0].order, 9500);
  assert.equal(ctx.sections[0].text, GUIDANCE);
  assert.equal(dispose.degraded, null);

  const global = ctx.contexts.filter((item) => item.name === HINT_CONTEXT_NAME);
  assert.equal(global.length, 1);
  assert.equal(global[0].order, HINT_CONTEXT_ORDER);
  assert.equal(global[0].interpolate, false);
  dispose();
});

test('宿主未 inject systemPrompt 时经 ctx.get 仍能注册段落，而不是静默降级', () => {
  const sections = [];
  const service = {
    section(section) {
      sections.push(section);
      return () => {};
    },
    context() {
      return () => {};
    },
  };
  const ctx = {
    get(name) {
      return name === 'systemPrompt' ? service : undefined;
    },
    get systemPrompt() {
      throw new Error('cannot get property "systemPrompt" without inject');
    },
    on() {
      return () => {};
    },
  };
  const dispose = attachLifecycle(ctx, makeStore());
  assert.equal(sections.length, 1);
  assert.equal(sections[0].order, 9500);
  assert.equal(dispose.degraded, null);
  dispose();
});

test('没有 systemPrompt 与事件总线时报告降级', () => {
  const dispose = attachLifecycle({}, makeStore());
  assert.equal(typeof dispose, 'function');
  assert.match(dispose.degraded, /system-prompt/);
  assert.match(dispose.degraded, /prompt-context/);
  assert.match(dispose.degraded, /hooks/);
  assert.doesNotThrow(() => dispose());
});

test('请求分类只对改动意图判定为适用', () => {
  assert.equal(classifyRequest('帮我实现一个 praxis 插件'), 'applicable');
  assert.equal(classifyRequest('修复 test/store.test.js 的失败'), 'applicable');
  assert.equal(classifyRequest('refactor the store module'), 'applicable');
  assert.equal(classifyRequest('什么是原子写'), 'not_applicable');
  assert.equal(classifyRequest('explain how the lock works'), 'not_applicable');
  assert.equal(classifyRequest('/help'), 'not_applicable');
  assert.equal(classifyRequest('看看 src/store.js'), 'not_applicable');
  assert.equal(classifyRequest(''), 'uncertain');
  assert.equal(classifyRequest('这个项目状态如何'), 'not_applicable');
  // 「整理/评估」类请求是在说事、不动代码：不能因为句子里有「开发」「进度」就注入改代码提醒。
  assert.equal(classifyRequest('整理一下你目前对这个项目的了解和开发规划'), 'not_applicable');
  assert.equal(classifyRequest('评估当前的开发进度'), 'not_applicable');
  assert.equal(classifyRequest('梳理一下有哪些风险'), 'not_applicable');
  assert.equal(classifyRequest('说明一下这个模块的职责'), 'not_applicable');
  // 名词短语里的「开发/实现」不是在动手：讨论计划、讲解实现都不该催建账。
  assert.equal(classifyRequest('讨论一下开发计划'), 'not_applicable');
  assert.equal(classifyRequest('这个插件的开发思路是什么'), 'not_applicable');
  assert.equal(classifyRequest('为什么要开发这个功能'), 'not_applicable');
  assert.equal(classifyRequest('开发者文档写得如何'), 'not_applicable');
  assert.equal(classifyRequest('分析一下 src/lifecycle.js 的实现'), 'not_applicable');
  assert.equal(classifyRequest('看看这个实现有没有问题'), 'not_applicable');
  assert.equal(classifyRequest('检查 Praxis 的提示注入机制'), 'not_applicable');
  assert.equal(classifyRequest('帮我把开发计划列出来'), 'not_applicable');
  // 只读、分析、规划、讨论即使出现动作词，也不能误判成要改代码。
  assert.equal(classifyRequest('分析一下如何修复这个 bug'), 'not_applicable');
  assert.equal(classifyRequest('讨论一下怎么优化提示逻辑'), 'not_applicable');
  assert.equal(classifyRequest('看看这段代码能不能优化'), 'not_applicable');
  assert.equal(classifyRequest('给我一些优化建议'), 'not_applicable');
  assert.equal(classifyRequest('这个 bug 的修复思路是什么'), 'not_applicable');
  assert.equal(classifyRequest('能不能优化一下这个循环'), 'not_applicable');
  assert.equal(classifyRequest('讨论这个方案'), 'not_applicable');
  assert.equal(classifyRequest('设计文档怎么写'), 'not_applicable');
  assert.equal(classifyRequest('实现方式是什么'), 'not_applicable');
  assert.equal(classifyRequest('如何直接修复这个 bug'), 'not_applicable');
  assert.equal(classifyRequest('怎么能直接优化一下'), 'not_applicable');
  assert.equal(classifyRequest('实现上有什么取舍'), 'not_applicable');
  assert.equal(classifyRequest('调整一下思路'), 'not_applicable');
  assert.equal(classifyRequest('重构的利弊'), 'not_applicable');
  assert.equal(classifyRequest('优化建议'), 'not_applicable');
  assert.equal(classifyRequest('修改建议'), 'not_applicable');
  assert.equal(classifyRequest('设计思考：为什么这样'), 'not_applicable');
  assert.equal(classifyRequest('开发这个功能需要多久'), 'not_applicable');
  assert.equal(classifyRequest('prefix 命名规范'), 'not_applicable');
  assert.equal(classifyRequest('fixture 命名规范'), 'not_applicable');
  assert.equal(classifyRequest('只读分析 src/lifecycle.js，先不要改代码'), 'not_applicable');
  // 反过来：口语化的改动请求不能漏，否则真该建账时一声不响。
  assert.equal(classifyRequest('给插件加个 dataDir 配置'), 'applicable');
  assert.equal(classifyRequest('给 README 补一段安装说明'), 'applicable');
  assert.equal(classifyRequest('优化一下 classify 的判断'), 'applicable');
  assert.equal(classifyRequest('实现一个按会话隔离的提示注入通道'), 'applicable');
  assert.equal(classifyRequest('实现这个方案'), 'applicable');
  assert.equal(classifyRequest('设计这个方案'), 'applicable');
  assert.equal(classifyRequest('请优化一下这个函数'), 'applicable');
  assert.equal(classifyRequest('修一下这个 bug'), 'applicable');
  assert.equal(classifyRequest('补一下测试'), 'applicable');
  assert.equal(classifyRequest('加一下这个字段'), 'applicable');
  assert.equal(classifyRequest('帮我修一下这个函数'), 'applicable');
  assert.equal(classifyRequest('帮我补一下测试'), 'applicable');
  assert.equal(classifyRequest('改这个文件'), 'applicable');
  assert.equal(classifyRequest('删掉这个函数'), 'applicable');
  assert.equal(classifyRequest('更新 README'), 'applicable');
  assert.equal(classifyRequest('重命名这个函数'), 'applicable');
  assert.equal(classifyRequest('/src/store.js 的测试失败了，修复它'), 'applicable');
  assert.equal(classifyRequest('为什么测试失败？帮我修复'), 'applicable');
  assert.equal(classifyRequest('检查一下：优化 Praxis 的提示注入机制'), 'applicable');
  assert.equal(classifyRequest('检查一下：实现这个方案'), 'applicable');
  assert.equal(classifyRequest('分析完直接实现'), 'applicable');
  assert.equal(classifyRequest('分析一下直接实现这个功能'), 'applicable');
  // 同一句里出现明确动作时，仍然算实现任务。
  assert.equal(classifyRequest('整理一下代码然后修复这个 bug'), 'applicable');
  assert.equal(classifyRequest('analyze and then fix the bug'), 'applicable');
  assert.equal(classifyRequest('can we optimize this loop?'), 'not_applicable');
  assert.equal(classifyRequest('review src/lifecycle.js'), 'not_applicable');
});

test('通用提醒是条件式的，误触发时也不断言本轮一定有代码改动', () => {
  assert.doesNotMatch(REMINDER, /本轮涉及代码改动/u);
  assert.match(REMINDER, /如果本轮要改代码/u);
  assert.match(REMINDER, /praxis_task start/u);
});

test('agent/created 后为每个会话注册 scoped 上下文，父子会话提示互不串扰', () => {
  const { ctx, store } = mount();
  const parent = ctx.createAgent('parent');
  const child = ctx.createAgent('child');
  assert.equal(parent.scoped.contexts.filter((item) => item.name === HINT_CONTEXT_NAME).length, 1);
  assert.equal(child.scoped.contexts.filter((item) => item.name === HINT_CONTEXT_NAME).length, 1);

  store.state.sessions = {
    parent: { praxisHint: '父会话提示' },
    child: { praxisHint: '子会话提示' },
  };
  assert.equal(ctx.hintText('parent'), '父会话提示');
  assert.equal(ctx.hintText('child'), '子会话提示');

  // 全局兜底同样按当前 agent 取提示；兼容宿主的 Session 对象与旧形状。
  const global = ctx.contexts.find((item) => item.name === HINT_CONTEXT_NAME);
  assert.equal(global.text({ agent: parent }), '父会话提示');
  assert.equal(global.text({ agent: { session: { id: 'child' } } }), '子会话提示');
  assert.equal(global.text({ agent: { id: 'parent', session: { id: 'child' } } }), '父会话提示');
  assert.equal(global.text({}), '');

  // 同一 agent 重复 created 不会重复注册；disposed 后 scoped 注册被移除。
  ctx.listeners.get('agent/created')({ agent: parent });
  assert.equal(parent.scoped.contexts.filter((item) => item.name === HINT_CONTEXT_NAME).length, 1);
  ctx.disposeAgent(child);
  assert.equal(child.scoped.contexts.length, 0);
  assert.equal(parent.scoped.contexts.filter((item) => item.name === HINT_CONTEXT_NAME).length, 1);
});

test('热加载时已活着的 agent 也会补注册 scoped 上下文', () => {
  const store = makeStore();
  const ctx = makeContext();
  const existing = {
    id: 'existing',
    session: { id: 'existing' },
    ctx: {
      get(name) {
        return name === 'systemPrompt' ? existing.scoped : undefined;
      },
    },
    scoped: makePrompt(),
  };
  ctx.liveAgents.push(existing);
  const dispose = attachLifecycle(ctx, store);
  store.state.sessions.existing = { praxisHint: '已存在会话' };

  assert.equal(existing.scoped.contexts.filter((item) => item.name === HINT_CONTEXT_NAME).length, 1);
  assert.equal(ctx.hintText('existing'), '已存在会话');
  dispose();
  assert.equal(existing.scoped.contexts.length, 0);
});

test('改动意图的第一轮第一步会注入一次提醒', async () => {
  const { ctx, store } = mount();
  const agent = ctx.createAgent('session-1');
  const handler = ctx.listeners.get('agent/pre-step');

  const payload = {
    agent,
    turn: 3,
    step: 1,
    messages: [userMessage('帮我实现一个插件')],
  };
  const decision = await handler(payload, next);
  // pre-step 不再改写消息：提醒改走宿主的运行时上下文通道，
  // 聊天界面里不会出现一条冒名用户发言的气泡。
  assert.equal(decision.kind, 'allow');
  assert.match(ctx.hintText('session-1'), /praxis_task/);
  assert.equal(store.state.sessions['session-1'].reminderCount, 1);
  assert.equal(store.state.sessions['session-1'].genericReminderCount, 1);
  assert.equal(store.state.sessions['session-1'].lastReminderTurn, 3);

  // 同一轮再次调用不重复计算，文本保持同一份
  const again = await handler(payload, next);
  assert.equal(again.kind, 'allow');
  assert.equal(store.state.sessions['session-1'].reminderCount, 1);
  assert.match(ctx.hintText('session-1'), /praxis_task/);
});

test('第一轮之后的后续步骤、非改动请求都不注入', async () => {
  const { ctx, store } = mount();
  const agent = ctx.createAgent('s1');
  const handler = ctx.listeners.get('agent/pre-step');

  const laterStep = await handler(
    { agent, turn: 1, step: 2, messages: [userMessage('帮我实现一个插件')] },
    next,
  );
  assert.equal(laterStep.kind, 'allow');

  const question = await handler(
    { agent, turn: 1, step: 1, messages: [userMessage('什么是原子写')] },
    next,
  );
  assert.equal(question.kind, 'allow');
  assert.equal(ctx.hintText('s1'), '');
  assert.equal(store.state.sessions.s1.reminderCount ?? 0, 0);
});

test('通用提醒每个会话只提示一次，不同会话各自计数', async () => {
  const { ctx, store } = mount();
  const one = ctx.createAgent('s1');
  const two = ctx.createAgent('s2');
  const handler = ctx.listeners.get('agent/pre-step');

  await handler({ agent: one, turn: 1, step: 1, messages: [userMessage('修复这个 bug')] }, next);
  await handler({ agent: one, turn: 2, step: 1, messages: [userMessage('修复这个 bug')] }, next);
  await handler({ agent: two, turn: 1, step: 1, messages: [userMessage('修复这个 bug')] }, next);
  assert.equal(store.state.sessions.s1.reminderCount, 1);
  assert.equal(store.state.sessions.s1.genericReminderCount, 1);
  assert.equal(store.state.sessions.s2.reminderCount, 1);
  assert.equal(store.state.sessions.s2.genericReminderCount, 1);
  // 第二轮不再留下重复的通用提醒。
  assert.equal(ctx.hintText('s1'), '');
  assert.match(ctx.hintText('s2'), /praxis_task/);
});

test('缺少会话标识时直接放行，不写状态', async () => {
  const { ctx, store } = mount();
  const handler = ctx.listeners.get('agent/pre-step');
  const decision = await handler({ turn: 1, step: 1, messages: [userMessage('实现插件')] }, next);
  assert.equal(decision.kind, 'allow');
  assert.deepEqual(store.state.sessions, {});
});

test('轮次停止只记录诊断，不改任务状态', async () => {
  const { ctx, store } = mount();
  const agent = ctx.createAgent('s1');
  const handler = ctx.listeners.get('agent/turn-stopping');
  assert.equal(typeof handler, 'function');

  await handler({ agent, turn: 2 });
  await handler({ agent, turn: 2 });
  assert.equal(store.state.sessions.s1.turnStops, 2);
  assert.equal(typeof store.state.sessions.s1.lastTurnStopAt, 'string');
  assert.deepEqual(store.state.tasks, []);
});

test('存储写失败时 pre-step 仍放行，不阻断对话', async () => {
  const ctx = makeContext();
  const agent = ctx.createAgent('s1');
  const broken = {
    async mutate() {
      throw new Error('disk full');
    },
  };
  attachLifecycle(ctx, broken);
  const handler = ctx.listeners.get('agent/pre-step');
  const decision = await handler(
    { agent, turn: 1, step: 1, messages: [userMessage('实现插件')] },
    next,
  );
  assert.equal(decision.kind, 'allow');
});

test('轮次停止记录未闭环任务，下一轮第一步只提醒一次；同缺口不重复', async () => {
  const { ctx, store } = mount();
  store.state.tasks.push({
    id: 'task-1',
    goal: '实现插件',
    sessionId: 's1',
    phase: 'implement',
    status: 'open',
    acceptance: [{ id: 'criterion-1', active: true }],
    verificationHistory: [],
    pendingChangeIds: ['obs-1'],
  });
  const agent = ctx.createAgent('s1');
  const turnStopping = ctx.listeners.get('agent/turn-stopping');
  const preStep = ctx.listeners.get('agent/pre-step');

  await turnStopping({ agent, turn: 2 });
  const hint = store.state.sessions.s1.closureHint;
  assert.equal(hint.taskId, 'task-1');
  assert.equal(hint.pending, true);
  assert.ok(hint.detail.some((line) => /implement/.test(line)));

  const payload = {
    agent,
    turn: 3,
    step: 1,
    messages: [userMessage('继续修复这个任务')],
  };
  const decision = await preStep(payload, next);
  assert.equal(decision.kind, 'allow');
  assert.match(ctx.hintText('s1'), /task-1/);
  assert.equal(store.state.sessions.s1.closureHint, null);
  assert.equal(store.state.sessions.s1.closureReminderCount, 1);

  // 同一轮再次调用保留原提示，不重复计数。
  await preStep(payload, next);
  assert.equal(store.state.sessions.s1.closureReminderCount, 1);

  // 下一轮缺口没变：不再重复提醒，也不退化成通用提醒。
  await turnStopping({ agent, turn: 3 });
  assert.notEqual(store.state.sessions.s1.closureHint, null);
  await preStep({ agent, turn: 4, step: 1, messages: [userMessage('继续修复这个任务')] }, next);
  assert.equal(store.state.sessions.s1.closureReminderCount, 1);
  assert.equal(ctx.hintText('s1'), '');
});

test('满足关闭条件的任务提醒 close，不再重复缺口提醒', async () => {
  const { ctx, store } = mount();
  const task = {
    id: 'task-2',
    goal: '实现插件',
    sessionId: 's1',
    projectKey: null,
    phase: 'verify',
    status: 'open',
    revision: 3,
    implementationStatus: 'unknown',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    acceptance: [{ id: 'criterion-1', text: '测试通过', source: 'user_explicit', active: true, kind: 'automated' }],
    verificationHistory: [{
      id: 'ver-1',
      level: 'passed',
      valid: true,
      revision: 3,
      provenance: 'observed',
      at: new Date().toISOString(),
      coverage: [{ criterionId: 'criterion-1', result: 'passed', observationIds: ['obs-1'] }],
    }],
    pendingChangeIds: [],
    events: [],
    needs: [],
    corrections: [],
    lessons: [],
  };
  store.state.tasks.push(task);
  // 与 engine.close 共用同一份门槛：按 complete 预演没有 blocker 才能提示 close。
  assert.deepEqual(readinessOf(task, 'complete').blockers, []);
  const agent = ctx.createAgent('s1');
  await ctx.listeners.get('agent/turn-stopping')({ agent, turn: 2 });
  assert.equal(store.state.sessions.s1.closureHint.pending, false);

  await ctx.listeners.get('agent/pre-step')(
    { agent, turn: 3, step: 1, messages: [userMessage('继续修复这个任务')] },
    next,
  );
  assert.match(ctx.hintText('s1'), /task-2/);
  assert.match(ctx.hintText('s1'), /close/);
  assert.doesNotMatch(ctx.hintText('s1'), /仍未闭环/);

  // 同一份 readiness 也被 engine.close 使用：提醒 close 时真实 close(done) 必须成功。
  const engine = createEngine(store);
  const closed = await engine.task(
    { sessionId: 's1', agentId: 's1', projectKey: null },
    { action: 'close', task_id: 'task-2', outcome: 'done', implementationStatus: 'complete' },
  );
  assert.equal(closed.ok, true, JSON.stringify(closed));
});

test('旧 revision 的通过验证不能当作关闭条件', async () => {
  const { ctx, store } = mount();
  const task = {
    id: 'task-stale',
    goal: '实现插件',
    sessionId: 's1',
    phase: 'verify',
    status: 'open',
    revision: 3,
    implementationStatus: 'unknown',
    acceptance: [{ id: 'criterion-1', active: true, kind: 'automated' }],
    verificationHistory: [{
      id: 'ver-old',
      level: 'passed',
      valid: true,
      revision: 2,
      coverage: [{ criterionId: 'criterion-1', result: 'passed', observationIds: ['obs-1'] }],
    }],
    pendingChangeIds: [],
  };
  store.state.tasks.push(task);
  assert.ok(readinessOf(task, 'complete').blockers.length > 0);

  const agent = ctx.createAgent('s1');
  await ctx.listeners.get('agent/turn-stopping')({ agent, turn: 2 });
  assert.equal(store.state.sessions.s1.closureHint.pending, true);
  assert.ok(store.state.sessions.s1.closureHint.detail.some((line) => /revision 不匹配/.test(line)));
  assert.ok(store.state.sessions.s1.closureHint.detail.some((line) => /未由当前 revision 复验覆盖/.test(line)));
});

test('旧版 closureHint 没有 codes 时不会冒充已满足 close 门槛', async () => {
  const { ctx, store } = mount();
  store.state.sessions.s1 = {
    closureHint: { taskId: 'task-old', pending: false, detail: [], phase: 'verify' },
  };
  const agent = ctx.createAgent('s1');
  await ctx.listeners.get('agent/pre-step')(
    { agent, turn: 1, step: 1, messages: [userMessage('继续修复这个任务')] },
    next,
  );
  assert.match(ctx.hintText('s1'), /旧版门槛不等于 close\(done\) 门槛/);
  assert.doesNotMatch(ctx.hintText('s1'), /已满足 close\(done\) 的门槛/);
});

test('只读请求即使有未闭环任务也不催收尾，缺口留到下一次开发请求', async () => {
  const { ctx, store } = mount();
  store.state.sessions.s1 = {
    closureHint: { taskId: 'task-3', pending: true, detail: ['仍在 implement 阶段'], phase: 'implement' },
  };
  const agent = ctx.createAgent('s1');
  await ctx.listeners.get('agent/pre-step')(
    { agent, turn: 1, step: 1, messages: [userMessage('分析一下 src/lifecycle.js 的实现')] },
    next,
  );
  assert.equal(store.state.sessions.s1.praxisHint ?? null, null);
  assert.equal(store.state.sessions.s1.closureHint.taskId, 'task-3');
  assert.equal(ctx.hintText('s1'), '');
});

test('dispose 后事件不再触发写入，scoped 注册也被清理', async () => {
  const { ctx, dispose } = mount();
  const agent = ctx.createAgent('s1');
  assert.equal(agent.scoped.contexts.length, 1);
  dispose();
  assert.equal(ctx.listeners.size, 0);
  assert.equal(agent.scoped.contexts.length, 0);
});

test('经验提示只在触发条件有具体锚点重合时命中，且项目经验必须同项目', () => {
  const state = emptyState();
  state.lessons.push({
    id: 'lesson-1',
    scope: 'global',
    status: 'active',
    trigger: '在 DSH 里写 agent/pre-step 钩子并往本轮注入消息时',
    lesson: 'pre-step 的 messages 是完整列表，必须追加而不是替换',
  });
  state.lessons.push({
    id: 'lesson-2',
    scope: 'project',
    projectKey: 'D:/x/y',
    status: 'active',
    trigger: 'rename 覆盖被系统拒绝、或需要处理进程崩溃后状态文件缺失时',
    lesson: '先备份旧文件再替换',
  });

  state.lessons.push({
    id: 'lesson-3',
    scope: 'global',
    status: 'active',
    trigger: '在 Cordis 插件里读取宿主服务时',
    lesson: '不要直接写 ctx.<service>，统一走 ctx.get(name) 兜底，拿不到就降级',
  });

  state.lessons.push({
    id: 'lesson-4',
    scope: 'project',
    projectKey: 'D:/atomic',
    status: 'active',
    trigger: '实现单文件状态的原子写入、rename 覆盖被系统拒绝、或需要处理进程崩溃后状态文件缺失的场景',
    lesson: '用临时文件加 rename 做原子替换，rename 失败时不能先把目标删掉，加载时若主文件缺失而备份完整则从备份恢复。',
  });

  // 错题本里没有相关经验就别提示：不做无意义检索。
  assert.deepEqual(matchingLessons(state, null, '写一个 CSV 导出功能：新增序列化层与 CLI 参数解析'), []);
  assert.deepEqual(matchingLessons(state, null, '给 README 补一段安装说明'), []);
  // 只重合一个高频中文二元组（「动作」「插件」）是噪声，不能算相关经验。
  assert.deepEqual(matchingLessons(state, null, '增加一个 summary 动作'), []);
  assert.deepEqual(matchingLessons(state, null, '给插件加一个 dataDir 配置'), []);
  // `name=` 这种词在每个 package.json 里都有：经验里写过 ctx.get(name)，不能因此把
  // 「写一个 sum.js 加测试」判成相关。实测这条曾以 2.24 分误命中一条宿主服务经验。
  assert.deepEqual(
    matchingLessons(state, null, '写 package.json（name=hint-probe，type=module），再写 src/sum.js 用 node --test 跑一次'),
    [],
  );

  const hits = matchingLessons(state, null, '修复 pre-step 注入提醒时把用户消息吞掉的 bug');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].lesson.id, 'lesson-1');
  // `step` 是 pre-step 拆出来的通用片段，不能因为请求里出现 step 就推 pre-step 经验。
  assert.deepEqual(matchingLessons(state, null, '下一步用 step 推进任务阶段'), []);

  // 项目经验对其它项目不可见，对同项目才可见。
  assert.deepEqual(matchingLessons(state, null, 'rename 覆盖被系统拒绝时不能让状态文件消失'), []);
  assert.deepEqual(matchingLessons(state, 'D:/other', 'rename 覆盖被系统拒绝时不能让状态文件消失'), []);
  const scoped = matchingLessons(state, 'D:/x/y', 'rename 覆盖被系统拒绝时不能让状态文件消失');
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].lesson.id, 'lesson-2');

  // 宿主给子代理的返程指引是自动追加的机械文本，与任务措辞无关。它含
  // send_message / parent agent id / messages 这些词，曾让 lesson-1 在「写 sum.js」
  // 这种无关任务上加到 4.11 分，于是每个子代理一开工就被推一条 pre-step 经验。
  const delegationGuidance = 'Your parent agent id is "session-1". Before you finish, send your result to that agent with send_message({ agent_id: "session-1", message: "<self-contained result>" }). The parent shares your workspace but does not automatically receive your transcript, tool output, or reasoning. Send earlier messages as well when a finding changes what the parent should do next; sending a message does not end your turn.';
  assert.deepEqual(
    matchingLessons(state, null, `写 package.json（name=a，type=module），再写 src/sum.js 并跑 node --test\n\n${delegationGuidance}`),
    [],
  );
  // 剥掉噪声之后，真实的 pre-step 意图仍然能对上。
  const guided = matchingLessons(state, null, `让 DSH 在 agent/pre-step 里往本轮注入一条提醒\n\n${delegationGuidance}`);
  assert.equal(guided.length, 1);
  assert.equal(guided[0].lesson.id, 'lesson-1');

  // 长请求不能因为分母随字数增长而漏掉：实测一条真实请求有 63 个中文二元组、命中 9 个，
  // 占比 0.143 卡在 0.2 阈值下，而同一意图的短句是 8/8。分母封顶后长请求才算数。
  const atomicLongRequest = '在 D:/tmp/x 目录里实现一个最小的单文件 JSON 状态存储：先写 package.json，再写 src/store.js 导出 createStore，提供 load 和 save，用「写临时文件再改名」的方式做原子替换，然后写 test/store.test.js 至少两个用例，覆盖首次加载文件不存在时返回空对象与一次保存后能读回，最后跑 npm test 确认全绿。';
  const atomicHits = matchingLessons(state, 'D:/atomic', atomicLongRequest);
  assert.equal(atomicHits.length, 1);
  assert.equal(atomicHits[0].lesson.id, 'lesson-4');

  // 测试替身词不指向任何主题：原子写任务里写一句「mock 一次 rename 失败」，就曾把一条
  // 讲 Cordis 宿主服务的经验以 2.26 分拉进提示。
  state.lessons.push({
    id: 'lesson-5',
    scope: 'global',
    status: 'active',
    trigger: '在 Cordis 插件里读取宿主服务时',
    lesson: '测试里必须用 getter 抛错的严格 mock，不要直接写 ctx.<service>',
  });
  assert.deepEqual(
    matchingLessons(state, null, '实现单文件 JSON 存储的原子写入，rename 被拒绝时用 mock 模拟失败'),
    [],
  );
  // 真去读宿主服务时仍然命中；同一触发条件的经验只提示最靠前的一条。
  const cordisHits = matchingLessons(state, null, '在 Cordis 插件里读取宿主服务 sessions 拿会话列表');
  assert.equal(cordisHits.length, 1);
  assert.ok(['lesson-3', 'lesson-5'].includes(cordisHits[0].lesson.id));

  // 句式模板和平台词不是主题锚点：只共享「检查一/查一下」或 Windows 不能算相关。
  state.lessons.push({
    id: 'lesson-template',
    scope: 'global',
    status: 'active',
    trigger: '检查一下配置是否生效时',
    lesson: '先看配置读取顺序。',
  });
  state.lessons.push({
    id: 'lesson-platform',
    scope: 'global',
    status: 'active',
    trigger: '在 Windows 沙箱里写文件被拒绝时',
    lesson: '检查沙箱策略。',
  });
  assert.deepEqual(matchingLessons(state, null, '检查一下提示词是否注入'), []);
  assert.deepEqual(matchingLessons(state, null, '调整 Windows 终端的配色'), []);
  assert.deepEqual(matchingLessons(state, null, '在 Cordis 里实现一个事件总线'), []);

  // 主题相关但触发条件不成立的经验不再提示：请求里有「检查」「实现」「验证」等通用词，
  // 但和「判断验证结果是否仍然适用于当前实现」没有共享具体锚点。
  state.lessons.push({
    id: 'lesson-6',
    scope: 'global',
    status: 'active',
    trigger: '需要判断一份验证/检查结果是否仍然适用于当前实现，或需要判断「写入」与「验证」谁先发生时',
    lesson: '用单调递增序号判断先后，不要用时间戳。',
  });
  assert.deepEqual(
    matchingLessons(
      state,
      null,
      '优化 Praxis 的提示注入机制：把通用提醒、经验推荐和任务闭环提示改为内部注入，并检查经验推荐是否存在误报。',
    ),
    [],
  );
  // 触发条件真的成立时仍然命中。
  const verifyHits = matchingLessons(state, null, '判断验证结果是否仍然适用于当前实现');
  assert.equal(verifyHits.length, 1);
  assert.equal(verifyHits[0].lesson.id, 'lesson-6');
});

test('同一轮多消息以最后意图为准，只读更正不会被前一条修复压过', async () => {
  const { ctx, store } = mount();
  const agent = ctx.createAgent('s1');
  const preStep = ctx.listeners.get('agent/pre-step');

  await preStep(
    {
      agent,
      turn: 1,
      step: 1,
      messages: [
        userMessage('帮我修复 store.js 的 bug'),
        userMessage('只读分析 lifecycle.js，不要改代码'),
      ],
    },
    next,
  );
  assert.equal(store.state.sessions.s1.praxisHint ?? null, null);
  assert.equal(store.state.sessions.s1.genericReminderCount ?? 0, 0);

  // 用户后来改口要修复时，最后一条意图仍然生效。
  await preStep(
    {
      agent,
      turn: 2,
      step: 1,
      messages: [
        userMessage('只读分析 lifecycle.js，先不要改代码'),
        userMessage('帮我修复 store.js 的 bug'),
      ],
    },
    next,
  );
  assert.match(ctx.hintText('s1'), /praxis_task/);
});

test('同 session id 的新 agent 会替换旧的 scoped 注册', () => {
  const { ctx } = mount();
  const first = ctx.createAgent('s1');
  const second = ctx.createAgent('s1');
  assert.equal(first.scoped.contexts.length, 0);
  assert.equal(second.scoped.contexts.length, 1);

  // 旧 agent 的 disposed 不能移除新 agent 的注册。
  ctx.disposeAgent(first);
  assert.equal(second.scoped.contexts.length, 1);
});

test('agent.ctx 的属性路径也能注册 scoped 上下文', () => {
  const { ctx, store } = mount();
  const scoped = makePrompt();
  const agent = {
    id: 'prop',
    session: { id: 'prop' },
    ctx: { systemPrompt: scoped },
    scoped,
  };
  ctx.liveAgents.push(agent);
  ctx.listeners.get('agent/created')({ agent });
  store.state.sessions.prop = { praxisHint: '属性路径提示' };
  assert.equal(ctx.hintText('prop'), '属性路径提示');
});

test('同一轮后续 step 沿用同一段提示，不重复写入', async () => {
  const { ctx, store } = mount();
  const agent = ctx.createAgent('s1');
  const preStep = ctx.listeners.get('agent/pre-step');

  await preStep({ agent, turn: 1, step: 1, messages: [userMessage('修复这个 bug')] }, next);
  const firstHint = ctx.hintText('s1');
  assert.match(firstHint, /praxis_task/);

  await preStep({ agent, turn: 1, step: 2, messages: [userMessage('修复这个 bug')] }, next);
  assert.equal(ctx.hintText('s1'), firstHint);
  assert.equal(store.state.sessions.s1.reminderCount, 1);
});

test('缺口不变时证据更新不会重复提醒', async () => {
  const { ctx, store } = mount();
  store.state.tasks.push({
    id: 'task-evidence',
    goal: '实现插件',
    sessionId: 's1',
    phase: 'implement',
    status: 'open',
    revision: 0,
    acceptance: [{ id: 'criterion-1', active: true, kind: 'automated' }],
    verificationHistory: [],
    pendingChangeIds: [],
  });
  store.state.observations.push({
    id: 'obs-1',
    taskId: 'task-evidence',
    sessionId: 's1',
    kind: 'test',
    outcome: 'success',
    resultSummary: 'first pass',
  });
  const agent = ctx.createAgent('s1');
  const turnStopping = ctx.listeners.get('agent/turn-stopping');
  const preStep = ctx.listeners.get('agent/pre-step');

  await turnStopping({ agent, turn: 1 });
  await preStep({ agent, turn: 2, step: 1, messages: [userMessage('继续修复这个任务')] }, next);
  assert.equal(store.state.sessions.s1.closureReminderCount, 1);
  assert.match(ctx.hintText('s1'), /obs-1/);

  // 新增一条更新的证据只改变正文里的 ID，不改变缺口类别。
  store.state.observations.push({
    id: 'obs-2',
    taskId: 'task-evidence',
    sessionId: 's1',
    kind: 'test',
    outcome: 'success',
    resultSummary: 'second pass',
  });
  await turnStopping({ agent, turn: 2 });
  await preStep({ agent, turn: 3, step: 1, messages: [userMessage('继续修复这个任务')] }, next);
  assert.equal(store.state.sessions.s1.closureReminderCount, 1);
  assert.equal(ctx.hintText('s1'), '');
});

test('闭环提醒之后不再补通用提醒', async () => {
  const { ctx, store } = mount();
  store.state.tasks.push({
    id: 'task-quota',
    goal: '实现插件',
    sessionId: 's1',
    phase: 'implement',
    status: 'open',
    acceptance: [{ id: 'criterion-1', active: true, kind: 'automated' }],
    verificationHistory: [],
    pendingChangeIds: [],
  });
  const agent = ctx.createAgent('s1');
  const turnStopping = ctx.listeners.get('agent/turn-stopping');
  const preStep = ctx.listeners.get('agent/pre-step');

  await turnStopping({ agent, turn: 1 });
  await preStep({ agent, turn: 2, step: 1, messages: [userMessage('继续修复这个任务')] }, next);
  assert.match(ctx.hintText('s1'), /task-quota/);
  assert.equal(store.state.sessions.s1.genericReminderCount, 1);

  store.state.tasks[0].status = 'closed';
  await turnStopping({ agent, turn: 3 });
  await preStep({ agent, turn: 4, step: 1, messages: [userMessage('继续修复这个任务')] }, next);
  assert.equal(store.state.sessions.s1.genericReminderCount, 1);
  assert.equal(ctx.hintText('s1'), '');
});

test('scoped 注册失败记录 warning，不冒充已启用', () => {
  const { ctx, dispose } = mount();
  const agent = {
    id: 'dup',
    session: { id: 'dup' },
    ctx: {
      systemPrompt: {
        context() {
          throw new Error('duplicate prompt context');
        },
      },
    },
    scoped: makePrompt(),
  };
  ctx.liveAgents.push(agent);
  ctx.listeners.get('agent/created')({ agent });
  assert.deepEqual(dispose.warnings, ['agent-scope']);
  dispose();
});

test('多个 open 任务只诊断最近更新的那个', async () => {
  const { ctx, store } = mount();
  const base = {
    goal: '实现插件',
    sessionId: 's1',
    phase: 'implement',
    status: 'open',
    revision: 0,
    acceptance: [{ id: 'criterion-1', active: true, kind: 'automated' }],
    verificationHistory: [],
    pendingChangeIds: [],
  };
  store.state.tasks.push({ ...base, id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' });
  store.state.tasks.push({ ...base, id: 'new', updatedAt: '2026-02-01T00:00:00.000Z' });
  const agent = ctx.createAgent('s1');
  await ctx.listeners.get('agent/turn-stopping')({ agent, turn: 1 });
  assert.equal(store.state.sessions.s1.closureHint.taskId, 'new');
});

test('存在人工验收项时不会提示 close(done)', async () => {
  const { ctx, store } = mount();
  store.state.tasks.push({
    id: 'task-manual',
    goal: '实现插件',
    sessionId: 's1',
    phase: 'verify',
    status: 'open',
    revision: 0,
    acceptance: [{ id: 'criterion-1', active: true, kind: 'manual' }],
    verificationHistory: [],
    pendingChangeIds: [],
  });
  const agent = ctx.createAgent('s1');
  await ctx.listeners.get('agent/turn-stopping')({ agent, turn: 1 });
  assert.equal(store.state.sessions.s1.closureHint.pending, true);
  assert.ok(store.state.sessions.s1.closureHint.detail.some((line) => /人工验收/.test(line)));

  await ctx.listeners.get('agent/pre-step')(
    { agent, turn: 2, step: 1, messages: [userMessage('继续修复这个任务')] },
    next,
  );
  assert.doesNotMatch(ctx.hintText('s1'), /已满足 close\(done\) 的门槛/);
});

test('相关经验在改动请求的第一轮提示一次，之后不再补通用提醒', async () => {
  const { ctx, store } = mount();
  store.state.lessons.push({
    id: 'lesson-1',
    scope: 'global',
    status: 'active',
    trigger: '写 agent/pre-step 钩子往本轮注入消息时',
    lesson: 'messages 必须追加不能替换',
  });
  const agent = ctx.createAgent('s1');

  const payload = {
    agent,
    turn: 1,
    step: 1,
    messages: [userMessage('修复 pre-step 注入提醒吞掉用户消息的问题')],
  };
  const decision = await ctx.listeners.get('agent/pre-step')(payload, next);
  assert.equal(decision.kind, 'allow');
  assert.match(ctx.hintText('s1'), /lesson-1/);
  assert.match(ctx.hintText('s1'), /何时适用/);
  assert.equal(store.state.sessions.s1.lessonHintShown, true);
  assert.equal(store.state.sessions.s1.lessonHintCount, 1);

  const again = await ctx.listeners.get('agent/pre-step')({ ...payload, turn: 2 }, next);
  assert.equal(again.kind, 'allow');
  assert.equal(ctx.hintText('s1'), '');
  assert.ok(!/lesson-1/.test(ctx.hintText('s1')));
  assert.equal(store.state.sessions.s1.lessonHintCount, 1);
  assert.equal(store.state.sessions.s1.genericReminderCount ?? 0, 0);
});

test('子代理的任务文本不会被返程指引盖掉', async () => {
  const { ctx, store } = mount();
  store.state.lessons.push({
    id: 'lesson-1',
    scope: 'global',
    status: 'active',
    trigger: '写 agent/pre-step 钩子往本轮注入消息时',
    lesson: 'messages 必须追加不能替换',
  });
  const agent = ctx.createAgent('child');
  const delegationGuidance = 'Your parent agent id is "parent". Before you finish, send your result to that agent with send_message({ agent_id: "parent", message: "<self-contained result>" }). The parent shares your workspace but does not automatically receive your transcript.';
  const messages = [
    userMessage('修复 pre-step 注入提醒吞掉用户消息的问题'),
    { role: 'user', content: [{ type: 'text', text: delegationGuidance }] },
  ];

  await ctx.listeners.get('agent/pre-step')({ agent, turn: 1, step: 1, messages }, next);
  assert.match(ctx.hintText('child'), /lesson-1/);
});

test('未闭环提醒直接给出可以引用的证据 ID', async () => {
  const { ctx, store } = mount();
  store.state.tasks.push({
    id: 'task-9',
    goal: '实现插件',
    sessionId: 's1',
    phase: 'implement',
    status: 'open',
    acceptance: [{ id: 'criterion-1', active: true }],
    verificationHistory: [],
    pendingChangeIds: [],
  });
  store.state.observations.push({
    id: 'obs-42',
    taskId: 'task-9',
    sessionId: 's1',
    kind: 'test',
    outcome: 'success',
    resultSummary: 'node --test → 144 pass 0 fail',
  });
  const agent = ctx.createAgent('s1');

  await ctx.listeners.get('agent/turn-stopping')({ agent, turn: 2 });
  const detail = store.state.sessions.s1.closureHint.detail.join('；');
  assert.match(detail, /obs-42/);
  assert.match(detail, /144 pass/);
});

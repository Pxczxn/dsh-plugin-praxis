import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GUIDANCE,
  REMINDER,
  attachLifecycle,
  classifyRequest,
} from '../src/lifecycle.js';
import { emptyState } from '../src/store.js';

function makeStore() {
  const state = emptyState();
  return {
    state,
    async load() {
      return state;
    },
    async mutate(fn) {
      const result = await fn(state);
      return result ?? state;
    },
  };
}

function makeContext(sections = []) {
  const listeners = new Map();
  return {
    sections,
    listeners,
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
  };
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

test('挂载时注册 order 9500 的静态段落', () => {
  const ctx = makeContext();
  const dispose = attachLifecycle(ctx, makeStore());
  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.sections[0].name, 'praxis');
  assert.equal(ctx.sections[0].order, 9500);
  assert.equal(ctx.sections[0].text, GUIDANCE);
  assert.equal(dispose.degraded, null);
  dispose();
});

test('宿主未 inject systemPrompt 时经 ctx.get 仍能注册段落，而不是静默降级', () => {
  const sections = [];
  const service = {
    section(section) {
      sections.push(section);
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
  assert.equal(classifyRequest('这个项目状态如何'), 'uncertain');
});

test('改动意图的第一轮第一步会注入一次提醒', async () => {
  const ctx = makeContext();
  const store = makeStore();
  attachLifecycle(ctx, store);
  const handler = ctx.listeners.get('agent/pre-step');

  const payload = {
    agent: { id: 'session-1' },
    turn: 3,
    step: 1,
    messages: [userMessage('帮我实现一个插件')],
  };
  const decision = await handler(payload, next);
  assert.equal(decision.kind, 'enter');
  // 提醒必须追加在原消息之后：pre-step 的 messages 是本轮完整用户消息列表，
  // 只返回提醒会把真正的任务指令吞掉（子代理 prompt 丢失即此原因）。
  assert.equal(decision.messages.length, 2);
  assert.equal(decision.messages[0].content[0].text, '帮我实现一个插件');
  assert.equal(decision.messages[1].role, 'user');
  assert.match(decision.messages[1].content[0].text, /praxis_task/);
  assert.equal(store.state.sessions['session-1'].reminderCount, 1);
  assert.equal(store.state.sessions['session-1'].lastReminderTurn, 3);

  // 同一轮再次调用不再注入
  const again = await handler(payload, next);
  assert.equal(again.kind, 'allow');
  assert.equal(store.state.sessions['session-1'].reminderCount, 1);
});

test('第一轮之后的后续步骤、非改动请求都不注入', async () => {
  const ctx = makeContext();
  const store = makeStore();
  attachLifecycle(ctx, store);
  const handler = ctx.listeners.get('agent/pre-step');

  const laterStep = await handler(
    { agent: { id: 's1' }, turn: 1, step: 2, messages: [userMessage('帮我实现一个插件')] },
    next,
  );
  assert.equal(laterStep.kind, 'allow');

  const question = await handler(
    { agent: { id: 's1' }, turn: 1, step: 1, messages: [userMessage('什么是原子写')] },
    next,
  );
  assert.equal(question.kind, 'allow');
  assert.equal(store.state.sessions.s1?.reminderCount ?? 0, 0);
});

test('新一轮可以再次提醒，但每个会话各自计数', async () => {
  const ctx = makeContext();
  const store = makeStore();
  attachLifecycle(ctx, store);
  const handler = ctx.listeners.get('agent/pre-step');

  await handler({ agent: { id: 's1' }, turn: 1, step: 1, messages: [userMessage('修复这个 bug')] }, next);
  await handler({ agent: { id: 's1' }, turn: 2, step: 1, messages: [userMessage('修复这个 bug')] }, next);
  await handler({ agent: { id: 's2' }, turn: 1, step: 1, messages: [userMessage('修复这个 bug')] }, next);
  assert.equal(store.state.sessions.s1.reminderCount, 2);
  assert.equal(store.state.sessions.s2.reminderCount, 1);
});

test('缺少会话标识时直接放行，不写状态', async () => {
  const ctx = makeContext();
  const store = makeStore();
  attachLifecycle(ctx, store);
  const handler = ctx.listeners.get('agent/pre-step');
  const decision = await handler({ turn: 1, step: 1, messages: [userMessage('实现插件')] }, next);
  assert.equal(decision.kind, 'allow');
  assert.deepEqual(store.state.sessions, {});
});

test('轮次停止只记录诊断，不改任务状态', async () => {
  const ctx = makeContext();
  const store = makeStore();
  attachLifecycle(ctx, store);
  const handler = ctx.listeners.get('agent/turn-stopping');
  assert.equal(typeof handler, 'function');

  await handler({ agent: { id: 's1' }, turn: 2 });
  await handler({ agent: { id: 's1' }, turn: 2 });
  assert.equal(store.state.sessions.s1.turnStops, 2);
  assert.equal(typeof store.state.sessions.s1.lastTurnStopAt, 'string');
  assert.deepEqual(store.state.tasks, []);
});

test('存储写失败时 pre-step 仍放行，不阻断对话', async () => {
  const ctx = makeContext();
  const broken = {
    async mutate() {
      throw new Error('disk full');
    },
  };
  attachLifecycle(ctx, broken);
  const handler = ctx.listeners.get('agent/pre-step');
  const decision = await handler(
    { agent: { id: 's1' }, turn: 1, step: 1, messages: [userMessage('实现插件')] },
    next,
  );
  assert.equal(decision.kind, 'allow');
});

test('轮次停止记录未闭环任务，下一轮第一步只提醒一次', async () => {
  const ctx = makeContext();
  const store = makeStore();
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
  attachLifecycle(ctx, store);

  await ctx.listeners.get('agent/turn-stopping')({ agent: { id: 's1' }, turn: 2 });
  const hint = store.state.sessions.s1.closureHint;
  assert.equal(hint.taskId, 'task-1');
  assert.equal(hint.pending, true);
  assert.ok(hint.detail.some((line) => /implement/.test(line)));

  const payload = {
    agent: { id: 's1' },
    turn: 3,
    step: 1,
    messages: [userMessage('继续')],
  };
  const decision = await ctx.listeners.get('agent/pre-step')(payload, next);
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 2, '原消息与提醒都要在');
  assert.equal(decision.messages[0].content[0].text, '继续');
  assert.match(decision.messages[1].content[0].text, /task-1/);
  assert.equal(store.state.sessions.s1.closureHint, null);
  assert.equal(store.state.sessions.s1.closureReminderCount, 1);

  const again = await ctx.listeners.get('agent/pre-step')(payload, next);
  assert.equal(again.kind, 'allow', '提醒过一次之后不再重复');
});

test('已闭环的任务不会触发未闭环提醒', async () => {
  const ctx = makeContext();
  const store = makeStore();
  store.state.tasks.push({
    id: 'task-2',
    goal: '实现插件',
    sessionId: 's1',
    phase: 'verify',
    status: 'open',
    acceptance: [{ id: 'criterion-1', active: true }],
    verificationHistory: [{ level: 'passed', valid: true }],
    pendingChangeIds: [],
  });
  attachLifecycle(ctx, store);

  await ctx.listeners.get('agent/turn-stopping')({ agent: { id: 's1' }, turn: 2 });
  assert.equal(store.state.sessions.s1.closureHint.pending, false);

  const decision = await ctx.listeners.get('agent/pre-step')(
    { agent: { id: 's1' }, turn: 3, step: 1, messages: [userMessage('继续')] },
    next,
  );
  assert.equal(decision.kind, 'allow');
});

test('dispose 后事件不再触发写入', async () => {
  const ctx = makeContext();
  const store = makeStore();
  const dispose = attachLifecycle(ctx, store);
  dispose();
  assert.equal(ctx.listeners.size, 0);
});

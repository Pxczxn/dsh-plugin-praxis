import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GUIDANCE,
  REMINDER,
  attachLifecycle,
  classifyRequest,
  matchingLessons,
} from '../src/lifecycle.js';
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

function makeContext(sections = [], contexts = []) {
  const listeners = new Map();
  return {
    sections,
    contexts,
    listeners,
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
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
  };
}

/** 模拟宿主的求值时机：请求前用当前会话去问运行时上下文要文本。 */
const hintText = (ctx, sessionId = 'session-1') => ctx.contexts[0].text({ agent: { session: sessionId } });

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
  // 反过来：口语化的改动请求不能漏，否则真该建账时一声不响。
  assert.equal(classifyRequest('给插件加个 dataDir 配置'), 'applicable');
  assert.equal(classifyRequest('给 README 补一段安装说明'), 'applicable');
  assert.equal(classifyRequest('优化一下 classify 的判断'), 'applicable');
  // 同一句里出现明确动作时，仍然算实现任务。
  assert.equal(classifyRequest('整理一下代码然后修复这个 bug'), 'applicable');
});

test('通用提醒是条件式的，误触发时也不断言本轮一定有代码改动', () => {
  assert.doesNotMatch(REMINDER, /本轮涉及代码改动/u);
  assert.match(REMINDER, /如果本轮要改代码/u);
  assert.match(REMINDER, /praxis_task start/u);
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
  // pre-step 不再改写消息：提醒改走宿主的运行时上下文通道，
  // 聊天界面里不会出现一条冒名用户发言的气泡。
  assert.equal(decision.kind, 'allow');
  assert.match(hintText(ctx, 'session-1'), /praxis_task/);
  assert.equal(store.state.sessions['session-1'].reminderCount, 1);
  assert.equal(store.state.sessions['session-1'].lastReminderTurn, 3);

  // 同一轮再次调用不再注入，文本保持同一份
  const again = await handler(payload, next);
  assert.equal(again.kind, 'allow');
  assert.equal(store.state.sessions['session-1'].reminderCount, 1);
  assert.match(hintText(ctx, 'session-1'), /praxis_task/);
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
  assert.equal(decision.kind, 'allow');
  assert.match(hintText(ctx, 's1'), /task-1/);
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

test('经验提示只在措辞对得上时命中，且项目经验必须同项目', () => {
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
  // 真去读宿主服务时仍然命中。
  const cordisHits = matchingLessons(state, null, '在 Cordis 插件里读取宿主服务 sessions 拿会话列表');
  assert.ok(cordisHits.some((hit) => hit.lesson.id === 'lesson-5'));
});

test('相关经验在改动请求的第一轮提示一次，之后回到通用提醒', async () => {
  const ctx = makeContext();
  const store = makeStore();
  store.state.lessons.push({
    id: 'lesson-1',
    scope: 'global',
    status: 'active',
    trigger: '写 agent/pre-step 钩子往本轮注入消息时',
    lesson: 'messages 必须追加不能替换',
  });
  attachLifecycle(ctx, store);

  const payload = {
    agent: { id: 's1' },
    turn: 1,
    step: 1,
    messages: [userMessage('修复 pre-step 注入提醒吞掉用户消息的问题')],
  };
  const decision = await ctx.listeners.get('agent/pre-step')(payload, next);
  assert.equal(decision.kind, 'allow');
  assert.match(hintText(ctx, 's1'), /lesson-1/);
  assert.equal(store.state.sessions.s1.lessonHintShown, true);
  assert.equal(store.state.sessions.s1.lessonHintCount, 1);

  const again = await ctx.listeners.get('agent/pre-step')({ ...payload, turn: 2 }, next);
  assert.equal(again.kind, 'allow');
  assert.match(hintText(ctx, 's1'), /praxis_task start/);
  assert.ok(!/lesson-1/.test(hintText(ctx, 's1')));
  assert.equal(store.state.sessions.s1.lessonHintCount, 1);
});

test('未闭环提醒直接给出可以引用的证据 ID', async () => {
  const ctx = makeContext();
  const store = makeStore();
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
  attachLifecycle(ctx, store);

  await ctx.listeners.get('agent/turn-stopping')({ agent: { id: 's1' }, turn: 2 });
  const detail = store.state.sessions.s1.closureHint.detail.join('；');
  assert.match(detail, /obs-42/);
  assert.match(detail, /144 pass/);
});

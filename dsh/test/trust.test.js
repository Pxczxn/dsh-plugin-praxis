import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../src/engine.js';
import { emptyState } from '../src/store.js';
import {
  extractConfirmation,
  recordConfirmation,
  findUsableConfirmation,
  consumeConfirmation,
  attachTrust,
  MAX_CONFIRMATIONS,
} from '../src/trust.js';

const ctx = { sessionId: 'session-1', agentId: 'session-1', projectKey: '/repo/demo' };

function fakeStore() {
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
    read() {
      return state;
    },
  };
}

function setup() {
  const store = fakeStore();
  return { store, state: store.state, engine: createEngine(store) };
}

/**
 * 构造一条宿主 user-question-reply 事件（形状来自 M0 实测 m1-payload.mjs）。
 * questions 的 question 文本必须包含验收项 id 与变更内容，才能通过覆盖检查。
 */
function replyEvent(callId, questions, answers, overrides = {}) {
  return {
    data: {
      sessionId: 'session-1',
      source: { kind: 'user-question-reply', callId, outcome: 'answered', ...(overrides.source ?? {}) },
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            kind: 'answer_to_pending_question',
            tool: 'ask_user_question',
            callId,
            questions,
            answers,
          }),
        },
      ],
      role: 'user',
      ...overrides.data,
    },
  };
}

/** 把一条已确认的授权写入 state（等价 attachTrust 观察到事件后的效果）。 */
function seedConfirmation(state, callId, questionText, selected = ['确认']) {
  recordConfirmation(state, {
    sessionId: 'session-1',
    callId,
    questions: [{ id: 'q1', question: questionText }],
    answers: [{ id: 'q1', selected }],
  });
}

async function protectedStart(engine, { callId = 'call-confirm-1', text = 'node --test 全部通过' } = {}) {
  return engine.task(ctx, {
    action: 'start',
    goal: '验证受保护验收项',
    acceptance: [
      {
        text,
        protected: true,
        confirmation_call_id: callId,
      },
    ],
  });
}

// ---------- trust.js：extractConfirmation ----------

test('extractConfirmation 只接受宿主 user-question-reply 的合法 spell', () => {
  const good = extractConfirmation(
    replyEvent('call-1', [{ id: 'q1', question: '是否同意 X？' }], [{ id: 'q1', selected: ['确认'] }]),
  );
  assert.equal(good.callId, 'call-1');
  assert.equal(good.questions.length, 1);
  assert.equal(good.answers[0].selected[0], '确认');
});

test('extractConfirmation 拒绝非回答来源、错 spell 与空问答', () => {
  // 其他用户消息不是授权
  assert.equal(
    extractConfirmation({ data: { source: { kind: 'user-rpc' }, content: [{ type: 'text', text: '你好' }] } }),
    null,
  );
  // outcome 不是 answered
  const pending = replyEvent('call-2', [{ id: 'q1', question: 'x' }], [{ id: 'q1', selected: ['y'] }]);
  pending.data.source.outcome = 'pending';
  assert.equal(extractConfirmation(pending), null);
  // callId 不一致
  const mismatched = replyEvent('call-3', [{ id: 'q1', question: 'x' }], [{ id: 'q1', selected: ['y'] }]);
  mismatched.data.content[0].text = JSON.stringify({
    kind: 'answer_to_pending_question',
    tool: 'ask_user_question',
    callId: 'other',
    questions: [{ id: 'q1', question: 'x' }],
    answers: [{ id: 'q1', selected: ['y'] }],
  });
  assert.equal(extractConfirmation(mismatched), null);
  // spell 损坏
  const corrupt = replyEvent('call-4', [{ id: 'q1', question: 'x' }], [{ id: 'q1', selected: ['y'] }]);
  corrupt.data.content[0].text = 'not json';
  assert.equal(extractConfirmation(corrupt), null);
  // 空问题/空回答
  assert.equal(extractConfirmation(replyEvent('call-5', [], [{ id: 'q1', selected: ['y'] }])), null);
  assert.equal(extractConfirmation(replyEvent('call-6', [{ id: 'q1', question: 'x' }], [])), null);
});

// ---------- trust.js：recordConfirmation ----------

test('recordConfirmation 按 (sessionId, callId) 幂等，消费状态不被覆盖', () => {
  const { state } = setup();
  const first = recordConfirmation(state, {
    sessionId: 's1',
    callId: 'c1',
    questions: [{ id: 'q1', question: 'q' }],
    answers: [{ id: 'q1', selected: ['a'] }],
  });
  assert.ok(first);
  consumeConfirmation(state, findUsableConfirmation(state, 's1', 'c1'), 'task:x');

  const replay = recordConfirmation(state, {
    sessionId: 's1',
    callId: 'c1',
    questions: [{ id: 'q1', question: 'q' }],
    answers: [{ id: 'q1', selected: ['a'] }],
  });
  assert.equal(replay, first);
  assert.equal(state.confirmations[0].consumedBy, 'task:x');
});

test('recordConfirmation 容量上限驱逐已消费项，全被引用时丢弃新记录', () => {
  const { state } = setup();
  for (let i = 0; i < MAX_CONFIRMATIONS; i += 1) {
    recordConfirmation(state, {
      sessionId: 's1',
      callId: `c${i}`,
      questions: [{ id: 'q', question: 'q' }],
      answers: [{ id: 'q', selected: ['a'] }],
    });
  }
  assert.equal(state.confirmations.length, MAX_CONFIRMATIONS);
  // 消费最早的一条，再插入新的：应驱逐旧的而不是丢弃新的。
  consumeConfirmation(state, state.confirmations[0], 'task:drain');
  const added = recordConfirmation(state, {
    sessionId: 's1',
    callId: 'c-new',
    questions: [{ id: 'q', question: 'q' }],
    answers: [{ id: 'q', selected: ['a'] }],
  });
  assert.ok(added);
  assert.equal(state.confirmations.length, MAX_CONFIRMATIONS);
  assert.equal(state.confirmations.some((item) => item.callId === 'c-new'), true);

  // 全部未消费时插入会丢弃新记录并计数。
  const another = recordConfirmation(state, {
    sessionId: 's1',
    callId: 'c-newer',
    questions: [{ id: 'q', question: 'q' }],
    answers: [{ id: 'q', selected: ['a'] }],
  });
  assert.equal(another, null);
  assert.equal(state.droppedConfirmations, 1);
  assert.equal(state.confirmations.some((item) => item.callId === 'c-newer'), false);
});

// ---------- 引擎：受保护项建立 ----------

test('新建 protected 验收项缺少 confirmation_call_id 被拒绝', async () => {
  const { engine } = setup();
  const response = await engine.task(ctx, {
    action: 'start',
    goal: 'x',
    acceptance: [{ text: 'node --test 通过', protected: true }],
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'confirmation-required');
});

test('新建 protected 验收项带有效确认则登记并写入 confirmationHistory', async () => {
  const { engine, state } = setup();
  seedConfirmation(state, 'call-confirm-1', '新增受保护验收项 criterion-1：node --test 全部通过（保护）');
  const response = await protectedStart(engine);
  assert.equal(response.ok, true, JSON.stringify(response));
  const item = response.data.acceptance[0];
  assert.equal(item.protected, true);
  const task = state.tasks.find((entry) => entry.id === response.data.task_id);
  assert.equal(task.acceptance[0].protected, true);
  assert.equal(task.acceptance[0].source, 'agent_proposed');
  const history = task.confirmationHistory;
  assert.equal(history.length, 1);
  assert.equal(history[0].callId, 'call-confirm-1');
  assert.equal(history[0].change, 'protect');
  // 确认已被消费，不能重放
  assert.equal(state.confirmations[0].consumedBy, 'acceptance:criterion-1');
});

test('新建 protected 用已消费的确认被拒绝（防重放）', async () => {
  const { engine, state } = setup();
  seedConfirmation(state, 'call-confirm-1', '新增受保护验收项 criterion-1：node --test 全部通过（保护）');
  const first = await protectedStart(engine);
  assert.equal(first.ok, true);
  // 同一确认不能再次使用
  const response = await engine.task(ctx, {
    action: 'start',
    goal: 'y',
    acceptance: [{ text: 'node --test 全部通过', protected: true, confirmation_call_id: 'call-confirm-1' }],
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'confirmation-invalid');
});

test('新建 protected 用其他会话的确认被拒绝（跨会话隔离）', async () => {
  const { engine, state } = setup();
  recordConfirmation(state, {
    sessionId: 'session-other',
    callId: 'call-confirm-1',
    questions: [{ id: 'q1', question: '新增受保护验收项 criterion-1：node --test 全部通过（保护）' }],
    answers: [{ id: 'q1', selected: ['确认'] }],
  });
  const response = await protectedStart(engine);
  assert.equal(response.ok, false);
  assert.equal(response.code, 'confirmation-invalid');
});

test('确认问题文本未覆盖变更内容被拒绝（confirmation-mismatch）', async () => {
  const { engine, state } = setup();
  seedConfirmation(state, 'call-confirm-1', '一个完全无关的问题：今天天气如何？');
  const response = await protectedStart(engine);
  assert.equal(response.ok, false);
  assert.equal(response.code, 'confirmation-mismatch');
});

// ---------- 引擎：自报 user_explicit 降级 ----------

test('自报 user_explicit 无确认降级为 agent_proposed 并给出 warning', async () => {
  const { engine, state } = setup();
  const response = await engine.task(ctx, {
    action: 'start',
    goal: 'x',
    acceptance: [{ text: 'node --test 通过', source: 'user_explicit' }],
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.acceptance[0].source, 'agent_proposed');
  assert.ok(response.warnings.some((item) => item.includes('user_explicit')));
  const task = state.tasks.find((entry) => entry.id === response.data.task_id);
  assert.equal(task.acceptance[0].source, 'agent_proposed');
});

test('自报 user_explicit 带有效确认时保留 user_explicit', async () => {
  const { engine, state } = setup();
  seedConfirmation(state, 'call-confirm-1', '确认验收项 criterion-1 由用户明确提出：node --test 通过');
  const response = await engine.task(ctx, {
    action: 'start',
    goal: 'x',
    acceptance: [
      { text: 'node --test 通过', source: 'user_explicit', confirmation_call_id: 'call-confirm-1' },
    ],
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.data.acceptance[0].source, 'user_explicit');
  const task = state.tasks.find((entry) => entry.id === response.data.task_id);
  assert.equal(task.acceptance[0].source, 'user_explicit');
});

// ---------- 引擎：受保护项修订与停用 ----------

test('修订受保护项文本需要新的有效确认', async () => {
  const { engine, state } = setup();
  seedConfirmation(state, 'call-confirm-1', '新增受保护验收项 criterion-1：node --test 全部通过（保护）');
  const started = await protectedStart(engine);
  const taskId = started.data.task_id;
  const criterionId = started.data.acceptance[0].id;

  const withoutAuth = await engine.task(ctx, {
    action: 'inventory',
    task_id: taskId,
    change_reason: '改一下措辞',
    acceptance: [{ id: criterionId, text: 'node --test 与 npm run check 全部通过' }],
  });
  assert.equal(withoutAuth.ok, false);
  assert.equal(withoutAuth.code, 'confirmation-required');

  seedConfirmation(state, 'call-b', '将 criterion-1 的验收文本由「node --test 全部通过」修改为「node --test 与 npm run check 全部通过」；理由：改一下措辞');
  const authorized = await engine.task(ctx, {
    action: 'inventory',
    task_id: taskId,
    change_reason: '改一下措辞',
    acceptance: [
      { id: criterionId, text: 'node --test 与 npm run check 全部通过', confirmation_call_id: 'call-b' },
    ],
  });
  assert.equal(authorized.ok, true, JSON.stringify(authorized));
  const task = state.tasks.find((entry) => entry.id === taskId);
  assert.equal(task.acceptance[0].text, 'node --test 与 npm run check 全部通过');
  const history = task.confirmationHistory;
  assert.equal(history.length, 2);
  assert.equal(history[1].change, 'modify');
});

test('停用受保护项需要授权；无授权停用后 close(done) 被 protected-deactivated 阻断', async () => {
  const { engine, state } = setup();
  seedConfirmation(state, 'call-confirm-1', '新增受保护验收项 criterion-1：node --test 全部通过（保护）');
  const started = await protectedStart(engine);
  const taskId = started.data.task_id;

  const deactivate = await engine.task(ctx, {
    action: 'inventory',
    task_id: taskId,
    change_reason: '这条其实不重要',
    acceptance: [{ id: 'criterion-1', text: 'node --test 全部通过', active: false }],
  });
  assert.equal(deactivate.ok, false);
  assert.equal(deactivate.code, 'confirmation-required');

  // "从验收列表移除"在合并语义下不产生任何变更（normalizeAcceptance 只更新/添加，
  // 永不删除），所以空数组静默无效果——受保护项不可能被静默移除，这正是防绕过保证。
  const remove = await engine.task(ctx, {
    action: 'inventory',
    task_id: taskId,
    change_reason: '不需要这条',
    acceptance: [],
  });
  assert.equal(remove.ok, true);
  const taskAfterRemove = state.tasks.find((entry) => entry.id === taskId);
  assert.equal(taskAfterRemove.acceptance.length, 1);
  assert.equal(taskAfterRemove.acceptance[0].id, 'criterion-1');

  // status 里能看到保护违规提示（readinessOf 预演）。
  const status = await engine.task(ctx, { action: 'status', task_id: taskId });
  assert.equal(status.ok, true);
  // 无授权停用会进 confirmation-required，不会真的改动状态；直接构造
  // "受保护项 active=false 且无授权记录" 的状态验证 readinessOf 门槛。
  const task = state.tasks.find((entry) => entry.id === taskId);
  task.acceptance[0].active = false;
  const readiness = await engine.task(ctx, { action: 'status', task_id: taskId });
  assert.equal(readiness.ok, true);
  assert.equal(
    JSON.stringify(readiness.data.blockerCodes ?? []).includes('protected-deactivated'),
    true,
    JSON.stringify(readiness.data.blockers ?? readiness),
  );
});

test('close(done) 在受保护项被无授权停用后被拒绝（gate 阻断）', async () => {
  const { engine, state } = setup();
  seedConfirmation(state, 'call-confirm-1', '新增受保护验收项 criterion-1：node --test 全部通过（保护）');
  const started = await protectedStart(engine);
  const taskId = started.data.task_id;

  // 模拟历史遗留：任务里有一条无授权停用的受保护项（如旧数据迁移场景）。
  const task = state.tasks.find((entry) => entry.id === taskId);
  task.acceptance[0].active = false;

  const done = await engine.task(ctx, {
    action: 'close',
    task_id: taskId,
    outcome: 'done',
    implementationStatus: 'complete',
  });
  assert.equal(done.ok, false);
});

test('有授权的停用写入 confirmationHistory，不再阻断', async () => {
  const { engine, state } = setup();
  seedConfirmation(state, 'call-confirm-1', '新增受保护验收项 criterion-1：node --test 全部通过（保护）');
  const started = await protectedStart(engine);
  const taskId = started.data.task_id;

  seedConfirmation(state, 'call-b', '停用受保护验收项 criterion-1：node --test 全部通过（active true→false）；理由：范围调整');
  const authorized = await engine.task(ctx, {
    action: 'inventory',
    task_id: taskId,
    change_reason: '范围调整',
    acceptance: [{ id: 'criterion-1', text: 'node --test 全部通过', active: false, confirmation_call_id: 'call-b' }],
  });
  assert.equal(authorized.ok, true, JSON.stringify(authorized));
  const task = state.tasks.find((entry) => entry.id === taskId);
  const history = task.confirmationHistory;
  assert.equal(history.some((entry) => entry.change === 'deactivate'), true);
  // 受保护项已停用且授权在案：readiness 不再报 protected-deactivated。
  const status = await engine.task(ctx, { action: 'status', task_id: taskId });
  assert.equal(status.ok, true);
  assert.equal(
    JSON.stringify(status.data.blockerCodes ?? []).includes('protected-deactivated'),
    false,
  );
});

// ---------- 引擎：非受保护项不受影响 ----------

test('普通 agent_proposed 项的增删改不需要确认（不增加无谓弹窗）', async () => {
  const { engine, state } = setup();
  const data = await engine.task(ctx, {
    action: 'start',
    goal: 'x',
    acceptance: [{ text: 'node --test 通过' }],
  });
  const taskId = data.data.task_id;
  const revised = await engine.task(ctx, {
    action: 'inventory',
    task_id: taskId,
    change_reason: '措辞调整',
    acceptance: [{ id: 'criterion-1', text: 'node --test 与 lint 通过' }],
  });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  const removed = await engine.task(ctx, {
    action: 'inventory',
    task_id: taskId,
    change_reason: '不需要',
    acceptance: [],
  });
  // 合并语义：空数组不产生变更（只更新/添加，永不删除），普通项原样保留。
  assert.equal(removed.ok, true);
  const task = state.tasks.find((entry) => entry.id === taskId);
  assert.equal(task.acceptance.length, 1);
  assert.equal(task.confirmationHistory.length, 0);
});

// ---------- attachTrust ----------

test('attachTrust 把宿主 user-question-reply 事件写入 state.confirmations', async () => {
  const store = fakeStore();
  const listeners = [];
  const hostCtx = {
    on(name, handler) {
      listeners.push({ name, handler });
      return () => {};
    },
  };
  const dispose = attachTrust(hostCtx, store);
  assert.equal(typeof dispose, 'function');
  const registered = listeners.find((item) => item.name === 'session/event');
  assert.ok(registered, '应注册 session/event 监听');

  const session = { id: 'session-1' };
  const event = replyEvent('call-1', [{ id: 'q1', question: '是否同意？' }], [{ id: 'q1', selected: ['确认'] }]);
  await registered.handler(session, event);
  assert.equal(store.state.confirmations.length, 1);
  assert.equal(store.state.confirmations[0].callId, 'call-1');

  // 非 user-question-reply 事件静默忽略。
  await registered.handler(session, { data: { source: { kind: 'user-rpc' } } });
  assert.equal(store.state.confirmations.length, 1);

  dispose();
});

test('attachTrust 容错：mutate 抛错时监听器不抛、信任记录缺失（安全失败）', async () => {
  const state = emptyState();
  const failing = {
    state,
    async load() {
      return state;
    },
    async mutate() {
      throw new Error('disk full');
    },
    read() {
      return state;
    },
  };
  let handler;
  const hostCtx = {
    on(name, fn) {
      handler = fn;
      return () => {};
    },
  };
  attachTrust(hostCtx, failing);
  const event = replyEvent('call-1', [{ id: 'q1', question: 'q' }], [{ id: 'q1', selected: ['a'] }]);
  // mutate 一直失败：信任记录写不进 state，诊断计数也写不进（同一坏 store）。
  // 安全失败方向：监听器不抛、confirmations 缺失 → 受保护项后续一律拒绝未授权修改。
  await assert.doesNotReject(() => handler({ id: 'session-1' }, event));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Array.isArray(state.confirmations) ? state.confirmations.length : 0, 0);
});

test('attachTrust 缺 ctx.on 或 store.mutate 时降级为 no-op disposer', () => {
  assert.equal(typeof attachTrust(null, null), 'function');
  assert.equal(typeof attachTrust({}, { mutate: () => {} }), 'function');
  assert.equal(typeof attachTrust({ on: () => {} }, null), 'function');
});

// ── M2 对抗补充：拒绝/空选择不能作为授权（用户 m03643 criterion-3/6）──
test('M2：selected 为拒绝选项时不能授权受保护项（confirmation-rejected）', async () => {
  const { engine, store } = setup();
  seedConfirmation(store.state, 'call-reject', '新增受保护验收项 criterion-1：node --test 全部通过（保护）', ['拒绝']);
  const res = await engine.task(ctx, { action: 'start', goal: 'g', acceptance: [{ text: 'node --test 全部通过', protected: true, confirmation_call_id: 'call-reject' }] });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'confirmation-rejected');
});

test('M2：selected 为同意选项时正常授权（回归）', async () => {
  const { engine, store } = setup();
  seedConfirmation(store.state, 'call-accept', '新增受保护验收项 criterion-1：node --test 全部通过（保护）', ['同意']);
  const res = await engine.task(ctx, { action: 'start', goal: 'g', acceptance: [{ text: 'node --test 全部通过', protected: true, confirmation_call_id: 'call-accept' }] });
  assert.equal(res.ok, true);
});

test('M2：selected 为空时不能授权', async () => {
  const { engine, store } = setup();
  seedConfirmation(store.state, 'call-empty', '新增受保护验收项 criterion-1：node --test 全部通过（保护）', []);
  const res = await engine.task(ctx, { action: 'start', goal: 'g', acceptance: [{ text: 'node --test 全部通过', protected: true, confirmation_call_id: 'call-empty' }] });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'confirmation-rejected');
});

// ── M2.5：完整变更匹配 + 确定性授权判断（用户 m03864）──
test('M2.5：确认长文本后提交其子串被拒（消除授权范围偏移）', async () => {
  const { engine, store } = setup();
  // 用户确认的完整验收文本很长；模型提交的只有前缀子串。
  const full = 'node --test 全部通过且覆盖率不低于 85% 且无新增告警';
  seedConfirmation(store.state, 'call-sub', `新增受保护验收项 criterion-1：${full}（保护）`, ['同意']);
  const res = await engine.task(ctx, { action: 'start', goal: 'g', acceptance: [{ text: 'node --test 全部通过且覆盖率不低于 85% 且无新增', protected: true, confirmation_call_id: 'call-sub' }] });
  assert.equal(res.ok, false);
  // 确认存在但问题文本对应的是完整长文本，与提交的弱化子串不一致 → mismatch。
  assert.equal(res.code, 'confirmation-mismatch');
});

test('M2.5：问题文本包含完整验收文本时正常授权（正例回归）', async () => {
  const { engine, store } = setup();
  const full = 'node --test 全部通过且覆盖率不低于 85%';
  seedConfirmation(store.state, 'call-full', `新增受保护验收项 criterion-1：${full}（保护）`, ['同意']);
  const res = await engine.task(ctx, { action: 'start', goal: 'g', acceptance: [{ text: full, protected: true, confirmation_call_id: 'call-full' }] });
  assert.equal(res.ok, true);
});

test('M2.5：提问带 options 时只认可 options 中的肯定选项（确定性判断）', async () => {
  const { engine, store } = setup();
  // 用户选了「随便看看」——不是提问给出的肯定选项，即使包含「同意」二字。
  recordConfirmation(store.state, {
    sessionId: 'session-1',
    callId: 'call-opt',
    questions: [{ id: 'q1', question: '新增受保护验收项 criterion-1：node --test 全部通过（保护）', options: ['同意', '拒绝'] }],
    answers: [{ id: 'q1', selected: ['同意并随便看看'] }],
  });
  const res = await engine.task(ctx, { action: 'start', goal: 'g', acceptance: [{ text: 'node --test 全部通过', protected: true, confirmation_call_id: 'call-opt' }] });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'confirmation-rejected');
});

test('M2.5：无 options 时否定词等值命中拒（「不同意」不再误判为含「同意」）', async () => {
  const { engine, store } = setup();
  seedConfirmation(store.state, 'call-deny-eq', '新增受保护验收项 criterion-1：node --test 全部通过（保护）', ['不同意']);
  const res = await engine.task(ctx, { action: 'start', goal: 'g', acceptance: [{ text: 'node --test 全部通过', protected: true, confirmation_call_id: 'call-deny-eq' }] });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'confirmation-rejected');
});

test('M2.5：修订受保护项同样要求完整变更匹配（弱化后缀被拒）', async () => {
  const { engine, store } = setup();
  const full = 'node --test 全部通过且覆盖率不低于 85%';
  seedConfirmation(store.state, 'call-1', `新增受保护验收项 criterion-1：${full}（保护）`, ['同意']);
  const started = await protectedStart(engine, { callId: 'call-1', text: full });
  assert.equal(started.ok, true);
  // 第二次确认覆盖了完整文本，但模型提交弱化后的子串文本。
  seedConfirmation(store.state, 'call-2', `修订受保护验收项 criterion-1 为：${full}（保护）`, ['同意']);
  const res = await engine.task(ctx, {
    action: 'inventory',
    task_id: started.data.task_id,
    change_reason: '按用户要求修订',
    acceptance: [{ id: 'criterion-1', text: 'node --test 全部通过', protected: true, confirmation_call_id: 'call-2' }],
  });
  assert.equal(res.ok, false);
  // 确认存在但问题文本对应完整新文本，与提交的弱化文本不一致 → mismatch。
  assert.equal(res.code, 'confirmation-mismatch');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine, MAX_SUMMARY_TASKS } from '../src/engine.js';
import { TASK_ACTIONS } from '../src/engine.js';
import { TASK_PARAMETERS, TASK_DESCRIPTION } from '../src/tools.js';
import { emptyState } from '../src/store.js';

const ctx = { sessionId: 'session-1', agentId: 'session-1', projectKey: '/repo/demo' };

function fakeStore() {
  const state = emptyState();
  const calls = { mutate: 0, load: 0 };
  return {
    state,
    calls,
    async load() {
      calls.load += 1;
      return state;
    },
    async mutate(fn) {
      calls.mutate += 1;
      const result = await fn(state);
      return result ?? state;
    },
  };
}

function setup() {
  const store = fakeStore();
  return { store, state: store.state, engine: createEngine(store) };
}

async function startTask(engine, { goal, projectKey, acceptance = [] }) {
  const response = await engine.task(ctx, { action: 'start', goal, projectKey, acceptance });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data.task_id;
}

function pushObservation(state, overrides = {}) {
  const sequence = state.nextObservation;
  state.nextObservation += 1;
  const observation = {
    id: `obs-${sequence}`,
    sessionId: 'session-1',
    agentId: 'session-1',
    toolCallId: `call-${sequence}`,
    taskId: null,
    revisionAtCapture: 0,
    sequence,
    tool: 'node --test',
    callSummary: 'node --test',
    at: new Date().toISOString(),
    outcome: 'success',
    exitCode: 0,
    kind: 'test',
    changeImpact: 'irrelevant',
    resultSummary: 'pass 5',
    digest: '0'.repeat(32),
    ...overrides,
  };
  state.observations.push(observation);
  return observation;
}

function pushLesson(state, overrides = {}) {
  const lesson = {
    id: `lesson-${state.lessons.length + 1}`,
    scope: 'global',
    projectKey: null,
    trigger: '触发条件',
    lesson: '经验正文',
    evidence: 'npm test 全绿',
    reusable_because: '会再次遇到',
    tags: [],
    status: 'active',
    ...overrides,
  };
  state.lessons.push(lesson);
  return lesson;
}

async function summary(engine) {
  return engine.task(ctx, { action: 'summary' });
}

// ---------- 契约形状 ----------

test('summary 出现在任务动作列表与工具 schema 中', () => {
  assert.ok(TASK_ACTIONS.includes('summary'));
  assert.deepEqual(TASK_PARAMETERS.properties.action.enum, TASK_ACTIONS);
  assert.match(TASK_DESCRIPTION, /summary\(\)/);
});

test('空状态下的 summary 返回完整零值形状而不是报错', async () => {
  const { engine } = setup();
  const response = await summary(engine);
  assert.equal(response.ok, true);
  assert.equal(response.code, 'ok');
  const data = response.data;
  assert.deepEqual(data.tasks.total, 0);
  assert.deepEqual(data.tasks.open, 0);
  assert.deepEqual(data.tasks.closed, 0);
  assert.deepEqual(data.tasks.byPhase, { understand: 0, implement: 0, verify: 0 });
  assert.deepEqual(data.tasks.byOutcome, { open: 0, done: 0, partial: 0, abandoned: 0 });
  assert.deepEqual(data.tasks.byImplementationStatus, {
    unknown: 0,
    complete: 0,
    incomplete: 0,
    not_applicable: 0,
  });
  assert.deepEqual(data.tasks.byProject, []);
  assert.deepEqual(data.open, []);
  assert.equal(data.openTruncated, false);
  assert.equal(data.openRemaining, 0);
  assert.deepEqual(data.lessons, { total: 0, active: 0, global: 0, project: 0, tags: [] });
  assert.equal(data.observations.total, 0);
  assert.equal(data.observations.usable, 0);
  assert.equal(data.observations.rejected, 0);
  assert.deepEqual(data.observations.byOutcome, []);
  assert.deepEqual(data.degraded, []);
  assert.deepEqual(response.warnings ?? [], []);
});

test('summary 是纯读路径：不写状态、不触发 store.mutate', async () => {
  const { store, state, engine } = setup();
  await startTask(engine, { goal: '任务一', projectKey: '/repo/demo' });
  pushObservation(state, {});
  const before = JSON.stringify(state);
  const mutateBefore = store.calls.mutate;

  const response = await summary(engine);

  assert.equal(response.ok, true);
  assert.equal(store.calls.mutate, mutateBefore, 'summary 不得走写路径');
  assert.equal(JSON.stringify(state), before, 'summary 不得改变状态');
});

test('summary 收到 task_id 时给出忽略警告，而不是静默过滤', async () => {
  const { engine } = setup();
  await startTask(engine, { goal: '任务一', projectKey: '/repo/a' });
  const response = await engine.task(ctx, { action: 'summary', task_id: 'task-whatever' });
  assert.equal(response.ok, true);
  assert.equal(response.data.tasks.total, 1);
  assert.ok((response.warnings ?? []).some((text) => text.includes('task_id 已忽略')));
});

// ---------- 聚合计数 ----------

test('summary 汇总任务总数、阶段、结局与实现状态', async () => {
  const { state, engine } = setup();
  const open = await startTask(engine, {
    goal: '进行中的任务',
    projectKey: '/repo/a',
    acceptance: [{ text: '自动验收', kind: 'automated' }],
  });
  const closedSource = await startTask(engine, {
    goal: '会关闭的任务',
    projectKey: '/repo/a',
    acceptance: [{ text: '自动验收', kind: 'automated' }],
  });
  await startTask(engine, { goal: '另一个项目', projectKey: '/repo/b' });

  const closed = await engine.task(ctx, {
    action: 'close',
    task_id: closedSource,
    outcome: 'partial',
    implementationStatus: 'incomplete',
    closureReason: 'implementation_incomplete',
  });
  assert.equal(closed.ok, true, JSON.stringify(closed));

  state.tasks.find((task) => task.id === open).phase = 'implement';

  const response = await summary(engine);
  const data = response.data;
  assert.equal(data.tasks.total, 3);
  assert.equal(data.tasks.open, 2);
  assert.equal(data.tasks.closed, 1);
  // byPhase / byImplementationStatus 是任务快照统计，包含已关闭任务（它们停在关闭时的阶段）。
  assert.deepEqual(data.tasks.byPhase, { understand: 2, implement: 1, verify: 0 });
  assert.deepEqual(data.tasks.byOutcome, { open: 2, done: 0, partial: 1, abandoned: 0 });
  assert.deepEqual(data.tasks.byImplementationStatus, {
    unknown: 2,
    complete: 0,
    incomplete: 1,
    not_applicable: 0,
  });
  assert.deepEqual(data.tasks.byProject, [
    { projectKey: '/repo/a', total: 2, open: 1, closed: 1 },
    { projectKey: '/repo/b', total: 1, open: 1, closed: 0 },
  ]);
  assert.deepEqual(data.open.map((item) => item.task_id).sort(), [open, state.tasks[2].id].sort());
});

test('summary 的 open 列表带出每个任务的验收覆盖与收尾阻碍', async () => {
  const { state, engine } = setup();
  const taskId = await startTask(engine, {
    goal: '待收尾任务',
    projectKey: '/repo/a',
    acceptance: [
      { text: '自动验收', kind: 'automated' },
      { text: '人工验收', kind: 'manual' },
    ],
  });
  const task = state.tasks.find((item) => item.id === taskId);
  task.phase = 'verify';
  task.implementationStatus = 'complete';
  task.pendingChangeIds = ['change-1', 'change-2'];
  task.revision = 3;

  const data = (await summary(engine)).data;
  const row = data.open.find((item) => item.task_id === taskId);
  assert.equal(row.phase, 'verify');
  assert.equal(row.revision, 3);
  assert.equal(row.pendingChanges, 2);
  assert.deepEqual(row.acceptance, { active: 2, manual: 1, covered: 0 });
  assert.equal(row.uncovered.length, 2);
  assert.ok(row.blockers.some((text) => text.includes('人工验收项')));
  assert.ok(row.blockers.some((text) => text.includes('未解除的可能写入')));
  assert.ok(row.blockers.some((text) => text.includes('未由当前 revision 复验覆盖')));
});

test('summary 把待复核写入的任务排在 open 列表前面', async () => {
  const { state, engine } = setup();
  const quiet = await startTask(engine, { goal: '安静任务', projectKey: '/repo/a' });
  const noisy = await startTask(engine, { goal: '待复核任务', projectKey: '/repo/a' });
  state.tasks.find((item) => item.id === noisy).pendingChangeIds = ['change-9'];
  state.tasks.find((item) => item.id === quiet).updatedAt = '2099-01-01T00:00:00.000Z';

  const data = (await summary(engine)).data;
  assert.equal(data.open[0].task_id, noisy);
  assert.equal(data.open[1].task_id, quiet);
});

test(`open 列表最多展开 ${MAX_SUMMARY_TASKS} 条，其余用 openRemaining 标记`, async () => {
  const { engine } = setup();
  const total = MAX_SUMMARY_TASKS + 3;
  for (let index = 0; index < total; index += 1) {
    await startTask(engine, { goal: `任务 ${index}`, projectKey: '/repo/a' });
  }

  const data = (await summary(engine)).data;
  assert.equal(data.tasks.total, total);
  assert.equal(data.open.length, MAX_SUMMARY_TASKS);
  assert.equal(data.openTruncated, true);
  assert.equal(data.openRemaining, 3);
});

// ---------- 经验与观察 ----------

test('summary 统计活跃经验的 scope 与标签热度，忽略已退役经验', async () => {
  const { state, engine } = setup();
  pushLesson(state, { tags: ['alpha', 'beta'] });
  pushLesson(state, { tags: ['alpha'], scope: 'project', projectKey: '/repo/a' });
  pushLesson(state, { tags: ['alpha'], status: 'retired' });

  const data = (await summary(engine)).data;
  assert.deepEqual(data.lessons, {
    total: 3,
    active: 2,
    global: 1,
    project: 1,
    tags: [
      { tag: 'alpha', count: 2 },
      { tag: 'beta', count: 1 },
    ],
  });
});

test('summary 区分可用观察、不够格的观察与未绑定任务的观察', async () => {
  const { state, engine } = setup();
  const taskId = await startTask(engine, { goal: '有用观察', projectKey: '/repo/a' });
  pushObservation(state, { taskId });
  pushObservation(state, { taskId: null, kind: 'read' });
  pushObservation(state, { taskId, outcome: 'failure', exitCode: 1, resultSummary: 'fail 1' });
  state.droppedObservations = 2;
  state.observerErrors = 1;

  const data = (await summary(engine)).data;
  assert.equal(data.observations.total, 3);
  assert.equal(data.observations.bound, 2);
  assert.equal(data.observations.unbound, 1);
  assert.equal(data.observations.rejected, 2);
  assert.equal(data.observations.usable, 1);
  assert.deepEqual(
    [...data.observations.byOutcome].sort((a, b) => a.outcome.localeCompare(b.outcome)),
    [
      { outcome: 'failure', count: 1 },
      { outcome: 'success', count: 2 },
    ],
  );
  assert.equal(data.observations.dropped, 2);
  assert.equal(data.observations.errors, 1);
  assert.equal(data.degraded.length, 2);
});

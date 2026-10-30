import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../src/engine.js';
import { emptyState } from '../src/store.js';

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

function addObservation(state, taskId, overrides = {}) {
  const sequence = state.nextObservation;
  state.nextObservation += 1;
  const observation = {
    id: `obs-${sequence}`,
    sessionId: 'session-1',
    agentId: 'session-1',
    toolCallId: `call-${sequence}`,
    taskId,
    revisionAtCapture: 0,
    sequence,
    tool: 'node --test',
    callSummary: 'node --test test/engine.test.js',
    at: new Date().toISOString(),
    outcome: 'success',
    exitCode: 0,
    kind: 'test',
    changeImpact: 'irrelevant',
    resultSummary: 'pass 12',
    digest: '0'.repeat(32),
    ...overrides,
  };
  state.observations.push(observation);
  return observation;
}

async function startedTask(engine, extra = {}) {
  const response = await engine.task(ctx, {
    action: 'start',
    goal: '给插件补测试',
    acceptance: [{ text: 'node --test 全部通过' }],
    ...extra,
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data;
}

async function concreteNeed(engine, taskId, target = '测试覆盖') {
  return engine.task(ctx, {
    action: 'need',
    task_id: taskId,
    target,
    decision: 'extend',
    evidence: 'test/engine.test.js:1 现有测试文件可以扩展用例',
  });
}

// ---------- 任务创建 ----------

test('start 缺少 goal 时给出缺失字段错误', async () => {
  const { engine } = setup();
  const response = await engine.task(ctx, { action: 'start' });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'missing-field');
  assert.match(response.message, /goal/);
});

test('start 进入 understand 阶段，未登记验收项时给出警告', async () => {
  const { engine } = setup();
  const response = await engine.task(ctx, { action: 'start', goal: '实现一次迁移' });
  assert.equal(response.ok, true);
  assert.equal(response.data.task.phase, 'understand');
  assert.equal(response.data.task.status, 'open');
  assert.ok(response.warnings.some((item) => item.includes('验收项')));
});

test('start 支持显式验收项并分配稳定 id', async () => {
  const { engine } = setup();
  const data = await startedTask(engine);
  assert.equal(data.acceptance.length, 1);
  assert.equal(data.acceptance[0].id, 'criterion-1');
  assert.equal(data.acceptance[0].active, true);
  assert.equal(data.acceptance[0].covered, false);
});

test('未知动作与未知阶段被明确拒绝', async () => {
  const { engine } = setup();
  const badAction = await engine.task(ctx, { action: 'finish' });
  assert.equal(badAction.ok, false);
  assert.equal(badAction.code, 'bad-action');

  const data = await startedTask(engine);
  const badPhase = await engine.task(ctx, { action: 'step', task_id: data.task_id, phase: 'ship' });
  assert.equal(badPhase.ok, false);
  assert.equal(badPhase.code, 'bad-action');
});

// ---------- 调查 ----------

test('need 空证据被拒绝', async () => {
  const { engine } = setup();
  const data = await startedTask(engine);
  const response = await engine.task(ctx, {
    action: 'need',
    task_id: data.task_id,
    target: '存储',
    decision: 'reuse',
    evidence: '',
  });
  assert.equal(response.ok, false);
  // 空串在字段校验阶段就被拒绝；空白或模糊叙述才进入证据强度判断。
  assert.ok(['missing-field', 'weak-evidence'].includes(response.code));
});

test('need 弱证据被接受但给出警告且不能通过实现门槛', async () => {
  const { engine } = setup();
  const data = await startedTask(engine);
  const response = await engine.task(ctx, {
    action: 'need',
    task_id: data.task_id,
    target: '存储',
    decision: 'reuse',
    evidence: '看起来已经有现成的 store 实现',
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.need.evidenceStrength, 'weak');
  assert.ok(response.warnings.length > 0);

  const step = await engine.task(ctx, { action: 'step', task_id: data.task_id, phase: 'implement' });
  assert.equal(step.ok, false);
  assert.equal(step.code, 'gate');
});

test('need 行号级证据可通过进入实现的门槛', async () => {
  const { engine } = setup();
  const data = await startedTask(engine);
  await concreteNeed(engine, data.task_id);
  const step = await engine.task(ctx, { action: 'step', task_id: data.task_id, phase: 'implement' });
  assert.equal(step.ok, true, JSON.stringify(step));
  assert.equal(step.data.task.phase, 'implement');
});

test('need 在 verify 阶段被拒绝', async () => {
  const { engine } = setup();
  const data = await startedTask(engine);
  await concreteNeed(engine, data.task_id);
  await engine.task(ctx, { action: 'step', task_id: data.task_id, phase: 'implement' });
  await engine.task(ctx, { action: 'step', task_id: data.task_id, phase: 'verify' });

  const response = await engine.task(ctx, {
    action: 'need',
    task_id: data.task_id,
    target: '另一处',
    decision: 'new',
    evidence: 'src/a.js:3 需要新增分支',
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'invalid-state');
});

test('inventory 批量登记调查结论与验收项', async () => {
  const { engine } = setup();
  const data = await startedTask(engine);
  const response = await engine.task(ctx, {
    action: 'inventory',
    task_id: data.task_id,
    needs: [
      { target: '接口层', decision: 'extend', evidence: 'src/index.js:10 已有注册入口' },
      { target: '存储层', decision: 'reuse', evidence: 'src/store.js:1 已存在原子写' },
    ],
    acceptance: [{ text: '新接口有测试' }],
    change_reason: '补充验收项以覆盖新增接口',
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.needs.length, 2);
  assert.equal(response.data.acceptance.length, 2);
});

test('inventory 修改验收项缺少 change_reason 被拒绝', async () => {
  const { engine } = setup();
  const data = await startedTask(engine);
  const response = await engine.task(ctx, {
    action: 'inventory',
    task_id: data.task_id,
    acceptance: [{ id: 'criterion-1', text: '改成别的标准' }],
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'missing-field');
  assert.match(response.message, /change_reason/);
});

test('inventory 带理由可以停用验收项，但停用项不再参与结项', async () => {
  const { engine } = setup();
  const data = await startedTask(engine);
  const response = await engine.task(ctx, {
    action: 'inventory',
    task_id: data.task_id,
    change_reason: '该验收项属于另一个任务',
    acceptance: [{ id: 'criterion-1', active: false }],
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.acceptance[0].active, false);
});

// ---------- 阶段 ----------

test('原地切换阶段只是提示，不报错', async () => {
  const { engine } = setup();
  const data = await startedTask(engine);
  const response = await engine.task(ctx, { action: 'step', task_id: data.task_id, phase: 'understand' });
  assert.equal(response.ok, true);
  assert.ok(response.warnings.some((item) => item.includes('already in phase')));
});

test('跳过实现直接验证需要说明理由并给出警告', async () => {
  const { engine } = setup();
  const data = await startedTask(engine);
  const withoutNote = await engine.task(ctx, { action: 'step', task_id: data.task_id, phase: 'verify' });
  assert.equal(withoutNote.ok, false);
  assert.equal(withoutNote.code, 'missing-field');

  const withNote = await engine.task(ctx, {
    action: 'step',
    task_id: data.task_id,
    phase: 'verify',
    note: '只是核对已有行为，无需改代码',
  });
  assert.equal(withNote.ok, true);
  assert.ok(withNote.warnings.some((item) => item.includes('跳过实现')));
});

test('回退阶段必须说明理由并记录自校正', async () => {
  const { engine } = setup();
  const data = await startedTask(engine);
  await concreteNeed(engine, data.task_id);
  await engine.task(ctx, { action: 'step', task_id: data.task_id, phase: 'implement' });

  const blocked = await engine.task(ctx, { action: 'step', task_id: data.task_id, phase: 'understand' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'missing-field');

  const ok = await engine.task(ctx, {
    action: 'step',
    task_id: data.task_id,
    phase: 'understand',
    note: '发现需要先确认现有数据结构',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.task.phase, 'understand');
});

test('没有活跃验收项不能进入验证', async () => {
  const { engine } = setup();
  const response = await engine.task(ctx, { action: 'start', goal: '无验收项的任务' });
  const taskId = response.data.task_id;
  await concreteNeed(engine, taskId);
  await engine.task(ctx, { action: 'step', task_id: taskId, phase: 'implement' });

  const step = await engine.task(ctx, { action: 'step', task_id: taskId, phase: 'verify' });
  assert.equal(step.ok, false);
  assert.equal(step.code, 'gate');
});

// ---------- 验证 ----------

async function readyToVerify(engine) {
  const data = await startedTask(engine);
  const taskId = data.task_id;
  await concreteNeed(engine, taskId);
  await engine.task(ctx, { action: 'step', task_id: taskId, phase: 'implement' });
  return { taskId, criterionId: data.acceptance[0].id };
}

test('passed 验证必须引用可信观察', async () => {
  const { engine } = setup();
  const { taskId, criterionId } = await readyToVerify(engine);

  const withoutObservation = await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'node --test',
    coverage: [{ criterionId, result: 'passed' }],
  });
  assert.equal(withoutObservation.ok, false);
  assert.equal(withoutObservation.code, 'unverified');

  const missing = await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'node --test',
    coverage: [{ criterionId, result: 'passed', observationIds: ['obs-999'] }],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'observation-not-found');
});

test('引用测试观察的 passed 验证被记录为 observed', async () => {
  const { engine, state } = setup();
  const { taskId, criterionId } = await readyToVerify(engine);
  const observation = addObservation(state, taskId);

  const response = await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'node --test',
    coverage: [{ criterionId, result: 'passed', observationIds: [observation.id] }],
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.data.level, 'passed');
  assert.equal(response.data.provenance, 'observed');
  assert.equal(response.data.acceptance[0].covered, true);
});

test('build 观察可以作为 passed 证据，且不会进待复核写入', async () => {
  const { engine, state } = setup();
  const { taskId, criterionId } = await readyToVerify(engine);
  await engine.task(ctx, { action: 'step', task_id: taskId, phase: 'verify' });

  const build = addObservation(state, taskId, {
    kind: 'build',
    changeImpact: 'irrelevant',
    tool: 'npm run build',
    callSummary: 'npm run build',
    resultSummary: 'built in 1.2s',
  });
  const task = state.tasks.find((item) => item.id === taskId);
  assert.deepEqual(task.pendingChangeIds, [], '构建观察不能进待复核写入');

  const response = await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'npm run build',
    coverage: [{ criterionId, result: 'passed', observationIds: [build.id] }],
  });
  assert.equal(response.ok, true, JSON.stringify(response));

  // 构建型任务不再因为“跑过构建”而永远差一条待复核写入。
  const closed = await engine.task(ctx, {
    action: 'close',
    task_id: taskId,
    outcome: 'done',
    implementationStatus: 'complete',
  });
  assert.equal(closed.ok, true, JSON.stringify(closed));
});

test('not_run 需要说明原因', async () => {
  const { engine } = setup();
  const { taskId, criterionId } = await readyToVerify(engine);
  const response = await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'not_run',
    scope: '端到端',
    coverage: [{ criterionId, result: 'not_run' }],
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'missing-field');
});

test('level=passed 与覆盖结果矛盾时拒绝', async () => {
  const { engine } = setup();
  const { taskId, criterionId } = await readyToVerify(engine);
  const response = await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: '部分',
    coverage: [{ criterionId, result: 'partial' }],
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'invalid-state');
});

test('understand 阶段不能执行验证', async () => {
  const { engine } = setup();
  const data = await startedTask(engine);
  const response = await engine.task(ctx, {
    action: 'verify',
    task_id: data.task_id,
    level: 'passed',
    scope: 'x',
    coverage: [{ criterionId: data.acceptance[0].id, result: 'passed' }],
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'invalid-state');
});

test('写入使旧 revision 的验证失效，close(done) 重新被阻断', async () => {
  const { engine, state } = setup();
  const { taskId, criterionId } = await readyToVerify(engine);
  const observation = addObservation(state, taskId);
  await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'node --test',
    coverage: [{ criterionId, result: 'passed', observationIds: [observation.id] }],
  });

  // 模拟观察层捕获到一次确认写入
  const task = state.tasks.find((item) => item.id === taskId);
  const before = task.revision;
  engine.applyConfirmedWrite(task, observation);
  assert.equal(task.revision, before + 1);
  assert.equal(task.verificationHistory[0].valid, false);

  const status = await engine.task(ctx, { action: 'status', task_id: taskId });
  assert.equal(status.data.acceptance[0].covered, false);
  assert.ok(status.data.blockers.length > 0);

  const close = await engine.task(ctx, {
    action: 'close',
    task_id: taskId,
    outcome: 'done',
    implementationStatus: 'complete',
  });
  assert.equal(close.ok, false);
  assert.equal(close.code, 'gate');
});

// ---------- 结项 ----------

test('close(done) 需要当前 revision 的全覆盖验证', async () => {
  const { engine, state } = setup();
  const { taskId, criterionId } = await readyToVerify(engine);

  const tooEarly = await engine.task(ctx, {
    action: 'close',
    task_id: taskId,
    outcome: 'done',
    implementationStatus: 'complete',
  });
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.code, 'gate');

  const observation = addObservation(state, taskId);
  await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'node --test',
    coverage: [{ criterionId, result: 'passed', observationIds: [observation.id] }],
  });

  const done = await engine.task(ctx, {
    action: 'close',
    task_id: taskId,
    outcome: 'done',
    implementationStatus: 'complete',
  });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.data.outcome, 'done');
  assert.equal(done.data.task.status, 'closed');
  assert.equal(done.data.reviewStatus, 'verified');
});

test('close(done) 在有实施未完成标记时被拒绝', async () => {
  const { engine, state } = setup();
  const { taskId, criterionId } = await readyToVerify(engine);
  const observation = addObservation(state, taskId);
  await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'node --test',
    coverage: [{ criterionId, result: 'passed', observationIds: [observation.id] }],
  });

  const response = await engine.task(ctx, {
    action: 'close',
    task_id: taskId,
    outcome: 'done',
    implementationStatus: 'incomplete',
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'gate');
});

test('close(partial) 需要 closureReason，等待人工验收可用 awaiting_manual', async () => {
  const { engine } = setup();
  const data = await startedTask(engine);

  const missing = await engine.task(ctx, {
    action: 'close',
    task_id: data.task_id,
    outcome: 'partial',
    implementationStatus: 'complete',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'missing-field');

  const partial = await engine.task(ctx, {
    action: 'close',
    task_id: data.task_id,
    outcome: 'partial',
    implementationStatus: 'complete',
    closureReason: 'awaiting_manual',
  });
  assert.equal(partial.ok, true);
  assert.equal(partial.data.task.status, 'closed');
  assert.equal(partial.data.reviewStatus, 'unverified');
});

test('close(abandoned) 需要说明原因', async () => {
  const { engine } = setup();
  const data = await startedTask(engine);
  const response = await engine.task(ctx, {
    action: 'close',
    task_id: data.task_id,
    outcome: 'abandoned',
    implementationStatus: 'incomplete',
    closureReason: 'other',
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'missing-field');
});

test('已关闭任务不能继续修改', async () => {
  const { engine } = setup();
  const data = await startedTask(engine);
  await engine.task(ctx, {
    action: 'close',
    task_id: data.task_id,
    outcome: 'partial',
    implementationStatus: 'incomplete',
    closureReason: 'other',
  });
  const response = await engine.task(ctx, {
    action: 'need',
    task_id: data.task_id,
    target: 'x',
    decision: 'reuse',
    evidence: 'src/a.js:1 已有实现',
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'task-closed');
});

test('status 概览与详情给出候选观察和阻断原因', async () => {
  const { engine, state } = setup();
  const data = await startedTask(engine);
  addObservation(state, data.task_id);

  const overview = await engine.task(ctx, { action: 'status' });
  assert.equal(overview.ok, true);
  assert.equal(overview.data.tasks.length, 1);
  assert.equal(overview.data.observations, 1);

  const detail = await engine.task(ctx, { action: 'status', task_id: data.task_id });
  assert.equal(detail.data.observations.length, 1);
  assert.ok(detail.data.observations[0].usableForVerification === false || detail.data.observations[0].usableForVerification === true);
  assert.ok(Array.isArray(detail.data.blockers));
});

// ---------- 幂等 ----------

test('同一 request_id 重放返回同一结果，不重复创建任务', async () => {
  const { engine, state } = setup();
  const args = { action: 'start', goal: '幂等任务', request_id: 'req-1' };
  const first = await engine.task(ctx, args);
  const second = await engine.task(ctx, args);
  assert.equal(first.data.task_id, second.data.task_id);
  assert.equal(second.replayed, true);
  assert.equal(state.tasks.length, 1);
});

test('同一 request_id 携带不同参数被拒绝', async () => {
  const { engine } = setup();
  await engine.task(ctx, { action: 'start', goal: '第一个', request_id: 'req-2' });
  const response = await engine.task(ctx, { action: 'start', goal: '第二个', request_id: 'req-2' });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'idempotency-conflict');
});

// ---------- 待复核写入的解除 ----------

test('覆盖全部活跃验收项的通过验证会解除待复核写入，之后可以 close(done)', async () => {
  const { engine, state } = setup();
  const { taskId, criterionId } = await readyToVerify(engine);

  const possible = addObservation(state, taskId, {
    kind: 'other',
    tool: 'mcp__unknown__frobnicate',
    callSummary: 'mcp__unknown__frobnicate({"path":"src/a.js"})',
    changeImpact: 'possible',
    at: '2026-01-01T00:00:00.000Z',
  });
  const task = state.tasks[0];
  task.pendingChangeIds.push(possible.id);
  task.reviewStatus = 'unverified';

  const verified = addObservation(state, taskId, { at: '2026-01-01T00:05:00.000Z' });
  const response = await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'node --test',
    coverage: [{ criterionId, result: 'passed', observationIds: [verified.id] }],
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.deepEqual(task.pendingChangeIds, [], '复验通过后待复核写入应被解除');
  assert.equal(task.reviewStatus, 'verified');
  assert.ok(response.warnings.some((line) => line.includes('解除')));

  const done = await engine.task(ctx, {
    action: 'close',
    task_id: taskId,
    outcome: 'done',
    implementationStatus: 'complete',
  });
  assert.equal(done.ok, true, JSON.stringify(done));
});

test('只覆盖部分验收项的通过验证不会解除待复核写入', async () => {
  const { engine, state } = setup();
  const start = await engine.task(ctx, {
    action: 'start',
    goal: '两个验收项的任务',
    acceptance: [{ text: '单元测试通过' }, { text: '冒烟通过' }],
  });
  const taskId = start.data.task_id;
  const first = start.data.acceptance[0];
  await concreteNeed(engine, taskId);
  await engine.task(ctx, { action: 'step', task_id: taskId, phase: 'implement' });

  const possible = addObservation(state, taskId, {
    kind: 'other',
    changeImpact: 'possible',
    at: '2026-01-01T00:00:00.000Z',
  });
  const task = state.tasks[0];
  task.pendingChangeIds.push(possible.id);

  const verified = addObservation(state, taskId, { at: '2026-01-01T00:05:00.000Z' });
  const verify = await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: '只覆盖第一项',
    coverage: [{ criterionId: first.id, result: 'passed', observationIds: [verified.id] }],
  });
  assert.equal(verify.ok, true, JSON.stringify(verify));
  assert.deepEqual(task.pendingChangeIds, [possible.id], '局部验证不能洗掉待复核写入');

  const done = await engine.task(ctx, {
    action: 'close',
    task_id: taskId,
    outcome: 'done',
    implementationStatus: 'complete',
  });
  assert.equal(done.ok, false);
  assert.equal(done.code, 'gate');
});

test('非零退出码的观察不能作为通过证据', async () => {
  const { engine, state } = setup();
  const { taskId, criterionId } = await readyToVerify(engine);
  const failing = addObservation(state, taskId, { exitCode: 1, resultSummary: '1 failing' });

  const response = await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'node --test',
    coverage: [{ criterionId, result: 'passed', observationIds: [failing.id] }],
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'unverified');
  assert.match(JSON.stringify(response), /退出码/);
});

test('实现变更后，变更前的观察不能再次作为通过证据', async () => {
  const { state, engine } = setup();
  const started = await startedTask(engine);
  const taskId = started.task_id;
  await concreteNeed(engine, taskId);
  await engine.task(ctx, { action: 'step', task_id: taskId, phase: 'implement' });
  const task = state.tasks.find((item) => item.id === taskId);

  // 变更发生前跑过的绿色测试
  const before = addObservation(state, taskId, {
    revisionAtCapture: task.revision,
    implRevisionAtCapture: task.implRevision ?? 0,
    at: '2026-01-01T00:00:00.000Z',
  });

  // 一次确认写入把实现改掉：observer 递增实现版本，旧观察随之过期
  task.implRevision = (task.implRevision ?? 0) + 1;

  const response = await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'code',
    coverage: [
      { criterionId: started.acceptance[0].id, result: 'passed', observationIds: [before.id] },
    ],
  });
  assert.equal(response.ok, false, '变更前的观察不能证明变更后的实现');
  assert.equal(response.code, 'stale-verification');
});

test('同一条命令既跑测试又改源码时，它不能充当通过证据', async () => {
  const { state, engine } = setup();
  const started = await startedTask(engine);
  const taskId = started.task_id;
  await concreteNeed(engine, taskId);
  await engine.task(ctx, { action: 'step', task_id: taskId, phase: 'implement' });
  const task = state.tasks.find((item) => item.id === taskId);

  // 回归素材：`npm test && echo x > src/math.js` —— 检查跑在写入之前，结果证明
  // 不了写入之后的实现。若它还允许充当证据，一条命令就能既给自己背书、又解除
  // 自己的嫌疑，close(done) 的硬门槛被绕过。
  const mixed = addObservation(state, taskId, {
    tool: 'bash',
    kind: 'test',
    callSummary: 'npm test && echo x > src/math.js',
    changeImpact: 'possible',
    implRevisionAtCapture: task.implRevision ?? 0,
  });
  task.pendingChangeIds.push(mixed.id);

  const response = await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'npm test',
    coverage: [
      { criterionId: started.acceptance[0].id, result: 'passed', observationIds: [mixed.id] },
    ],
  });
  assert.equal(response.ok, false, '可疑观察不能给自己背书');
  assert.equal(response.code, 'unverified');
  const status = await engine.task(ctx, { action: 'status', task_id: taskId });
  const row = status.data.observations.find((item) => item.id === mixed.id);
  assert.match(row?.rejectedReason ?? '', /可能包含实现写入/);
  assert.deepEqual(task.pendingChangeIds, [mixed.id], '被拒绝之后嫌疑仍然保留');
});

test('干净测试观察可以解除此前可能的写入，队列清零并允许 close(done)', async () => {
  const { state, engine } = setup();
  const started = await startedTask(engine);
  const taskId = started.task_id;
  await concreteNeed(engine, taskId);
  await engine.task(ctx, { action: 'step', task_id: taskId, phase: 'implement' });
  const task = state.tasks.find((item) => item.id === taskId);

  const suspect = addObservation(state, taskId, {
    tool: 'bash',
    kind: 'other',
    callSummary: 'node bench/bench.js',
    changeImpact: 'possible',
  });
  task.pendingChangeIds.push(suspect.id);

  const check = addObservation(state, taskId, { changeImpact: 'irrelevant' });
  const response = await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'node --test',
    coverage: [
      { criterionId: started.acceptance[0].id, result: 'passed', observationIds: [check.id] },
    ],
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.deepEqual(task.pendingChangeIds, [], '独立跑的干净检查应当解除此前的可疑写入');

  const done = await engine.task(ctx, {
    action: 'close',
    task_id: taskId,
    outcome: 'done',
    implementationStatus: 'complete',
  });
  assert.equal(done.ok, true, JSON.stringify(done));
});

test('跨实现版本的旧待复核写入在后续有效验证后必须被解除，不能永久阻断 close(done)', async () => {
  const { state, engine } = setup();
  const started = await startedTask(engine);
  const taskId = started.task_id;
  await concreteNeed(engine, taskId);
  await engine.task(ctx, { action: 'step', task_id: taskId, phase: 'implement' });
  const task = state.tasks.find((item) => item.id === taskId);

  // 第 0 版实现上采集的一条可疑写入（典型是自定义 benchmark 命令）
  const suspect = addObservation(state, taskId, {
    tool: 'bash',
    kind: 'shell',
    changeImpact: 'possible',
    implRevisionAtCapture: 0,
  });
  task.pendingChangeIds.push(suspect.id);

  // 之后实现被真实改动过两次，这条嫌疑写入停留在了旧版本上
  task.implRevision = 2;

  // 当前版本上跑出的测试观察
  const check = addObservation(state, taskId, {
    implRevisionAtCapture: 2,
    revisionAtCapture: task.revision,
  });

  const response = await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'node --test',
    coverage: [
      { criterionId: started.acceptance[0].id, result: 'passed', observationIds: [check.id] },
    ],
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.deepEqual(
    task.pendingChangeIds,
    [],
    '旧版本上的嫌疑写入已被后续改动与这次验证覆盖，必须解除；若拿「版本必须相同」再卡一道，它永远等不到匹配的版本号，close(done) 被历史记录永久阻断',
  );
});

test('时钟回拨时，验证之后才发生的待复核写入不会被错误解除', async () => {
  const { state, engine } = setup();
  const started = await startedTask(engine);
  const taskId = started.task_id;
  await concreteNeed(engine, taskId);
  await engine.task(ctx, { action: 'step', task_id: taskId, phase: 'implement' });
  const task = state.tasks.find((item) => item.id === taskId);

  // 序号在前、时间戳在后：一次正常的通过检查
  const check = addObservation(state, taskId, { at: '2026-01-01T00:20:00.000Z' });
  // 系统时钟回拨：这次可疑写入的序号更大（确实发生在检查之后），时间戳却更早
  const suspect = addObservation(state, taskId, {
    at: '2026-01-01T00:10:00.000Z',
    tool: 'bash',
    kind: 'shell',
    changeImpact: 'possible',
  });
  task.pendingChangeIds.push(suspect.id);

  const response = await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'code',
    coverage: [
      { criterionId: started.acceptance[0].id, result: 'passed', observationIds: [check.id] },
    ],
  });
  assert.equal(response.ok, true);
  assert.deepEqual(
    task.pendingChangeIds,
    [suspect.id],
    '这次写入发生在验证之后，先后顺序必须按观察序号判定，不能被执行时间戳骗过去',
  );
});

test('人工验收项不会阻塞待复核写入的解除', async () => {
  const { state, engine } = setup();
  const started = await startedTask(engine, {
    acceptance: [
      { text: 'node --test 全部通过', kind: 'automated' },
      { text: '人工复核输出是否可读', kind: 'manual' },
    ],
  });
  const taskId = started.task_id;
  await concreteNeed(engine, taskId);
  await engine.task(ctx, { action: 'step', task_id: taskId, phase: 'implement' });
  const task = state.tasks.find((item) => item.id === taskId);

  const suspect = addObservation(state, taskId, {
    tool: 'bash',
    kind: 'shell',
    changeImpact: 'possible',
    implRevisionAtCapture: 0,
  });
  task.pendingChangeIds.push(suspect.id);

  const check = addObservation(state, taskId, { revisionAtCapture: task.revision });
  const response = await engine.task(ctx, {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'node --test',
    coverage: [
      { criterionId: started.acceptance[0].id, result: 'passed', observationIds: [check.id] },
    ],
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.deepEqual(
    task.pendingChangeIds,
    [],
    '人工验收项任何观察都覆盖不到，不能因为它在「必须全部覆盖」里就把自动证据的解除路径堵死',
  );
});

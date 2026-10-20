import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attachObserver, MAX_OBSERVATIONS, recordObservation } from '../src/observer.js';
import { changeImpact, classifyTool, summarizeCall, summarizeResult } from '../src/classify.js';

// The observer reads host identity only from the tools/result event, so every
// fixture below plays the host: no model-supplied ids are trusted.

function emptyState() {
  return {
    version: 2,
    nextObservation: 1,
    tasks: [],
    observations: [],
    requests: [],
    lessons: [],
    sessions: {},
  };
}

function makeTask(overrides = {}) {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    id: 'task-1',
    goal: 'goal',
    projectKey: null,
    sessionId: 's1',
    parentTaskId: null,
    phase: 'implement',
    status: 'open',
    revision: 0,
    implementationStatus: 'unknown',
    reviewStatus: 'unverified',
    acceptance: [],
    needs: [],
    verificationHistory: [],
    corrections: [],
    lessons: [],
    events: [],
    omittedEventCount: 0,
    pendingChangeIds: [],
    closedAs: null,
    closureReason: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function verification(id, revision, extra = {}) {
  return {
    id,
    level: 'passed',
    scope: 'unit tests',
    coverage: [],
    evidence: 'node --test → 3 passed',
    evidenceStrength: 'concrete',
    provenance: 'observed',
    observationIds: [],
    revision,
    valid: true,
    note: null,
    at: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function writeCall(sessionId = 's1', toolCallId = 'call-1') {
  return {
    sessionId,
    toolCallId,
    tool: 'write',
    args: { file_path: 'src/a.js', content: 'const a = 1' },
    result: { isError: false, value: { exitCode: 0, stdout: 'ok' } },
  };
}

function fillObservations(state, count) {
  for (let index = 1; index <= count; index += 1) {
    state.observations.push({
      id: `obs-${index}`,
      sessionId: 's1',
      agentId: null,
      toolCallId: `call-${index}`,
      taskId: null,
      revisionAtCapture: 0,
      sequence: index,
      tool: 'read',
      callSummary: '',
      at: '2026-01-01T00:00:00.000Z',
      outcome: 'success',
      exitCode: 0,
      kind: 'read',
      changeImpact: 'not_applicable',
      resultSummary: '',
      digest: '',
    });
  }
  state.nextObservation = count + 1;
}

function createCtx() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    emit(event, ...args) {
      return handlers.get(event)(...args);
    },
  };
}

function createStore(state) {
  return {
    state,
    calls: 0,
    async mutate(fn) {
      this.calls += 1;
      fn(this.state);
      return this.state;
    },
  };
}

// --- identity -------------------------------------------------------------

test('calls without host identity are not recorded', () => {
  const state = emptyState();

  assert.equal(recordObservation(state, {}), null);
  assert.equal(recordObservation(state, { sessionId: 's1', toolCallId: 'c1' }), null);
  assert.equal(recordObservation(state, { sessionId: 's1', tool: 'write' }), null);
  assert.equal(recordObservation(state, { toolCallId: 'c1', tool: 'write' }), null);
  assert.equal(recordObservation(state, { sessionId: '   ', toolCallId: 'c1', tool: 'write' }), null);

  assert.equal(state.observations.length, 0);
  assert.equal(state.nextObservation, 1);
});

test('replaying the same host call does not create a second observation', () => {
  const state = emptyState();
  const first = recordObservation(state, writeCall());
  const second = recordObservation(state, writeCall());

  assert.equal(state.observations.length, 1);
  assert.equal(first.id, second.id);
  assert.equal(first.sequence, 1);
  assert.equal(state.nextObservation, 2);
});

test('observations carry the sanitized host facts a verifier can re-check', () => {
  const state = emptyState();
  state.tasks.push(makeTask());
  const observation = recordObservation(state, writeCall());

  assert.equal(observation.id, 'obs-1');
  assert.equal(observation.sequence, 1);
  assert.equal(observation.sessionId, 's1');
  assert.equal(observation.agentId, 's1');
  assert.equal(observation.toolCallId, 'call-1');
  assert.equal(observation.tool, 'write');
  assert.equal(observation.kind, 'write');
  assert.equal(observation.changeImpact, 'confirmed');
  assert.equal(observation.outcome, 'success');
  assert.equal(observation.exitCode, 0);
  assert.equal(observation.taskId, 'task-1');
  assert.equal(observation.revisionAtCapture, 0);
  assert.ok(observation.callSummary.includes('src/a.js'));
  assert.match(observation.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(observation.digest.length, 32);
});

// --- attribution ----------------------------------------------------------

test('a single open task in the same session receives the observation', () => {
  const state = emptyState();
  state.tasks.push(makeTask({ revision: 3 }));

  const observation = recordObservation(state, writeCall());

  assert.equal(observation.taskId, 'task-1');
  assert.equal(observation.revisionAtCapture, 3);
});

test('several open tasks leave the observation unattributed instead of guessing', () => {
  const state = emptyState();
  state.tasks.push(makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' }));

  const observation = recordObservation(state, writeCall());

  assert.equal(observation.taskId, null);
  assert.equal(state.tasks[0].revision, 0);
  assert.equal(state.tasks[1].revision, 0);
  assert.equal(state.tasks[0].events.length, 0);
  assert.equal(state.tasks[1].events.length, 0);
});

test('closed tasks and tasks from another session are not candidates', () => {
  const state = emptyState();
  state.tasks.push(
    makeTask({ id: 'closed-task', status: 'closed' }),
    makeTask({ id: 'other-session', sessionId: 's2' }),
  );

  const observation = recordObservation(state, writeCall());

  assert.equal(observation.taskId, null);
  assert.equal(state.tasks[0].revision, 0);
  assert.equal(state.tasks[1].revision, 0);
});

// --- confirmed impact -----------------------------------------------------

test('confirmed writes bump revision and invalidate older verifications', () => {
  const state = emptyState();
  const open = makeTask({
    revision: 1,
    verificationHistory: [
      verification('v-old', 0),
      verification('v-current', 1),
      verification('v-newer', 2),
    ],
  });
  state.tasks.push(open);

  const observation = recordObservation(state, writeCall());

  assert.equal(observation.changeImpact, 'confirmed');
  assert.equal(observation.revisionAtCapture, 1);
  assert.equal(open.revision, 2);
  assert.equal(open.verificationHistory[0].valid, false);
  assert.equal(open.verificationHistory[1].valid, false);
  // A verification recorded for a later revision is untouched.
  assert.equal(open.verificationHistory[2].valid, true);
  assert.equal(open.updatedAt, observation.at);

  const invalidations = open.events.filter((event) => event.kind === 'invalidate');
  assert.equal(invalidations.length, 1);
  assert.match(invalidations[0].detail, /obs-1 .*confirmed/);
  assert.match(invalidations[0].detail, /revision -> 2/);
  assert.match(invalidations[0].detail, /invalidated 2 verification\(s\)/);
});

// --- possible impact ------------------------------------------------------

test('possible writes add a pending change, mark review unverified, and keep revision', () => {
  const state = emptyState();
  const open = makeTask({
    revision: 1,
    reviewStatus: 'verified',
    verificationHistory: [verification('v1', 1)],
  });
  state.tasks.push(open);

  const observation = recordObservation(state, {
    sessionId: 's1',
    toolCallId: 'call-install',
    tool: 'bash',
    args: { command: 'npm install left-pad' },
    result: { isError: false, value: { exitCode: 0, stdout: 'added 1 package' } },
  });

  assert.equal(observation.changeImpact, 'possible');
  assert.equal(observation.kind, 'other');
  assert.deepEqual(open.pendingChangeIds, ['obs-1']);
  assert.equal(open.reviewStatus, 'unverified');
  assert.equal(open.revision, 1);
  assert.equal(open.verificationHistory[0].valid, true);
  assert.equal(open.events.filter((event) => event.kind === 'invalidate').length, 1);
  assert.match(open.events[0].detail, /may have changed the implementation/);
});

test('an unknown command is graded possible, never silently irrelevant', () => {
  const state = emptyState();
  state.tasks.push(makeTask());
  const observation = recordObservation(state, {
    sessionId: 's1',
    toolCallId: 'call-unknown',
    tool: 'bash',
    args: { command: 'mystery-tool --rewrite-everything' },
    result: { isError: false },
  });

  assert.equal(observation.changeImpact, 'possible');
  assert.deepEqual(state.tasks[0].pendingChangeIds, [observation.id]);
});

test('plain reads and read-only checks leave verifications valid', () => {
  const state = emptyState();
  const open = makeTask({
    revision: 1,
    reviewStatus: 'verified',
    verificationHistory: [verification('v1', 1)],
  });
  state.tasks.push(open);

  const read = recordObservation(state, {
    sessionId: 's1',
    toolCallId: 'call-read',
    tool: 'read',
    args: { file_path: 'src/a.js' },
  });
  const status = recordObservation(state, {
    sessionId: 's1',
    toolCallId: 'call-git',
    tool: 'bash',
    args: { command: 'git status --short' },
  });
  const tests = recordObservation(state, {
    sessionId: 's1',
    toolCallId: 'call-test',
    tool: 'bash',
    args: { command: 'node --test test/observer.test.js' },
  });

  assert.equal(read.changeImpact, 'not_applicable');
  assert.equal(status.changeImpact, 'irrelevant');
  assert.equal(tests.changeImpact, 'irrelevant');
  assert.equal(tests.kind, 'test');

  assert.equal(open.revision, 1);
  assert.equal(open.reviewStatus, 'verified');
  assert.deepEqual(open.pendingChangeIds, []);
  assert.equal(open.events.length, 0);
  assert.equal(open.verificationHistory[0].valid, true);
});

// --- capacity -------------------------------------------------------------

test('capacity evicts only the oldest unreferenced observation', () => {
  const state = emptyState();
  const open = makeTask({
    needs: [
      {
        target: 'keep this evidence',
        decision: 'reuse',
        evidence: 'src/a.js:1',
        evidenceStrength: 'concrete',
        observationIds: ['obs-1'],
        plan: null,
        at: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
  state.tasks.push(open);
  fillObservations(state, MAX_OBSERVATIONS);

  const observation = recordObservation(state, writeCall('s1', 'call-new'));

  assert.ok(observation);
  assert.equal(state.observations.length, MAX_OBSERVATIONS);
  assert.ok(state.observations.some((entry) => entry.id === 'obs-1'));
  assert.ok(!state.observations.some((entry) => entry.id === 'obs-2'));
  assert.ok(state.observations.some((entry) => entry.id === observation.id));
  assert.equal(state.droppedObservations, 0);
});

test('capacity refuses to drop referenced records and counts the drop', () => {
  const state = emptyState();
  const open = makeTask();
  fillObservations(state, MAX_OBSERVATIONS);
  open.pendingChangeIds = state.observations.map((entry) => entry.id);
  state.tasks.push(open);

  const observation = recordObservation(state, writeCall('s1', 'call-new'));

  assert.equal(observation, null);
  assert.equal(state.observations.length, MAX_OBSERVATIONS);
  assert.equal(state.droppedObservations, 1);
  assert.equal(state.nextObservation, MAX_OBSERVATIONS + 1);
});

// --- host wiring ----------------------------------------------------------

test('attachObserver records host tool results through store.mutate', async () => {
  const state = emptyState();
  state.tasks.push(makeTask());
  const store = createStore(state);
  const ctx = createCtx();
  const dispose = attachObserver(ctx, store);

  await ctx.emit(
    'tools/result',
    { callId: 'call-1', name: 'write', arguments: { file_path: 'src/a.js', content: 'x' }, agent: { id: 's1' } },
    { isError: false, value: { exitCode: 0, stdout: 'ok' } },
  );

  assert.equal(state.observations.length, 1);
  assert.equal(state.observations[0].sessionId, 's1');
  assert.equal(state.observations[0].taskId, 'task-1');
  assert.equal(state.tasks[0].revision, 1);

  dispose();
  assert.equal(ctx.handlers.has('tools/result'), false);
});

test('attachObserver ignores results without session identity', async () => {
  const state = emptyState();
  const store = createStore(state);
  const ctx = createCtx();
  attachObserver(ctx, store);

  await ctx.emit('tools/result', { name: 'write', callId: 'c1' }, { isError: false });

  assert.equal(state.observations.length, 0);
  assert.equal(state.observerErrors ?? 0, 0);
});

test('attachObserver contains store failures instead of breaking the host', async () => {
  const state = emptyState();
  let calls = 0;
  const store = {
    state,
    async mutate(fn) {
      calls += 1;
      if (calls === 1) throw new Error('lock-busy');
      fn(state);
      return state;
    },
  };
  const ctx = createCtx();
  const dispose = attachObserver(ctx, store);

  await assert.doesNotReject(async () => {
    await ctx.emit(
      'tools/result',
      { callId: 'c1', name: 'write', arguments: {}, agent: { id: 's1' } },
      { isError: false },
    );
  });

  assert.equal(state.observations.length, 0);
  assert.equal(state.observerErrors, 1);
  assert.equal(calls, 2);
  dispose();
});

test('attachObserver degrades to a no-op when the hook cannot be wired', async () => {
  const state = emptyState();
  const store = createStore(state);
  const ctx = {
    on() {
      throw new Error('hook unavailable');
    },
  };

  const dispose = attachObserver(ctx, store);
  assert.equal(typeof dispose, 'function');
  assert.doesNotThrow(() => dispose());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.observerErrors, 1);
});

// --- classify (used by the observer above) --------------------------------

test('summarizeCall redacts credentials and clips long arguments', () => {
  const summary = summarizeCall('bash', {
    command:
      'curl -H "Authorization: Bearer sk-live-abcdef123456" -H "X-Api-Key: abcdef123456" https://example.test',
  });

  assert.ok(!summary.includes('sk-live-abcdef123456'));
  assert.ok(!summary.includes('abcdef123456'));
  assert.ok(summary.includes('***'));
  assert.ok(summary.length <= 300);
});

test('summarizeResult keeps a bounded, redacted tail', () => {
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
  lines.push('password: hunter2', '# tests 12', '# pass 12');
  const summary = summarizeResult({
    isError: false,
    value: { exitCode: 0, stdout: lines.join('\n') },
  });

  assert.equal(summary.outcome, 'success');
  assert.equal(summary.exitCode, 0);
  assert.ok(!summary.summary.includes('hunter2'));
  assert.ok(summary.summary.includes('# pass 12'));
  assert.ok(!summary.summary.includes('line 0'));
  assert.ok(summary.summary.length <= 500);
});

test('summarizeResult reports unknown outcome without a usable result body', () => {
  assert.deepEqual(summarizeResult(undefined), { outcome: 'unknown', exitCode: null, summary: '' });
  assert.equal(summarizeResult({ isError: true }).outcome, 'failure');
  assert.equal(summarizeResult({ isError: false, meta: { exitCode: 2 } }).exitCode, 2);
});

test('changeImpact grades shell commands conservatively', () => {
  assert.equal(changeImpact('write', {}), 'confirmed');
  assert.equal(changeImpact('read', {}), 'not_applicable');
  assert.equal(changeImpact('bash', { command: 'git status' }), 'irrelevant');
  assert.equal(changeImpact('bash', { command: 'git diff && npm test' }), 'irrelevant');
  assert.equal(changeImpact('bash', { command: 'npm test' }), 'irrelevant');
  assert.equal(changeImpact('bash', { command: 'node --test' }), 'irrelevant');
  assert.equal(changeImpact('bash', { command: 'npx eslint src' }), 'irrelevant');
  assert.equal(changeImpact('bash', { command: 'npx eslint --fix src' }), 'possible');
  assert.equal(changeImpact('bash', { command: 'npm install x' }), 'possible');
  assert.equal(changeImpact('bash', { command: 'npm run build' }), 'possible');
  assert.equal(changeImpact('bash', { command: 'mkdir -p out' }), 'possible');
  assert.equal(changeImpact('bash', { command: 'ls && rm -rf dist' }), 'possible');
  assert.equal(changeImpact('bash', { command: 'echo hello > out.txt' }), 'possible');
  assert.equal(changeImpact('bash', { command: 'echo "npm test" > /dev/null' }), 'irrelevant');
  assert.equal(changeImpact('bash', { command: 'mystery-tool --flag' }), 'possible');
  assert.equal(changeImpact('some_mcp_tool', {}), 'possible');
  // praxis 自己的台账工具只写 state.json，不应制造阻断 done 的待复核写入。
  assert.equal(changeImpact('praxis_task', {}), 'not_applicable');
  assert.equal(changeImpact('praxis_lesson', {}), 'not_applicable');
  // 计划类工具只写内存里的待办，同样不该制造阻断 done 的待复核写入。
  assert.equal(changeImpact('todo_write', { todos: [] }), 'not_applicable');
  assert.equal(changeImpact('mcp__planner__todo_write', {}), 'not_applicable');
  // 上下文与展示类工具作用于对话，不作用于项目。
  assert.equal(changeImpact('compress', {}), 'not_applicable');
  assert.equal(changeImpact('ask_user_question', {}), 'not_applicable');
  // 造临时 fixture 属于验证动作：写系统临时目录不改变实现。
  assert.equal(changeImpact('bash', { command: 'printf "| A |\\n" > /tmp/table.md' }), 'irrelevant');
  assert.equal(changeImpact('bash', { command: 'npm test > /tmp/log.txt' }), 'irrelevant');
  // 但写到工作区里的文件仍然是真实变更。
  assert.equal(changeImpact('bash', { command: 'printf "x" > out.txt' }), 'possible');
  // fd 重定向不是文件写入。
  assert.equal(changeImpact('bash', { command: 'node --test 2>&1 | tail -3' }), 'irrelevant');
  assert.equal(changeImpact('bash', { command: 'npm test 2>&1' }), 'irrelevant');
});

test('classifyTool assigns the observation kind', () => {
  assert.equal(classifyTool('write', {}), 'write');
  assert.equal(classifyTool('read', {}), 'read');
  assert.equal(classifyTool('bash', { command: 'npm test' }), 'test');
  assert.equal(classifyTool('bash', { command: 'npm run build' }), 'build');
  assert.equal(classifyTool('bash', { command: 'npx eslint src' }), 'lint');
  assert.equal(classifyTool('bash', { command: 'git status' }), 'read');
  assert.equal(classifyTool('mystery', {}), 'other');
});

test('planning and meta tools never block a completion gate', () => {
  for (const tool of ['todo_write', 'todo_read', 'praxis_task', 'praxis_lesson', 'compress', 'ask_user_question']) {
    assert.equal(changeImpact(tool, {}), 'not_applicable', tool);
  }
  assert.equal(changeImpact('mcp__planner__todo_write', {}), 'not_applicable');
});

test('scratch redirects stay out of change detection', () => {
  assert.equal(changeImpact('bash', { command: 'printf "| A |\n" > /tmp/table.md' }), 'irrelevant');
  assert.equal(changeImpact('bash', { command: 'npm test > /tmp/log.txt' }), 'irrelevant');
  assert.equal(changeImpact('bash', { command: 'printf "x" > out.txt' }), 'possible');
  assert.equal(changeImpact('bash', { command: 'npm test 2>&1' }), 'irrelevant');
});

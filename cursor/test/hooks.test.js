import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createStore } from '../server/core/store.js';
import { createEngine } from '../server/core/engine.js';
import { hookPath, runNode, tempDir, writeSessionFile } from '../test-support/helpers.mjs';

function ctx(sessionId) {
  return { sessionId, agentId: sessionId, projectKey: null };
}

async function startTask(store, sessionId, goal = '验证 Cursor hooks') {
  const engine = createEngine(store);
  const started = await engine.task(ctx(sessionId), {
    action: 'start',
    goal,
    acceptance: [{ text: '新行为生效', kind: 'automated' }],
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  return { engine, taskId: started.data.task_id };
}

function fileEditPayload(sessionId, workspace, extra = {}) {
  return {
    conversation_id: sessionId,
    generation_id: 'gen-1',
    hook_event_name: 'afterFileEdit',
    workspace_roots: [workspace],
    file_path: join(workspace, 'src', 'a.js'),
    edits: [{ old_string: 'a', new_string: 'b' }],
    ...extra,
  };
}

test('afterFileEdit：记录 confirmed 观察、递增 revision，同一改动不重复记录', async () => {
  const dir = tempDir();
  const workspace = tempDir('praxis-ws-');
  writeSessionFile(dir, 'conv-1', workspace);
  const store = createStore({ dir });
  const { taskId } = await startTask(store, 'conv-1');
  const payload = fileEditPayload('conv-1', workspace);

  const first = await runNode(hookPath('after-file-edit.mjs'), {
    input: JSON.stringify(payload),
    env: { CURSOR_PRAXIS_DATA_DIR: dir },
  });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout.trim()), {});

  let state = await store.load();
  assert.equal(state.observations.length, 1);
  assert.equal(state.observations[0].changeImpact, 'confirmed');
  assert.equal(state.observations[0].taskId, taskId);
  assert.equal(state.tasks[0].revision, 1);

  const second = await runNode(hookPath('after-file-edit.mjs'), {
    input: JSON.stringify(payload),
    env: { CURSOR_PRAXIS_DATA_DIR: dir },
  });
  assert.equal(second.code, 0, second.stderr);
  state = await store.load();
  assert.equal(state.observations.length, 1);
  assert.equal(state.tasks[0].revision, 1);
});

test('postToolUse：记录检查观察，闭环提示同一组缺口只出现一次', async () => {
  const dir = tempDir();
  const workspace = tempDir('praxis-ws-');
  writeSessionFile(dir, 'conv-hint', workspace);
  const store = createStore({ dir });
  const { taskId } = await startTask(store, 'conv-hint');

  await runNode(hookPath('after-file-edit.mjs'), {
    input: JSON.stringify(fileEditPayload('conv-hint', workspace)),
    env: { CURSOR_PRAXIS_DATA_DIR: dir },
  });

  const shellPayload = {
    conversation_id: 'conv-hint',
    generation_id: 'gen-1',
    hook_event_name: 'postToolUse',
    workspace_roots: [workspace],
    cwd: workspace,
    tool_name: 'Shell',
    tool_input: { command: 'node --test' },
    tool_output: JSON.stringify({ exitCode: 0, stdout: '# tests 3\n# pass 3' }),
    tool_use_id: 'tool-1',
  };
  const first = await runNode(hookPath('post-tool-use.mjs'), {
    input: JSON.stringify(shellPayload),
    env: { CURSOR_PRAXIS_DATA_DIR: dir },
  });
  assert.equal(first.code, 0, first.stderr);
  const firstOutput = JSON.parse(first.stdout.trim());
  assert.match(firstOutput.additional_context, new RegExp(taskId));

  const state = await store.load();
  const testObservation = state.observations.find((item) => item.toolCallId === 'tool-1');
  assert.equal(testObservation.kind, 'test');
  assert.equal(testObservation.outcome, 'success');
  assert.equal(testObservation.changeImpact, 'irrelevant');

  const second = await runNode(hookPath('post-tool-use.mjs'), {
    input: JSON.stringify({ ...shellPayload, tool_use_id: 'tool-2' }),
    env: { CURSOR_PRAXIS_DATA_DIR: dir },
  });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout.trim()), {});
});

test('postToolUseFailure：失败观察不能充当 passed 证据', async () => {
  const dir = tempDir();
  const workspace = tempDir('praxis-ws-');
  writeSessionFile(dir, 'conv-fail', workspace);
  const store = createStore({ dir });
  const { engine, taskId } = await startTask(store, 'conv-fail');

  const need = await engine.task(ctx('conv-fail'), {
    action: 'need',
    task_id: taskId,
    target: 'Cursor hook 接线',
    decision: 'new',
    evidence: 'cursor/hooks/post-tool-use.mjs:1 现有实现已检查，Cursor 侧没有等价能力',
  });
  assert.equal(need.ok, true, JSON.stringify(need));
  const step = await engine.task(ctx('conv-fail'), {
    action: 'step',
    task_id: taskId,
    phase: 'implement',
  });
  assert.equal(step.ok, true, JSON.stringify(step));

  const failure = await runNode(hookPath('post-tool-use-failure.mjs'), {
    input: JSON.stringify({
      conversation_id: 'conv-fail',
      generation_id: 'gen-1',
      hook_event_name: 'postToolUseFailure',
      workspace_roots: [workspace],
      cwd: workspace,
      tool_name: 'Shell',
      tool_input: { command: 'node --test' },
      tool_use_id: 'fail-1',
      error_message: 'Command failed with exit code 1',
      failure_type: 'error',
    }),
    env: { CURSOR_PRAXIS_DATA_DIR: dir },
  });
  assert.equal(failure.code, 0, failure.stderr);

  const state = await store.load();
  const observation = state.observations.find((item) => item.toolCallId === 'fail-1');
  assert.equal(observation.outcome, 'failure');
  assert.equal(observation.kind, 'test');

  const criterionId = state.tasks[0].acceptance[0].id;
  const verify = await engine.task(ctx('conv-fail'), {
    action: 'verify',
    task_id: taskId,
    level: 'passed',
    scope: 'unit',
    coverage: [{ criterionId, result: 'passed', observationIds: [observation.id] }],
  });
  assert.equal(verify.ok, false);
  assert.equal(verify.code, 'unverified');
});

test('stop：一轮结束时提醒一次未闭环任务，重复触发不再续轮', async () => {
  const dir = tempDir();
  const workspace = tempDir('praxis-ws-');
  writeSessionFile(dir, 'conv-stop', workspace);
  const store = createStore({ dir });
  const { taskId } = await startTask(store, 'conv-stop', 'stop 提醒测试');

  await runNode(hookPath('after-file-edit.mjs'), {
    input: JSON.stringify(fileEditPayload('conv-stop', workspace)),
    env: { CURSOR_PRAXIS_DATA_DIR: dir },
  });

  const stopInput = JSON.stringify({
    conversation_id: 'conv-stop',
    generation_id: 'gen-1',
    hook_event_name: 'stop',
    workspace_roots: [workspace],
    status: 'completed',
    loop_count: 0,
  });
  const first = await runNode(hookPath('stop.mjs'), {
    input: stopInput,
    env: { CURSOR_PRAXIS_DATA_DIR: dir },
  });
  assert.equal(first.code, 0, first.stderr);
  const firstOutput = JSON.parse(first.stdout.trim());
  assert.match(firstOutput.followup_message, new RegExp(taskId));

  const second = await runNode(hookPath('stop.mjs'), {
    input: stopInput,
    env: { CURSOR_PRAXIS_DATA_DIR: dir },
  });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout.trim()), {});
});

test('sessionStart / beforeSubmitPrompt / sessionEnd：维护活跃会话指针', async () => {
  const dir = tempDir();
  const workspace = tempDir('praxis-ws-');
  const env = { CURSOR_PRAXIS_DATA_DIR: dir };
  const base = {
    conversation_id: 'conv-life',
    generation_id: 'gen-0',
    workspace_roots: [workspace],
  };

  const started = await runNode(hookPath('session-start.mjs'), {
    input: JSON.stringify({ ...base, hook_event_name: 'sessionStart' }),
    env,
  });
  assert.equal(started.code, 0, started.stderr);
  let book = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
  assert.equal(book.active.sessionId, 'conv-life');
  assert.equal(book.active.workspaceRoot, workspace);

  const submitted = await runNode(hookPath('before-submit-prompt.mjs'), {
    input: JSON.stringify({ ...base, hook_event_name: 'beforeSubmitPrompt', prompt: '改一下' }),
    env,
  });
  assert.equal(submitted.code, 0, submitted.stderr);
  assert.deepEqual(JSON.parse(submitted.stdout.trim()), { continue: true });

  const ended = await runNode(hookPath('session-end.mjs'), {
    input: JSON.stringify({ ...base, hook_event_name: 'sessionEnd', reason: 'completed' }),
    env,
  });
  assert.equal(ended.code, 0, ended.stderr);
  book = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
  assert.equal(book.active, null);
  assert.ok(book.sessions['conv-life'].endedAt);
});

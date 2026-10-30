// Cursor hooks 的共用逻辑：读 stdin、记录观察、判断闭环缺口。
//
// 所有 hook 都必须 fail-open：Cursor 把非 0 退出码当成 hook 失败并继续执行动作，
// 但 stdout 里的半截输出仍可能被解析。这里统一捕获错误并输出一个合法响应。
import { createHash } from 'node:crypto';

import { dataDir, readHint, touchSession, writeHint } from '../server/session.mjs';

const HOOK_TIMEOUT_MS = 15_000;

// Cursor 的编辑器类工具会另外触发 afterFileEdit；同一个改动不重复记两次观察。
const FILE_EDIT_TOOLS = new Set([
  'write',
  'edit',
  'patch',
  'multiedit',
  'multi_edit',
  'apply_patch',
  'str_replace_editor',
  'edit_file',
  'rewrite_file',
]);

function textOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 与 core/classify.js 相同的命名空间归一化：MCP:praxis_task -> praxis_task。 */
export function baseName(name) {
  let base = String(name ?? '').trim().toLowerCase();
  if (!base) return '';
  if (base.includes('__')) base = base.split('__').pop() ?? base;
  base = base.split(/[.:/\\]/).pop() ?? base;
  return base.trim();
}

export function isFileEditTool(name) {
  return FILE_EDIT_TOOLS.has(baseName(name));
}

export function parseJsonish(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { input: value };
  } catch {
    return { input: value };
  }
}

/** postToolUse 的 tool_output 是 JSON 字符串；解析失败时当正文摘要。 */
export function resultFromToolOutput(toolOutput) {
  if (toolOutput === undefined || toolOutput === null) return { isError: false };
  if (typeof toolOutput !== 'string') return { isError: false, value: toolOutput };
  const text = toolOutput.trim();
  if (!text) return { isError: false };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { isError: false, value: parsed };
    }
    return { isError: false, value: text };
  } catch {
    return { isError: false, value: text };
  }
}

export function sessionIdOf(input) {
  return textOf(input?.conversation_id) ?? textOf(input?.session_id);
}

export function workspaceRootOf(input) {
  const roots = input?.workspace_roots;
  if (Array.isArray(roots)) {
    const root = roots.map(textOf).find(Boolean);
    if (root) return root;
  }
  return textOf(input?.cwd);
}

/** 记录/刷新活跃会话；失败不影响 hook 主流程。 */
export function touch(input) {
  const sessionId = sessionIdOf(input);
  if (!sessionId) return null;
  try {
    return touchSession({
      sessionId,
      workspaceRoot: workspaceRootOf(input),
      event: textOf(input?.hook_event_name) ?? 'hook',
    });
  } catch {
    return null;
  }
}

export function callIdOf(input) {
  const hostId = textOf(input?.tool_use_id) ?? textOf(input?.tool_call_id);
  if (hostId) return hostId;
  return `hook-${digest([
    sessionIdOf(input),
    input?.generation_id,
    input?.hook_event_name,
    input?.tool_name,
    input?.tool_input,
  ])}`;
}

export function editCallIdOf(input) {
  return `edit-${digest([
    sessionIdOf(input),
    input?.generation_id,
    input?.hook_event_name,
    input?.file_path,
    input?.edits,
  ])}`;
}

function digest(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

let corePromise = null;

/** core/ 是安装/测试时由 dsh/src 生成的；缺 core 时 hook 静默降级。 */
function coreModules() {
  corePromise ??= Promise.all([
    import('../server/core/store.js'),
    import('../server/core/observer.js'),
    import('../server/core/engine.js'),
  ]).then(([store, observer, engine]) => ({
    createStore: store.createStore,
    recordObservation: observer.recordObservation,
    readinessOf: engine.readinessOf,
  }));
  return corePromise;
}

/**
 * 把一次宿主工具调用写成观察。callId 必须来自宿主事件（或稳定摘要），
 * 模型无法伪造。返回 { store, observation, sessionId } 或 null。
 */
export async function observe(input, { tool, args = {}, result = { isError: false }, callId = null }) {
  const sessionId = sessionIdOf(input);
  if (!sessionId || !tool) return null;
  touch(input);
  const { createStore, recordObservation } = await coreModules();
  const store = createStore({ dir: dataDir() });
  let observation = null;
  await store.mutate((state) => {
    observation = recordObservation(state, {
      sessionId,
      agentId: sessionId,
      toolCallId: callId || callIdOf(input),
      tool,
      args,
      result,
      cwd: workspaceRootOf(input) ?? undefined,
    });
  });
  return observation ? { store, observation, sessionId } : null;
}

function latestOpenTask(state, sessionId) {
  const tasks = (state?.tasks ?? []).filter(
    (task) => task && task.status === 'open' && task.sessionId === sessionId,
  );
  if (tasks.length === 0) return null;
  tasks.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return tasks[0];
}

function usableEvidenceOf(state, task) {
  const candidates = (state?.observations ?? []).filter(
    (item) =>
      item &&
      item.sessionId === task.sessionId &&
      (item.taskId === null || item.taskId === task.id) &&
      ['test', 'build', 'lint'].includes(item.kind) &&
      item.outcome === 'success' &&
      (item.exitCode === null || item.exitCode === 0),
  );
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

function readiness(state, task) {
  const { readinessOf } = readinessCache;
  if (typeof readinessOf !== 'function') return [];
  const { blockers, codes } = readinessOf(task, 'complete');
  const gaps = blockers.map((text, index) => ({ code: codes[index], text }));
  if (codes.includes('uncovered') || codes.includes('stale')) {
    const evidence = usableEvidenceOf(state, task);
    if (evidence) {
      gaps.push({
        code: 'usable-evidence',
        text: `已有可用证据 ${evidence.id}（${evidence.resultSummary || evidence.callSummary}），verify 可直接引用`,
      });
    }
  }
  return gaps;
}

// readinessOf 在 core/engine.js；core 缺失时所有提示函数返回 null。
const readinessCache = { readinessOf: null };

async function ensureCore() {
  if (!readinessCache.readinessOf) {
    const { readinessOf } = await coreModules();
    readinessCache.readinessOf = readinessOf;
  }
  return readinessCache.readinessOf !== null;
}

function signatureOf(task, gaps) {
  const stable = gaps.map((gap) => gap.code);
  return `${task.id}|${task.phase ?? ''}|${stable.join(',')}`;
}

function rememberOnce(sessionId, signature) {
  try {
    if (readHint(sessionId, 'closure') === signature) return false;
    writeHint(sessionId, 'closure', signature);
    return true;
  } catch {
    return false;
  }
}

/**
 * postToolUse 之后的闭环提示：只在这次调用确实改了实现、或跑了检查时出现，
 * 且同一组缺口每个会话只提示一次。返回 additional_context 文本或 null。
 */
export async function closureHint(recorded) {
  if (!recorded?.observation || !recorded.store) return null;
  if (!(await ensureCore())) return null;
  const { observation, store, sessionId } = recorded;
  const state = store.read();
  const task = latestOpenTask(state, sessionId);
  if (!task || observation.taskId !== task.id) return null;

  const informative =
    observation.changeImpact === 'confirmed' ||
    observation.changeImpact === 'possible' ||
    ['test', 'build', 'lint'].includes(observation.kind);
  if (!informative) return null;

  const gaps = readiness(state, task);
  const signature = signatureOf(task, gaps);
  if (!rememberOnce(sessionId, signature)) return null;

  if (gaps.length === 0) {
    return [
      `[Praxis] 任务 ${task.id} 已满足 close(done) 的门槛。`,
      '确认工作确实完成后用 praxis_task close(outcome=done, implementationStatus=complete) 结项；',
      '如果还有人工验收或未完成项，用 close(partial, complete, awaiting_manual) 或 step/need 说明。',
    ].join('');
  }
  return [
    `[Praxis] 任务 ${task.id}（${task.phase}）仍有未闭环项：${gaps.map((gap) => gap.text).join('；')}。`,
    '改完实现后先跑只含检查的命令，再用 praxis_task verify 引用观察 ID；',
    '没完成就 step 推进阶段或用 need 记录下一步，不要只在回复里口头收尾。',
  ].join('');
}

/**
 * stop 钩子的收尾提醒：只对这个会话里已经产生过工作的 open 任务提示一次。
 * 返回 followup_message 文本或 null。
 */
export async function stopNudge(input) {
  const sessionId = sessionIdOf(input);
  if (!sessionId) return null;
  touch(input);
  if (!(await ensureCore())) return null;

  const { createStore } = await coreModules();
  const store = createStore({ dir: dataDir() });
  const state = await store.load();
  const task = latestOpenTask(state, sessionId);
  if (!task) return null;

  const hasWork = (state.observations ?? []).some(
    (item) => item && item.sessionId === sessionId && item.taskId === task.id,
  );
  if (!hasWork) return null;

  const gaps = readiness(state, task);
  const signature = signatureOf(task, gaps);
  if (!rememberOnce(sessionId, signature)) return null;

  if (gaps.length === 0) {
    return [
      `[Praxis] 任务 ${task.id} 已满足 close(done) 的门槛，但还没有结项。`,
      '确认完成后调用 praxis_task close(outcome=done, implementationStatus=complete)；',
      '还有人工验收就 close(partial, complete, awaiting_manual)。',
    ].join('');
  }
  return [
    `[Praxis] 本轮结束时任务 ${task.id}（${task.phase}）仍未闭环：${gaps.map((gap) => gap.text).join('；')}。`,
    '如果工作确实完成了，用 praxis_task verify 引用观察 ID 后 close；',
    '如果没完成，用 step 推进阶段或用 need 记录下一步。',
  ].join('');
}

/** 读取 hook 的 stdin JSON；空输入或坏 JSON 视为 {}。 */
export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 统一的 hook 入口：读取输入、执行 handler、输出 JSON。
 * fallback 用于必须给宿主明确响应的钩子（如 beforeSubmitPrompt 的 continue）。
 */
export function safe(handler, fallback = {}) {
  const watchdog = setTimeout(() => {
    process.stderr.write('[praxis] hook timed out waiting for stdin\n');
    process.exit(0);
  }, HOOK_TIMEOUT_MS);
  watchdog.unref();

  readHookInput()
    .then((input) => handler(input))
    .then((output) => {
      process.stdout.write(`${JSON.stringify(output && typeof output === 'object' ? output : fallback)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`[praxis] hook failed: ${error?.stack ?? error}\n`);
      process.stdout.write(`${JSON.stringify(fallback)}\n`);
    })
    .finally(() => clearTimeout(watchdog));
}

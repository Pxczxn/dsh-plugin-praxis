// Trusted-observation capture around the host tool pipeline (CONTRACT §5,
// design §3.3).
//
// Identity is only ever taken from the host event: `sessionId`, `toolCallId`
// and the tool name cannot be supplied by the model, and a call that lacks any
// of them is not recorded at all. Recording is contained: a failure while
// writing state must never change the tool result the caller sees, so every
// throw is swallowed and only counted in `state.observerErrors`.

import { createHash } from 'node:crypto';
import { LIMITS, clip } from './evidence.js';
import { changeImpact, classifyTool, summarizeCall, summarizeResult } from './classify.js';

/** Hard cap on retained observations (design §3.4 / CONTRACT §5). */
export const MAX_OBSERVATIONS = 1000;

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function revisionOf(task) {
  return Number.isFinite(task?.revision) ? task.revision : 0;
}

function ensureShape(state) {
  if (!Array.isArray(state.observations)) state.observations = [];
  if (!Array.isArray(state.tasks)) state.tasks = [];
  if (!Array.isArray(state.lessons)) state.lessons = [];
  if (!Number.isFinite(state.nextObservation) || state.nextObservation < 1) state.nextObservation = 1;
  if (!Number.isFinite(state.droppedObservations)) state.droppedObservations = 0;
  if (!Number.isFinite(state.observerErrors)) state.observerErrors = 0;
}

/**
 * A task is bound only when the session has exactly one open Praxis task.
 * Several open tasks, a parent/child pair, or a different session all mean
 * "cannot attribute" — the observation is kept with taskId=null and must stay
 * read-only-diagnostic (design §3.3.2).
 */
function resolveTaskId(state, sessionId) {
  let match = null;
  let count = 0;
  for (const task of state.tasks) {
    if (!task || task.status !== 'open' || task.sessionId !== sessionId) continue;
    count += 1;
    match = task;
    if (count > 1) return null;
  }
  return count === 1 && match && typeof match.id === 'string' ? match.id : null;
}

/** Every observation id referenced by a task, verification or lesson. */
function referencedObservationIds(state) {
  const ids = new Set();
  const add = (value) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === 'string' && item) ids.add(item);
    }
  };
  for (const task of state.tasks) {
    if (!task) continue;
    add(task.pendingChangeIds);
    for (const need of task.needs ?? []) add(need?.observationIds);
    for (const verification of task.verificationHistory ?? []) {
      add(verification?.observationIds);
      for (const coverage of verification?.coverage ?? []) add(coverage?.observationIds);
    }
  }
  for (const lesson of state.lessons ?? []) add(lesson?.observationIds);
  return ids;
}

function pushEvent(task, at, kind, detail) {
  if (!Array.isArray(task.events)) task.events = [];
  task.events.push({ at, kind, detail: clip(detail, LIMITS.note) });
}

function digestOf(observation) {
  const hash = createHash('sha256');
  for (const part of [
    observation.id,
    observation.sessionId,
    observation.toolCallId,
    observation.tool,
    observation.kind,
    observation.changeImpact,
    observation.outcome,
    String(observation.exitCode),
    observation.callSummary,
    observation.resultSummary,
  ]) {
    hash.update(String(part ?? ''));
    hash.update('\u0000');
  }
  return hash.digest('hex').slice(0, 32);
}

function applyImpact(task, observation, at) {
  if (!task) return;

  if (observation.changeImpact === 'confirmed') {
    const revision = revisionOf(task) + 1;
    task.revision = revision;
    let invalidated = 0;
    if (!Array.isArray(task.verificationHistory)) task.verificationHistory = [];
    for (const verification of task.verificationHistory) {
      if (!verification) continue;
      const verificationRevision = Number.isFinite(verification.revision) ? verification.revision : 0;
      if (verificationRevision < revision) {
        if (verification.valid !== false) invalidated += 1;
        verification.valid = false;
      }
    }
    task.updatedAt = at;
    pushEvent(
      task,
      at,
      'invalidate',
      `${observation.id} (${observation.tool}) confirmed what looks like an implementation write; revision -> ${revision}; invalidated ${invalidated} verification(s)`,
    );
    return;
  }

  if (observation.changeImpact === 'possible') {
    if (!Array.isArray(task.pendingChangeIds)) task.pendingChangeIds = [];
    if (!task.pendingChangeIds.includes(observation.id)) task.pendingChangeIds.push(observation.id);
    // A possible write blocks `done` until an independent re-check after it.
    task.reviewStatus = 'unverified';
    task.updatedAt = at;
    pushEvent(
      task,
      at,
      'invalidate',
      `${observation.id} (${observation.tool}) may have changed the implementation; re-verify after it before closing as done`,
    );
  }
}

/**
 * Pure state transition: append one host observation and apply its write
 * impact. Returns the new (or de-duplicated existing) observation, or null
 * when the call is untrusted or the capacity guard refused to store it.
 *
 * @param {object} state  mutable Praxis state (the store's transaction)
 * @param {{ sessionId?: unknown, agentId?: unknown, toolCallId?: unknown, tool?: unknown, args?: unknown, result?: unknown }} input
 */
export function recordObservation(state, input = {}) {
  if (!state || typeof state !== 'object') return null;

  const sessionId = textOrNull(input.sessionId);
  const toolCallId = textOrNull(input.toolCallId);
  const tool = textOrNull(input.tool);
  if (!sessionId || !toolCallId || !tool) return null;

  ensureShape(state);

  // Replaying the same host call must not create a second record (§3.3.1).
  const existing = state.observations.find(
    (entry) => entry && entry.sessionId === sessionId && entry.toolCallId === toolCallId,
  );
  if (existing) return existing;

  const taskId = resolveTaskId(state, sessionId);
  const task = taskId ? state.tasks.find((entry) => entry && entry.id === taskId) ?? null : null;

  const at = new Date().toISOString();
  const sequence = Math.floor(state.nextObservation);
  const id = `obs-${sequence}`;
  const kind = classifyTool(tool, input.args);
  const impact = changeImpact(tool, input.args);
  const callSummary = summarizeCall(tool, input.args);
  const result = summarizeResult(input.result);

  // Capacity: evict only the oldest record that nothing references. If every
  // retained record is referenced, drop the new one and count it instead of
  // silently breaking an audit link (design §3.4).
  let referenced = null;
  while (state.observations.length >= MAX_OBSERVATIONS) {
    if (referenced === null) referenced = referencedObservationIds(state);
    const index = state.observations.findIndex((entry) => entry && !referenced.has(entry.id));
    if (index < 0) {
      state.droppedObservations += 1;
      return null;
    }
    state.observations.splice(index, 1);
  }

  const observation = {
    id,
    sessionId,
    // 宿主只暴露 SessionId：没给 agentId 时与会话同值，便于审计定位。
    agentId: textOrNull(input.agentId) ?? sessionId,
    toolCallId,
    taskId,
    revisionAtCapture: task ? revisionOf(task) : 0,
    sequence,
    tool,
    callSummary,
    at,
    outcome: result.outcome,
    exitCode: result.exitCode,
    kind,
    changeImpact: impact,
    resultSummary: result.summary,
    digest: '',
  };
  observation.digest = digestOf(observation);

  state.nextObservation = sequence + 1;
  state.observations.push(observation);
  applyImpact(task, observation, at);
  return observation;
}

async function bumpObserverError(store) {
  try {
    await store.mutate((state) => {
      if (!state || typeof state !== 'object') return;
      if (!Number.isFinite(state.observerErrors)) state.observerErrors = 0;
      state.observerErrors += 1;
    });
  } catch {
    // Diagnostic bookkeeping must not escalate into a host-visible failure.
  }
}

function idFrom(event, keys) {
  for (const key of keys) {
    const value = textOrNull(event?.[key]);
    if (value) return value;
  }
  return null;
}

function unwrap(exec, result) {
  // Some hosts deliver one `{ exec, result }` payload instead of two arguments.
  if (exec && typeof exec === 'object' && result === undefined && 'exec' in exec && !('name' in exec)) {
    return { call: exec.exec, result: exec.result };
  }
  return { call: exec, result };
}

/**
 * Register the observer on `tools/result` and return a disposer.
 * A missing/broken hook wiring degrades to a no-op rather than failing load.
 */
export function attachObserver(ctx, store) {
  // Compatibility with the pre-0.2.1 wiring (`attachObserver({ ctx, store })`):
  // a stale index.js then degrades to no observing instead of throwing.
  if (ctx && typeof ctx === 'object' && typeof ctx.on !== 'function' && ctx.ctx && store === undefined) {
    store = ctx.store;
    ctx = ctx.ctx;
  }
  if (!ctx || typeof ctx.on !== 'function' || !store || typeof store.mutate !== 'function') {
    return () => {};
  }

  const observe = async (exec, rawResult) => {
    try {
      const { call, result } = unwrap(exec, rawResult);
      const sessionId = idFrom(call, ['sessionId']) ?? idFrom(call?.agent, ['id']) ?? idFrom(call, ['agentId']);
      const toolCallId =
        idFrom(call, ['callId', 'toolCallId', 'id']) ?? idFrom(result, ['callId', 'toolCallId']);
      const tool = textOrNull(call?.name) ?? textOrNull(call?.tool);
      if (!sessionId || !toolCallId || !tool) return;

      await store.mutate((state) => {
        recordObservation(state, {
          sessionId,
          // The host exposes one SessionId in 0.2.1; keep agentId for the model.
          agentId: sessionId,
          toolCallId,
          tool,
          args: call?.arguments ?? call?.args ?? null,
          result,
        });
      });
    } catch {
      await bumpObserverError(store);
    }
  };

  const handler = (exec, result) => {
    const pending = observe(exec, result);
    // Never let a rejection escape into the host event loop.
    pending.catch(() => {});
    return pending;
  };

  let off;
  try {
    off = ctx.on('tools/result', handler);
  } catch {
    awaitlessError(store);
    return () => {};
  }

  return () => {
    try {
      if (typeof off === 'function') off();
    } catch {
      // the listener is already gone
    }
  };
}

function awaitlessError(store) {
  // Fire-and-forget: a failed hook registration is a diagnostic, not a crash.
  bumpObserverError(store).catch(() => {});
}

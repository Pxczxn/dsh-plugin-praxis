// Praxis 规则引擎：状态机、验证绑定与失效、经验生命周期、幂等账本。
// 只通过 store.mutate 做单事务写入；本文件不碰文件系统、不依赖 DSH。
import { createHash } from 'node:crypto';
import {
  LIMITS,
  PraxisError,
  clip,
  evidenceGaps,
  evidenceStrength,
  id,
  nowIso,
  relevance,
  similarity,
} from './evidence.js';
import { findUsableConfirmation, consumeConfirmation, confirmationDigest, isAffirmativeAnswer } from './trust.js';

export const PHASES = ['understand', 'implement', 'verify'];
export const OUTCOMES = ['done', 'partial', 'abandoned'];
export const IMPLEMENTATION_STATUS = ['unknown', 'complete', 'incomplete', 'not_applicable'];
export const LEVELS = ['passed', 'partial', 'blocked', 'not_run'];
export const CLOSURE_REASONS = [
  'awaiting_manual',
  'verification_missing',
  'implementation_incomplete',
  'other',
];
export const DECISIONS = ['reuse', 'extend', 'new'];
export const TASK_ACTIONS = [
  'start',
  'need',
  'inventory',
  'step',
  'verify',
  'close',
  'status',
  'summary',
];
export const LESSON_ACTIONS = ['search', 'save', 'update', 'retire'];

export const NEAR_DUPLICATE = 0.85;
export const RELATED = 0.6;
export const MAX_TASKS = 200;
export const MAX_LESSONS = 400;
export const MAX_EVENTS = 40;
export const MAX_OBSERVATIONS = 1000;
export const MAX_REQUESTS = 500;
export const REPEAT_REWIND_AT = 3;
// summary 是只读概览：计数铺开，细节只展开最近活跃的前 N 个未结任务。
export const MAX_SUMMARY_TASKS = 20;

const MUTATING_TASK_ACTIONS = new Set(['start', 'need', 'inventory', 'step', 'verify', 'close']);
const MUTATING_LESSON_ACTIONS = new Set(['save', 'update', 'retire']);
const EVIDENCE_KINDS = new Set(['test', 'build', 'lint']);

function ok(data = {}, warnings = []) {
  const response = { ok: true, code: 'ok', data };
  if (warnings.length > 0) response.warnings = warnings;
  return response;
}

function refusal(error) {
  return {
    ok: false,
    code: error.code ?? 'invalid-state',
    message: error.message,
    hint: error.hint ?? null,
    changed: error.changed === true,
  };
}

function requiredString(args, field, limit = LIMITS.note) {
  const value = args[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PraxisError('missing-field', `缺少必填字段 ${field}`, {
      hint: `请提供非空的 ${field}`,
    });
  }
  return clip(value.trim(), limit);
}

function optionalString(args, field, limit = LIMITS.note) {
  const value = args[field];
  if (value === undefined || value === null || value === '') return null;
  return clip(String(value).trim(), limit);
}

function optionalArray(args, field) {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new PraxisError('bad-action', `${field} 必须是数组`, { hint: `请把 ${field} 传成数组` });
  }
  return value;
}

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new PraxisError('bad-action', `${field} 不合法：${value}`, {
      hint: `允许值：${allowed.join(' | ')}`,
    });
  }
  return value;
}

function findTask(state, taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    throw new PraxisError('task-not-found', `找不到任务 ${taskId}`, {
      hint: '先用 status 查看任务 ID；不存在的任务无法操作',
    });
  }
  return task;
}

function ensureOpen(task) {
  if (task.status === 'closed') {
    throw new PraxisError('task-closed', `任务 ${task.id} 已关闭（${task.closedAs}）`, {
      hint: '已关闭任务不可再修改；请创建新任务并用 parentTaskId 关联',
    });
  }
  return task;
}

function pushEvent(task, kind, detail, at = nowIso()) {
  task.events.push({ at, kind, detail: clip(detail, 300) });
  while (task.events.length > MAX_EVENTS) {
    task.events.shift();
    task.omittedEventCount = (task.omittedEventCount ?? 0) + 1;
  }
}

function touch(task, at = nowIso()) {
  task.updatedAt = at;
}

function summarizeTask(task) {
  return {
    task_id: task.id,
    goal: task.goal,
    projectKey: task.projectKey,
    phase: task.phase,
    status: task.status,
    revision: task.revision,
    implementationStatus: task.implementationStatus,
    reviewStatus: task.reviewStatus,
    closedAs: task.closedAs,
    closureReason: task.closureReason,
    acceptance: task.acceptance.length,
    needs: task.needs.length,
    verifications: task.verificationHistory.length,
    pendingChanges: task.pendingChangeIds.length,
    updatedAt: task.updatedAt,
  };
}

function summarizeLesson(lesson) {
  return {
    lesson_id: lesson.id,
    scope: lesson.scope,
    projectKey: lesson.projectKey,
    trigger: lesson.trigger,
    lesson: lesson.lesson,
    evidence: lesson.evidence,
    reusable_because: lesson.reusable_because,
    tags: lesson.tags,
    source_task: lesson.source_task,
    supersedes: lesson.supersedes,
    supersededBy: lesson.supersededBy,
    status: lesson.status,
    createdAt: lesson.createdAt,
    updatedAt: lesson.updatedAt,
  };
}

/**
 * M1：验收项的来源与保护语义。
 *
 * 可信边界：模型在工具参数里自报的 source:user_explicit / protected:true 不能单独
 * 建立信任（criterion-1）。两条路径：
 * - 修订/新建时由调用方（start/inventory）先做授权核对，再传入 normalize；
 * - 旧 state 里已经是 user_explicit 的项保持原样（兼容，不自动升级也不自动降级）。
 */
/**
 * M1 受保护项授权核对（criterion-2/3/4/5）。必须在调用方的 mutate 事务内执行：
 * 查找→校验→消费一步完成，锁保证原子性。
 *
 * 授权绑定：callId 必须 ① 存在于本任务 state.confirmations（宿主 user-question-reply
 * 事件登记）；② 属于当前会话（跨会话/子代理无效）；③ 未被消费（防重放）；④
 * 用户回答覆盖到本次变更（变更描述作为问题文本出现在该次提问里）。
 */
function requireProtectedConfirmation(ctx, state, criterionId, { before, after, changeReason, change, callId: explicitCallId }) {
  // callId 优先取验收项自带的 confirmation_call_id；顶层 ctx 通道仅作兼容兜底。
  const callId = explicitCallId ?? ctx?.__pendingConfirmationCallId ?? null;
  if (!callId || typeof callId !== 'string') {
    throw new PraxisError('confirmation-required', `受保护验收项 ${criterionId} 的修改需要用户授权`, {
      hint: '先 ask_user_question（timed）向用户描述本次修改，用户确认后带 confirmation_call_id 重新提交',
    });
  }
  const sessionId = ctx?.sessionId ?? null;
  const record = findUsableConfirmation(state, sessionId, callId);
  if (!record) {
    throw new PraxisError('confirmation-invalid', `确认 ${clip(callId, 80)} 不存在、已消费或不属于当前会话`, {
      hint: 'confirmation_call_id 必须来自本会话内一次真实 ask_user_question 回答，且未被使用过',
    });
  }
  // ④ 变更内容与用户确认的问题对应（M2.5 完整变更匹配）。仅要求
  // asked.includes(after.text) 无法防止「确认了长文本、提交其弱化子串」的
  // 偏移（子串同样是长文本的子串）。因此：
  //   · 文本被修改（before.text !== after.text）：按引导模板把确认问题中的
  //     【变更段】提取出来做【等值】比较——问题必须能定位出与本次提交完全
  //     一致的新文本；提取不到（不遵循模板）一律拒（fail-closed）。
  //   · 停用/恢复（文本不变，active 变化）：文本内容无弱化空间，要求问题
  //     包含 criterionId 与完整验收文本即可（gate 还核对结果状态与授权记录）。
  const keyText = normalizeQuestionText(after?.text ?? '');
  const textChanged = normalizeQuestionText(before?.text ?? '') !== keyText;
  const covered = record.questions.some((item) => {
    const asked = normalizeQuestionText(item?.question);
    if (asked === '') return false;
    if (!asked.includes(criterionId)) return false;
    if (keyText === '') return true; // 纯删除类变更：id 覆盖即可
    if (!textChanged) return asked.includes(keyText); // 停用/恢复：文本未变
    // 文本修改：提取确认问题中的新文本，要求与提交文本等值。
    const extracted = extractConfirmedText(asked, criterionId, keyText);
    return extracted !== null && extracted === keyText;
  });
  if (!covered) {
    throw new PraxisError('confirmation-mismatch', `确认 ${clip(callId, 80)} 的问题文本未完整对应验收项 ${criterionId} 的本次变更（需要与提交文本一致的完整内容）`, {
      hint: '提问必须逐字引用变更后的完整验收文本，例如「将 criterion-1 修订为：<完整文本>，是否同意？」；不得省略或截断',
    });
  }
  // M2：宿主对「拒绝」与「同意」都产生 outcome:'answered'（m2-reject.mjs 实测），
  // 这里必须核对所选选项语义，否则用户拒绝也会被当成授权。
  if (!isAffirmativeAnswer(record)) {
    throw new PraxisError('confirmation-rejected', `确认 ${clip(callId, 80)} 的用户回答不是同意（拒绝/取消不能作为授权）`, {
      hint: '只有用户明确选择同意（如「同意」「确认」）的确认才能授权修改受保护验收项',
    });
  }
  consumeConfirmation(state, record, `acceptance:${criterionId}`);
  // 同一 mutate 事务内的临时通道：调用方取走后写进 task.confirmationHistory。
  // ctx 是每次工具调用新建的对象，不会跨请求泄漏。
  if (!Array.isArray(ctx.__consumedConfirmations)) ctx.__consumedConfirmations = [];
  ctx.__consumedConfirmations.push({
    criterionId,
    callId,
    change: change ?? 'modify',
    at: new Date().toISOString(),
  });
  return record;
}

function describeChange(before, after, changeReason) {
  const parts = [];
  if (before.text !== after.text) parts.push(`文本「${before.text}」→「${after.text}」`);
  if (before.source !== after.source) parts.push(`来源 ${before.source}→${after.source}`);
  if (before.kind !== after.kind) parts.push(`类型 ${before.kind}→${after.kind}`);
  if (before.active !== after.active) parts.push(after.active ? '重新启用' : '停用');
  if (changeReason) parts.push(String(changeReason).slice(0, 200));
  return parts.join('；') || '建立保护';
}

function normalizeQuestionText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

// M2.5：从确认问题文本中提取 criterionId 对应的【变更段】，供与提交的完整
// 验收文本做等值比较。提取策略（按引导模板，依次尝试，命中即返回）：
//   a) A→B 修订式：提取「由「X」修改为「Y」」中的新文本 Y；
//   b) 直接式：id 后跳过引导词（修订为/为/：），取到模板边界
//     （（保护）/问句标点/是否同意）之前的完整文本。
// 提取不到或不完整时返回 null（fail-closed）。
// keyText 用于边界截断的回退判定（验收文本自身含边界字符时不误截）。
function extractConfirmedText(asked, criterionId, keyText) {
  const idx = asked.indexOf(criterionId);
  if (idx === -1) return null;
  const cleaned = normalizeQuestionText(keyText);
  if (cleaned === '') return null;

  // a) 修订式：...由「old」修改为「new」... ——"new" 必须与 keyText 等值。
  const revise = asked.match(/[「\"]([^「」\"]+)[」\"]\s*(?:修改|变更|修订|改|调整为?|更新)\s*(?:为|成|到)?\s*[「\"]([^「」\"]+)[」\"]/);
  if (revise && asked.slice(0, revise.index).includes(criterionId)) {
    return revise[2].trim();
  }

  // b) 直接式：id 之后跳过引导词，取到模板边界之前。
  let rest = asked.slice(idx + criterionId.length);
  rest = rest.replace(/^[^：:]*[：:]\s*/, '').replace(/^\s*(修订|修改|新增|变更为|改为|为)\s*/, '');
  if (rest === '') return null;
  const boundary = /[（(]保护[）)]|[？?。！!]|是否同意|是否确认/;
  const match = rest.match(boundary);
  let segment = match ? rest.slice(0, match.index) : rest;
  segment = segment.replace(/[\s，,、；;：:]+$/g, '').trim();
  if (segment === '') return null;
  // 若截断后不含完整 keyText（验收文本自身含边界字符被截断），回退到全文。
  if (!segment.includes(cleaned) && rest.includes(cleaned)) segment = rest.trim();
  return segment === '' ? null : segment;
}

function userExplicitAllowed(raw) {
  return raw?.confirmation_call_id !== undefined && raw?.confirmation_call_id !== null;
}

function normalizeAcceptance(items, existing = [], warnings = [], ctx = null, state = null) {
  const newConfirmations = [];
  const result = existing.map((item) => ({ ...item }));
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') {
      throw new PraxisError('bad-action', 'acceptance 项必须是对象', {
        hint: '每项至少提供 text；可用 id 指定要更新的验收项',
      });
    }
    const text = typeof raw.text === 'string' ? clip(raw.text.trim(), LIMITS.acceptance) : null;
    const explicitId = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : null;
    if (explicitId) {
      const target = result.find((item) => item.id === explicitId);
      if (!target) {
        if (!text) {
          throw new PraxisError('missing-field', `新验收项 ${explicitId} 缺少 text`, {
            hint: '新验收项必须给出 text',
          });
        }
        // 新建：模型自报 user_explicit/protected 必须绑定真实用户确认（criterion-1）。
        const wantedSource = oneOf(raw.source ?? 'agent_proposed', ['user_explicit', 'agent_proposed'], 'source');
        const wantsProtected = raw.protected === true;
        if ((wantedSource === 'user_explicit' || wantsProtected) && !userExplicitAllowed(raw)) {
          if (wantedSource === 'user_explicit') {
            warnings.push(`验收项 ${clip(explicitId, 80)} 标记 source=user_explicit 但没有真实用户确认（confirmation_call_id），已降级为 agent_proposed`);
          }
          if (wantsProtected) {
            throw new PraxisError('confirmation-required', `验收项 ${clip(explicitId, 80)} 标记 protected=true 必须提供 confirmation_call_id`, {
              hint: '受保护项的建立需要用户确认：先 ask_user_question（timed）让用户确认，再带 confirmation_call_id 提交',
            });
          }
        }
        // 受保护项建立时也做真实核对：确认存在、同会话、未消费、问题覆盖该验收文本。
        if (wantsProtected && userExplicitAllowed(raw) && ctx && state) {
          const record = requireProtectedConfirmation(ctx, state, explicitId, {
            before: { text: null, source: null, kind: null, active: true },
            after: { text, source: wantedSource, kind: oneOf(raw.kind ?? 'automated', ['automated', 'manual'], 'kind'), active: raw.active !== false, protected: true },
            change: 'protect',
            callId: raw.confirmation_call_id ?? null,
          });
          newConfirmations.push({ criterionId: explicitId, callId: record.callId, change: 'protect', at: new Date().toISOString() });
        }
        result.push({
          id: clip(explicitId, 80),
          text,
          source: wantedSource === 'user_explicit' && !userExplicitAllowed(raw) ? 'agent_proposed' : wantedSource,
          kind: oneOf(raw.kind ?? 'automated', ['automated', 'manual'], 'kind'),
          active: raw.active !== false,
          ...(wantsProtected && userExplicitAllowed(raw) ? { protected: true } : {}),
        });
        continue;
      }
      // 修订已存在项：受保护项的任何改动（文本/来源/类型/停用/重新启用/身份）都要授权。
      const wantsProtected = raw.protected === true || target.protected === true;
      const modifiesProtected = target.protected === true;
      const changesSomething =
        (text !== null && text !== target.text) ||
        (raw.source !== undefined && raw.source !== target.source) ||
        (raw.kind !== undefined && raw.kind !== target.kind) ||
        (raw.active !== undefined && (raw.active !== false) !== target.active);
      if (modifiesProtected && changesSomething) {
        const nextActive = raw.active === undefined ? target.active : raw.active !== false;
        requireProtectedConfirmation(ctx, state, explicitId, {
          before: { text: target.text, source: target.source, kind: target.kind, active: target.active },
          after: {
            text: text ?? target.text,
            source: raw.source ?? target.source,
            kind: raw.kind ?? target.kind,
            active: nextActive,
          },
          change: nextActive === false ? 'deactivate' : 'modify',
          callId: raw.confirmation_call_id ?? null,
        });
      }
      // 非 protected 项升级为 protected 也算建立保护，需要授权。
      if (target.protected !== true && raw.protected === true) {
        requireProtectedConfirmation(ctx, state, explicitId, {
          before: { text: target.text, source: target.source, kind: target.kind, active: target.active },
          after: { text: text ?? target.text, source: raw.source ?? target.source, kind: raw.kind ?? target.kind, active: target.active, protected: true },
          change: 'protect',
          callId: raw.confirmation_call_id ?? null,
        });
      }
      // 未授权的 user_explicit 自报对非受保护项只降级，不阻断（保持 v1.0.1 之外的旧行为宽松）。
      if (raw.source === 'user_explicit' && !userExplicitAllowed(raw) && target.source !== 'user_explicit') {
        warnings.push(`验收项 ${explicitId} 自报 source=user_explicit 未绑定用户确认，保持 ${target.source}`);
      }
      if (text !== null) target.text = text;
      if (raw.source !== undefined) {
        const allowedExplicit = userExplicitAllowed(raw) || target.source === 'user_explicit';
        target.source = oneOf(
          allowedExplicit ? raw.source : (raw.source === 'user_explicit' ? 'agent_proposed' : raw.source),
          ['user_explicit', 'agent_proposed'],
          'source',
        );
      }
      if (raw.kind !== undefined) target.kind = oneOf(raw.kind, ['automated', 'manual'], 'kind');
      if (raw.active !== undefined) target.active = raw.active !== false;
      if (raw.protected === true && userExplicitAllowed(raw)) target.protected = true;
      continue;
    }
    if (!text) {
      throw new PraxisError('missing-field', 'acceptance 项缺少 text', {
        hint: '每项至少提供 text；已存在的项请带 id',
      });
    }
    const nextNumber = result.length + 1;
    let newId = `criterion-${nextNumber}`;
    while (result.some((item) => item.id === newId)) newId = `${newId}x`;
    const wantedSource = oneOf(raw.source ?? 'agent_proposed', ['user_explicit', 'agent_proposed'], 'source');
    const wantsProtected = raw.protected === true;
    if ((wantedSource === 'user_explicit' || wantsProtected) && !userExplicitAllowed(raw)) {
      if (wantedSource === 'user_explicit') {
        warnings.push(`新验收项 ${newId} 标记 source=user_explicit 但没有真实用户确认（confirmation_call_id），已降级为 agent_proposed`);
      }
      if (wantsProtected) {
        throw new PraxisError('confirmation-required', `新验收项 ${newId} 标记 protected=true 必须提供 confirmation_call_id`, {
          hint: '受保护项的建立需要用户确认：先 ask_user_question（timed）让用户确认，再带 confirmation_call_id 提交',
        });
      }
    }
    if (wantsProtected && userExplicitAllowed(raw) && ctx && state) {
      const record = requireProtectedConfirmation(ctx, state, newId, {
        before: { text: null, source: null, kind: null, active: true },
        after: { text, source: wantedSource, kind: oneOf(raw.kind ?? 'automated', ['automated', 'manual'], 'kind'), active: raw.active !== false, protected: true },
        change: 'protect',
        callId: raw.confirmation_call_id ?? null,
      });
      newConfirmations.push({ criterionId: newId, callId: record.callId, change: 'protect', at: new Date().toISOString() });
    }
    result.push({
      id: newId,
      text,
      source: wantedSource === 'user_explicit' && !userExplicitAllowed(raw) ? 'agent_proposed' : wantedSource,
      kind: oneOf(raw.kind ?? 'automated', ['automated', 'manual'], 'kind'),
      active: raw.active !== false,
      ...(wantsProtected && userExplicitAllowed(raw) ? { protected: true } : {}),
    });
  }
  return { items: result, confirmations: newConfirmations, warnings };
}

function acceptanceChanges(before, after) {
  const changes = [];
  const byId = new Map(before.map((item) => [item.id, item]));
  for (const item of after) {
    const old = byId.get(item.id);
    if (!old) {
      changes.push({ kind: 'added', id: item.id, text: item.text });
      continue;
    }
    if (old.text !== item.text) changes.push({ kind: 'text_changed', id: item.id, from: old.text, to: item.text });
    if (old.source !== item.source) changes.push({ kind: 'source_changed', id: item.id, from: old.source, to: item.source });
    if (old.kind !== item.kind) changes.push({ kind: 'kind_changed', id: item.id, from: old.kind, to: item.kind });
    if (old.active !== item.active) changes.push({ kind: item.active ? 'reactivated' : 'deactivated', id: item.id });
  }
  const afterIds = new Set(after.map((item) => item.id));
  for (const item of before) {
    if (!afterIds.has(item.id)) changes.push({ kind: 'removed', id: item.id, text: item.text });
  }
  return changes;
}

function invalidate(task, at, reason) {
  let invalidated = 0;
  for (const verification of task.verificationHistory) {
    if (verification.valid && verification.revision < task.revision) {
      verification.valid = false;
      invalidated += 1;
    }
  }
  if (invalidated > 0) pushEvent(task, 'invalidate', `${reason}；${invalidated} 条旧验证失效`, at);
  return invalidated;
}

function pickObservations(state, ctx, task, ids) {
  const picked = [];
  for (const observationId of ids) {
    const observation = state.observations.find((item) => item.id === observationId);
    if (!observation) {
      throw new PraxisError('observation-not-found', `观察 ${observationId} 不存在`, {
        hint: '只接受宿主 tools/result 生成、且仍保留在状态文件中的观察 ID',
      });
    }
    if (observation.sessionId !== ctx.sessionId) {
      throw new PraxisError('observation-not-found', `观察 ${observationId} 不属于当前会话`, {
        hint: '跨会话观察不能用于本任务验证',
      });
    }
    if (observation.taskId !== task.id) {
      throw new PraxisError('ambiguous-owner', `观察 ${observationId} 未绑定到任务 ${task.id}`, {
        hint: '只有捕获时唯一确定归属的观察才能作为验证证据；模糊归属只允许只读诊断',
      });
    }
    if (!picked.some((item) => item.id === observation.id)) picked.push(observation);
  }
  return picked;
}

/**
 * 实现变更计数：只有「确认写入实现」才会递增，台账动作（need/inventory/step）
 * 不动它。revision 记的是台账修订轮次，不能用来判断实现是否变过。
 */
function implRevisionOf(task) {
  return Number.isFinite(task?.implRevision) ? task.implRevision : 0;
}

function observationRejection(observation, task = null) {
  if (observation.outcome !== 'success') return '工具执行失败';
  if (!EVIDENCE_KINDS.has(observation.kind)) {
    return `工具类型 ${observation.kind} 只能作过程证据，不能作为验收证明`;
  }
  if (!observation.resultSummary) return '缺少可复核的结果摘要';
  // isError:false 只说明宿主没抛错；非零退出码仍可能来自被管道吞掉失败的
  // 命令，不能算一次通过的检查。
  if (Number.isFinite(observation.exitCode) && observation.exitCode !== 0) {
    return `退出码 ${observation.exitCode}，非零退出码不能作为通过证据`;
  }
  // 这条观察可能夹带了实现修改（命令里混了写操作，或无法确认是否写入）。它
  // 同时会进待复核队列，若还允许它充当通过证据，一条命令就能既给自己背书又
  // 解除自己的嫌疑，close(done) 的硬门槛被绕过。宁可要求重跑一条判定为只读
  // 的检查命令。
  if (observation.changeImpact === 'possible') {
    return '这条观察可能包含实现写入，不能作为当前实现的通过证据';
  }
  // 每次确认写入实现都会让 implRevision 递增。变更之前跑出来的绿色结果只证明
  // 旧实现，拿来给当前实现背书等于让旧证据无限复用，结项门槛就形同虚设。
  if (task) {
    const captured = Number.isFinite(observation.implRevisionAtCapture)
      ? observation.implRevisionAtCapture
      : 0;
    if (captured !== implRevisionOf(task)) {
      return `采集于实现第 ${captured} 版，当前第 ${implRevisionOf(task)} 版：变更前的观察不能作为当前实现的通过证据`;
    }
  }
  return null;
}

function coverageRows(task, coverage) {
  if (!Array.isArray(coverage) || coverage.length === 0) {
    throw new PraxisError('missing-field', 'coverage 不能为空', {
      hint: '每项验收目标都要给出 result；passed 需要引用通过检查的观察 ID',
    });
  }
  const active = new Map(task.acceptance.filter((item) => item.active).map((item) => [item.id, item]));
  return coverage.map((raw) => {
    const criterionId = typeof raw?.criterionId === 'string' ? raw.criterionId : '';
    if (!active.has(criterionId)) {
      throw new PraxisError('acceptance-uncovered', `验收项 ${criterionId || '(空)'} 不存在或已停用`, {
        hint: 'coverage 必须指向当前活跃的验收项',
      });
    }
    const result = oneOf(raw.result, LEVELS, 'coverage.result');
    const observationIds = Array.isArray(raw.observationIds) ? raw.observationIds.map(String) : [];
    return {
      criterionId,
      result,
      observationIds,
      note: optionalString(raw, 'note', LIMITS.note),
    };
  });
}

function verifiedAcceptanceIds(task) {
  const history = Array.isArray(task.verificationHistory) ? task.verificationHistory : [];
  const current = history.filter(
    (item) => item.valid && item.revision === task.revision,
  );
  const passed = new Map();
  for (const verification of current) {
    for (const row of verification.coverage ?? []) {
      if (row.result === 'passed' && row.observationIds.length > 0) {
        passed.set(row.criterionId, verification);
      }
    }
  }
  return passed;
}

/**
 * 距离 close(done) 还差什么。
 *
 * `implementationStatus` 可覆盖任务当前记录：生命周期提醒用 'complete' 预演「如果按
 * complete 结项」是否只差这些项；close 本身在提交实施状态之后再用任务上的值检查。
 * 返回的 codes 与 blockers 一一对应，供提醒去重使用稳定类别，不携带会变化的证据摘要。
 */
export function readinessOf(task, implementationStatus = task.implementationStatus) {
  const blockers = [];
  const codes = [];
  const add = (code, text) => {
    blockers.push(text);
    codes.push(code);
  };
  const acceptance = Array.isArray(task.acceptance) ? task.acceptance : [];
  const history = Array.isArray(task.verificationHistory) ? task.verificationHistory : [];
  const pendingChangeIds = Array.isArray(task.pendingChangeIds) ? task.pendingChangeIds : [];
  if (task.phase !== 'verify') add('phase', `任务处于 ${task.phase ?? 'understand'}，未进入 verify`);
  if (implementationStatus !== 'complete') {
    add('implementation', `implementationStatus=${implementationStatus}，done 需要 complete`);
  }
  const active = acceptance.filter((item) => item.active);
  if (active.length === 0) add('no-acceptance', '没有活跃验收项');
  const manual = active.filter((item) => item.kind === 'manual');
  if (manual.length > 0) {
    add('manual', `存在人工验收项，无法由模型自述完成：${manual.map((item) => item.id).join(', ')}`);
  }
  if (pendingChangeIds.length > 0) {
    add('pending', `存在未解除的可能写入：${pendingChangeIds.join(', ')}`);
  }
  const passed = verifiedAcceptanceIds(task);
  const uncovered = active.filter((item) => !passed.has(item.id)).map((item) => item.id);
  if (uncovered.length > 0) add('uncovered', `未由当前 revision 复验覆盖：${uncovered.join(', ')}`);
  const stale = history.filter(
    (item) => item.valid && item.revision !== task.revision,
  );
  if (stale.length > 0) add('stale', `存在 revision 不匹配的验证：${stale.length} 条`);
  // M1 criterion-2：受保护项被停用/替换但没有授权记录时，close(done) 必须拒绝。
  // 授权记录只在修改发生时当场核对（requireProtectedConfirmation 已消费确认），
  // 这里核对的是"结果状态"：受保护项停用但 confirmationHistory 里没有对应授权。
  const confirmHistory = Array.isArray(task.confirmationHistory) ? task.confirmationHistory : [];
  const deactivatedProtected = acceptance.filter(
    (item) => item.protected === true && item.active === false,
  );
  for (const item of deactivatedProtected) {
    const authorized = confirmHistory.some(
      (entry) =>
        entry &&
        entry.criterionId === item.id &&
        (entry.change === 'deactivate' || entry.change === 'replace' || entry.change === 'delete'),
    );
    if (!authorized) {
      add(
        'protected-deactivated',
        `受保护验收项 ${item.id} 被停用但没有用户授权记录；不能通过停用受保护项绕过 done`,
      );
    }
  }
  return { blockers, codes, uncovered, manual: manual.map((item) => item.id) };
}

function digestArgs(args) {
  const clone = {};
  for (const key of Object.keys(args).sort()) {
    if (key === 'request_id') continue;
    clone[key] = args[key];
  }
  return createHash('sha256').update(JSON.stringify(clone)).digest('hex');
}

function requestKey(ctx, action, requestId) {
  return [
    ctx.sessionId ?? 'no-session',
    ctx.projectKey ?? 'no-project',
    action,
    requestId,
  ].join('|');
}

function replay(state, ctx, action, args) {
  const requestId = args.request_id;
  if (typeof requestId !== 'string' || requestId.trim() === '') return null;
  const key = requestKey(ctx, action, requestId.trim());
  const record = state.requests.find((item) => item.key === key);
  if (!record) return null;
  const digest = digestArgs(args);
  if (record.payloadDigest !== digest) {
    throw new PraxisError('idempotency-conflict', '同一 request_id 携带了不同参数', {
      hint: '换一个 request_id，或原样重试同一组参数',
    });
  }
  const snapshot = record.resultRef ? JSON.parse(record.resultRef) : { replay_of: record.ref };
  // 重放必须返回与首次相同的响应形状，调用方才能无差别解析。
  return { ok: true, code: 'ok', data: { ...snapshot, replayed: true }, replayed: true };
}

function remember(state, ctx, action, args, response) {
  const requestId = args.request_id;
  if (typeof requestId !== 'string' || requestId.trim() === '') return;
  const key = requestKey(ctx, action, requestId.trim());
  state.requests.push({
    key,
    payloadDigest: digestArgs(args),
    resultRef: clip(JSON.stringify(response.data ?? {}), 8000),
    ref: response.data?.task_id ?? response.data?.lesson_id ?? null,
    at: nowIso(),
  });
  while (state.requests.length > MAX_REQUESTS) state.requests.shift();
}

function acceptanceView(task) {
  const passed = verifiedAcceptanceIds(task);
  // 注意：不能输出 undefined 值属性（如 protected: undefined）。JSON.stringify
  // 会静默丢键，但宿主 ToolRuntime 的 lossless JSON 校验检查 JS 对象本身，
  // 遇到 undefined 值直接判 INVALID_TOOL_OUTPUT。条件键必须用条件展开。
  return task.acceptance.map((item) => ({
    id: item.id,
    text: item.text,
    source: item.source,
    kind: item.kind,
    active: item.active,
    ...(item.protected === true ? { protected: true } : {}),
    covered: item.active ? passed.has(item.id) : null,
  }));
}

function verificationState(verification, task) {
  if (!verification.valid) return 'invalidated';
  if (verification.revision !== task.revision) return 'stale';
  return 'current';
}

function applyConfirmedWrite(task, observation) {
  task.revision += 1;
  const at = observation.at;
  invalidate(task, at, `观察到已确认实现写入 ${observation.id}`);
  touch(task, at);
}

function applyPossibleWrite(task, observation) {
  if (!task.pendingChangeIds.includes(observation.id)) task.pendingChangeIds.push(observation.id);
  task.reviewStatus = 'unverified';
  pushEvent(task, 'invalidate', `观察到可能写入 ${observation.id}，等待复验`, observation.at);
  touch(task, observation.at);
}

export function createEngine(store) {
  async function write(fn) {
    let response;
    await store.mutate((state) => {
      response = fn(state);
    });
    return response;
  }

  async function read(fn) {
    const state = await store.load();
    return fn(state);
  }

  // ---------- 任务动作 ----------

  function start(ctx, state, args) {
    const goal = requiredString(args, 'goal', LIMITS.goal);
    if (state.tasks.length >= MAX_TASKS) {
      const reclaimable = state.tasks.filter(
        (task) => task.status === 'closed' && task.lessons.length === 0,
      ).length;
      throw new PraxisError('capacity', '任务数量达到上限', {
        hint: reclaimable > 0 ? '存在可回收的已关闭任务；当前版本不自动删除，请清理状态文件后重试' : '请先清理已关闭任务',
      });
    }
    const parentTaskId = optionalString(args, 'parentTaskId', 80);
    if (parentTaskId) {
      const parent = findTask(state, parentTaskId);
      if (parent.status === 'closed') {
        throw new PraxisError('task-closed', `父任务 ${parent.id} 已关闭`, {
          hint: '父任务关闭后不可再作为父任务；请直接创建独立任务',
        });
      }
    }
    const acceptanceResult = args.acceptance === undefined
      ? { items: [], confirmations: [], warnings: [] }
      : normalizeAcceptance(optionalArray(args, 'acceptance') ?? [], [], [], ctx, state);
    const acceptance = acceptanceResult.items;
    const at = nowIso();
    const task = {
      id: id(),
      goal,
      projectKey: optionalString(args, 'projectKey', LIMITS.projectKey) ?? ctx.projectKey ?? null,
      sessionId: ctx.sessionId ?? null,
      parentTaskId: parentTaskId ?? null,
      phase: 'understand',
      status: 'open',
      revision: 0,
      implementationStatus: 'unknown',
      reviewStatus: 'unverified',
      acceptance,
      confirmationHistory: acceptanceResult.confirmations.map((entry) => ({ ...entry })),
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
    };
    pushEvent(task, 'start', clip(goal, 200), at);
    state.tasks.push(task);
    // start 用 acceptanceResult.confirmations 写 confirmationHistory；
    // 清空 ctx 临时通道，避免同一 ctx 后续调用把 protect 授权重复写入。
    if (Array.isArray(ctx.__consumedConfirmations)) ctx.__consumedConfirmations.length = 0;
    const warnings = [];
    if (acceptance.length === 0) {
      warnings.push('尚未登记验收项；没有活跃验收项时不能 close(done)');
    }
    return ok({ task_id: task.id, task: summarizeTask(task), acceptance: acceptanceView(task) }, [
      ...acceptanceResult.warnings,
      ...warnings,
    ]);
  }

  function need(ctx, state, args) {
    const task = ensureOpen(findTask(state, requiredString(args, 'task_id', 80)));
    if (task.phase === 'verify') {
      throw new PraxisError('invalid-state', 'verify 阶段不能更新调查判断', {
        hint: '先用 step 回退到 implement 或 understand，再更新 need',
      });
    }
    const target = requiredString(args, 'target', LIMITS.target);
    const decision = oneOf(requiredString(args, 'decision', 20), DECISIONS, 'decision');
    const evidence = requiredString(args, 'evidence', LIMITS.evidence);
    const strength = evidenceStrength(evidence);
    if (strength === 'none') {
      throw new PraxisError('weak-evidence', '调查依据为空', { hint: '给出文件:行号、执行的命令与关键输出' });
    }
    const observationIds = optionalArray(args, 'observationIds') ?? [];
    pickObservations(state, ctx, task, observationIds);
    const plan = optionalString(args, 'plan', LIMITS.plan);
    const at = nowIso();
    const row = {
      target,
      decision,
      evidence,
      evidenceStrength: strength,
      observationIds,
      plan,
      at,
    };
    const existing = task.needs.find((item) => item.target === target);
    const warnings = [];
    if (strength === 'weak') {
      warnings.push(`调查依据缺少可核对结果：${evidenceGaps(evidence).join('；')}`);
    }
    if (existing) {
      existing.revisions = existing.revisions ?? [];
      existing.revisions.push({
        at: existing.at,
        decision: existing.decision,
        evidence: existing.evidence,
        plan: existing.plan,
      });
      Object.assign(existing, row);
      warnings.push(`目标 ${target} 的调查判断已更新，旧判断保留在 revisions 中`);
    } else {
      task.needs.push(row);
    }
    if (task.phase === 'implement') {
      task.revision += 1;
      invalidate(task, at, '调查判断有实质修改');
    }
    pushEvent(task, 'need', `${decision} ${target}（${strength}）`, at);
    touch(task, at);
    return ok(
      { task_id: task.id, need: row, revision: task.revision, needs: task.needs },
      warnings,
    );
  }

  function inventory(ctx, state, args) {
    const task = ensureOpen(findTask(state, requiredString(args, 'task_id', 80)));
    const rawNeeds = optionalArray(args, 'needs');
    const rawAcceptance = optionalArray(args, 'acceptance');
    // acceptance: [] 是显式的"删除全部验收项"，也是合法变更（受保护项删除仍需授权）。
    if (rawNeeds === undefined && rawAcceptance === undefined) {
      throw new PraxisError('missing-field', 'inventory 至少需要 needs 或 acceptance 之一', {
        hint: '批量补充调查结论或验收项',
      });
    }
    const changeReason = optionalString(args, 'change_reason', LIMITS.reason);
    const at = nowIso();
    const warnings = [];
    if (rawAcceptance && task.phase === 'verify') {
      throw new PraxisError('invalid-state', 'verify 阶段不能直接修改验收项', {
        hint: '先用 step 回退到 implement/understand；修改会登记理由并使旧验证失效',
      });
    }
    if (rawNeeds && task.phase === 'verify') {
      throw new PraxisError('invalid-state', 'verify 阶段不能修改调查判断', {
        hint: '先 step 回退，再更新 needs',
      });
    }
    let changed = false;
    if (rawNeeds) {
      for (const raw of rawNeeds) {
        const target = requiredString(raw ?? {}, 'target', LIMITS.target);
        const decision = oneOf(requiredString(raw, 'decision', 20), DECISIONS, 'decision');
        const evidence = requiredString(raw, 'evidence', LIMITS.evidence);
        const strength = evidenceStrength(evidence);
        if (strength === 'none') {
          throw new PraxisError('weak-evidence', `目标 ${target} 的调查依据为空`);
        }
        if (strength === 'weak') warnings.push(`目标 ${target} 只有格式弱证据`);
        const observationIds = Array.isArray(raw.observationIds) ? raw.observationIds.map(String) : [];
        if (observationIds.length > 0) pickObservations(state, ctx, task, observationIds);
        const row = {
          target,
          decision,
          evidence,
          evidenceStrength: strength,
          observationIds,
          plan: optionalString(raw, 'plan', LIMITS.plan),
          at,
        };
        const existing = task.needs.find((item) => item.target === target);
        if (existing) {
          existing.revisions = existing.revisions ?? [];
          existing.revisions.push({
            at: existing.at,
            decision: existing.decision,
            evidence: existing.evidence,
            plan: existing.plan,
          });
          Object.assign(existing, row);
        } else {
          task.needs.push(row);
        }
        changed = true;
      }
    }
    if (rawAcceptance) {
      const before = task.acceptance;
      const afterResult = normalizeAcceptance(rawAcceptance, before, warnings, ctx, state);
      const after = afterResult.items;
      const changes = acceptanceChanges(before, after);
      if (changes.length > 0) {
        if (!changeReason) {
          throw new PraxisError('missing-field', '修改验收项必须提供 change_reason', {
            hint: '说明为何新增、停用或调整验收项；不能通过删除未通过项绕过 close(done)',
          });
        }
        task.acceptance = after;
        changed = true;
        pushEvent(task, 'advance', `验收项变更：${clip(JSON.stringify(changes), 240)}`, at);
      }
    }
    // M1：受保护项修改已当场核销用户确认，把授权记录写进任务审计历史（criterion-3）。
    if (Array.isArray(ctx.__consumedConfirmations) && ctx.__consumedConfirmations.length > 0) {
      task.confirmationHistory = Array.isArray(task.confirmationHistory) ? task.confirmationHistory : [];
      for (const entry of ctx.__consumedConfirmations) {
        task.confirmationHistory.push(entry);
        pushEvent(task, 'advance', `受保护验收项 ${entry.criterionId} 变更已获用户授权（${entry.callId}，${entry.change}）`, at);
      }
      ctx.__consumedConfirmations.length = 0;
      changed = true;
    }
    if (changed && task.phase === 'implement') {
      task.revision += 1;
      invalidate(task, at, '验收项或调查判断有实质修改');
    }
    if (changeReason) pushEvent(task, 'advance', `inventory：${changeReason}`, at);
    touch(task, at);
    return ok(
      {
        task_id: task.id,
        needs: task.needs,
        acceptance: acceptanceView(task),
        revision: task.revision,
      },
      warnings,
    );
  }

  function step(ctx, state, args) {
    const task = ensureOpen(findTask(state, requiredString(args, 'task_id', 80)));
    const phase = oneOf(requiredString(args, 'phase', 20), PHASES, 'phase');
    const note = optionalString(args, 'note', LIMITS.note);
    const at = nowIso();
    const warnings = [];
    if (task.phase === phase) {
      return ok({ task: summarizeTask(task), acceptance: acceptanceView(task) }, ['already in phase']);
    }
    const forward = PHASES.indexOf(phase) > PHASES.indexOf(task.phase);
    const allowed = {
      understand: ['implement', 'verify'],
      implement: ['verify', 'understand'],
      verify: ['implement', 'understand'],
    };
    if (!allowed[task.phase].includes(phase)) {
      throw new PraxisError('invalid-state', `不允许从 ${task.phase} 转到 ${phase}`, {
        hint: `当前仅允许：${allowed[task.phase].join(' | ')}`,
      });
    }
    if (phase === 'implement' && task.phase === 'understand') {
      const concrete = task.needs.some((item) => item.evidenceStrength === 'concrete');
      if (!concrete) {
        throw new PraxisError('gate', '进入实现前缺少具体调查依据', {
          hint: '至少一条 need 需要给出文件:行号、命令与关键输出等可核对依据；弱证据不能通过',
        });
      }
      task.revision += 1;
      invalidate(task, at, '进入实现阶段');
    }
    if (phase === 'verify' && task.phase === 'understand') {
      if (task.acceptance.filter((item) => item.active).length === 0) {
        throw new PraxisError('gate', '没有活跃验收项，不能进入验证', {
          hint: '用 inventory 登记可判定的验收项',
        });
      }
      if (!note) {
        throw new PraxisError('missing-field', '从 understand 直接进入 verify 需要说明为何无需实现', {
          hint: '在 note 中写明跳过实现的原因，并确保验收项可判定',
        });
      }
      warnings.push('跳过实现阶段；请确认该任务确实无需代码改动');
    }
    if (phase === 'verify' && task.phase === 'implement') {
      if (task.acceptance.filter((item) => item.active).length === 0) {
        throw new PraxisError('gate', '没有活跃验收项，不能进入验证', {
          hint: '用 inventory 登记可判定的验收项',
        });
      }
    }
    if (!forward) {
      if (!note) {
        throw new PraxisError('missing-field', '回退阶段必须说明理由（note）', {
          hint: '记录回退原因，便于自校正与审计',
        });
      }
      task.corrections.push({ at, from: task.phase, to: phase, reason: note });
      task.revision += 1;
      invalidate(task, at, `回退到 ${phase}：${note}`);
      if (task.corrections.length >= REPEAT_REWIND_AT) {
        warnings.push(`本任务已回退 ${task.corrections.length} 次；请检查是否存在需求理解不足或验证范围错误`);
      }
    }
    task.phase = phase;
    pushEvent(task, forward ? 'advance' : 'rewind', `${task.phase}${note ? `：${note}` : ''}`, at);
    touch(task, at);
    return ok({ task: summarizeTask(task), acceptance: acceptanceView(task) }, warnings);
  }

  function verify(ctx, state, args) {
    const task = ensureOpen(findTask(state, requiredString(args, 'task_id', 80)));
    const level = oneOf(requiredString(args, 'level', 20), LEVELS, 'level');
    const scope = requiredString(args, 'scope', LIMITS.scope);
    if (task.phase === 'understand') {
      throw new PraxisError('invalid-state', 'understand 阶段不能执行验证', {
        hint: '先 step 到 implement；或对无需实现的任务 step 到 verify',
      });
    }
    const coverage = coverageRows(task, args.coverage);
    const at = nowIso();
    const warnings = [];

    if (level === 'passed' && coverage.some((row) => row.result !== 'passed')) {
      throw new PraxisError('invalid-state', 'level=passed 与覆盖结果矛盾', {
        hint: '任一验收项不是 passed 时，level 只能是 partial 或 blocked',
      });
    }
    if (level === 'passed' && !coverage.every((row) => row.observationIds.length > 0)) {
      throw new PraxisError('unverified', 'passed 验证的每一项都必须引用可信观察', {
        hint: '先运行可观察的检查（测试/构建/lint），再用 status 取得候选观察 ID',
      });
    }
    if (level === 'not_run' && !optionalString(args, 'note', LIMITS.note)) {
      throw new PraxisError('missing-field', 'not_run 需要说明为什么没有运行', { hint: '在 note 中写明原因' });
    }

    const allObservations = [];
    const perRow = [];
    for (const row of coverage) {
      const observations = pickObservations(state, ctx, task, row.observationIds);
      if (row.result === 'passed') {
        if (observations.length === 0) {
          throw new PraxisError('unverified', `验收项 ${row.criterionId} 缺少观察证据`);
        }
        const rejected = observations.map((item) => ({ item, reason: observationRejection(item, task) }));
        const usable = rejected.filter((entry) => entry.reason === null);
        if (usable.length === 0) {
          const stale = observations.every((item) => {
            const captured = Number.isFinite(item.implRevisionAtCapture)
              ? item.implRevisionAtCapture
              : 0;
            return captured !== implRevisionOf(task);
          });
          throw stale
            ? new PraxisError(
                'stale-verification',
                `验收项 ${row.criterionId} 引用的观察都采集于 revision 变更之前，不能证明当前实现`,
                {
                  hint: '实现变更后要重新跑一次检查，用新采集的观察作为证据',
                  changed: false,
                },
              )
            : new PraxisError('unverified', `验收项 ${row.criterionId} 的观察不能证明检查通过`, {
                hint: rejected.map((entry) => `${entry.item.id}: ${entry.reason}`).join('；'),
              });
        }
      }
      for (const item of observations) {
        if (!allObservations.some((entry) => entry.id === item.id)) allObservations.push(item);
      }
      perRow.push(row);
    }

    const evidence = optionalString(args, 'evidence', LIMITS.evidence);
    const strength = evidence ? evidenceStrength(evidence) : 'none';
    if (strength === 'weak') warnings.push(`验证说明只有格式弱证据：${evidenceGaps(evidence).join('；')}`);
    const provenance = allObservations.length > 0 ? 'observed' : 'self_reported';
    if (provenance === 'self_reported') {
      warnings.push('本次验证没有引用宿主观察；它不能独立支持 close(done)');
    }

    const revision = task.revision;
    const verification = {
      id: id(),
      level,
      scope,
      coverage: perRow,
      evidence: evidence ?? '',
      evidenceStrength: strength,
      provenance,
      observationIds: allObservations.map((item) => item.id),
      revision,
      // 审计用：这条验证是在第几版实现上取得的。观察复用按这个版本号判定，
      // revision 记的是台账修订轮次，两者不同。
      implRevision: implRevisionOf(task),
      valid: true,
      note: optionalString(args, 'note', LIMITS.note),
      at,
    };
    task.verificationHistory.push(verification);
    if (task.phase === 'implement') {
      task.phase = 'verify';
      pushEvent(task, 'advance', '验证成功后进入 verify', at);
    }
    pushEvent(task, 'verify', `${level}（${provenance}）`, at);

    // 解除路径（design §3.3.3）：通过验证会重新确立实现的可信度，因此发生在
    // 这次验证之前的 possible 写入视为已被覆盖。只在整个任务全部活跃验收项
    // 都被本次验证覆盖时才解除，避免用局部验证洗掉可疑写入。
    if (level === 'passed' && task.pendingChangeIds.length > 0) {
      const activeItems = task.acceptance.filter((item) => item.active);
      // 人工验收项只能由人确认，任何观察都覆盖不到它。若把它算进「必须全部
      // 覆盖」，带人工验收项的任务就永远解不除待复核写入——自动证据与人工
      // 判断互相拖死。这里只看能被观察覆盖的项；全是人工项时不解解除。
      const coverableItems = activeItems.filter((item) => item.kind !== 'manual');
      const fullyCovered =
        coverableItems.length > 0 &&
        coverableItems.every((item) =>
          perRow.some(
            (row) => row.criterionId === item.id && row.result === 'passed' && row.observationIds.length > 0,
          ),
        );
      // 先后顺序按观察序号判定，不按时间戳：观察序号由状态单调递增分配，而
      // 系统时钟会回拨，回拨之后「新观察的 at 更早」会让验证之后的写入看起来
      // 发生在验证之前，于是被错误解除，结项门槛就被绕过去了。
      const verificationSequence = Math.max(
        ...allObservations.map((item) => (Number.isFinite(item.sequence) ? item.sequence : -1)),
      );
      if (fullyCovered && Number.isFinite(verificationSequence) && verificationSequence >= 0) {
        const cleared = [];
        task.pendingChangeIds = task.pendingChangeIds.filter((changeId) => {
          const change = state.observations.find((item) => item?.id === changeId);
          if (!change) return true;
          // 解除只看先后，不看这条写入采集于哪一版实现：能执行到这里说明本次
          // 验证引用的观察都属于当前实现版本（旧版本的观察在 observationRejection
          // 就被 stale-verification 拦下），所以验证确实发生在最后一次改动之后，
          // 此前所有可疑写入都已被它覆盖。反过来，验证之后又发生的写入序号更大，
          // 自然留在队列里等下一轮。若再拿 implRevision 卡一道「版本必须相同」，
          // 那些跨过几次改动仍留在队列里的旧嫌疑就永远等不到匹配的版本号，
          // close(done) 会被历史记录永久阻断。
          if (Number.isFinite(change.sequence)) {
            // 用「小于等于」：验证引用的那条观察本身也会进待复核队列（一条命令
            // 里同时跑测试和自定义脚本时必然如此），严格小于永远清不掉它，
            // close(done) 就被这次验证自己永久阻断。
            if (change.sequence <= verificationSequence) {
              cleared.push(changeId);
              return false;
            }
            return true;
          }
          // 没有序号的老观察只能退回时间戳比较。
          const changeTime = Date.parse(String(change.at ?? ''));
          const verificationTime = Math.min(
            ...allObservations
              .map((item) => Date.parse(String(item.at ?? '')))
              .filter((value) => Number.isFinite(value)),
          );
          if (Number.isFinite(changeTime) && Number.isFinite(verificationTime) && changeTime < verificationTime) {
            cleared.push(changeId);
            return false;
          }
          return true;
        });
        if (cleared.length > 0) {
          if (task.pendingChangeIds.length === 0) task.reviewStatus = 'verified';
          pushEvent(task, 'verify', `复验解除可能的写入：${cleared.join(', ')}`, at);
          warnings.push(`已由本次复验解除待复核写入：${cleared.join(', ')}`);
        }
      }
    }

    touch(task, at);

    const nextHint = level === 'passed'
      ? task.pendingChangeIds.length > 0
        ? `仍有 ${task.pendingChangeIds.length} 条待复核写入（${task.pendingChangeIds.join(', ')}）；再跑一次覆盖全部活跃验收项的通过验证即可解除`
        : '确认未覆盖验收项与待复核写入后，可尝试 close(done)'
      : '记录问题并考虑 step 回退修复；不要用 remove 验收项绕过门槛';
    return ok(
      {
        task_id: task.id,
        verification_id: verification.id,
        level,
        provenance,
        revision,
        coverage: perRow,
        acceptance: acceptanceView(task),
        next_hint: nextHint,
      },
      warnings,
    );
  }

  function close(ctx, state, args) {
    const task = ensureOpen(findTask(state, requiredString(args, 'task_id', 80)));
    const outcome = oneOf(requiredString(args, 'outcome', 20), OUTCOMES, 'outcome');
    const implementationStatus = oneOf(
      requiredString(args, 'implementationStatus', 30),
      IMPLEMENTATION_STATUS,
      'implementationStatus',
    );
    const closureReason = args.closureReason === undefined
      ? null
      : oneOf(args.closureReason, CLOSURE_REASONS, 'closureReason');
    const note = optionalString(args, 'note', LIMITS.note);
    const at = nowIso();
    const warnings = [];
    // 结项时提交的实施状态才是任务的最终状态；done 门槛检查的就是它。
    task.implementationStatus = implementationStatus;

    if (outcome === 'done') {
      const { blockers } = readinessOf(task);
      if (blockers.length > 0) {
        throw new PraxisError('gate', '不满足 close(done) 门槛', {
          hint: blockers.join('；'),
        });
      }
    } else {
      if (!closureReason) {
        throw new PraxisError('missing-field', `${outcome} 结项必须提供 closureReason`, {
          hint: `允许值：${CLOSURE_REASONS.join(' | ')}`,
        });
      }
      if (outcome === 'abandoned' && !note) {
        throw new PraxisError('missing-field', 'abandoned 需要说明终止原因（note）');
      }
      if (outcome === 'partial' && implementationStatus === 'complete' && closureReason !== 'awaiting_manual') {
        warnings.push('实施已完成但以 partial 结项，请确认 closureReason 准确描述了剩余事项');
      }
    }

    let lesson = null;
    const lessonInput = args.lesson;
    const lessonId = args.lesson_id;
    if (lessonInput !== undefined && lessonId !== undefined) {
      throw new PraxisError('bad-action', 'close 只能携带 lesson 或 lesson_id 之一', {
        hint: '新建经验用 lesson；关联已有经验用 lesson_id',
      });
    }
    if (lessonInput !== undefined) {
      lesson = saveLessonInState(ctx, state, { ...lessonInput, source_task: task.id }, { sourceSnapshot: snapshot(task) });
      task.lessons.push(lesson.lesson.id);
      warnings.push(...lesson.warnings);
    } else if (lessonId !== undefined) {
      const target = state.lessons.find((item) => item.id === lessonId);
      if (!target) throw new PraxisError('lesson-not-found', `找不到经验 ${lessonId}`);
      if (target.status !== 'active') {
        throw new PraxisError('invalid-state', `经验 ${lessonId} 当前状态为 ${target.status}`, {
          hint: '只有 active 经验可以关联到任务',
        });
      }
      if (target.scope === 'project' && target.projectKey !== task.projectKey) {
        throw new PraxisError('conflict', '项目经验与任务项目不一致', { hint: '跨项目经验不能关联到本任务' });
      }
      if (!task.lessons.includes(target.id)) task.lessons.push(target.id);
    }

    task.status = 'closed';
    task.closedAs = outcome;
    task.closureReason = closureReason;
    task.reviewStatus = outcome === 'done' ? 'verified' : 'unverified';
    if (note) task.closureNote = note;
    pushEvent(task, 'close', `${outcome}${closureReason ? ` / ${closureReason}` : ''}`, at);
    touch(task, at);

    const data = {
      task_id: task.id,
      outcome,
      implementationStatus,
      reviewStatus: task.reviewStatus,
      task: summarizeTask(task),
      acceptance: acceptanceView(task),
    };
    if (lesson) data.lesson = lesson.lesson;
    if (outcome !== 'done') {
      data.next_hint = outcome === 'partial'
        ? 'partial 表示仍有未完成或待人工确认事项；不能当作 done'
        : '任务已终止，后续需要重新开始时请创建新任务';
    }
    return ok(data, warnings);
  }

  function snapshot(task) {
    const lastVerification = task.verificationHistory[task.verificationHistory.length - 1] ?? null;
    return {
      task_id: task.id,
      goal: task.goal,
      projectKey: task.projectKey,
      phase: task.phase,
      implementationStatus: task.implementationStatus,
      lastVerification: lastVerification
        ? { level: lastVerification.level, revision: lastVerification.revision, at: lastVerification.at }
        : null,
      at: nowIso(),
    };
  }

  function status(ctx, state, args) {
    const taskId = optionalString(args, 'task_id', 80);
    const degraded = [];
    if (state.droppedObservations > 0) degraded.push(`已丢弃 ${state.droppedObservations} 条超出容量的观察`);
    if (state.observerErrors > 0) degraded.push(`观察采集失败 ${state.observerErrors} 次`);
    if (!taskId) {
      const open = state.tasks.filter((task) => task.status === 'open');
      return ok({
        tasks: open.map(summarizeTask),
        totalTasks: state.tasks.length,
        closedTasks: state.tasks.length - open.length,
        lessons: state.lessons.filter((item) => item.status === 'active').length,
        observations: state.observations.length,
        degraded,
      });
    }
    const task = findTask(state, taskId);
    const limit = Math.min(Math.max(Number(args.observation_limit) || 10, 1), 50);
    const cursor = Math.max(Number(args.observation_cursor) || 0, 0);
    const candidates = state.observations
      .filter((item) => item.sessionId === ctx.sessionId)
      .filter((item) => item.taskId === null || item.taskId === task.id)
      .sort((a, b) => b.sequence - a.sequence);
    const page = candidates.slice(cursor, cursor + limit).map((item) => {
      const reason = observationRejection(item, item.taskId === task.id ? task : null);
      return {
        id: item.id,
        sequence: item.sequence,
        tool: item.tool,
        kind: item.kind,
        callSummary: item.callSummary,
        outcome: item.outcome,
        taskId: item.taskId,
        at: item.at,
        changeImpact: item.changeImpact,
        usableForVerification: item.taskId === task.id && reason === null,
        rejectedReason: item.taskId === task.id ? reason : '捕获时未绑定到本任务（仅诊断）',
      };
    });
    const verificationViews = task.verificationHistory.map((item) => ({
      id: item.id,
      level: item.level,
      revision: item.revision,
      state: verificationState(item, task),
      provenance: item.provenance,
      at: item.at,
      coverage: item.coverage,
    }));
    const { blockers, codes, uncovered } = readinessOf(task);
    return ok({
      task: summarizeTask(task),
      acceptance: acceptanceView(task),
      uncovered,
      blockers,
      blockerCodes: codes,
      confirmationHistory: Array.isArray(task.confirmationHistory) ? task.confirmationHistory : [],
      needs: task.needs,
      corrections: task.corrections,
      pendingChangeIds: task.pendingChangeIds,
      verifications: verificationViews,
      observations: page,
      observationTotal: candidates.length,
      next_cursor: cursor + limit < candidates.length ? cursor + limit : null,
      degraded,
    });
  }

  // 跨任务只读概览。与 status 的分工：status 面向单个任务（详情、候选观察），
  // summary 面向「整体到哪了」——只聚合、不改状态、不产生观察。
  function summary(ctx, state, args) {
    const warnings = [];
    if (args?.task_id) {
      warnings.push('summary 只做跨任务聚合，task_id 已忽略；查看单个任务请用 status');
    }
    const degraded = [];
    if (state.droppedObservations > 0) degraded.push(`已丢弃 ${state.droppedObservations} 条超出容量的观察`);
    if (state.observerErrors > 0) degraded.push(`观察采集失败 ${state.observerErrors} 次`);

    const byPhase = Object.fromEntries(PHASES.map((phase) => [phase, 0]));
    const byImplementationStatus = Object.fromEntries(
      IMPLEMENTATION_STATUS.map((status) => [status, 0]),
    );
    const byOutcome = { open: 0 };
    for (const outcome of OUTCOMES) byOutcome[outcome] = 0;
    const projects = new Map();
    const openTasks = [];

    for (const task of state.tasks) {
      if (task.phase in byPhase) byPhase[task.phase] += 1;
      if (task.implementationStatus in byImplementationStatus) {
        byImplementationStatus[task.implementationStatus] += 1;
      }
      if (task.status === 'open') {
        byOutcome.open += 1;
        openTasks.push(task);
      } else if (task.closedAs in byOutcome) {
        byOutcome[task.closedAs] += 1;
      }
      const key = task.projectKey ?? null;
      const bucket = projects.get(key) ?? { projectKey: key, total: 0, open: 0, closed: 0 };
      bucket.total += 1;
      if (task.status === 'open') bucket.open += 1;
      else bucket.closed += 1;
      projects.set(key, bucket);
    }

    // 待复核写入最能打断收尾，先让它排前面；同档按最近更新时间。
    const recent = [...openTasks]
      .sort((a, b) => {
        const delta = b.pendingChangeIds.length - a.pendingChangeIds.length;
        if (delta !== 0) return delta;
        return String(b.updatedAt).localeCompare(String(a.updatedAt));
      })
      .slice(0, MAX_SUMMARY_TASKS);

    const open = recent.map((task) => {
      const { blockers, uncovered } = readinessOf(task);
      const active = task.acceptance.filter((item) => item.active);
      return {
        task_id: task.id,
        goal: task.goal,
        projectKey: task.projectKey,
        phase: task.phase,
        revision: task.revision,
        implementationStatus: task.implementationStatus,
        reviewStatus: task.reviewStatus,
        acceptance: {
          active: active.length,
          manual: active.filter((item) => item.kind === 'manual').length,
          covered: verifiedAcceptanceIds(task).size,
        },
        pendingChanges: task.pendingChangeIds.length,
        uncovered,
        blockers,
        updatedAt: task.updatedAt,
      };
    });

    const activeLessons = state.lessons.filter((item) => item.status === 'active');
    const tagCounts = new Map();
    for (const lesson of activeLessons) {
      for (const tag of lesson.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    const tags = [...tagCounts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 10);

    const observationOutcomes = new Map();
    let bound = 0;
    let rejected = 0;
    for (const observation of state.observations) {
      observationOutcomes.set(
        observation.outcome,
        (observationOutcomes.get(observation.outcome) ?? 0) + 1,
      );
      if (observation.taskId != null) bound += 1;
      if (observationRejection(observation) !== null) rejected += 1;
    }

    return ok({
      tasks: {
        total: state.tasks.length,
        open: openTasks.length,
        closed: state.tasks.length - openTasks.length,
        byPhase,
        byOutcome,
        byImplementationStatus,
        byProject: [...projects.values()].sort((a, b) => b.total - a.total),
      },
      open,
      openTruncated: openTasks.length > open.length,
      openRemaining: Math.max(openTasks.length - open.length, 0),
      lessons: {
        total: state.lessons.length,
        active: activeLessons.length,
        global: activeLessons.filter((item) => item.scope === 'global').length,
        project: activeLessons.filter((item) => item.scope === 'project').length,
        tags,
      },
      observations: {
        total: state.observations.length,
        bound,
        unbound: state.observations.length - bound,
        rejected,
        usable: state.observations.length - rejected,
        byOutcome: [...observationOutcomes.entries()].map(([outcome, count]) => ({
          outcome,
          count,
        })),
        dropped: state.droppedObservations ?? 0,
        errors: state.observerErrors ?? 0,
      },
      degraded,
    }, warnings);
  }

  // ---------- 经验动作 ----------

  function visibleLesson(ctx, state, args, lesson) {
    if (lesson.status !== 'active') return false;
    if (args.tag) {
      const tag = String(args.tag).trim().toLowerCase();
      if (!lesson.tags.some((item) => item.toLowerCase() === tag)) return false;
    }
    const scope = args.scope ?? null;
    if (scope === 'global') return lesson.scope === 'global';
    if (scope === 'project') {
      const projectKey = args.projectKey ?? ctx.projectKey;
      return lesson.scope === 'project' && lesson.projectKey === projectKey;
    }
    if (lesson.scope === 'global') return true;
    const projectKey = args.projectKey ?? ctx.projectKey;
    return lesson.scope === 'project' && lesson.projectKey === projectKey;
  }

  function search(ctx, state, args) {
    const query = requiredString(args, 'query', LIMITS.query);
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
    const hits = state.lessons
      .filter((lesson) => visibleLesson(ctx, state, args, lesson))
      .map((lesson) => ({
        lesson,
        score: relevance(query, `${lesson.trigger} ${lesson.lesson} ${lesson.tags.join(' ')}`),
      }))
      .sort((a, b) => b.score - a.score || b.lesson.updatedAt.localeCompare(a.lesson.updatedAt))
      .slice(0, limit)
      .map(({ lesson, score }) => ({
        ...summarizeLesson(lesson),
        score: Number(score.toFixed(3)),
        boundary: lesson.scope === 'global' ? '全局经验，需确认是否适用于当前项目' : `仅适用于 ${lesson.projectKey}`,
      }));
    return ok({
      lessons: hits,
      count: hits.length,
      note: '历史经验是调查线索，不是当前项目的事实证据；采用前请重新核实',
    });
  }

  function lessonCandidates(state, ctx, args, ignoreId = null) {
    const projectKey = args.projectKey ?? ctx.projectKey;
    return state.lessons
      .filter((item) => item.status === 'active' && item.id !== ignoreId)
      .filter((item) => item.scope === 'global' || item.projectKey === projectKey)
      .map((item) => ({
        lesson: item,
        score: similarity(`${item.trigger}\n${item.lesson}`, `${args.trigger}\n${args.lesson}`),
      }))
      .sort((a, b) => b.score - a.score);
  }

  function saveLessonInState(ctx, state, args, extra = {}) {
    const scope = oneOf(requiredString(args, 'scope', 20), ['global', 'project'], 'scope');
    const projectKey = scope === 'project'
      ? optionalString(args, 'projectKey', LIMITS.projectKey) ?? ctx.projectKey ?? null
      : null;
    if (scope === 'project' && !projectKey) {
      throw new PraxisError('missing-field', '项目经验需要 projectKey', {
        hint: '当前会话无法确定项目标识；请显式提供 projectKey，或改为 global（仅在确定适用边界时）',
      });
    }
    const trigger = requiredString(args, 'trigger', LIMITS.trigger);
    const lessonText = requiredString(args, 'lesson', LIMITS.lesson);
    const evidence = requiredString(args, 'evidence', LIMITS.evidence);
    const reusableBecause = requiredString(args, 'reusable_because', LIMITS.reusableBecause);
    const strength = evidenceStrength(evidence);
    if (strength !== 'concrete') {
      throw new PraxisError('weak-evidence', '经验证据不足以证明结论已验证', {
        hint: `需要同时给出具体操作/定位与可核对结果：（${evidenceGaps(evidence).join('；')}）`,
      });
    }
    if (state.lessons.length >= MAX_LESSONS) {
      throw new PraxisError('capacity', '经验数量达到上限', {
        hint: '退役不再适用的经验后再保存；被 supersedes 链引用的经验不能删除',
      });
    }
    const tags = (optionalArray(args, 'tags') ?? []).map((tag) => clip(String(tag).trim().toLowerCase(), LIMITS.tag)).filter(Boolean);
    const observationIds = optionalArray(args, 'observationIds') ?? [];
    if (observationIds.length > 0) {
      for (const observationId of observationIds) {
        const observation = state.observations.find((item) => item.id === observationId);
        if (!observation || observation.sessionId !== ctx.sessionId) {
          throw new PraxisError('observation-not-found', `经验引用的观察 ${observationId} 不可用`);
        }
      }
    }
    const sourceTaskId = optionalString(args, 'source_task', 80);
    let sourceTask = null;
    if (sourceTaskId) {
      sourceTask = state.tasks.find((item) => item.id === sourceTaskId);
      if (!sourceTask) throw new PraxisError('task-not-found', `来源任务 ${sourceTaskId} 不存在`);
    }
    const differenceReason = optionalString(args, 'difference_reason', LIMITS.reason);

    const candidates = lessonCandidates(state, ctx, args);
    const exact = candidates.find((entry) => entry.score >= 1);
    if (exact) {
      return {
        lesson: summarizeLesson(exact.lesson),
        warnings: [`已存在完全相同内容的经验 ${exact.lesson.id}，未创建第二条`],
        duplicate: true,
      };
    }
    const near = candidates.find((entry) => entry.score >= NEAR_DUPLICATE);
    if (near && !differenceReason) {
      throw new PraxisError('near_duplicate', '存在高度相似的经验', {
        hint: `候选 ${near.lesson.id}（相似度 ${near.score.toFixed(2)}）；确认差异后再保存，并提供 difference_reason`,
      });
    }
    const related = candidates.filter((entry) => entry.score >= RELATED).slice(0, 3);
    const warnings = [];
    if (related.length > 0) {
      warnings.push(`存在相关经验：${related.map((entry) => `${entry.lesson.id}(${entry.score.toFixed(2)})`).join(', ')}`);
    }

    const supersedes = optionalString(args, 'supersedes', 80);
    if (supersedes) {
      const target = state.lessons.find((item) => item.id === supersedes);
      if (!target) throw new PraxisError('lesson-not-found', `要替代的经验 ${supersedes} 不存在`);
      if (target.status !== 'active') {
        throw new PraxisError('conflict', `要替代的经验 ${supersedes} 状态为 ${target.status}`);
      }
      const compatible = target.scope === scope
        && (scope === 'global' || target.projectKey === projectKey);
      if (!compatible) {
        throw new PraxisError('conflict', '被替代经验与新经验作用域不兼容', {
          hint: '只能在相同 scope（项目经验还需相同 projectKey）之间建立替代关系',
        });
      }
      if (target.supersedes === null && state.lessons.some((item) => item.supersedes === target.id)) {
        throw new PraxisError('conflict', `经验 ${supersedes} 已被其他经验替代`);
      }
    }

    const at = nowIso();
    const record = {
      id: id(),
      scope,
      projectKey,
      trigger,
      lesson: lessonText,
      evidence,
      evidenceStrength: strength,
      observationIds,
      reusable_because: reusableBecause,
      tags,
      source_task: sourceTaskId ?? null,
      sourceSnapshot: extra.sourceSnapshot ?? (sourceTask ? { task_id: sourceTask.id, goal: sourceTask.goal, phase: sourceTask.phase, at } : null),
      supersedes: supersedes ?? null,
      supersededBy: null,
      status: 'active',
      retiredReason: null,
      differenceReason,
      revisions: [],
      createdAt: at,
      updatedAt: at,
    };
    state.lessons.push(record);
    if (supersedes) {
      const target = state.lessons.find((item) => item.id === supersedes);
      target.status = 'superseded';
      target.supersededBy = record.id;
      target.updatedAt = at;
      target.revisions.push({ at, reason: `被 ${record.id} 替代`, changes: { supersededBy: record.id } });
    }
    return { lesson: summarizeLesson(record), warnings, related: related.map((entry) => entry.lesson.id) };
  }

  function save(ctx, state, args) {
    const result = saveLessonInState(ctx, state, args);
    return ok(
      {
        lesson: result.lesson,
        lesson_id: result.lesson.lesson_id,
        duplicate: result.duplicate === true,
        related: result.related ?? [],
      },
      result.warnings,
    );
  }

  function update(ctx, state, args) {
    const lessonId = requiredString(args, 'lesson_id', 80);
    const lesson = state.lessons.find((item) => item.id === lessonId);
    if (!lesson) throw new PraxisError('lesson-not-found', `找不到经验 ${lessonId}`);
    if (lesson.status !== 'active') {
      throw new PraxisError('invalid-state', `经验 ${lessonId} 状态为 ${lesson.status}，不能修订`, {
        hint: '已被替代或退役的经验只能通过新经验表达；如需恢复，请新存一条',
      });
    }
    const reason = requiredString(args, 'reason', LIMITS.reason);
    const changes = {};
    const next = { ...lesson };
    if (args.trigger !== undefined) next.trigger = requiredString(args, 'trigger', LIMITS.trigger);
    if (args.lesson !== undefined) next.lesson = requiredString(args, 'lesson', LIMITS.lesson);
    if (args.evidence !== undefined) {
      next.evidence = requiredString(args, 'evidence', LIMITS.evidence);
      const strength = evidenceStrength(next.evidence);
      if (strength !== 'concrete') {
        throw new PraxisError('weak-evidence', '修订后的证据不足以证明结论', {
          hint: evidenceGaps(next.evidence).join('；'),
        });
      }
      next.evidenceStrength = strength;
    }
    if (args.reusable_because !== undefined) {
      next.reusable_because = requiredString(args, 'reusable_because', LIMITS.reusableBecause);
    }
    if (args.tags !== undefined) {
      next.tags = (optionalArray(args, 'tags') ?? [])
        .map((tag) => clip(String(tag).trim().toLowerCase(), LIMITS.tag))
        .filter(Boolean);
    }
    if (args.scope !== undefined) {
      next.scope = oneOf(args.scope, ['global', 'project'], 'scope');
      if (next.scope === 'global') next.projectKey = null;
    }
    if (args.projectKey !== undefined && next.scope === 'project') {
      next.projectKey = optionalString(args, 'projectKey', LIMITS.projectKey);
      if (!next.projectKey) throw new PraxisError('missing-field', '项目经验需要 projectKey');
    }
    for (const key of Object.keys(next)) {
      if (key === 'revisions' || key === 'updatedAt') continue;
      if (JSON.stringify(next[key]) !== JSON.stringify(lesson[key])) {
        changes[key] = { from: clip(JSON.stringify(lesson[key]), 300), to: clip(JSON.stringify(next[key]), 300) };
      }
    }
    if (Object.keys(changes).length === 0) {
      return ok({ lesson_id: lesson.id, lesson: summarizeLesson(lesson) }, ['没有需要修改的字段']);
    }
    const conflict = lessonCandidates(state, ctx, { ...next, projectKey: next.projectKey }, lesson.id)
      .find((entry) => entry.score >= NEAR_DUPLICATE);
    if (conflict) {
      throw new PraxisError('conflict', `修订后与经验 ${conflict.lesson.id} 高度相似`, {
        hint: `相似度 ${conflict.score.toFixed(2)}；请合并、改用 supersedes，或说明差异后再试`,
      });
    }
    const at = nowIso();
    lesson.revisions.push({ at, reason, changes });
    Object.assign(lesson, {
      trigger: next.trigger,
      lesson: next.lesson,
      evidence: next.evidence,
      evidenceStrength: next.evidenceStrength,
      reusable_because: next.reusable_because,
      tags: next.tags,
      scope: next.scope,
      projectKey: next.projectKey,
      updatedAt: at,
    });
    return ok({ lesson_id: lesson.id, lesson: summarizeLesson(lesson), changed: Object.keys(changes) });
  }

  function retire(ctx, state, args) {
    const lessonId = requiredString(args, 'lesson_id', 80);
    const lesson = state.lessons.find((item) => item.id === lessonId);
    if (!lesson) throw new PraxisError('lesson-not-found', `找不到经验 ${lessonId}`);
    const reason = requiredString(args, 'reason', LIMITS.reason);
    if (lesson.status === 'retired') {
      return ok({ lesson_id: lesson.id, status: 'retired', lesson: summarizeLesson(lesson) }, ['经验已处于退役状态']);
    }
    if (lesson.status === 'superseded') {
      throw new PraxisError('invalid-state', `经验 ${lessonId} 已被 ${lesson.supersededBy} 替代`, {
        hint: '替代链中的经验不能再单独退役；请修订替代它的新经验',
      });
    }
    const at = nowIso();
    lesson.status = 'retired';
    lesson.retiredReason = reason;
    lesson.updatedAt = at;
    lesson.revisions.push({ at, reason, changes: { status: { from: 'active', to: 'retired' } } });
    return ok({ lesson_id: lesson.id, status: 'retired', lesson: summarizeLesson(lesson) });
  }

  // ---------- 入口 ----------

  async function dispatch(ctx, tool, args) {
    const action = args?.action;
    if (typeof action !== 'string' || action === '') {
      throw new PraxisError('missing-field', '缺少 action', {
        hint: tool === 'task' ? `允许动作：${TASK_ACTIONS.join(' | ')}` : `允许动作：${LESSON_ACTIONS.join(' | ')}`,
      });
    }
    if (tool === 'task') {
      if (!TASK_ACTIONS.includes(action)) {
        throw new PraxisError('bad-action', `未知任务动作 ${action}`, { hint: `允许动作：${TASK_ACTIONS.join(' | ')}` });
      }
      if (MUTATING_TASK_ACTIONS.has(action)) {
        return write((state) => {
          const cached = replay(state, ctx, action, args);
          if (cached) return cached;
          const response = { start, need, inventory, step, verify, close }[action](ctx, state, args);
          remember(state, ctx, action, args, response);
          return response;
        });
      }
      const reader = action === 'summary' ? summary : status;
      return read((state) => reader(ctx, state, args));
    }
    if (!LESSON_ACTIONS.includes(action)) {
      throw new PraxisError('bad-action', `未知经验动作 ${action}`, { hint: `允许动作：${LESSON_ACTIONS.join(' | ')}` });
    }
    if (MUTATING_LESSON_ACTIONS.has(action)) {
      return write((state) => {
        const cached = replay(state, ctx, action, args);
        if (cached) return cached;
        const response = { save, update, retire }[action](ctx, state, args);
        remember(state, ctx, action, args, response);
        return response;
      });
    }
    return read((state) => search(ctx, state, args));
  }

  return {
    async task(ctx, args) {
      try {
        return await dispatch(ctx, 'task', args ?? {});
      } catch (error) {
        if (error instanceof PraxisError) return refusal(error);
        return refusal(new PraxisError('state-corrupt', `内部错误：${error?.message ?? error}`, {
          hint: '状态未写入；请检查输入或报告问题',
        }));
      }
    },
    async lesson(ctx, args) {
      try {
        return await dispatch(ctx, 'lesson', args ?? {});
      } catch (error) {
        if (error instanceof PraxisError) return refusal(error);
        return refusal(new PraxisError('state-corrupt', `内部错误：${error?.message ?? error}`, {
          hint: '状态未写入；请检查输入或报告问题',
        }));
      }
    },
    applyConfirmedWrite,
    applyPossibleWrite,
    // 供观察层复用的纯函数
    observationRejection,
  };
}

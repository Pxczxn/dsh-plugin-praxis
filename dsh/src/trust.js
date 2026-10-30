// M1 受保护验收项：可信用户授权通道（criterion-1/3/4/5）。
//
// 信任只来自宿主：`ctx.on('session/event', …, { global: true })` 观察到的
// `user/message`（source.kind === 'user-question-reply'）是宿主 createUserMessage
// 生成的持久化用户回答，模型/工具参数无法伪造其 source（M0 实测 m0-sessev.mjs、
// m1-payload.mjs）。内容是自描述 spell：JSON `{kind:'answer_to_pending_question',
// tool, callId, questions[], answers[]}`。
//
// 与 observer 相同的容错原则：监听器写入失败绝不影响宿主事件流，只计数。

import { createHash } from 'node:crypto';
import { LIMITS, clip } from './evidence.js';

/** Hard cap on retained confirmations; eviction mirrors observer 的引用保护。 */
export const MAX_CONFIRMATIONS = 500;

/** spell 解析失败的容忍上限：只丢弃该条，不影响通道。 */
function textOf(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 从宿主 user/message 事件中提取一次可信用户回答。
 * 返回 null 表示该事件不是可用的授权记录（保持静默，不是错误）。
 */
export function extractConfirmation(event) {
  const data = event?.data;
  const source = data?.source;
  if (!source || typeof source !== 'object') return null;
  if (source.kind !== 'user-question-reply') return null;
  if (source.outcome !== 'answered') return null;
  const callId = textOf(source.callId);
  if (!callId) return null;

  // content 可能是字符串或块数组；只有 JSON spell 才携带结构化 answers。
  let raw = null;
  const content = data?.content;
  if (typeof content === 'string') raw = content;
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        raw = block.text;
        break;
      }
    }
  }
  if (!raw) return null;
  let spell;
  try {
    spell = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!spell || typeof spell !== 'object') return null;
  if (spell.kind !== 'answer_to_pending_question') return null;
  if (textOf(spell.tool) !== 'ask_user_question') return null;
  if (textOf(spell.callId) !== callId) return null;

  const questions = Array.isArray(spell.questions)
    ? spell.questions
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          id: textOf(item.id) ?? '',
          question: typeof item.question === 'string' ? clip(item.question, LIMITS.note) : '',
          // M2.5：保留提问给出的选项，供 isAffirmativeAnswer 做
          //「所选 label 必须是提问中显式提供的肯定选项」的确定性判断。
          options: Array.isArray(item.options)
            ? item.options
                .map((opt) => {
                  if (typeof opt === 'string') return opt;
                  if (opt && typeof opt === 'object' && typeof opt.label === 'string') return opt.label;
                  return null;
                })
                .filter((label) => label !== null && label !== '')
            : [],
        }))
    : [];
  const answers = Array.isArray(spell.answers)
    ? spell.answers
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          id: textOf(item.id) ?? '',
          selected: Array.isArray(item.selected) ? item.selected.map((v) => String(v)) : [],
          // 不能用 text: undefined——lossless JSON 校验禁止 undefined 值属性。
          ...(typeof item.text === 'string' ? { text: clip(item.text, LIMITS.note) } : {}),
        }))
    : [];
  if (questions.length === 0 || answers.length === 0) return null;

  return { callId, questions, answers };
}

/**
 * M2（用户 m03643）：确认记录须保留用户所选选项；授权核对时用它区分
 * 「同意」与「拒绝」——真实宿主中两者都产生 outcome:'answered' 事件
 *（m2-reject.mjs 实测），不检查 selected 语义时「拒绝」也会被当成授权。
 */
export function isAffirmativeAnswer(record) {
  const answers = Array.isArray(record?.answers) ? record.answers : [];
  if (answers.length === 0) return false;
  // M2.5（用户 m03864）：授权判断必须确定性——不再用模糊词表子串包含
  //（「不同意」会 includes「同意」）。判定规则：
  //   1) 提问带 options 时（首选，宿主可信数据）：用户所选 label 必须
  //      与 options 中某个肯定选项【完全相等】（等值，不是子串）；
  //   2) 无 options 时退回词表，但也做【等值匹配】（去空白后全等），
  //      并先排除否定词等值命中。
  const AFFIRM = new Set(['同意', '确认', '是', 'yes', 'allow', 'approve', 'ok', 'approve']);
  const DENY = new Set(['拒绝', '否', '不同意', '取消', 'no', 'deny', 'reject', 'cancel']);
  const eq = (s) => String(s ?? '').trim().toLowerCase();

  // 从同一问题里取肯定选项集合：label 等值命中 AFFIRM 词表的选项。
  const affirmOptionsFor = (questionId) => {
    const question = (record.questions ?? []).find((item) => item?.id === questionId);
    const options = Array.isArray(question?.options) ? question.options : [];
    return new Set(options.map((label) => eq(label)).filter((label) => AFFIRM.has(label)));
  };

  return answers.every((item) => {
    const selected = Array.isArray(item?.selected) ? item.selected : [];
    if (selected.length === 0) return false;
    const affirmOptions = affirmOptionsFor(item?.id);
    return selected.every((label) => {
      const norm = eq(label);
      if (norm === '') return false;
      // 否定选项等值命中即拒——优先级高于肯定判断。
      if (DENY.has(norm)) return false;
      // 有 options：只认提问中显式提供的肯定选项（完全相等）。
      if (affirmOptions.size > 0) return affirmOptions.has(norm);
      // 无 options 兜底：词表等值匹配（不是子串）。
      return AFFIRM.has(norm);
    });
  });
}

/** 授权记录的稳定指纹：去重与审计用。 */
export function confirmationDigest(record) {
  const hash = createHash('sha256');
  hash.update(record.sessionId ?? '');
  hash.update('\u0000');
  hash.update(record.callId ?? '');
  hash.update('\u0000');
  hash.update(JSON.stringify(record.questions ?? []));
  hash.update('\u0000');
  hash.update(JSON.stringify(record.answers ?? []));
  return hash.digest('hex').slice(0, 32);
}

/**
 * Pure state transition: append one host-observed user confirmation.
 * 与 recordObservation 同构：同一 (sessionId, callId) 只记录一次（幂等）。
 */
export function recordConfirmation(state, input = {}) {
  if (!state || typeof state !== 'object') return null;
  const sessionId = textOf(input.sessionId);
  if (!sessionId || !input.callId) return null;

  if (!Array.isArray(state.confirmations)) state.confirmations = [];
  // 幂等：同一会话同一 callId 只保留一条（宿主不会重放同一事件，防御性兜底）。
  const existing = state.confirmations.find(
    (item) => item && item.sessionId === sessionId && item.callId === input.callId,
  );
  if (existing) return existing;

  const at = new Date().toISOString();
  const record = {
    callId: input.callId,
    sessionId,
    questions: input.questions ?? [],
    answers: input.answers ?? [],
    digest: confirmationDigest({ sessionId, callId: input.callId, questions: input.questions, answers: input.answers }),
    consumedBy: null,
    consumedAt: null,
    at,
  };
  state.confirmations.push(record);

  // 容量：优先驱逐已消费且无引用的旧记录；全被引用时丢弃新记录并计数。
  while (state.confirmations.length > MAX_CONFIRMATIONS) {
    const index = state.confirmations.findIndex(
      (item) => item && item.consumedBy !== null,
    );
    if (index < 0) {
      state.droppedConfirmations = (Number.isFinite(state.droppedConfirmations) ? state.droppedConfirmations : 0) + 1;
      state.confirmations.pop();
      return null;
    }
    state.confirmations.splice(index, 1);
  }
  return record;
}

/**
 * 查找一条可用于授权的确认：同会话、同 callId、未消费。
 * 只读；消费由调用方在同一个 mutate 事务里完成。
 */
export function findUsableConfirmation(state, sessionId, callId) {
  if (!state || typeof state !== 'object') return null;
  if (!Array.isArray(state.confirmations)) return null;
  const record = state.confirmations.find(
    (item) =>
      item &&
      item.sessionId === sessionId &&
      item.callId === callId &&
      item.consumedBy === null,
  );
  return record ?? null;
}

/** 在同一 mutate 事务内消费一条授权（原子：找不到/已消费返回 null）。 */
export function consumeConfirmation(state, record, consumer) {
  if (!record || record.consumedBy !== null) return null;
  record.consumedBy = consumer;
  record.consumedAt = new Date().toISOString();
  return record;
}

/** attach 侧容错计数与 observer 的 observerErrors 同型。 */
export async function bumpTrustError(store) {
  try {
    await store.mutate((state) => {
      if (!state || typeof state !== 'object') return;
      state.trustErrors = (Number.isFinite(state.trustErrors) ? state.trustErrors : 0) + 1;
    });
  } catch {
    // 诊断计数写不进去不影响宿主
  }
}

/**
 * 注册 session/event 监听器，把宿主确认的用户回答写入 state.confirmations。
 * 返回 disposer；接线失败降级为 no-op（trust 不可用时受保护项一律拒绝未授权修改，
 * 安全失败方向正确）。
 */
export function attachTrust(ctx, store) {
  if (ctx && typeof ctx === 'object' && typeof ctx.on !== 'function' && ctx.ctx && store === undefined) {
    store = ctx.store;
    ctx = ctx.ctx;
  }
  if (!ctx || typeof ctx.on !== 'function' || !store || typeof store.mutate !== 'function') {
    return () => {};
  }

  const handle = (session, event) => {
    const pending = (async () => {
      try {
        const sessionId = textOf(session?.id) ?? textOf(event?.data?.sessionId);
        if (!sessionId) return;
        const confirmation = extractConfirmation(event);
        if (!confirmation) return;
        await store.mutate((state) => {
          recordConfirmation(state, {
            sessionId,
            callId: confirmation.callId,
            questions: confirmation.questions,
            answers: confirmation.answers,
          });
        });
      } catch {
        await bumpTrustError(store);
      }
    })();
    pending.catch(() => {});
    return pending;
  };

  let off;
  try {
    off = ctx.on('session/event', handle, { global: true });
  } catch {
    bumpTrustError(store).catch(() => {});
    return () => {};
  }
  return () => {
    try {
      if (typeof off === 'function') off();
    } catch {
      // 已释放
    }
  };
}

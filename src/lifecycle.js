// 生命周期钩子：静态指引段落、每轮一次提醒、轮次停止诊断。只做提醒，不改写任务状态。
import { clip } from './evidence.js';

export const GUIDANCE = [
  'Praxis 是宿主内的任务与经验台账（工具 praxis_task 与 praxis_lesson）。',
  '1) 非平凡代码任务开始时先 start 记录目标与已知验收项；没有活跃验收项的任务不能以 done 结项。',
  '2) 动手改代码前，先调查现有实现，用 need/inventory 记录复用、扩展或新增的判断连同证据（文件:行号、命令与关键输出）；弱证据会被拒绝。',
  '3) 声称完成或修复前，把真实验证结果用 verify 映射到验收项；passed 必须引用宿主记录的观察 ID。',
  '4) 验证之后又改文件，先前验证会失效，需要重新验证。',
  '5) 等待人工验收用 close(partial, complete, awaiting_manual)，不要谎报 done。',
  '6) 经验只在能给出可复核证据时才保存；检索到的经验是调查线索，不是当前事实。',
].join('\n');

export const REMINDER =
  '[Praxis] 本轮涉及代码改动：非平凡任务先用 praxis_task start 记录目标与验收项；调查后用 need 记录复用/扩展/新增判断与证据；声称完成前先 verify 并引用观察 ID，再 close。';

const IMPLEMENT_VERBS = [
  '实现', '修复', '修改', '改一下', '改成', '重构', '迁移', '新增', '添加', '删除', '移除',
  '开发', '写一个', '写个', '接入', '集成', '升级', '优化性能', '补测试', '加测试',
  // 英文
  'implement', 'fix', 'refactor', 'migrate', 'add ', 'remove ', 'delete ', 'update ',
  'build ', 'create ', 'rename', 'upgrade', 'optimi', 'wire ',
];

const QUESTION_MARKERS = [
  '什么是', '是什么', '为什么', '为何', '解释', '说明一下', '怎么理解', '区别是什么',
  'what is', 'why does', 'explain', 'difference between', 'how does',
];

const CODE_MARKERS = [
  '```', '文件', '目录', '函数', '类 ', '模块', '插件', '测试', '报错', '日志',
  '.js', '.ts', '.py', '.java', '.rs', '.json', '.md', 'node --test', 'npm ', 'pnpm ',
];

/**
 * 只做粗分类：拿不准时返回 uncertain，调用方不注入。
 * 纯问答、只读查询不注入；涉及改动意图才注入。
 */
export function classifyRequest(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return 'uncertain';
  const lower = raw.toLowerCase();
  if (raw.startsWith('/')) return 'not_applicable';

  const hasVerb = IMPLEMENT_VERBS.some((verb) => lower.includes(verb.toLowerCase()));
  const hasQuestion = QUESTION_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
  const hasCode = CODE_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));

  if (hasVerb) return 'applicable';
  if (hasQuestion && !hasCode) return 'not_applicable';
  // 中文不必带词边界：以“查看/列出”开头的句子本身就是只读意图。
  if (/^(列出|看看|查看|显示|有哪些)/u.test(raw)) return 'not_applicable';
  if (/^(tell me|show me|list|where)\b/i.test(raw)) return 'not_applicable';
  if (hasCode) return 'uncertain';
  return 'uncertain';
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
    }
    return '';
  }
  return '';
}

function reminderMessage(text) {
  return {
    id: `praxis-reminder-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text: clip(text, 1000) }],
    source: { kind: 'user' },
  };
}

function sessionOf(state, sessionId) {
  const existing = state.sessions[sessionId];
  if (existing) return existing;
  const created = { reminderCount: 0, turnStops: 0 };
  state.sessions[sessionId] = created;
  return created;
}

/** 本会话里第一个仍 open 的任务；多于一个时只诊断第一个，不替模型选。 */
function openTaskOf(state, sessionId) {
  return state.tasks.find((task) => task && task.status === 'open' && task.sessionId === sessionId) ?? null;
}

/** 只做粗略诊断：具体门槛由 praxis_task close 判定，这里用于决定是否提醒。 */
function closureGaps(task) {
  const gaps = [];
  if (task.phase !== 'verify') gaps.push(`仍在 ${task.phase} 阶段`);
  const active = (task.acceptance ?? []).filter((item) => item.active);
  if (active.length === 0) gaps.push('没有活跃验收项');
  const passed = (task.verificationHistory ?? []).some(
    (item) => item && item.level === 'passed' && item.valid !== false,
  );
  if (!passed) gaps.push('没有有效的通过验证');
  if ((task.pendingChangeIds ?? []).length > 0) {
    gaps.push(`有 ${task.pendingChangeIds.length} 条待复核写入`);
  }
  return gaps;
}

function closureReminder(hint) {
  return [
    `[Praxis] 上一轮结束时任务 ${hint.taskId} 仍未闭环：${hint.detail.join('；')}。`,
    '如果这一轮确实完成了工作，用 praxis_task verify 引用观察 ID 后 close；',
    '如果还没完成，用 step 推进阶段或用 need 记录下一步，不要只在回复里口头收尾。',
  ].join('');
}

/** 接线失败时返回的 dispose 上带 degraded 字段，调用方据此报告降级而不是假装启用。 */
export function attachLifecycle(ctx, store) {
  const disposers = [];
  const degraded = [];

  const systemPrompt = (() => {
    try {
      return ctx?.systemPrompt ?? ctx?.get?.('systemPrompt') ?? null;
    } catch {
      return null;
    }
  })();

  if (systemPrompt && typeof systemPrompt.section === 'function') {
    try {
      const remove = systemPrompt.section({ name: 'praxis', order: 9500, text: GUIDANCE });
      if (typeof remove === 'function') disposers.push(remove);
    } catch {
      degraded.push('system-prompt');
    }
  } else {
    degraded.push('system-prompt');
  }

  const on = typeof ctx?.on === 'function' ? ctx.on.bind(ctx) : null;
  if (!on) {
    degraded.push('hooks');
  } else {
    try {
      const removePreStep = on('agent/pre-step', async (payload, next) => {
        try {
          const sessionId = payload?.agent?.id;
          const turn = payload?.turn;
          if (!sessionId || typeof turn !== 'number') return next();
          // 只在本轮第一个模型步骤提醒；后续 step 继续走原流程。
          if (typeof payload.step === 'number' && payload.step > 1) return next();

          // 闭环提醒优先：上一轮结束时任务还开着，就具体点出缺什么。
          const snapshot = await store.load();
          const hint = snapshot.sessions?.[sessionId]?.closureHint;
          if (hint && hint.pending && hint.taskId) {
            let inject = false;
            await store.mutate((state) => {
              const session = sessionOf(state, sessionId);
              if (!session.closureHint || session.closureHint.taskId !== hint.taskId) return;
              session.closureHint = null;
              session.closureReminderCount = (session.closureReminderCount ?? 0) + 1;
              inject = true;
            });
            if (inject) return { kind: 'enter', messages: [reminderMessage(closureReminder(hint))] };
          }

          if (classifyRequest(lastUserText(payload.messages)) !== 'applicable') return next();

          let inject = false;
          await store.mutate((state) => {
            const session = sessionOf(state, sessionId);
            if (session.lastReminderTurn === turn) return;
            session.lastReminderTurn = turn;
            session.reminderCount = (session.reminderCount ?? 0) + 1;
            inject = true;
          });
          if (!inject) return next();
          return { kind: 'enter', messages: [reminderMessage(REMINDER)] };
        } catch {
          return next();
        }
      });
      if (typeof removePreStep === 'function') disposers.push(removePreStep);

      const removeTurnStopping = on('agent/turn-stopping', async (payload) => {
        try {
          const sessionId = payload?.agent?.id;
          if (!sessionId) return;
          await store.mutate((state) => {
            const session = sessionOf(state, sessionId);
            session.turnStops = (session.turnStops ?? 0) + 1;
            session.lastTurnStopAt = new Date().toISOString();
            // 只诊断、不结项：把“还差什么”留给下一轮开头提醒一次。
            const task = openTaskOf(state, sessionId);
            if (!task) {
              session.closureHint = null;
              return;
            }
            const detail = closureGaps(task);
            session.closureHint = {
              taskId: task.id,
              pending: detail.length > 0,
              detail: detail.length > 0 ? detail : [],
              phase: task.phase,
            };
          });
        } catch {
          // 诊断信息写不进去不影响整轮结束
        }
      });
      if (typeof removeTurnStopping === 'function') disposers.push(removeTurnStopping);
    } catch {
      degraded.push('hooks');
    }
  }

  const dispose = () => {
    for (const remove of disposers) {
      try {
        remove();
      } catch {
        // 已释放
      }
    }
  };
  dispose.degraded = degraded.length > 0 ? degraded.join(',') : null;
  return dispose;
}

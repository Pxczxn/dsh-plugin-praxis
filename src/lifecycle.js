// 生命周期钩子：静态指引段落、每轮一次提醒、轮次停止诊断。只做提醒，不改写任务状态。
import { clip, relevance } from './evidence.js';
import { resolveService, sessionContext } from './context.js';

export const GUIDANCE = [
  'Praxis 是宿主内的任务与经验台账（工具 praxis_task 与 praxis_lesson）。',
  '1) 非平凡代码任务开始时先 start 记录目标与已知验收项；没有活跃验收项的任务不能以 done 结项。',
  '2) 动手改代码前，先调查现有实现，用 need/inventory 记录复用、扩展或新增的判断连同证据（文件:行号、命令与关键输出）；弱证据会被拒绝。',
  '3) 声称完成或修复前，把真实验证结果用 verify 映射到验收项；passed 必须引用宿主记录的观察 ID。',
  '4) 验证之后又改文件，先前验证会失效，需要重新验证。',
  '5) 跑完最后一轮测试就当场 verify 并 close，不要攒到下一轮：会话可能在你收尾之前结束。',
  '6) 等待人工验收用 close(partial, complete, awaiting_manual)，不要谎报 done。',
  '7) 经验只在能给出可复核证据时才保存；检索到的经验是调查线索，不是当前事实。',
].join('\n');

export const REMINDER =
  '[Praxis] 如果本轮要改代码：非平凡任务先用 praxis_task start 记录目标与验收项；调查后用 need 记录复用/扩展/新增判断与证据；声称完成前先 verify 并引用观察 ID，再 close。';

// 明确动手的动词：出现就可以按改动任务提醒。
const ACTION_VERBS = [
  '修复', '修好', '重构', '迁移', '改造', '替换', '接入', '集成', '升级',
  '改掉', '改成', '改为', '改一下', '修改',
  '补上', '补齐', '补充', '补一段', '加上', '加个', '加一个',
  '新增', '添加', '删除', '移除', '优化', '写一个', '写个', '补测试', '加测试',
  // 英文
  'implement', 'fix', 'refactor', 'migrate', 'rename', 'upgrade', 'optimi',
  'add ', 'remove ', 'delete ', 'update ', 'create ', 'build ', 'wire ',
];

// 这些词大量出现在名词短语里（开发计划、实现思路、设计文档），
// 单独出现不足以说明要改代码，必须再看到具体代码对象才算实现任务。
const WEAK_VERBS = ['开发', '实现', '设计', '调整'];

// 命中这些词时，句子在谈「计划/文档/动机」，不是在动手。
const NOMINAL_CONTEXT =
  /(计划|规划|进度|流程|思路|想法|文档|动机|原因|意义|价值|方向|目标|指南|说明|方案|理念|哲学|背景)/u;

const QUESTION_MARKERS = [
  '什么是', '是什么', '为什么', '为何', '解释', '说明一下', '怎么理解', '区别是什么',
  'what is', 'why does', 'explain', 'difference between', 'how does',
];

const CODE_MARKERS = [
  '```', '文件', '目录', '函数', '类 ', '模块', '插件', '测试', '报错', '日志',
  '.js', '.ts', '.py', '.java', '.rs', '.json', '.md', 'node --test', 'npm ', 'pnpm ',
];

// 以这些词开头通常是「说清楚就行」的请求：整理现状、讲解代码、评估风险，都不动实现。
const READONLY_OPENERS =
  /^(整理|梳理|说明|介绍|解释|总结|盘点|评估|讲解|列出|看看|查看|显示|有哪些|讲讲|谈谈|说说|分析|讨论|检查|复查|对比|回顾|核对|了解|调研|判断|统计)/u;
// 但句子里出现明确动作时仍算实现任务：「整理一下代码然后修复这个 bug」。
const CONCRETE_ACTIONS =
  /(修复|修好|重构|迁移|改造|替换|接入|集成|升级|改掉|改成|改为|改一下|补上|补齐|补充|补一段|加上|加个|加一个|新增|添加|删除|移除|优化|写一个|写个)/u;

/**
 * 只做粗分类：拿不准时返回 uncertain，调用方不注入。
 * 纯问答、只读查询、规划讨论都不注入；只有明确的动手意图才注入。
 */
export function classifyRequest(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return 'uncertain';
  const lower = raw.toLowerCase();
  if (raw.startsWith('/')) return 'not_applicable';

  const hasAction = ACTION_VERBS.some((verb) => lower.includes(verb.toLowerCase()));
  const hasWeak = WEAK_VERBS.some((verb) => lower.includes(verb));
  const hasQuestion = QUESTION_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
  const hasCode = CODE_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));

  // 先看意图：整理/分析/讨论类请求即使在说「开发」「实现」，也是在说事、不是动手。
  // 例：「整理一下你目前对这个项目的了解和开发规划」曾被「开发」判成实现任务并注入提醒。
  if (READONLY_OPENERS.test(raw) && !CONCRETE_ACTIONS.test(raw)) return 'not_applicable';
  if (hasAction) return 'applicable';
  if (NOMINAL_CONTEXT.test(raw)) return 'not_applicable';
  if (hasQuestion && !hasCode) return 'not_applicable';
  // 「实现这个函数」这类：泛动词 + 具体代码对象才算动手。
  if (hasWeak && hasCode) return 'applicable';
  // 中文不必带词边界：以“查看/列出”开头的句子本身就是只读意图。
  if (/^(列出|看看|查看|显示|有哪些)/u.test(raw)) return 'not_applicable';
  if (/^(tell me|show me|list|where)\b/i.test(raw)) return 'not_applicable';
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

// 提示不再以用户消息的形式注入：宿主的 pre-step 会把 source.kind === 'user' 的消息
// 当作一条用户发言写进会话历史，于是插件的话会被渲染成聊天气泡。改成 systemPrompt 的
// 运行时上下文（与宿主自己的 cwd、审批策略同一条通道），由宿主在每次请求前求值。
export const HINT_CONTEXT_NAME = 'praxis:hint';
// 宿主的上下文位置：WORKING_DIRECTORY 100、SANDBOX_POLICY 110、APPROVAL_POLICY 115、
// SUBAGENT_DELEGATION 120、TEAM_IDENTITY 125、HARNESS_SOURCE 200、WEB_SURFACE 210。
// 150 落在「会话策略之后、源码说明之前」，不抢宿主的固定槽位。
export const HINT_CONTEXT_ORDER = 150;

/** 当前会话待注入的内部提示；context 的 text 同步求值，这里只读内存缓存。 */
export function hintOf(state, sessionId) {
  const text = state?.sessions?.[sessionId]?.praxisHint;
  return typeof text === 'string' ? text : '';
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

/** 最近一条能直接当通过证据的观察：提醒里给出 ID，模型就不必再翻 status 找它。 */
function usableEvidenceOf(state, task) {
  const usable = (state?.observations ?? []).filter(
    (item) =>
      item &&
      item.taskId === task.id &&
      item.sessionId === task.sessionId &&
      item.outcome === 'success' &&
      typeof item.resultSummary === 'string' &&
      item.resultSummary !== '' &&
      ['test', 'lint', 'build'].includes(item.kind),
  );
  return usable.length > 0 ? usable[usable.length - 1] : null;
}

/** 只做粗略诊断：具体门槛由 praxis_task close 判定，这里用于决定是否提醒。 */
function closureGaps(task, state) {
  const gaps = [];
  if (task.phase !== 'verify') gaps.push(`仍在 ${task.phase} 阶段`);
  const active = (task.acceptance ?? []).filter((item) => item.active);
  if (active.length === 0) gaps.push('没有活跃验收项');
  const passed = (task.verificationHistory ?? []).some(
    (item) => item && item.level === 'passed' && item.valid !== false,
  );
  if (!passed) {
    const evidence = usableEvidenceOf(state, task);
    gaps.push(
      evidence
        ? `没有有效的通过验证（已有可用证据 ${evidence.id}：${clip(evidence.resultSummary, 80)}，verify 直接引用即可）`
        : '没有有效的通过验证',
    );
  }
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

// 宁可漏提示，也不要每轮催检索：三个信号都不达标就不提，把调用机会留给模型自己判断。
const LESSON_HINT_LIMIT = 2;
const STRONG_TOKEN_MIN = 4;
const CJK_HIT_MIN = 2;
// 只数二元组个数不够：长句里随便两个「测试」「结果」就能凑到 2 个，占比却只有一成。
// 要求个数与占比同时达标，短句和长句才都筛得干净。
const CJK_RATIO_MIN = 0.2;
// 占比的分母要封顶：请求越长，二元组数量越线性增长，同样命中关键词反而被稀释。实测一条
// 真实请求（「实现单文件状态存储」+ 三条具体要求）命中 14 个二元组却只有 0.194，刚好卡在
// 阈值下——长请求于是永远拿不到经验提示。
const CJK_RATIO_SPAN = 30;
const LEXICAL_MIN = 0.5;

// 跨领域高频词，命中它们说明不了「相关」，只会制造噪声。
const STOP_TOKENS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'were', 'will', 'your', 'into',
  'then', 'than', 'them', 'they', 'been', 'when', 'what', 'over', 'also', 'just', 'like', 'make',
  'must', 'only', 'some', 'such', 'test', 'tests', 'code', 'file', 'files', 'node', 'npm', 'pnpm',
  'http', 'https', 'true', 'false', 'null', 'undefined', 'function', 'const', 'return', 'await',
  'async', 'case', 'default', 'value', 'string', 'number', 'object', 'array', 'this', 'type',
  // 下面这些在经验正文和请求里都随处可见，却不构成主题信号：`name=` 出现在每个
  // package.json 里，曾让一条 Cordis 服务解析的经验以 2.24 分命中「写一个 sum.js」这种
  // 完全无关的任务。宁可漏提示，也不要把通用词当强标识符。
  'name', 'names', 'path', 'paths', 'index', 'main', 'json', 'text', 'line', 'lines',
  'item', 'items', 'size', 'args', 'read', 'write', 'load', 'save',
  // 测试替身：原子写任务里写一句「mock 一次 rename 失败」，就足以撞上一条完全无关的
  // Cordis 宿主服务经验——这类词只在讲测试手法，不指向任何主题。
  'mock', 'mocks', 'stub', 'stubs', 'spy', 'spies', 'fixture', 'fixtures',
]);

// 同样跨领域的中文二元组：命中它们不代表任务和某条经验有关。
const STOP_BIGRAMS = new Set([
  '实现', '文件', '数据', '状态', '需要', '当前', '一个', '我们', '可以', '这个', '进行',
  '使用', '处理', '问题', '并且', '不是', '已经', '任务', '记录', '之后', '然后', '如果',
]);

// 宿主会给委派任务追加一段机械说明（返程指引、相邻 Agent 的消息前缀），它对每个
// 子代理都一模一样，与任务措辞无关。这段文本里的 `send_message`、`parent agent id`、
// `messages` 曾让一条 pre-step 经验在「写一个 sum.js」这种完全无关的任务上以 4.11 分
// 命中——匹配前先剥掉，不要让它参与打分。
const HOST_NOISE = [
  /\byour parent agent id is[\s\S]*$/i,
  /^\s*agent\s+[\w-]+\s+sent a message:\s*/i,
];

function stripHostNoise(text) {
  let result = String(text ?? '');
  for (const pattern of HOST_NOISE) result = result.replace(pattern, ' ');
  return result.trim();
}

/** 英文标识符切成强词：整体保留，再按 . / : _ - 拆开，让 agent/pre-step 与 pre-step 互相可见。 */
function strongTokens(text) {
  const found = String(text ?? '').toLowerCase().match(/[a-z][a-z0-9_.:/-]{2,}/g) ?? [];
  const tokens = new Set();
  for (const token of found) {
    if (token.length >= STRONG_TOKEN_MIN && !STOP_TOKENS.has(token)) tokens.add(token);
    for (const part of token.split(/[./:_-]+/)) {
      if (part.length >= STRONG_TOKEN_MIN && !STOP_TOKENS.has(part)) tokens.add(part);
    }
  }
  return tokens;
}

/** 中文没有空格分词，用字面二元组重叠近似语义重合。 */
function cjkBigrams(text) {
  const runs = String(text ?? '').match(/[\u4e00-\u9fa5]+/g) ?? [];
  const grams = new Set();
  for (const run of runs) {
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const gram = run.slice(index, index + 2);
      if (!STOP_BIGRAMS.has(gram)) grams.add(gram);
    }
  }
  return grams;
}

function overlapCount(left, right) {
  let count = 0;
  for (const item of left) {
    if (right.has(item)) count += 1;
  }
  return count;
}

function lessonScore(text, lesson) {
  const haystack = `${lesson.trigger ?? ''} ${lesson.lesson ?? ''}`;
  const lessonTokens = strongTokens(haystack);
  const sharedTokens = [...strongTokens(text)].filter((token) => lessonTokens.has(token));
  const grams = cjkBigrams(text);
  const cjkHits = overlapCount(grams, cjkBigrams(haystack));
  const cjkRatio = grams.size === 0 ? 0 : cjkHits / Math.min(grams.size, CJK_RATIO_SPAN);
  return { sharedTokens, strongHits: sharedTokens.length, cjkHits, cjkRatio, lexical: relevance(text, haystack) };
}

/** 只挑真的对得上的活跃经验；项目经验必须同项目，全局经验都可见。 */
export function matchingLessons(state, projectKey, text) {
  const query = stripHostNoise(text);
  const lessons = Array.isArray(state?.lessons) ? state.lessons : [];
  const hits = [];
  for (const lesson of lessons) {
    if (!lesson || lesson.status !== 'active') continue;
    if (lesson.scope === 'project') {
      if (!projectKey || lesson.projectKey !== projectKey) continue;
    } else if (lesson.scope !== 'global') {
      continue;
    }
    const score = lessonScore(query, lesson);
    // 单个中文二元组的重合几乎全是噪声（「插件」「配置」「动作」这类词到处都是），
    // 所以中文信号要求至少两个二元组、且占查询词两成以上；英文标识符一个够独特就成立。
    const cjkWeak = score.cjkHits < CJK_HIT_MIN || score.cjkRatio < CJK_RATIO_MIN;
    if (score.strongHits === 0 && cjkWeak && score.lexical < LEXICAL_MIN) continue;
    hits.push({ lesson, score: score.strongHits * 2 + score.cjkRatio + score.lexical });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, LESSON_HINT_LIMIT);
}

function lessonHintMessage(hits) {
  const lines = hits.map((hit) => `- ${clip(hit.lesson.trigger ?? '（无触发条件）', 120)}（lesson_id ${hit.lesson.id}）`);
  return [
    '[Praxis] 错题本里有与本次任务措辞接近的经验，可以先用 praxis_lesson search 判断是否适用：',
    ...lines,
    '经验是过往证据，不等于当前事实；不适用就忽略，不要为了检索而检索。',
  ].join('\n');
}

/** 接线失败时返回的 dispose 上带 degraded 字段，调用方据此报告降级而不是假装启用。 */
export function attachLifecycle(ctx, store) {
  const disposers = [];
  const degraded = [];

  // context 的 text 是同步求值，先预热一次缓存：首次请求若早于第一个 pre-step，
  // read() 还可能是 null，预热把它变成真实状态而不是「沉默地没有提示」。
  if (typeof store?.load === 'function') Promise.resolve(store.load()).catch(() => {});

  const systemPrompt = resolveService(ctx, 'systemPrompt');

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

  // 动态提示走宿主的运行时上下文通道：不进消息流、不伪装成用户发言，
  // 且每次请求前由 refreshContext 重新求值，所以本轮就能看到 pre-step 刚写入的文本。
  if (systemPrompt && typeof systemPrompt.context === 'function') {
    try {
      const remove = systemPrompt.context({
        name: HINT_CONTEXT_NAME,
        order: HINT_CONTEXT_ORDER,
        interpolate: false,
        text: (context) => {
          const sessionId = context?.agent?.session;
          if (!sessionId) return '';
          return hintOf(store.read(), sessionId);
        },
      });
      if (typeof remove === 'function') disposers.push(remove);
    } catch {
      degraded.push('prompt-context');
    }
  } else {
    degraded.push('prompt-context');
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
          // 只在本轮第一个模型步骤决定本轮提示；后续 step 沿用同一段文本，不重复计算。
          if (typeof payload.step === 'number' && payload.step > 1) return next();

          const requestText = lastUserText(payload.messages);
          const applicable = classifyRequest(requestText) === 'applicable';
          const { projectKey } = sessionContext(ctx, sessionId);
          const snapshot = await store.load();

          await store.mutate((state) => {
            const session = sessionOf(state, sessionId);

            // 闭环提醒优先：上一轮结束时任务还开着，就具体点出缺什么。
            const pendingClosure = snapshot.sessions?.[sessionId]?.closureHint;
            if (
              pendingClosure &&
              pendingClosure.pending &&
              pendingClosure.taskId &&
              session.closureHint &&
              session.closureHint.taskId === pendingClosure.taskId
            ) {
              session.closureHint = null;
              session.closureReminderCount = (session.closureReminderCount ?? 0) + 1;
              session.praxisHint = clip(closureReminder(pendingClosure), 1000);
              return;
            }

            // 只读、问答、规划类请求不提示：本轮把上一轮残留的提示一并清掉。
            if (!applicable) {
              session.praxisHint = null;
              return;
            }

            // 相关经验：整个会话只提一次，且只在措辞真的对得上时才提。
            if (!session.lessonHintShown) {
              const hits = matchingLessons(snapshot, projectKey, requestText);
              if (hits.length > 0) {
                session.lessonHintShown = true;
                session.lessonHintCount = (session.lessonHintCount ?? 0) + 1;
                session.lastReminderTurn = turn;
                session.reminderCount = (session.reminderCount ?? 0) + 1;
                session.praxisHint = clip(lessonHintMessage(hits), 1000);
                return;
              }
            }

            // 通用提醒每轮一次；同一轮内不重复。
            if (session.lastReminderTurn === turn) return;
            session.lastReminderTurn = turn;
            session.reminderCount = (session.reminderCount ?? 0) + 1;
            session.praxisHint = clip(REMINDER, 1000);
          });

          return next();
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
            const detail = closureGaps(task, state);
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

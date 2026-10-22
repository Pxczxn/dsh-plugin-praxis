// 生命周期钩子：静态指引段落、每轮一次提醒、轮次停止诊断。只做提醒，不改写任务状态。
import { clip, relevance } from './evidence.js';
import { readinessOf } from './engine.js';
import { resolveService, sessionContext } from './context.js';

export const GUIDANCE = [
  'Praxis 是宿主内的任务与经验台账（工具 praxis_task 与 praxis_lesson）。',
  '1) 非平凡代码任务开始时先 start 记录目标与已知验收项；没有活跃验收项的任务不能以 done 结项。',
  '2) 动手改代码前先调查：need 是调查后的结论，不是待调查清单；没有结论先查，不要先填 reuse/extend/new 占位，也不要为数量或形式完整而登记。按独立决策目标记录判断与证据（文件:行号、命令与关键输出）；判断、证据、处理一致的目标可合并，但 target 要写明覆盖范围，不要为凑数拆分文件或方法；弱证据只说明还没查完，不能当作结论或进入实现的依据。new 要写清检查过的现有能力及不适用原因；结论形成后把未确认范围写进该 need 的 plan，不假装调查完整。只读、讨论、规划轮次不用 start。',
  '3) 声称完成或修复前，把真实验证结果用 verify 映射到验收项；passed 必须引用宿主记录的观察 ID。',
  '4) 验证之后又改文件，先前验证会失效，需要重新验证。',
  '5) 跑完最后一轮测试就当场 verify 并 close，不要攒到下一轮：会话可能在你收尾之前结束。',
  '6) 等待人工验收用 close(partial, complete, awaiting_manual)，不要谎报 done。',
  '7) 经验只在能给出可复核证据时才保存；检索到的经验是调查线索，不是当前事实。',
].join('\n');

export const REMINDER =
  '[Praxis] 如果本轮要改代码：非平凡任务先用 praxis_task start 记录目标与验收项；调查后按独立目标用 need 记录复用/扩展/新增结论与证据，need 不是待调查清单，未查清不要先填 decision 占位，也不要为凑数登记；new 要说明检查过的现有能力及不适用原因；声称完成前先 verify 并引用观察 ID，再 close。只读、讨论、规划轮次忽略本条。';

// 明确动手的动词：出现就可以按改动任务提醒。
const ACTION_VERBS = [
  '修复', '修好', '修一下', '重构', '迁移', '改造', '替换', '接入', '集成', '升级',
  '改掉', '改成', '改为', '改一下', '改这个', '修改', '更新', '重命名', '增加',
  '补上', '补齐', '补充', '补一段', '补一下', '加上', '加个', '加一个', '加一下',
  '新增', '添加', '删除', '移除', '删掉', '优化', '写一个', '写个', '补测试', '加测试',
];
// 英文动作词必须按词边界匹配，否则 fix 会命中 prefix、optimi 会命中 optimal。
const ENGLISH_ACTION =
  /\b(?:implement|fix|refactor|migrate|rename|upgrade|optimi[sz]e|add|remove|delete|update|create|build|wire)\b/i;

// 这些词大量出现在名词短语里（开发计划、实现思路、设计文档），
// 单独出现不足以说明要改代码，必须再看到具体代码对象才算实现任务。
const WEAK_VERBS = ['开发', '实现', '设计', '调整'];

// 命中这些词时，句子在谈「计划/文档/动机」，不是在动手。
const NOMINAL_CONTEXT =
  /(计划|规划|进度|流程|思路|想法|文档|动机|原因|意义|价值|方向|目标|指南|说明|方案|理念|哲学|背景|建议|可行性|取舍|优缺点|利弊|规范)/u;

// 用户明确说只读/不要改时，优先于任何动作词。
const READONLY_DIRECTIVE =
  /(只读|只分析|只讨论|只解释|只说明|只调研|不要改|别改|先别改|不要改代码|不要动代码|不要修改|无需修改|不用修改|不改代码|先不要实现|先不实现)/u;

const QUESTION_MARKERS = [
  '什么是', '是什么', '为什么', '为何', '解释', '说明一下', '怎么理解', '区别是什么',
  'what is', 'why does', 'explain', 'difference between', 'how does',
];

// 明确的技术对象。弱动词（开发/实现/设计/调整）只有配上这些对象才算动手，
// 否则「实现思路」「设计文档」这类名词短语会被误判。
const CODE_MARKERS = [
  '```', '文件', '目录', '函数', '类 ', '模块', '插件', '测试', '报错', '日志',
  '.js', '.ts', '.py', '.java', '.rs', '.json', '.md', 'node --test', 'npm ', 'pnpm ',
  '接口', '通道', '机制', '逻辑', '流程', '服务', '组件', '配置', '能力', '行为',
  '规则', '策略', '字段', '参数', '钩子', '事件', '状态', '边界', '权限', '缓存',
  '队列', '会话', '上下文', '提示词', '工具',
];

// 以这些词开头通常是「说清楚就行」的请求：整理现状、讲解代码、评估风险，都不动实现。
const READONLY_OPENERS =
  /^(整理|梳理|说明|介绍|解释|总结|盘点|评估|讲解|列出|看看|查看|显示|有哪些|讲讲|谈谈|说说|分析|讨论|检查|复查|对比|回顾|核对|了解|调研|判断|统计)/u;
// 但句子里出现明确动作时仍算实现任务：「整理一下代码然后修复这个 bug」。
const CONCRETE_ACTIONS =
  /(修复|修好|重构|迁移|改造|替换|接入|集成|升级|改掉|改成|改为|改一下|补上|补齐|补充|补一段|加上|加个|加一个|新增|添加|删除|移除|优化|写一个|写个|补测试|加测试)/u;
// 请求以明确动作开头：这时动作就是主句谓语，不再按「名词短语」处理。
const ACTION_AT_START =
  /^(修复|修好|重构|迁移|改造|替换|接入|集成|升级|改掉|改成|改为|改一下|修改|补上|补齐|补充|补一段|加上|加个|加一个|新增|添加|删除|移除|优化|写一个|写个|补测试|加测试|实现|开发|设计|调整|implement|fix|refactor|migrate|rename|upgrade|optimi[sz]e|add |remove |delete |update |create |build |wire )/iu;
// 「实现思路」「设计文档」是名词短语；「实现这个方案」则是明确的执行请求。
const NOMINAL_ACTION_PREFIX = /^(设计|开发|实现)\s*(文档|计划|规划|方案|思路|说明|指南|方式|方法|原理|细节)/u;
// 句首动作后跟这些词，通常是在评估/讨论，不是在执行（实现上有什么取舍、优化建议）。
const NOMINAL_TAIL =
  /(建议|思路|取舍|利弊|优缺点|方式|方法|原理|影响|意义|可行性|规范|思考|多久|多长时间|工期|工作量)/u;
// 「帮我修复」「请你优化」这类是明确的执行请求，不是只读讨论。
const EXPLICIT_IMPERATIVE =
  /(帮我|请你|麻烦你|给我)\s*(修复|修好|重构|迁移|改造|替换|接入|集成|升级|改掉|改成|改为|改一下|修改|补上|补齐|补充|加上|加个|加一个|新增|添加|删除|移除|优化|实现|开发|设计|调整|写)/u;
// 疑问、建议、思路类框架：出现时按说明类请求处理，除非同时出现执行序列或任务结构。
const SPECULATIVE =
  /(如何|怎么|怎样|为什么|为何|能不能|可不可以|能否|要不要|该不该|是否|有没有|值不值得|建议|思路|是什么|怎么理解|有什么区别|可行性|利弊|取舍|优缺点|多久|多长时间|工期|工作量|思考|can we|could we|should we|would it|how to|how can|is it possible|do we need|what is|why does|difference between|suggest(?:ion)?|approach|trade-?off)/iu;
// 任务说明结构：出现时说明这是一份执行要求，而不是随口问问。
const TASK_STRUCTURE =
  /(\*\*目标\*\*|(^|[\s，。；;])目标[:：]|验收|(^|[\s，。；;])要求[:：]|(^|[\s，；;])约束[:：]|完成标准|需要你|请你在|务必|必须)/u;
// 执行序列：「整理一下然后修复」不是只读请求。
const EXECUTION_SEQUENCE =
  /(然后|接着|随后|顺便|并且|并|再|直接|立即|马上|先[^。；;\n]{0,40}再|and then|\bthen\b|after that)/iu;
// 英文只读开场：explain / review / analyze 等。
const ENGLISH_READONLY =
  /^(explain|tell me|show me|list|where|what|why|how|review|analy[sz]e|discuss|compare|summari[sz]e|describe|inspect|walk me)\b/iu;

/** 冒号后面直接跟执行动作：例如「检查一下：优化 Praxis 的提示注入机制」。 */
function executionAfterColon(raw) {
  const match = /[:：]\s*([\s\S]{0,200})/u.exec(raw);
  if (!match) return false;
  const after = match[1].trim();
  return ACTION_AT_START.test(after) && !NOMINAL_ACTION_PREFIX.test(after);
}

/**
 * 只做粗分类：拿不准时返回 uncertain，调用方不注入。
 * 纯问答、只读查询、规划讨论都不注入；只有明确的动手意图才注入。
 */
export function classifyRequest(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return 'uncertain';
  // 只认识 /help 这类命令，不要把绝对路径 /src/store.js 当成命令。
  if (/^\/[a-z][\w-]*(?:\s|$)/i.test(raw)) return 'not_applicable';
  // 用户明确说只读/不要改时，不让后面的动作词把它翻案。
  if (READONLY_DIRECTIVE.test(raw)) return 'not_applicable';

  const hasAction = ACTION_VERBS.some((verb) => raw.includes(verb)) || ENGLISH_ACTION.test(raw);
  const hasWeak = WEAK_VERBS.some((verb) => raw.includes(verb));
  const hasQuestion = QUESTION_MARKERS.some((marker) => raw.toLowerCase().includes(marker.toLowerCase()));
  const hasCode = CODE_MARKERS.some((marker) => raw.toLowerCase().includes(marker.toLowerCase()));
  const speculative = SPECULATIVE.test(raw);
  const execution = EXECUTION_SEQUENCE.test(raw);
  const taskStructure = TASK_STRUCTURE.test(raw);

  // 明确的执行指令优先于只读措辞：「检查一下：优化…」是要动手，「分析一下如何修复」才是讨论。
  if (executionAfterColon(raw)) return 'applicable';
  if (EXPLICIT_IMPERATIVE.test(raw)) return 'applicable';

  // 先看意图：整理/分析/讨论类请求即使在说「开发」「实现」，也是在说事、不是动手。
  // 例：「整理一下你目前对这个项目的了解和开发规划」曾被「开发」判成实现任务并注入提醒。
  if (READONLY_OPENERS.test(raw)) {
    if (speculative) return 'not_applicable';
    const hasChange = CONCRETE_ACTIONS.test(raw) || WEAK_VERBS.some((verb) => raw.includes(verb));
    if (hasChange && (execution || taskStructure)) return 'applicable';
    return 'not_applicable';
  }

  // 动作在句首是主句谓语；但「设计文档」「实现思路」「优化建议」「实现上有什么取舍」
  // 仍是名词短语或评估请求。
  const weakNominal =
    /^(开发|设计)/u.test(raw) && NOMINAL_CONTEXT.test(raw) && !/(这个|该|此|新)/u.test(raw);
  if (
    ACTION_AT_START.test(raw) &&
    !NOMINAL_ACTION_PREFIX.test(raw) &&
    !NOMINAL_TAIL.test(raw) &&
    !weakNominal
  ) {
    return 'applicable';
  }
  if (ENGLISH_READONLY.test(raw)) {
    if (execution && hasAction) return 'applicable';
    return 'not_applicable';
  }
  // 「给我一些优化建议」「这个 bug 的修复思路是什么」在讨论方案，不是在动手。
  // 疑问/建议框架优先于「直接/立即」这类执行副词。
  if (speculative && !taskStructure) return 'not_applicable';
  if (hasAction) return 'applicable';
  if (NOMINAL_CONTEXT.test(raw)) return 'not_applicable';
  if (hasQuestion && !hasCode) return 'not_applicable';
  // 「实现这个函数」这类：泛动词 + 具体代码对象才算动手。
  if (hasWeak && hasCode) return 'applicable';
  return 'uncertain';
}

/**
 * 本轮最后一条有效的用户意图。
 *
 * 同一轮可能有多条消息（排队输入、父代理消息、用户的更正）。只看最后一条有效
 * 文本：用户先说「修复」再更正「只读分析」时，不能拿前一条去触发改动提醒；子代理
 * 的返程指引剥掉后为空时继续往前找任务本身。
 */
function lastUserIntent(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const content = message.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
    }
    const cleaned = stripHostNoise(text).trim();
    if (cleaned !== '') return cleaned;
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

/** 本会话最近更新的 open 任务；有多个时只诊断最近的那个，不替模型选。 */
function openTaskOf(state, sessionId) {
  let latest = null;
  for (const task of state.tasks) {
    if (!task || task.status !== 'open' || task.sessionId !== sessionId) continue;
    if (!latest) {
      latest = task;
      continue;
    }
    const at = task.updatedAt ?? '';
    const latestAt = latest.updatedAt ?? '';
    if (at > latestAt) latest = task;
  }
  return latest;
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

/**
 * 只做粗略诊断：具体门槛由 praxis_task close 判定，这里用于决定是否提醒。
 *
 * 复用 engine 的 readinessOf，并按「如果按 complete 结项」预演；返回稳定的缺口
 * 类别 codes，供提醒去重使用，证据 ID/摘要只进正文，不参与签名。
 */
function closureGaps(task, state) {
  const { blockers, codes } = readinessOf(task, 'complete');
  const gaps = blockers.map((text, index) => ({ code: codes[index], text }));
  if (codes.includes('uncovered') || codes.includes('stale')) {
    const evidence = usableEvidenceOf(state, task);
    if (evidence) {
      gaps.push({
        code: 'usable-evidence',
        text: `已有可用证据 ${evidence.id}：${clip(evidence.resultSummary, 80)}，verify 直接引用即可`,
      });
    }
  }
  return gaps;
}

function closureReminder(hint) {
  if (!hint.pending) {
    // 旧版本写入的 closureHint 没有 codes，可能只检查过「有任意 passed」；不要沿用
    // 那个宽门槛声称已经满足 close(done)，只提醒按真门槛确认。
    const confirmed = Array.isArray(hint.codes);
    return [
      confirmed
        ? `[Praxis] 上一轮结束时任务 ${hint.taskId} 已满足 close(done) 的门槛（阶段 verify）。`
        : `[Praxis] 上一轮结束时任务 ${hint.taskId} 未检测到旧版诊断中的缺口，但旧版门槛不等于 close(done) 门槛。`,
      confirmed
        ? '确认工作确实完成后用 praxis_task close(outcome=done, implementationStatus=complete) 结项；'
        : 'close(done) 前请按验收覆盖、当前 revision、人工验收项与待复核写入逐项确认；',
      '如果实际还有人工验收或未完成项，用 close(partial, complete, awaiting_manual) 或 step/need 说明，不要谎报 done。',
    ].join('');
  }
  return [
    `[Praxis] 上一轮结束时任务 ${hint.taskId} 仍未闭环：${hint.detail.join('；')}。`,
    '如果这一轮确实完成了工作，用 praxis_task verify 引用观察 ID 后 close；',
    '如果还没完成，用 step 推进阶段或用 need 记录下一步，不要只在回复里口头收尾。',
  ].join('');
}

/** 同一任务、同一组缺口类别只提醒一次；证据 ID/摘要变化不算新缺口。 */
function closureSignature(hint) {
  const stable = hint.codes ?? hint.detail ?? [];
  return `${hint.taskId}|${hint.phase ?? ''}|${stable.join(',')}`;
}

// 宁可漏提示，也不要每轮催检索：触发条件没有具体锚点重合就不提，把调用机会留给模型自己判断。
const LESSON_HINT_LIMIT = 1;
const STRONG_TOKEN_MIN = 4;
const CJK_HIT_MIN = 2;
const CJK_TRIGRAM_MIN = 1;
// 占比的分母要封顶：请求越长，二元组数量越线性增长，同样命中关键词反而被稀释。
// 这个比值只参与排序，不再作为单独门槛——门槛靠三元组锚点和英文标识符。
const CJK_RATIO_SPAN = 30;
// 用户请求常常是一整份任务说明，后半段的约束/验收词会把主题稀释。只看前 800 字：
// 意图与关键对象通常都在这段里，尾部不再参与噪声打分。
const LESSON_QUERY_LIMIT = 800;

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
  // DSH 自己的通用词：每条经验都在讲 DSH/Cordis 插件，`agent` 这种词不能当主题锚点；
  // `step`/`pre` 是 pre-step 拆出来的通用片段，只保留整体 `pre-step` 作为锚点。
  // cordis 和平台词同样几乎出现在所有经验里，不能只凭它们命中。
  'agent', 'agents', 'plugin', 'plugins', 'harness', 'dsh', 'step', 'steps', 'pre',
  'cordis', 'windows', 'win32', 'linux', 'macos', 'darwin',
  'state', 'error', 'errors', 'event', 'events', 'hook', 'hooks', 'loop', 'config', 'configs',
]);

// 同样跨领域的中文二元组：命中它们不代表任务和某条经验有关。
const STOP_BIGRAMS = new Set([
  '实现', '文件', '数据', '状态', '需要', '当前', '一个', '我们', '可以', '这个', '进行',
  '使用', '处理', '问题', '并且', '不是', '已经', '任务', '记录', '之后', '然后', '如果',
]);

// 三元组比二元组具体得多：两个互不相关的任务很难恰好共享「单文件」「宿主服务」这种
// 带对象的三字片段。这里只剔除纯功能词和「检查一/查一下」这类句式模板；条目必须是
// 真正的三字片段，否则 cjkTrigrams 永远不会匹配到它。
const STOP_TRIGRAMS = new Set([
  '实现一', '现一个', '个功能', '检查一', '查一下', '是什么', '为什么', '的时候',
  '任务记', '是一个', '一个功', '这个功', '功能需', '需要多', '多长时',
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

/** 英文标识符切成强词：整体、按 / 分出的路径段、再按 . : _ - 拆开，
 * 让 agent/pre-step、pre-step、step 三者既互相可见，又能单独过滤通用片段。 */
function strongTokens(text) {
  const found = String(text ?? '').toLowerCase().match(/[a-z][a-z0-9_.:/-]{2,}/g) ?? [];
  const tokens = new Set();
  const add = (token) => {
    if (token.length >= STRONG_TOKEN_MIN && !STOP_TOKENS.has(token)) tokens.add(token);
  };
  for (const token of found) {
    add(token);
    for (const segment of token.split('/')) {
      add(segment);
      for (const part of segment.split(/[._:-]+/)) add(part);
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

/** 中文三元组：经验推荐的主题锚点，避免只用「检查」「实现」这类通用二元组凑分。 */
function cjkTrigrams(text) {
  const runs = String(text ?? '').match(/[\u4e00-\u9fa5]+/g) ?? [];
  const grams = new Set();
  for (const run of runs) {
    for (let index = 0; index + 3 <= run.length; index += 1) {
      const gram = run.slice(index, index + 3);
      if (!STOP_TRIGRAMS.has(gram)) grams.add(gram);
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
  // 只看 trigger（「何时适用」），不看经验正文：正文里的 revision、observation 等
  // 术语会把与主题无关的经验拉进提示。
  const haystack = String(lesson.trigger ?? '');
  const lessonTokens = strongTokens(haystack);
  const sharedTokens = [...strongTokens(text)].filter((token) => lessonTokens.has(token));
  const grams = cjkBigrams(text);
  const cjkHits = overlapCount(grams, cjkBigrams(haystack));
  const cjkRatio = grams.size === 0 ? 0 : cjkHits / Math.min(grams.size, CJK_RATIO_SPAN);
  const trigramHits = overlapCount(cjkTrigrams(text), cjkTrigrams(haystack));
  return {
    sharedTokens,
    strongHits: sharedTokens.length,
    cjkHits,
    trigramHits,
    cjkRatio,
    lexical: relevance(text, haystack),
  };
}

/** 只挑真的对得上的活跃经验；项目经验必须同项目，全局经验都可见。 */
export function matchingLessons(state, projectKey, text) {
  const query = stripHostNoise(text).slice(0, LESSON_QUERY_LIMIT);
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
    // 英文标识符一个够独特就成立；中文必须至少共享一个三元组，且至少两个二元组。
    // 只重合「检查」「实现」「验证」这类通用二元组不再算相关——这正是误报的来源。
    const anchored = score.trigramHits >= CJK_TRIGRAM_MIN && score.cjkHits >= CJK_HIT_MIN;
    if (score.strongHits === 0 && !anchored) continue;
    hits.push({
      lesson,
      score: score.strongHits * 3 + score.trigramHits * 2 + score.cjkRatio + score.lexical * 0.5,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, LESSON_HINT_LIMIT);
}

function lessonHintMessage(hits) {
  const hit = hits[0];
  const trigger = clip(String(hit.lesson.trigger ?? '（无触发条件）').replace(/\s+/g, ' ').trim(), 160);
  const gist = clip(String(hit.lesson.lesson ?? '').replace(/\s+/g, ' ').trim(), 180);
  return [
    '[Praxis] 错题本里有一条经验的触发条件与本次请求有具体重合，先判断是否适用，再决定要不要检索：',
    `- 何时适用：${trigger}`,
    `- 经验结论：${gist}`,
    `  需要细节时用 praxis_lesson search 查 ${hit.lesson.id}；触发条件不成立就忽略，不要为了检索而检索。`,
    '经验是过往证据，不等于当前事实。',
  ].join('\n');
}

/** 接线失败时返回的 dispose 上带 degraded 字段，调用方据此报告降级而不是假装启用。 */
export function attachLifecycle(ctx, store) {
  const disposers = [];
  const degraded = [];
  const warnings = [];

  const systemPrompt = resolveService(ctx, 'systemPrompt');
  const on = typeof ctx?.on === 'function' ? ctx.on.bind(ctx) : null;

  if (systemPrompt && typeof systemPrompt.section === 'function') {
    try {
      const remove = systemPrompt.section({
        name: 'praxis',
        order: 9500,
        text: GUIDANCE,
        interpolate: false,
      });
      if (typeof remove === 'function') disposers.push(remove);
    } catch {
      degraded.push('system-prompt');
    }
  } else {
    degraded.push('system-prompt');
  }

  // 动态提示走宿主的运行时上下文通道：不进消息流、不伪装成用户发言，
  // 且每次请求前由 refreshContext 重新求值，所以本轮就能看到 pre-step 刚写入的文本。
  //
  // 这里先在全局作用域注册一份兜底：宿主在 assemble 时会传入当前 agent（或 agent 作
  // 为 scope），旧宿主、热加载后尚未补注册的 agent 都能靠它取到自己的提示。
  if (systemPrompt && typeof systemPrompt.context === 'function') {
    try {
      const remove = systemPrompt.context({
        name: HINT_CONTEXT_NAME,
        order: HINT_CONTEXT_ORDER,
        interpolate: false,
        text: (context) => {
          const agent = context?.agent ?? context?.scope;
          const sessionId =
            typeof agent?.id === 'string'
              ? agent.id
              : typeof agent?.session?.id === 'string'
                ? agent.session.id
                : '';
          return sessionId ? hintOf(store.read(), sessionId) : '';
        },
      });
      if (typeof remove === 'function') disposers.push(remove);
    } catch {
      degraded.push('prompt-context');
    }
  } else {
    degraded.push('prompt-context');
  }

  // 每个 agent 的会话级注册：注册落在 agent.ctx 的 scope 里，闭包绑定 session id。
  // 这是宿主文档化的用法（通过 agent.ctx 注册只影响该 agent），父子代理互不串扰；
  // 也不再依赖 context 回调里未类型化的 agent 字段。
  const scopedHints = new Map();
  const registerAgent = (agent) => {
    const sessionId = typeof agent?.id === 'string' ? agent.id : '';
    if (!sessionId) return;
    const existing = scopedHints.get(sessionId);
    if (existing?.agent === agent) return;
    // 同一 session id 换成新 agent（setup 回滚后重建）时，先撤掉旧 scope 的注册。
    if (existing) {
      scopedHints.delete(sessionId);
      try {
        existing.remove();
      } catch {
        // 旧 scope 可能已经被宿主销毁
      }
    }
    const agentCtx = agent.ctx;
    if (!agentCtx) return;
    const prompt = resolveService(agentCtx, 'systemPrompt');
    if (!prompt || typeof prompt.context !== 'function') return;
    try {
      const remove = prompt.context({
        name: HINT_CONTEXT_NAME,
        order: HINT_CONTEXT_ORDER,
        interpolate: false,
        text: () => hintOf(store.read(), sessionId),
      });
      scopedHints.set(sessionId, {
        agent,
        remove: typeof remove === 'function' ? remove : () => {},
      });
    } catch {
      // 同名同 scope 已注册（热加载）或宿主拒绝：全局兜底仍然可用。
      if (!warnings.includes('agent-scope')) warnings.push('agent-scope');
    }
  };
  const unregisterAgent = (agent) => {
    const sessionId = typeof agent?.id === 'string' ? agent.id : '';
    const entry = sessionId ? scopedHints.get(sessionId) : null;
    if (!entry || entry.agent !== agent) return;
    scopedHints.delete(sessionId);
    try {
      entry.remove();
    } catch {
      // 已释放
    }
  };

  if (!on) {
    degraded.push('hooks');
  } else {
    // agent/created 是宿主文档化事件：等 agent.ctx 就绪后再注册会话级上下文。
    try {
      disposers.push(on('agent/created', (payload) => registerAgent(payload?.agent)));
      disposers.push(on('agent/disposed', (payload) => unregisterAgent(payload?.agent)));
    } catch {
      degraded.push('agent-scope');
    }
    // 热加载时已有 agent 不会再触发 created，补注册当前活着的 agent。
    const agents = resolveService(ctx, 'agents');
    if (agents && typeof agents.list === 'function') {
      try {
        for (const agent of agents.list()) registerAgent(agent);
      } catch {
        // 拿不到活 agent 列表就继续用全局兜底
      }
    }

    try {
      const removePreStep = on('agent/pre-step', async (payload, next) => {
        try {
          const sessionId = payload?.agent?.id;
          const turn = payload?.turn;
          if (!sessionId || typeof turn !== 'number') return next();
          // 只在本轮第一个模型步骤决定本轮提示；后续 step 沿用同一段文本，不重复计算。
          if (typeof payload.step === 'number' && payload.step > 1) return next();

          const requestText = lastUserIntent(payload.messages);
          const applicable = classifyRequest(requestText) === 'applicable';
          const { projectKey } = sessionContext(ctx, sessionId);

          await store.mutate((state) => {
            const session = sessionOf(state, sessionId);

            // 只读、问答、规划、讨论类请求不提示：清掉上一轮残留的提示。
            // 未闭环提醒留到下一次明确开发请求再给，不在讨论时催收尾。
            if (!applicable) {
              session.praxisHint = null;
              return;
            }

            // 同一轮已经决定过提示：保留原文，不因重复 pre-step 清掉或重算。
            if (session.lastReminderTurn === turn && typeof session.praxisHint === 'string' && session.praxisHint !== '') {
              return;
            }
            // 本轮重新决定提示：先清掉上一轮的残留，再由下面任一条分支写入。
            session.praxisHint = null;

            // 闭环提醒优先：上一轮结束时任务还开着，就具体点出缺什么；
            // 已经满足关闭条件时提醒 close，而不是继续沉默。
            // 同一任务、同一组缺口只提醒一次；缺口变化后才值得再说一遍。
            const pendingClosure = session.closureHint;
            if (pendingClosure && pendingClosure.taskId) {
              const signature = closureSignature(pendingClosure);
              session.closureHint = null;
              if (session.lastClosureSignature !== signature) {
                session.lastClosureSignature = signature;
                session.lastReminderTurn = turn;
                session.closureReminderCount = (session.closureReminderCount ?? 0) + 1;
                session.reminderCount = (session.reminderCount ?? 0) + 1;
                // 闭环提醒也占用通用提醒配额：一个会话不再额外补一条泛泛的改动提醒。
                session.genericReminderCount = Math.max(session.genericReminderCount ?? 0, 1);
                session.praxisHint = clip(closureReminder(pendingClosure), 1000);
              }
              // 缺口没变就不再重复提醒；也不退化成通用提醒。
              return;
            }

            // 相关经验：整个会话只提一次。触发条件没有具体锚点重合就不提，
            // 宁可漏提示，也不把主题相近但用不上的经验塞进来。
            if (!session.lessonHintShown) {
              const hits = matchingLessons(state, projectKey, requestText);
              if (hits.length > 0) {
                session.lessonHintShown = true;
                session.lessonHintCount = (session.lessonHintCount ?? 0) + 1;
                session.lastReminderTurn = turn;
                session.reminderCount = (session.reminderCount ?? 0) + 1;
                session.praxisHint = clip(lessonHintMessage(hits), 1000);
                return;
              }
            }

            // 通用提醒每个会话只提一次：系统提示里已有完整指引，这里重复刷屏没有价值。
            // 已经给过更具体的经验提示时，也不再补一条通用提醒。
            if (session.lessonHintShown || (session.genericReminderCount ?? 0) > 0) {
              session.praxisHint = null;
              return;
            }
            session.genericReminderCount = 1;
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
              session.lastClosureSignature = null;
              return;
            }
            const gaps = closureGaps(task, state);
            session.closureHint = {
              taskId: task.id,
              pending: gaps.length > 0,
              detail: gaps.map((gap) => gap.text),
              codes: gaps.map((gap) => gap.code),
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
    for (const entry of scopedHints.values()) {
      try {
        entry.remove();
      } catch {
        // 已释放
      }
    }
    scopedHints.clear();
  };
  dispose.degraded = degraded.length > 0 ? degraded.join(',') : null;
  dispose.warnings = warnings;
  return dispose;
}

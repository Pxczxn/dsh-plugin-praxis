// 两个模型工具的 schema 与执行适配层。规则在 src/engine.js。
import { PraxisError } from './evidence.js';

export const TASK_NAME = 'praxis_task';
export const LESSON_NAME = 'praxis_lesson';

export const TASK_DESCRIPTION = `记录一个开发任务的调查判断、阶段、验证与结项。用于非平凡代码任务；只读、讨论、规划不必调用。

动作：
- start(goal, acceptance[]?, projectKey?)：创建任务；可先不登记验收项，但没有活跃验收项不能 close(done)
- need(task_id, target, decision, evidence)：记录对一个改动目标的复用判断（reuse/extend/new）与调查依据；need 是调查后的结论，不是待调查清单，未查清不要先填 decision 占位，也不要为数量或形式完整登记；独立决策目标分别记录，判断/证据/处理一致的可合并但 target 要写明覆盖范围；new 要说明检查过的现有能力及不适用原因；结论形成后把未确认范围写进 plan；弱证据会被警告且不能通过进入实现的门槛
- inventory(task_id, needs[]?, acceptance[]?, change_reason?)：批量调整调查结论和验收项；needs 的粒度规则同 need；修改验收项必须给 change_reason
- step(task_id, phase, note?)：understand → implement → verify 前进或回退；回退必须给 note
- verify(task_id, level, scope, coverage[], evidence?, note?)：把验证结果映射到验收项；passed 的每一项必须引用宿主观察 ID（先用 status 查看候选）
- close(task_id, outcome, implementationStatus, closureReason?, note?, lesson?, lesson_id?)：done 需要当前 revision 对全部活跃验收项有可信通过记录；等待人工验收用 partial + complete + awaiting_manual
- status(task_id?)：概览或详情；详情含候选观察、未覆盖验收项、待复核写入
- summary()：跨任务只读概览——阶段/结局/项目计数、未结任务及其收尾阻碍、经验与观察统计；不改变任何状态

响应含 ok/code/data/warnings。所有变更动作可用 request_id 获得一次性幂等重试。插件只记录与提醒，不能证明业务正确性。`;

export const LESSON_DESCRIPTION = `沉淀、检索、修订、退役可复用的工程经验（错题本）。

动作：
- search(query, projectKey?, tag?, scope?, limit?)：只读检索，默认 5 条、最多 20；不改变排序权重；结果是调查线索而非当前事实
- save(scope, trigger, lesson, evidence, reusable_because, projectKey?, tags?, source_task?, supersedes?, observationIds?, difference_reason?)：只接受可复核证据；重复/近似重复会被拦截或提示
- update(lesson_id, reason, ...fields)：保留修订原因与差异；冲突时拒绝而非覆盖
- retire(lesson_id, reason)：保留退役原因与历史

经验必须能回答：何时适用、已证实什么、证据在哪里、为什么可能再次遇到。`;

const acceptanceItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: '已存在验收项的稳定 ID；新项可省略' },
    text: { type: 'string', description: '可判定的验收目标' },
    source: { type: 'string', enum: ['user_explicit', 'agent_proposed'] },
    kind: { type: 'string', enum: ['automated', 'manual'] },
    active: { type: 'boolean', description: 'false 表示停用（必须给 change_reason）' },
  },
};

const needItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string' },
    decision: { type: 'string', enum: ['reuse', 'extend', 'new'] },
    evidence: { type: 'string', description: '文件:行号、命令与关键输出' },
    plan: { type: 'string' },
    observationIds: { type: 'array', items: { type: 'string' } },
  },
};

const coverageItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    criterionId: { type: 'string' },
    result: { type: 'string', enum: ['passed', 'partial', 'blocked', 'not_run'] },
    observationIds: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
};

const lessonInput = {
  type: 'object',
  additionalProperties: false,
  description: 'close 时顺带沉淀一条经验；失败时任务不会关闭',
  properties: {
    scope: { type: 'string', enum: ['global', 'project'] },
    trigger: { type: 'string' },
    lesson: { type: 'string' },
    evidence: { type: 'string' },
    reusable_because: { type: 'string' },
    projectKey: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    observationIds: { type: 'array', items: { type: 'string' } },
    difference_reason: { type: 'string' },
    supersedes: { type: 'string' },
  },
};

export const TASK_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['start', 'need', 'inventory', 'step', 'verify', 'close', 'status', 'summary'],
    },
    task_id: { type: 'string' },
    goal: { type: 'string' },
    projectKey: { type: 'string' },
    parentTaskId: { type: 'string' },
    acceptance: { type: 'array', items: acceptanceItem },
    request_id: { type: 'string', description: '同一组参数重试时复用，避免重复创建' },
    target: { type: 'string' },
    decision: { type: 'string', enum: ['reuse', 'extend', 'new'] },
    evidence: { type: 'string' },
    plan: { type: 'string' },
    needs: { type: 'array', items: needItem },
    change_reason: { type: 'string' },
    phase: { type: 'string', enum: ['understand', 'implement', 'verify'] },
    note: { type: 'string' },
    level: { type: 'string', enum: ['passed', 'partial', 'blocked', 'not_run'] },
    scope: { type: 'string' },
    coverage: { type: 'array', items: coverageItem },
    observationIds: { type: 'array', items: { type: 'string' } },
    outcome: { type: 'string', enum: ['done', 'partial', 'abandoned'] },
    implementationStatus: {
      type: 'string',
      enum: ['unknown', 'complete', 'incomplete', 'not_applicable'],
    },
    closureReason: {
      type: 'string',
      enum: ['awaiting_manual', 'verification_missing', 'implementation_incomplete', 'other'],
    },
    lesson: lessonInput,
    lesson_id: { type: 'string' },
    observation_limit: { type: 'number' },
    observation_cursor: { type: 'number' },
  },
  required: ['action'],
};

export const LESSON_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['search', 'save', 'update', 'retire'] },
    query: { type: 'string' },
    projectKey: { type: 'string' },
    tag: { type: 'string' },
    scope: { type: 'string', enum: ['global', 'project'] },
    limit: { type: 'number' },
    trigger: { type: 'string' },
    lesson: { type: 'string' },
    evidence: { type: 'string' },
    reusable_because: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    source_task: { type: 'string' },
    supersedes: { type: 'string' },
    observationIds: { type: 'array', items: { type: 'string' } },
    difference_reason: { type: 'string' },
    request_id: { type: 'string' },
    lesson_id: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['action'],
};

const TASK_FIELDS = new Set(Object.keys(TASK_PARAMETERS.properties));
const LESSON_FIELDS = new Set(Object.keys(LESSON_PARAMETERS.properties));

function ensureKnownFields(args, allowed) {
  for (const key of Object.keys(args ?? {})) {
    if (!allowed.has(key)) {
      throw new PraxisError('bad-action', `未知参数 ${key}`, {
        hint: `允许的参数：${[...allowed].join(', ')}`,
      });
    }
  }
}

export function createHandlers({ engine, context }) {
  const run = async (tool, args, exec) => {
    ensureKnownFields(args, tool === 'task' ? TASK_FIELDS : LESSON_FIELDS);
    const ctx = await context(exec);
    return tool === 'task' ? engine.task(ctx, args ?? {}) : engine.lesson(ctx, args ?? {});
  };
  return {
    task: (args, exec) => run('task', args, exec),
    lesson: (args, exec) => run('lesson', args, exec),
  };
}

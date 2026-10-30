# Praxis 设计稿 v0.2.1（契约收口版）

> 状态：**P0/P1 契约修订完成，待设计复审；未授权实施**。基于 `DESIGN(1).md` v0.1 与 `Praxis-DESIGN-v0.2.md` 修订；保留两个工具和总体架构。本文仅定义预期行为，**不代表已实现、已在 DSH 0.2.1-rc.2 验证或已获准修改用户项目**。

一个把「工程纪律」持久化的 DSH 插件：帮助 Agent 在修改前调查并判断 `reuse` / `extend` / `new`，在结项时区分验证声明与真实可追溯证据，并把经检验、值得复用的经验沉淀为可检索、可修订的记录。

## 1. 定位与边界

Praxis 是**开发流程的记录、提醒与有限门禁层**，不是任务调度器，也不能仅凭文本证明代码正确。

1. **理解需求**：调查现状，对计划改动的目标记录复用、扩展或新增判断，以及调查依据。
2. **执行与自校正**：记录阶段、回退、验证及其证据来源；避免旧验证被新实现继承。
3. **错题本**：只收录具有可复用价值和可追溯依据的经验，支持检索、修正、替代与退役。

**约束等级必须诚实区分：**

- **硬约束（插件自身可保证）**：工具输入校验、状态转移、存储完整性、经验关联、`close(done)` 的记录门槛。
- **软引导（不能保证模型服从）**：何时主动调用工具、先调查再改动、是否提供完整验收标准。依赖宿主生命周期扩展点提示和审计，不能宣传为强制执行。
- **插件无法直接证明的事实**：未经宿主观察到的命令是否运行、工具输出是否覆盖真实业务需求、所有修改是否都被捕获。此类情况必须标为未确认。

设计原则：纯函数规则尽量独立于 DSH；只写 Praxis 数据目录；默认低干扰、失败可恢复；不修改用户项目；不自动启动子代理、浏览器或测试；子代理与多会话不得串状态。

### 1.1 适用性

| 场景 | 预期处理 |
|---|---|
| 明确要求修改代码、修 Bug、实现功能、重构、配置或测试修复 | 适用；尝试引导开始/恢复任务 |
| 仅阅读、解释、代码审计、技术咨询、闲聊 | 默认不创建任务、不强制写经验；若用户明确要求记录，可以手动调用 |
| 需求含糊、尚处讨论阶段 | 不预建任务；可给一次轻量提示，不强行进入实现阶段 |
| 小改动 | 仍可记录，但允许一次批量 `inventory` 和最小化验证；不得制造多余阶段打卡 |
| 用户明确要求跳过 Praxis | 不强迫调用；只要未发生用户未授权的安全动作，不干预原任务 |

## 2. 核心能力与主动触发（P0-01）

| 要求 | 主工具 | 宿主支持行为 |
|---|---|---|
| 调查 → `reuse/extend/new` | `praxis_task.start/need/inventory` | 在适用任务开头提示复用判断；可观察是否遗漏 |
| 实现 → 验证 → 自校正 | `praxis_task.step/verify/close` | 观察工具结果、提醒检查验证失效；结束前有限提醒 |
| 经验召回与沉淀 | `praxis_lesson.search/save/update/retire` | 适用任务可提醒检索；结项时按价值判断是否沉淀，**不是每次必存** |

**保持两个模型工具、一个持久化状态文件。** 工具描述只是辅助发现，不能作为主动调用能力的验收依据。

### 2.1 触发路径（候选设计，须在目标 DSH 实测）

1. `ctx.systemPrompt.section()`：注入一段精简的职责说明；全局与子代理作用域的可见性分别验证，避免与 Axiom / 其他规则重复或覆盖。
2. `agent/pre-step`：根据本轮用户请求和当前会话状态，**保守**识别明显适用任务；每个任务或会话轮次至多提示一次，不在每个模型步骤重复注入。未知意图不自动升级为强制任务。
3. `tools/result`：在宿主实际提供会话、调用标识、执行结果及必要执行上下文时，采集可信观察并绑定任务；缺少必要字段时只记录诊断，不提升为可信来源。观察引用的查询、归属与消费详见第 3.3、4.3 节。
4. `agent/turn-stopping`：**不能把日志提示冒充已递交模型的提醒**。默认只记录缺口；可选 `steer_once` 模式才允许对明确适用且缺验证的任务续接**至多一个模型步骤**（有 Token/时延成本），仍不强制调用工具。相同任务轮次不再重复续接；具体行为见第 7 节。
5. 钩子缺失、工具不可见或宿主版本不兼容时：**降级为手动工具模式，显示能力缺口**；不得假装已自动介入。

触发规则应当可配置、可观察、可测试；启发式结果分 `applicable / not_applicable / uncertain`，**仅明确的 `applicable` 自动提醒**。适用性检测不得读取用户项目文件，不借故扫描所有历史会话。

### 2.2 行为评估而非调用刷量

记录必要的运行诊断：是否有明确适用任务、是否展示提示、是否实际调用 Praxis、是否生成可信验证记录、是否造成重复提示或错误干预。诊断仅存在于测试日志或有界的插件内部状态，默认不落整段对话或完整工具输出。

目标是**提高真实适用任务的自主使用率，同时减少误触发**；不能用“插件工具被列在工具清单里”或“自动弹过提示”冒充目标达成。盲测样本、预设发布阈值及基线对照见第 12.2 节。

## 3. 数据模型与身份边界

新设计文件格式为 `version: 2`，与 v0.1 示例的字段发生不兼容变化。迁移规则见第 8 节。

```jsonc
{
  "version": 2,
  "tasks": [{
    "id": "uuid",
    "goal": "一句话目标",
    "projectKey": "稳定的仓库/工作区标识；不能确定时为 null",
    "sessionId": "由宿主确定；无法取得则 null",
    "parentTaskId": null,
    "phase": "understand | implement | verify",
    "status": "open | closed",
    "revision": 0,
    "implementationStatus": "unknown | complete | incomplete | not_applicable",
    "reviewStatus": "unverified | verified | awaiting_manual | blocked",
    "acceptance": [{
      "id": "criterion-id",
      "text": "可判定的验收目标",
      "source": "user_explicit | agent_proposed",
      "kind": "automated | manual",
      "active": true
    }],
    "needs": [{
      "target": "改动目标",
      "decision": "reuse | extend | new",
      "evidence": "调查依据摘要",
      "evidenceStrength": "concrete | weak | none",
      "observationIds": ["observed-event-id"],
      "plan": "可空",
      "at": "ISO-8601"
    }],
    "verificationHistory": [{
      "id": "uuid",
      "level": "passed | partial | blocked | not_run",
      "scope": "本次验证覆盖的具体内容",
      "coverage": [{
        "criterionId": "criterion-id",
        "result": "passed | partial | blocked | not_run",
        "observationIds": ["observed-event-id"],
        "note": "如何判定对应目标，可空"
      }],
      "evidence": "命令与关键输出摘要",
      "evidenceStrength": "concrete | weak | none",
      "provenance": "observed | self_reported",
      "observationIds": ["observed-event-id"],
      "revision": 0,
      "valid": true,
      "note": "可空",
      "at": "ISO-8601"
    }],
    "corrections": [{ "at": "ISO-8601", "from": "verify", "to": "implement", "reason": "回退原因" }],
    "lessons": ["lesson-id"],
    "events": [{ "at": "ISO-8601", "kind": "start|need|advance|rewind|verify|invalidate|close", "detail": "..." }],
    "omittedEventCount": 0,
    "pendingChangeIds": ["observed-event-id"],
    "closedAs": "done | partial | abandoned | null",
    "closureReason": "awaiting_manual | verification_missing | implementation_incomplete | other | null",
    "createdAt": "ISO-8601",
    "updatedAt": "ISO-8601"
  }],
  "observations": [{
    "id": "observed-event-id",
    "sessionId": "由宿主取得的会话标识",
    "agentId": "由宿主取得的 Agent 标识；缺失则 null",
    "toolCallId": "宿主调用唯一标识；若无法取得则不得标为可信",
    "taskId": "捕获时唯一确定的活动任务；无法确定则 null",
    "revisionAtCapture": 0,
    "sequence": 1,
    "tool": "实际工具标识",
    "callSummary": "脱敏后的命令/检查目标/必要参数摘要",
    "at": "ISO-8601",
    "outcome": "success | failure | unknown",
    "exitCode": "可用时记录数值，否则 null",
    "kind": "read | write | test | build | lint | other",
    "changeImpact": "confirmed | possible | irrelevant | not_applicable",
    "resultSummary": "脱敏、截断的关键执行结果与测试统计",
    "digest": "规范化观察摘要的校验值，非安全签名"
  }],
  "requests": [{
    "key": "session/project + action + request_id",
    "payloadDigest": "规范化参数摘要",
    "resultRef": "结果主键或稳定结果摘要",
    "at": "ISO-8601"
  }],
  "lessons": [{
    "id": "uuid",
    "scope": "global | project",
    "projectKey": "project 时必填，global 时 null",
    "trigger": "适用条件",
    "lesson": "经验证的经验结论",
    "evidence": "可追溯证据摘要",
    "observationIds": ["observed-event-id"],
    "reusable_because": "复用价值",
    "tags": ["spring", "transaction"],
    "source_task": "task-id | null",
    "sourceSnapshot": "必要的来源摘要，防止历史引用过期",
    "supersedes": "lesson-id | null",
    "supersededBy": "lesson-id | null",
    "status": "active | retired | superseded",
    "retiredReason": "string | null",
    "revisions": [{ "at": "ISO-8601", "reason": "修订理由", "changes": {} }],
    "createdAt": "ISO-8601",
    "updatedAt": "ISO-8601"
  }]
}
```

上面 `observationIds` 指向同一个 `state.json` 内由宿主事件生成的 `observations`。**模型提交 ID 只能请求关联，不能创建、改写或指定观察来源。** 记录必须能跨重启查询和核对；`digest` 只是摘要一致性校验，不是独立执行证明。必要的调用身份、命令/目标摘要、状态或结果若缺失，则该记录不可用于 `observed` 门槛。仅保存脱敏且有长度限制的元数据，不持久化完整 stdout；被有效验证、经验或幂等结果引用的记录不能直接淘汰。

`implementationStatus` 表示**做到了什么**，`reviewStatus` 表示**验证到了什么程度**，两者必须分开；`closedAs=partial` 可同时记录 `implementationStatus=complete` 和 `closureReason=awaiting_manual`，不得因此把实施结果误报为未完成。`acceptance` 和 `coverage` 是记录的验收契约与证据映射，不保证插件本身可以判断业务含义。

### 3.1 身份及关联规则

- `projectKey` 优先使用宿主提供的稳定工作区/仓库标识；仅在明确拿到关联证据时才采用。无法确定则 `null`，不得把不同仓库都合并到 `unspecified` 项目。
- `sessionId`、观察事件归属由宿主获取，不允许模型通过自填字符串跨会话冒用。
- 子代理默认拥有独立的任务作用域；只有明确、可验证的 `parentTaskId` 关联才共享上下文。父代理的结项不能自动替子代理做可信验证。
- 项目经验必须绑定同一 `projectKey`；全局经验只有在确定适用范围时才允许保存，不因项目标识缺失自动升级为全局。
- `source_task` 只引用存在或留有来源快照的任务；`task.lessons` 与经验来源必须一致。批量操作失败不可留下半条关联。

### 3.2 验收项的来源、修订与稳定性（P0-01）

- 任务 `start` 可以提交 `acceptance[]`；如果当时尚不清楚，允许先启动，但**不能在没有验收项时 `close(done)`**。`inventory` 可以在完成调查后批量补充/修订验收项；只用现有两个工具，不新增工具。
- 每项有稳定 `id`、可判定文字、`user_explicit | agent_proposed` 来源、`automated | manual` 类型。`agent_proposed` 不等于用户已经批准；若存在实质需求歧义，Agent 应澄清，不能凭自行拟定的狭窄验收项宣称整个用户目标完成。
- 验收目标应能与 `goal`、明确用户约束相互对照；插件只能机械检查 ID、是否覆盖、是否存在矛盾，**不能自动证明这些条目已经完整表达用户意图**。交付报告必须保留这一限制。
- 验收项新增、删除、替换或从自动改为人工，必须留下理由和变更记录；已进入验证阶段时需显式回退，并使受影响的旧验证失效。不可通过删除未通过的验收项绕过 `close(done)`。
- `verify` 的 `coverage[]` 必须指向当前活跃验收项；每个结果记录真实观察 ID、检查结论及必要说明。当前 revision 内的**多次**有效 `verify` 可以合并覆盖，但一条 `passed` 不自动代表全部验收项已通过。
- 纯人工验收项在未取得可信的人类确认接入能力前，不能仅由模型自述判为可信 `passed`；可 `close(partial, implementationStatus=complete, closureReason=awaiting_manual)`，明确等待人工验收，不宣称缺少实现。

### 3.3 可信观察的归属、发现与生命周期（P0-02）

1. 宿主事件收集器仅在能取得**真实的 `sessionId`、可区分的 `toolCallId`、工具执行状态及必要调用/结果信息**时保存可用观察；为每条观察分配单调 `sequence` 和持久化 ID。捕获写入与去重原子进行；同一宿主调用重放不创建新观察。
2. 任务通过 `praxis_task.start` 与宿主会话绑定。会话中只有一个明确活动的 Praxis 任务时，可以将观察自动挂到该任务；多任务并行、父子代理或身份不明时，`taskId=null`，禁止猜测归属。子代理观察不能仅凭父代理的参数冒用。
3. `praxis_task.status(task_id)` 返回该任务最近候选观察的**ID、工具、动作/检查摘要、顺序、结果、可用于验证的原因或拒绝原因**；必要时有界分页。模糊归属的观察仅允许只读诊断，**不能由模型任意指定 `task_id` 来取得可信身份**。
4. `praxis_task.verify` 接收 `observationIds` 和逐项 `coverage`；插件按会话/任务作用域、revision、事件顺序、工具类型、执行状态校验，仅保留已脱敏的可复核**摘要**（非完整原文）。未传 ID 时可以返回候选，但不得自动把任何 exit 0 当作测试通过。
5. 观察采集时区分「工具执行成功」与「检查通过」；`echo passed`、`git status`、未知命令、无实际断言的操作只能作过程证据，不能作验收证明。聚合脚本若无可复核输出或无法知道其内部操作顺序，标为 `unknown`，不能硬升格。
6. `tools/result` 的实际字段、事件时序和子代理边界须在 **DSH 0.2.1-rc.2 真机**先验证；缺关键字段就禁用可信观察能力，继续允许手动记账，但不能绕过 `done` 的门槛。

### 3.4 容量及保留

沿用初始目标：任务 200 条、经验 400 条、单任务普通事件 40 条（**上限属于可配置的初始值，不是丢失历史的许可**）。

- 优先清理**未被经验引用**的已关闭任务；退役经验若被 `supersedes` 链引用，不能直接删除。
- 关键纠错、验证历史、修订记录不得因普通事件环形裁剪而丢失；普通事件裁剪须累计 `omittedEventCount`。
- 观察记录与 `requests` 幂等账本分别设容量/体积上限；只回收无任何任务、经验、验证或有效幂等承诺引用的过期记录。账本清理必须声明幂等保留窗口；**窗口到期后不保证重试仍返回原结果**，不得宣传无限期幂等。
- 若容量达到上限且不能安全回收，返回明确的 `capacity` 错误，**绝不删除活跃任务、有效经验或审计关联**。
- 每个字段及每次输出均须限制最大长度，敏感内容先脱敏后写入。

### 3.5 幂等账本和重试（P1-01）

- 所有变更动作均允许 `request_id`；对于容易重复创建的 `start`、`save`、`close` 尤其推荐提供。键包含宿主作用域、动作与 ID；规范化参数摘要不同而复用同一键时返回 `idempotency-conflict`。
- 在同一原子事务中写入业务变化及 `requests` 记录。**提交后、响应前崩溃**，同键重试返回原结果；**提交前崩溃**，重试正常执行一次。跨进程争锁仍按第 8 节处理。
- 不提供 `request_id` 的操作仅保证明确规定的业务级幂等（如不变 `step`、重复 `retire`），不承诺网络重试不重复。精确重复 `lesson.save` 可复用既有 ID。
- 已清理的幂等账本条目不能冒充仍受保护；存活对象引用及用户可预期的最短窗口由实现前的测试契约确定并公示，容量满且不能安全淘汰时拒写。

## 4. 工具一：`praxis_task`

动作保持：`start` · `need` · `inventory` · `step` · `verify` · `close` · `status`。

| 动作 | 必填 | 可选 | 语义与约束 |
|---|---|---|---|
| `start` | `goal` | `projectKey`、`parentTaskId`、`acceptance[]`、`request_id` | 创建任务；可先不给验收项但不能无验收项 `done`；关联父任务需校验；会话身份取自宿主 |
| `need` | `task_id`、`target`、`decision`、`evidence` | `plan`、`observationIds`、`request_id` | 按目标更新调查判断；保留修订轨迹；不能伪造 observed 身份 |
| `inventory` | `task_id` | `needs[]`、`acceptance[]`、`change_reason`、`request_id` | 原子批量调整调查结论和验收项；至少提供一组非空；验收项修改遵守回退与失效规则 |
| `step` | `task_id`、`phase` | `note`、`request_id` | 按状态转移表前进或回退；回退 `note` 必填 |
| `verify` | `task_id`、`level`、`scope`、`coverage[]` | `evidence`、`observationIds`、`note`、`request_id` | 每次验证映射到验收项；插件确认观察来源、顺序与范围；`passed` 不能与各项结果矛盾 |
| `close` | `task_id`、`outcome`、`implementationStatus` | `closureReason`、`note`、`lesson`、`lesson_id`、`request_id` | 实施状态与验证状态分开记录；`done` 严格门槛；等待人工验收用 `partial + complete + awaiting_manual` |
| `status` | — | `task_id`、`observation_limit`、`observation_cursor` | 概览或详情；有任务时列有界候选观察、可用/不可用原因、未覆盖验收项、过期验证与不确定写入 |

工具响应统一包含 `ok`、`code`、`data`、`warnings[]`、`next_hint`（仅需要时）。**有 `request_id` 的重复请求按第 3.5 节幂等；没有请求 ID 仅保证指定操作的业务级幂等。** 未知参数、非法状态与跨会话伪造关联返回明确错误，不静默忽略关键输入。`praxis_lesson` 的变更动作也允许 `request_id`。

### 4.1 合法状态转换

| 当前阶段 | 目标阶段/操作 | 条件 |
|---|---|---|
| `understand` | `implement` | 至少有一个已说明 target、decision 和具体调查依据的 need；仅凭弱证据不可通过该门槛 |
| `understand` | `verify` | 仅允许无需实现的任务；必须有验收项与无实现理由，跳过原因须留痕 |
| `implement` | `verify` | 已有可识别的验收项；执行 `verify` 时可自动前进，并绑定本轮 revision |
| `implement` | `understand` | 必须记录回退理由；使旧验证失效 |
| `verify` | `implement` 或 `understand` | 必须记录回退理由；使旧验证失效 |
| 任意未关闭阶段 | `close(partial/abandoned)` | 必须说明剩余事项/终止原因，不暗示完成 |
| `verify` | `close(done)` | 满足第 4.3 节严格门槛 |
| `closed` | 改动/验证/再结项 | 拒绝；新任务须单独创建并可关联旧任务 |

阶段重复设为当前值时应幂等，不写伪回退。`need` 在已进入 `verify` 后不得更新，必须先显式回退。`verify` 返回 `partial` / `blocked` 时只给出回退建议，不自动修改代码或创建新的任务。

### 4.2 验证绑定、写入分级与失效（P0-03）

`revision` 是 Praxis 的**逻辑实施轮次**（非 Git commit、文件指纹或全系统写入追踪）。首次进入实施、回退重做、实质修改调查判断或验收项，递增 revision；原样重复调用不递增。每条验证保存创建时 revision 与观察事件的最后 `sequence`，历史不覆盖。

| 观察到的后续操作 | 判定 | 对旧验证的影响 |
|---|---|---|
| 明确修改当前项目实现（如已确认的 edit/write/patch） | `confirmed` | revision 递增，已受影响验证 `valid=false` |
| 命令/脚本可能修改实现，无法确认有无或先后顺序 | `possible` | 加入 `pendingChangeIds`，置 `reviewStatus=unverified`，禁止直接 `done`；暂不擅自宣布已修改代码 |
| 有充分上下文可判定与实现无关（如只读检查、确认只产出独立临时产物的测试） | `irrelevant` | 维持旧验证；不能仅凭 `exit 0` 或命令名判定无影响 |
| 不涉及项目内容（仅元信息或其他会话） | `not_applicable` | 不改变当前验证 |

**恢复可信状态：** 对 `possible`，优先使用**发生在可疑操作之后、可观察且覆盖受影响验收项的独立复验**；若要改判为 `irrelevant`，必须提供宿主可复核的变更检查依据并记录判定理由，不能仅靠 Agent 一句「没改代码」。仍不能判明则维持待复核，允许 `close(partial)`。

**顺序不能猜：** 一次 `bash` 里同时修改代码又运行测试，只有最终工具结果时无法确定最后一次实现变更与测试的先后，不能凭该结果给修改后的代码授予可信 `passed`。应在后续**单独**执行能观察到顺序的检查；`tools/result` 缺少细粒度字段时能力降级。

未被宿主观察到的外部修改无法自动失效，须在状态、交付报告里标记监控覆盖限制；`status` 区分「历史通过」「当前有效」「待复核」，不把已过期证据展示成通过。

### 4.3 `close(done)` 门槛（P0-01 / P0-02 / P0-03）

同时满足才允许 `close(outcome=done, implementationStatus=complete)`：

1. 任务处于 `verify`，有至少一项**当前活跃、可判定的验收目标**；调查结论及无实现豁免符合状态机约束。不得通过移除失败验收项或缩小用户原目标绕过门槛。
2. 同一 revision 的有效 `verificationHistory` 合并后，**每个活跃验收项**都存在匹配的 `coverage.result=passed`。各结果必须记录对应 `observationIds`，不能把一个总体 `level=passed` 自动投射到所有验收项。
3. 所用观察来自第 3.3 节**真实宿主事件**，会话/任务身份、revision、执行顺序有效；检查工具确有可复核的通过结果，且具备针对验收项的证据说明。`echo passed`、`git status`、未知命令的成功退出不能直接作为测试通过。
4. 无已确认的后续实现变更、未解除的 `possible` 写入、过期观察、未解决阻断项；各验收项**最后一次可信验证发生在相关变更之后**。
5. `implementationStatus=complete`，且没有仍待人工确认的 `manual` 验收项。`reviewStatus` 根据校验结论计算为 `verified`，不接受 Agent 直接设置 `reviewStatus` 冒充通过。

**声明边界：** 以上只是 Praxis 可机械验证的「**声明的验收项有可信观察关联**」，并不能证明模型列出的验收项覆盖了用户所有真实意图、测试断言正确、软件无其他缺陷。应在交付报告展示 `user_explicit` 与 `agent_proposed` 的区别、未覆盖操作及人工验收边界；不能把它宣传为独立业务正确性证明。

`close(partial)` 也要明示实际实施情况：例如 `implementationStatus=complete, closureReason=awaiting_manual` 表示代码可能完成、等待人验，并非「只完成了一半」。`implementationStatus=incomplete, closureReason=implementation_incomplete` 才是实施尚未完成。`abandoned` 保留终止原因。关闭后不得就地改写旧验收结果，后续人工确认需要关联新任务或独立审计记录。

### 4.4 自校正回路

- `verify(partial/blocked)` 不篡改已记录测试结果，提示 Agent 调查根因、记录修正理由并适当回退。
- 同一任务第三次回退起给出重复回退提醒，但不得直接认定需求理解不足（也可能是新证据或外部环境变化）。
- `close` 若同时携带经验对象 `lesson`，必须先校验价值、证据与查重，再**单事务**写入经验、关联关系和结项；失败时任务仍未关闭。`lesson_id` 关联已存在的有效经验也要原子完成。

## 5. 工具二：`praxis_lesson`

动作保持：`search` · `save` · `update` · `retire`。

| 动作 | 必填 | 可选 | 语义与约束 |
|---|---|---|---|
| `search` | `query` | `projectKey`、`tag`、`scope`、`limit` | 只读检索，默认最多 5 条、最大 20；检索不等于采用 |
| `save` | `scope`、`trigger`、`lesson`、`evidence`、`reusable_because` | `projectKey`、`tags`、`source_task`、`supersedes`、`observationIds`、`difference_reason`、`request_id` | 只接受具有可复核证据、确实有可复用价值的条目；按请求 ID 或精确内容复用已存条目 |
| `update` | `lesson_id`、`reason` | 需修改字段、`request_id` | 保留修改前内容或结构化差异；修订后重新检查证据、作用域、冲突 |
| `retire` | `lesson_id`、`reason` | `request_id` | 留存退役原因与历史，默认检索不再显示；重复退役幂等 |

### 5.1 经验质量门槛

- 经验不是任务流水账、测试日志、一次性的业务配置或未经验证的猜测。
- 必须能回答：**何时适用、已证实什么、证据在哪里、为什么可能再次遇到**。
- `source_task` 及其验证结果可作为强关联；没有来源任务时，也必须存在有效且可复核的观察依据；纯叙述不能升级为事实。
- 经验修改时如依据被新证据推翻，必须 `update`（留修订原因）或 `supersedes` / `retire`，不能默默覆盖历史。

### 5.2 查重、替代与一致性

沿用归一化 `trigger + lesson` 的字符二元组 Jaccard：

- `1.0`：`duplicate`，返回原条目，不创建第二条。
- `>=0.85`：`near_duplicate`，返回候选并要求检查含义；**文本相似不等于语义相同**，不能自动合并或替代。若仍需保存，必须通过 `difference_reason` 给出经检查的差异理由。
- `>=0.6`：给 `related` 提示；默认不影响保存。

`supersedes` 需验证目标存在、状态有效、作用域兼容、无循环引用；新旧双向关联和状态变化必须一次性提交。`update` 若造成冲突需先报告 `would_duplicate` 或 `conflict`，禁止静默覆盖其他经验。所有修订记录 `at`、`reason` 与前后差异，不允许无理由覆盖。

### 5.3 检索语义

- 检索**不修改**经验的 `hits` 或“采用次数”，也不因多次搜索而使条目越排越靠前。
- 排序先由关键词/标签相关性决定；新鲜度仅用于相近相关度的次级排序。首版不引入复杂标签 DSL，不使用未经核实的“使用度”加权。
- `status=active`；`global` 条目可见，但显示适用边界；`project` 条目只有 `projectKey` 匹配时可见；tag 精确匹配并明确大小写归一化规则。
- 每次返回附注：**历史经验是调查线索，不是当前项目的事实证据**。

## 6. 证据格式与可信来源（P0-02）

### 6.1 `evidenceStrength(text)` 只检验**格式**

继续支持原有线索：`file:line`、行号、命令、引用块、结果文本；空串 `none`。但命令名本身（如 `npm test`）、孤立行号、孤立 `passed` **不能自动评为可结项证据**。格式评估可返回 `concrete / weak / none` 以及缺失字段提示。

建议评为 `concrete` 的文本至少同时包含**具体操作/定位**与**实际结果/摘录**；这依然是格式分级，不是独立执行证明。`need` 可记录弱证据并提醒，不能靠弱证据进入实施；`lesson.save/update` 禁止弱证据冒充已验证经验。

### 6.2 可信来源

| 来源 | 意义 | 能否独立支持 `done` |
|---|---|---|
| `self_reported` | Agent 在调用参数中提交的说明、粘贴的命令输出 | **不能** |
| `observed` | 插件从已完成的宿主工具事件建立可复核记录，校验工具状态、会话、顺序及必要摘要 | **有条件可以**，仍需验证范围与失效检查 |
| 未覆盖操作 | 外部终端、手工编辑、子代理宿主不可观测路径 | **不能自动证明**，需补测或明确报告限制 |

任何来自 Agent 的 `observationIds` 都只是待校验的引用；不存在、跨会话、已失效或工具失败的 ID 必须被拒绝。不能让 Agent 自己填 `provenance: observed`。

## 7. 运行期行为与干扰控制

- **默认模式：`advisory + tool-level gates`**。不拦截通用 `bash/write/edit`，不阻止提交，也不擅自跑命令；在已确认适用的代码任务首次进入模型步骤时，尝试提供一次紧凑引导，并记录该提示是否真的送达模型。
- `agent/pre-step` 的一次性提醒须依据真实准入结果注入；只记录诊断、在 UI 显示提示或更新状态文件，**不等于模型看见了提示**。提示的去重键为宿主会话 + 用户任务轮次 + 触发阶段，状态未变化不重复注入。
- `agent/turn-stopping` 提供 `off | observe | steer_once` 三档，**默认 `observe`**：只记录缺验证的诊断，不发消息、不启动新模型请求。`steer_once` 才允许在本轮结束前续接一次模型步骤，必须标注额外 Token/时延成本、通过宿主标准生命周期派发，且最多一次；若续步不被接受、用户拒绝或能力缺失，立即回退观察模式，不延迟正常结束。
- 子代理与主代理分别计数；跳过 Praxis、只读/含糊任务、没有可靠任务身份、已提示过本轮的情形都不得再触发。日志要区分「检查到问题」「尝试提示」「模型已收到」「Agent 实际调用」。
- 观察工具时不存储完整 stdout、文件正文、认证头、Cookie、API Key；必要片段做脱敏与长度限制，并将真实错误返回给调用方。
- 如果宿主钩子接线失败，不得吞错并声称正常启用；提供降级标识，并允许正常工作继续。
- 首版不设计强制工具调用 / 强制停止 Agent。若未来要做宿主级强约束，必须单独设计权限、安全与误触发撤销机制。

## 8. 存储、并发与迁移（P1）

- 默认目录 `~/.dsh/praxis/`，可用 `DSH_PRAXIS_DATA_DIR` 指定；仅允许写入 Praxis 自有的 `state.json`、同目录临时/锁文件，以及经授权的备份文件。不写业务仓库或 DSH 其他插件配置。
- 写入流程：校验输入 → 获取跨进程写锁 → 重读最新状态 → 验证版本和业务约束 → 同目录写临时文件 → 必要同步 → 原子替换或失败回退 → 释放锁。单进程串行队列不是跨进程互斥锁。
- 锁竞争或无法确认锁是否可安全恢复：**拒绝写入并返回 `lock-busy`**，不静默覆盖。锁恢复规则及 Windows 文件占用场景必须测试。
- 无效 JSON、未知版本、半写状态：拒绝写入、保留原文件和错误证据，禁止自动置空重建。
- 目录权限 `0o700` / 文件 `0o600` 是类 Unix 目标；Windows 应测试 ACL 和实际访问边界，不能仅凭 mode 数值声称隔离已生效。
- `version:1` 数据如果存在，不得直接按 `version:2` 写入覆盖。提供显式迁移（备份、只读预检、可回滚）或明确拒绝启动写入；首版不能假设正式环境为空。
- 任意写入失败后原有效状态保持可读；持久幂等请求及其业务变化必须同事务提交；`requests` 的保留/过期遵守第 3.5 节。

## 9. 错误契约

`PraxisError` 有 `code` / `hint`，并标明**是否发生状态变更**：

| 错误码 | 含义 |
|---|---|
| `bad-action`、`missing-field`、`invalid-state` | 动作、字段或转换不合法 |
| `task-not-found`、`lesson-not-found`、`task-closed` | 对象缺失或不可修改 |
| `gate`、`weak-evidence`、`unverified`、`stale-verification` | 阶段门槛、来源或有效性不足 |
| `duplicate`、`near_duplicate`、`conflict` | 经验重复或替代关系冲突 |
| `capacity`、`lock-busy`、`state-corrupt`、`unsupported-version` | 容量、并发或数据异常 |
| `hook-unavailable` | 宿主能力缺失，自动提醒/可信观察降级 |
| `idempotency-conflict` | 同作用域同 `request_id` 携带不同规范化参数 |
| `ambiguous-owner`、`observation-not-found` | 观察归属不明、不可见或不存在 |
| `acceptance-uncovered`、`possible-change` | 验收项未由当前复验覆盖、存在未解决的可能改动 |

错误不可吞；有条件成功须返回明确 `warnings` 与未覆盖部分；涉及事务的失败必须没有部分写入。

## 10. 复用 / 扩展 / 新增决策

| 能力 | 判断 | 说明 |
|---|---|---|
| 原证据启发式 | **扩展** | 保留格式线索，但与可信来源分离，不再以命令名当作已执行 |
| `start/need/inventory/step/verify/close` | **扩展** | 沿用两工具交互，补状态转移、验证历史与失效规则 |
| 原子写 + 串行队列 + 损坏拒写 | **扩展** | 加跨进程互斥和迁移边界 |
| 经验查重阈值 1.0/0.85/0.6 | **保留并修正语义** | 不自动把文本相似当语义等价 |
| 任务↔经验关联、批量 inventory | **保留** | 增加事务一致性与来源快照 |
| 经验检索 | **收敛** | 去掉检索即 hits 加权，优先相关性 |
| `supersedes` 与经验修订 | **扩展** | 补 `supersededBy`、修订理由、关系校验 |
| 适用性判断、有限提醒与漏用观测 | **新增** | 针对上一轮盲测暴露的自主调用缺失 |
| 宿主观察引用、验证 revision 绑定 | **新增** | 增加身份、观察查询、验收映射与后续变更影响分类，防止“有结果 ≠ 覆盖需求” |
| 请求幂等持久化、实施与验证双状态 | **新增** | 解决重试重复任务和「代码已完成人工待验」的表达 |

旧 DevFlow 与 Praxis 在同一运行环境中**不应长期同时自动管理同一任务**。首版采用独立数据目录、独立工具名、显式灰度，确认可替代后再决定迁移；不读取或改写 `~/.dsh/devflow/state.json`。

## 11. 不做什么

- 不启动 Workflow / Subagent / Team，不运行命令，不自动改代码或提交 Git。
- 不独立裁判业务正确性，不假设看到一条测试 exit 0 就覆盖了所有验收标准。
- 不生成项目内部报告，不修改用户仓库；除 Praxis 数据目录外不写用户文件。
- 不与已有 `todo_write` 竞争任务调度，不迫使只读任务或普通对话进入开发流程。
- 不为了实现“主动触发”而无限追加 prompt、重复开启 Agent 轮次或擅自注入工具调用。

## 12. 实现前检查与验收计划

### 12.1 实现前必须调查

1. 核对 DSH **实际安装版本 `0.2.1-rc.2`** 的 `systemPrompt.section`、`agent/pre-step`、`tools/result`、`agent/turn-stopping` 数据结构、作用域和实际装配结果。官方文档仅能证明存在扩展点，不能证明该用户版本的完整兼容。
2. 检查现有 Praxis、DevFlow、Axiom 与其他可能注入 Prompt/监听钩子的插件，验证冲突和重复提示；只读调查，未经授权不得修改既有插件。
3. 确认待开发仓库是独立干净工作区；保存开始前 Git 状态快照，不能自动清理或覆盖已有修改。测试时始终覆写 `DSH_PRAXIS_DATA_DIR` 为临时目录。

### 12.2 工程验证矩阵

| 测试组 | 必测场景 | 通过标准 |
|---|---|---|
| A 基础契约 | 两工具全动作、非法参数、幂等、阶段转换、回退、结束 | 状态符合契约；无多写、无 silent fallback |
| B 对抗性验证 | `npm test` 文本冒充执行、弱证据 passed、缺验收项/漏一项、已验证后再改动、同一 shell 混合写入和测试、跨会话 observation | 证据无效或范围不足时不能 `done`；confirmed 使旧验证失效，possible 阻断至复验/可复核澄清 |
| C 自主触发盲测 | **不提 Praxis** 的 fresh Agent 开发任务、普通问答、只读审计、含糊请求；与工具仅注册的基线对照 | 样本数与发布阈值在实验前冻结（见表后）；区分提示送达、真实调用、可信完成和误触发 |
| D 子代理与交接 | fresh 子代理、虚假/过时简报、新证据推翻旧结论、父子关系 | 重查真实现状；修订留下痕迹；跨会话经验不串写 |
| E 数据与安全 | 多进程并发、崩溃/临时文件、锁竞争、损坏 v1 数据、容量极限、Windows 权限、提交后响应前崩溃并重试同 ID | 不丢正式数据、不覆写异常状态、不损坏关联；幂等重试返回同一结果、不同参数冲突 |
| F 环境隔离 | 在 DSH Desktop 真正装配、启停/重启、回退插件、`doctor_profile` | 没有 FAIL；正常任务不受干扰；卸载不遗留宿主配置污染 |

**预先固定盲测验收（避免测试后移动门槛）：** 至少 **12 个明确适用开发任务 + 12 个非适用任务**；覆盖不少于 3 个 fresh Agent 会话，同一批任务以相同模型、努力程度、工具权限，在「工具仅注册」基线和「含主动机制」版本分别运行，记录所有失败与跳过。发布候选须同时满足：适用任务**有意义的 Praxis 工具调用 ≥9/12**、相对基线提升至少 **3/12**；非适用任务**误触发 ≤1/12**；同轮重复提醒 **0 次**、单轮额外续步 **≤1**、跨会话错绑 **0 次**。`observe` 默认模式的最终提醒只计诊断，不算 Agent 已接收。另单列可信验收项覆盖率（不拿它冒充调用率），所有原始调用日志要可核对。样本较小，这些是**工程发布门槛而非统计学效果证明**；不足则标为未达标并分析失败，不临时降低阈值。

### 12.3 开发顺序（以验证风险为先）

1. 先做 **宿主钩子可用性探针**（独立临时 profile，不改正式 DSH），确认数据形状、子代理可见性、`tools/result` 是否提供调用身份/命令结果/顺序、steer_once 接口与降级路径；若关键接线不可用，先修改设计。
2. 定义纯函数状态机、**验收项—验证结果关联**、写入影响三态/四态分类、证据来源、检索与经验生命周期契约，先编写失败反例。
3. 实现存储层的跨进程写入保护、原子事务、**持久请求幂等账本**、迁移/损坏保护与测试隔离。
4. 接入 `praxis_task` / `praxis_lesson` 两工具及低干扰生命周期辅助。
5. 执行基础/对抗/盲测/真实宿主冒烟；独立复跑结果、审查被动漏用与误触发，确认零工作区污染。

语法检查与单测是必要条件，但不能替代真实 DSH 的生命周期与行为验收。可复核报告必须区分 **实测通过 / 仅模拟通过 / 未验证 / 受环境阻塞**，不得用“全部通过”掩盖 skip 或钩子降级。

## 13. 已确定决策与待复审事项

**已确定（沿用 v0.1 的合理取舍）：**

- 阶段名称：`understand / implement / verify`。
- `close(done)`：不允许 `partial` 冒充完成，必须对应当前轮次有效可信的 `passed`。
- 模型工具：`praxis_task` 与 `praxis_lesson`，不合并为一个巨型工具。
- 检索参数：沿用独立 `tag` 参数，首版不增加 `tag:...` 搜索语法。
- 工作区：**本次只修订设计文档**；未授权修改项目文件、运行用户机器上的插件或向 GitHub 推送。

**待实现前复审：**

1. DSH 0.2.1-rc.2 钩子的实际可见性/作用域/工具结果可观察字段，是否足以建立可信引用。
2. 观察摘要、宿主调用身份、归属、可复核结果、验收项覆盖与写入先后能否形成完整的跨重启链路；若做不到，须收缩 `close(done)` 能力，不得降低可信门槛。
3. 旧 DevFlow 数据是否未来需要迁移（本轮默认**不迁移**），以及多个 DSH 进程共用状态目录的实际运行形态。

> **发布裁决标准**：P0（主动机制、验收项覆盖、可信观察、写入失效）与 P1（幂等、停止提醒语义、完成/验收分离、状态/经验历史、并发、作用域）经设计复审、反例测试与目标 DSH 真机验证后方可发布。**设计复审通过只是进入实现的条件，不等于运行能力已验证。**

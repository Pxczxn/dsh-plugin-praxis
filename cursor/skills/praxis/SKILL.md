---
name: praxis
description: 工程纪律任务台账与错题本。用于非平凡代码改动、调试、重构、多文件修改：先登记调查结论与证据，再实现，完成前用观察 ID 验证并结项；也用于检索、保存、修订可复用经验。只读问答、讨论、规划不用。
---

# Praxis

Praxis 不替你写代码，只让三件事有据可查：**需求判断有证据、完成声明有验证、经验沉淀可复用也能被修正**。任务规则由 MCP server 强制执行，hooks 负责把编辑与命令自动记成观察。

## 何时使用

用：

- 非平凡代码改动：多文件、重构、修 bug、改行为、新增能力。
- 需要证明「做完了」的改动：验收项、验证结果要被记录。
- 任务开始时检索过往经验，或任务结束后沉淀一条可复用经验。

不用：

- 只读、问答、解释、讨论、规划；用户明确说「只读 / 不要改」。
- 纯文案或一次性小改，没有验收要求。

## 工具

两个 MCP 工具：`praxis_task`（任务台账）与 `praxis_lesson`（错题本）。响应统一为 `{ ok, code, data, warnings }`；失败时读 `message` 与 `hint`，不要忽略 `warnings`。

### 任务流程

1. `praxis_task { action: "start", goal, acceptance: [{ text, kind: "automated" }] }`
   - `acceptance` 写可判定的验收目标；没有验收项不能 `close(done)`。
   - `kind: "manual"` 表示必须人工验收的项。
2. 调查后用 `need` 记录结论：`{ action: "need", task_id, target, decision: "reuse" | "extend" | "new", evidence }`
   - `target` 是独立决策目标（功能、模块、接口、共享能力），不是文件清单；判断/证据/处理一致的可合并，但 `target` 要写明覆盖范围。
   - `new` 要写清检查过的现有能力（文件:行号）以及为何不适用。
   - 未确认范围写进 `plan`，不要假装调查完整。
3. `step { action: "step", task_id, phase: "implement" }`
   - 进入 `implement` 前，至少一条 `need` 的 `evidence` 必须是具体证据。
4. 实现完成后跑检查（测试 / 构建 / lint），然后：
   `step { action: "step", task_id, phase: "verify" }`
5. `status { action: "status", task_id }` 查看候选观察与未覆盖的验收项。
6. `verify`：`{ action: "verify", task_id, level: "passed", scope, coverage: [{ criterionId, result: "passed", observationIds: ["obs-12"] }] }`
   - `passed` 的每一项必须引用**成功执行的 test/build/lint 观察**；失败、只读或可能包含写入的观察不能当证据。
   - 一项没覆盖全就先用 `partial` 或继续检查，不要谎报。
7. `close`：
   - 完成：`{ action: "close", task_id, outcome: "done", implementationStatus: "complete" }`
   - 等待人工验收：`{ action: "close", task_id, outcome: "partial", implementationStatus: "complete", closureReason: "awaiting_manual" }`
   - 放弃：`outcome: "abandoned"`，并给 `note`。

阶段只能按 `understand → implement → verify` 流转；回退必须给 `note`，会记入 `corrections` 并让本轮验证失效。每次确认写入（编辑文件、可能改源码的命令）都会递增 revision，之前的验证自动失效——改完必须重跑检查。

### 观察 ID

hooks 会把工具调用与结果记成观察（`obs-<序号>`），脱敏并截断：

- 文件编辑 → `confirmed` 写入，revision 递增；
- 可能改源码的 shell 命令 → 待复核写入，阻断 `close(done)`；
- 测试 / 构建 / lint → 可作为 `verify` 的通过证据；
- 失败调用 → 记录为失败，不能当通过证据。

用 `status` 查看候选观察；不要自己编造 ID。验证之后又改了代码，旧的验证就作废；重新检查并重新 `verify`。

### 经验（错题本）

- `praxis_lesson { action: "search", query, projectKey?, tag? }`：先查再动手；结果是调查线索，不是当前事实。
- `praxis_lesson { action: "save", scope: "project" | "global", trigger, lesson, evidence, reusable_because }`：只接受具体证据。`trigger` 写「何时适用」，不要写正文摘要。
- 完全相同不重复保存；相似度 ≥ 0.85 要给 `difference_reason`。
- `update` 必须给 `reason`；改弱证据或与活跃经验高度重合会被拒绝。
- `retire` 必须给 `reason`；被 `supersedes` 取代的经验不再出现在检索里。

### 证据分级

具体证据满足任一：文件+行号（`src/store.js:120`）、命令+输出（`npm test` + `113 pass 0 fail`）、原样引用+可核对结果、文件+命令。只写「我试过了」「应该可以」是弱证据或不算证据。

## 闭环提醒

`postToolUse` 与 `stop` 钩子会在有 open 任务且缺口未变时给一次提醒（`additional_context` 或 `followup_message`），同一组缺口只提醒一次。提醒不是让你机械结项：确实没完成就 `step` / `need` 说明，或者继续验证。

## Cursor 的限制

- 没有宿主 `ask_user_question` 确认链：`protected: true` 与 `source: user_explicit` 无法取得 `confirmation_call_id`。需要人工确认的验收项用 `kind: "manual"` + `source: "agent_proposed"`。
- MCP server 通过 `sessionStart` / `beforeSubmitPrompt` 写入的活跃会话指针识别当前会话。同一工作区同时开多个对话时，指针可能指向最后活动的那个；这时先确认任务归属（`status`）再继续。
- 数据默认在 `~/.cursor/praxis/`（`session.json` 会话指针，`state.json` 任务与经验）。

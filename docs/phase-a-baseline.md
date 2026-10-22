# Praxis 阶段 A 调查粒度基线

状态：候选版已实现软引导与场景测试；本文记录 10 个场景的结构化基线和一次 20 次 Agent 的 A/B 代理对照。
限制：这不是宿主内真实 `praxis_task` 工具调用，也不是真实多会话/子代理 e2e；A/B 只证明“给定场景和引导时，Agent 会怎样做决定”，不能证明实际调查充分。

## 1. 场景基线

场景定义在 `test-support/phase-a-scenarios.js`，评分器在 `test-support/phase-a-rubric.js`。10 个场景覆盖：

| id | 场景 | 关键期望 |
| --- | --- | --- |
| `simple-single-point` | 简单单点修改 | 明确代码改动应 start；只登记 1 条针对该分支的 need |
| `two-interfaces-different` | 两个接口需要不同处理 | 分别登记 A/B，target 可区分 |
| `shared-capability` | 多接口共享同一能力 | 可合并为 1 条，target 覆盖 A/B/CSV |
| `existing-satisfies` | 现有功能已满足需求 | 只读核实，不 start、不登记 need |
| `new-without-investigation` | 未调查就判断 new | 若判 new，evidence 必须写清现有能力不适用原因 |
| `extra-dependency` | 实施中发现额外依赖 | 已有任务，更新 need/inventory，不新建任务 |
| `huge-task` | 超大任务 | 只展开当前范围，plan 写明未确认/后续批次 |
| `high-risk-small` | 高风险小改动 | 最多 2 条独立 need；风险不靠拆更多目标表达 |
| `read-only-discussion` | 纯讨论、只读分析 | 不 start、不登记、不进入 implement |
| `update-conclusion` | 更新调查结论 | 已有任务更新结论并重新验证，不新建任务 |

首轮 A/B 暴露了基线自身的 3 个 `should_start` 期望错误：`existing-satisfies` 是只读核实，`extra-dependency` / `update-conclusion` 已有任务，都不应新建任务。已修正这 3 个期望；没有放宽 need 数量、new 证据或目标覆盖要求。`simple-single-point` 仍按“明确代码改动应 start”计；平凡改动是否必须记账可继续讨论。

## 2. A/B 方法

- 20 个独立 Agent：10 场景 × 2 变体，每个 Agent 只看到场景和一份引导文案，要求只读、不调用工具、不改文件，输出 `should_start` / `needs` / `would_enter_implement` / `rationale`。
- 原版：v1.0.1 的 `GUIDANCE` 第 2 条与 `REMINDER`。
- 候选版：当前 `src/lifecycle.js` 的软引导。
- 评分：用 `test-support/phase-a-rubric.js` 对结构评分；`would_enter_implement` 只作观察，不当作真实门槛结果。
- 未保存 20 条原始 transcript 到仓库；本文表格是逐条核对后的汇总。

## 3. 结果

| 指标 | 原版 | 候选版 |
| --- | --- | --- |
| start 决策与基线一致 | 7/10 | 10/10 |
| need 数量在基线上限内 | 8/10 | 10/10 |
| 独立目标遗漏 | 0 | 0 |
| 无依据 new | 0 | 0 |
| 过度拆分（按基线上限） | 1（高风险 3 条） | 0 |
| 结构评分完全通过 | 5/10 | 10/10 |
| `would_enter_implement=true` | 3 | 2 |

逐场景差异：

- `simple-single-point`：原版不 start（0 need），候选 start 并登记 1 条覆盖该分支的 need。原版在“明确代码改动”上漏触发。
- `existing-satisfies`：原版 start 并登记 2 条 need；候选判定为只读核实，不 start、不登记。原版把核实当成实现任务。
- `extra-dependency`：原版 start 新任务；候选识别已有任务，追加 2 条 need。原版会重复建任务。
- `high-risk-small`：原版 3 条（判定本体、管理员能力、调用面/测试），候选 2 条；按本基线“最多 2 条”，原版被标过度拆分。这是启发式判断，不是绝对错误。
- `new-without-investigation`：原版 start 但 0 need，无法进入实现；候选登记 2 条待核实目标（reuse/extend），未凭空判 new。
- `huge-task`：两者都收窄到提示通道；候选 1 条 need，原版 2 条；两者 plan 都表达了未确认范围。
- 其余场景两者结构一致。

## 4. 结论与限制

1. 候选版在这 10 个代理场景中修正了原版的 3 个 start 错误，结构评分 10/10；但这不等于真实调查充分。
2. 候选版的 evidence 大量是“尚未读取/需要先检查”，属于弱证据。真实 `step(implement)` 仍会被“至少一条 concrete need”挡住；A/B 没有实际调用该门槛，`would_enter_implement` 不能当成工具已放行。
3. 本样本没有出现无依据 new 或独立目标遗漏；这两个风险仍由合成单测覆盖，不能被“A/B 0 次”证明已消失。
4. 候选引导每次多约 117 个字符（第 2 条 76 → 193，约 2.54×），提醒多约 27 个字符；10 次候选 A/B 约多 1.2K 字符。候选 need 总数 12 条，原版 14 条，但候选 evidence 更长；未接 token 计费，不能给精确 token 数。
5. 未验证：真实宿主工具调用、真实多会话/子代理并发、语义正确性、长上下文下的遵从率、真实用户请求的误触发率。

## 5. 复现

```bash
npm test
```

新增测试覆盖：场景基线完整性、遗漏独立目标、过度拆分、无依据 new、只读误 start、已有任务重复 start、plan 未确认范围，以及软引导/schema 不变。

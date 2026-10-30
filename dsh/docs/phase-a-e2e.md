# 阶段 A 收口：真实宿主任务与测试记录

> 记录时间：2026-10-22（UTC）
> 代码状态：`D:\Coding\project\dsh\plugins\praxis`，版本 1.0.1，基线 HEAD `2c4180f`，本轮改动见同次提交。
> 性质：真实 DSH 宿主会话内的 `praxis_task` 调用，不是模拟脚本；但观察者与执行者是同一个 Agent，未做盲测。

## 1. 环境

- 宿主：DSH Web GUI（`http://127.0.0.1:63973`）。
- 插件：当前工作区，已挂载 `praxis_task` / `praxis_lesson`。
- 数据：`~/.dsh/praxis/state.json`（本文件末尾的 `tasks.json` 是其中两个任务的原始快照）。
- 原始日志：`test-results/phase-a-e2e/npm-test.log`、`test-results/phase-a-e2e/npm-check.log`、对应的 `.exit` 文件。

## 2. 任务一：need 语义收口

- 任务 ID：`9eeb394d-0300-4a4d-a63b-a5f54b92bf41`
- 目标：把 need 明确为调查后的结论，修正 GUIDANCE / REMINDER / TASK_DESCRIPTION 与测试；用真实任务观察；不进入阶段 B。
- 实际时间线（任务事件）：
  - `16:43:14` `start`，进入 understand。
  - `16:43:19`–`16:43:31` 连续登记 4 条 need，全部 `concrete`：
    - `src/lifecycle.js` 的 GUIDANCE/REMINDER 语义 → `extend`
    - `src/tools.js` 的 TASK_DESCRIPTION 语义 → `extend`
    - `test/phase-a-guidance.test.js` 的语义断言 → `extend`
    - `README/CONTRACT` 的语义说明 → `extend`
  - `16:43:35` `step(implement)`，说明“调查确认四条现有文案/测试/文档均未把 need 定义为结论；以最小文案与测试修改收口”。
  - 实现写入持续到 `16:44:09`，revision 从 1 递增到 7。
  - `16:47:47` `step(verify)`。
- 观察到的 need 证据：
  - 每条都带具体文件与行号，例如 `src/lifecycle.js:9`、`src/tools.js:11`、`test/phase-a-guidance.test.js:7-31`、`README.md:59-66`。
  - 没有出现“尚未读取 / 需要先查 / 待确认”作为 evidence 的占位记录。
  - `step(implement)` 在 need 之后执行，没有被提前调用。
- 真实写入（revision 2–7）：`src/lifecycle.js`、`src/tools.js`、`README.md`、`CONTRACT.md`、`test/phase-a-guidance.test.js`。
- 任务级验证：`f9b8302c-c5d3-4dcb-bea8-1d9c02b46047`（`partial`，observed，revision 7）；criterion-1/2 为 passed，criterion-3/4/5 为 partial；最终 `close(partial, complete, awaiting_manual)`。
- 结论：这 2 条约束（结论语义、不预填）在该任务中按预期被执行；但不能据此证明所有任务都会如此。

## 3. 任务二：评分器 premature-decision 规则

- 任务 ID：`190580d5-e47c-4334-8de4-59d5a3d3b6a6`
- 目标：给测试评分器增加“未调查占位证据”检测；只改测试评分器与测试，不改生产 schema/门槛。
- 时间线：
  - `16:44:21` `start`。
  - `16:44:26`、`16:44:32` 登记 2 条 need，全部 `concrete`：
    - `test-support/phase-a-rubric.js:23-88` 缺少 evidence 占位检查；
    - `test/phase-a-scenarios.test.js:31-171` 缺少占位/结论两类回归用例。
  - `16:44:36` `step(implement)`。
  - 实际修改 `test-support/phase-a-rubric.js`，新增 `PLACEHOLDER` 规则和 `premature-decision` finding；`test/phase-a-scenarios.test.js` 新增两条用例。
- 限制：该任务在 `16:47:16` 被临时 `close(partial, verification_missing)`，用来释放会话内“唯一 open 任务”的观察绑定；之后宿主工具没有 `reopen` 动作，因此它没有拿到任务绑定的测试观察。其代码已被全量测试覆盖，但不能声称该任务已独立验证。

## 4. 测试记录

| 命令 | 结果 | 原始记录 | 观察 |
| --- | --- | --- | --- |
| `node --test test/phase-a-guidance.test.js test/phase-a-scenarios.test.js` | 21 pass / 0 fail | 终端输出；任务绑定观察 `obs-4497` | 文案断言 + 10 场景基线 + premature 正反例 |
| `npm test` | 194 pass / 0 fail | `test-results/phase-a-e2e/npm-test.log`；`obs-4499` | 全量套件 |
| `npm run check` | exit 0 | `test-results/phase-a-e2e/npm-check.log`；`obs-4501` | 所有入口 `node --check` |
| `git diff --check` | exit 0 | 终端输出 | 无空白错误 |

第一次跑聚焦测试时，旧的 `assert.match(GUIDANCE, /未确认的范围写进 plan/)` 与新文案不匹配而失败；已改为 `/未确认范围写进.*plan/`，重跑 21 pass。这是测试适配，不是生产行为失败。

## 5. 三类结论必须分开

1. **代码测试通过**：194 个用例和语法检查通过；这是可复核事实。
2. **Agent 行为改善**：在本轮 2 个真实任务里，6 条 need 都在调查后登记、都带具体证据，`step(implement)` 没有提前；这是有限观察，不是普遍证明。
3. **真实调查充分性**：没有证明。评分器只检查结构与规则；本轮任务都是同一仓库的元改动，没有外部功能任务，也没有独立评审者判断“调查是否真的足够”。

## 6. 未覆盖与剩余问题

- 只有 2 个真实任务，且都是同一仓库、同一类收口任务；没有第三个外部功能任务。
- 两个任务由同一个 Agent 执行，没有盲测或独立 Agent 对照；无法排除“知道新文案所以照着做”的偏差。
- 任务二没有任务绑定的验证观察；其改动只由全量测试间接覆盖。
- 没有做多会话/子代理并发下的真实 A/B。
- 没有实施阶段 B 的 `covers`、稳定 ID、逐目标硬门槛；本次改动已提交到本地，未推送。
- 引导仍是软约束：Agent 仍可能写出“已阅读 XX”但没有真正核对内容的结论。

## 7. 原始快照

这些文件只保留在本地工作区，不纳入提交：`tasks.json` 含宿主 `sessionId`，`*.log` 已被 `.gitignore` 忽略，`test-results/` 已整体忽略。

- `test-results/phase-a-e2e/tasks.json`：上述两个任务及 `obs-4497` / `obs-4499` / `obs-4501` 的原始字段。
- `test-results/phase-a-e2e/npm-test.log`、`npm-check.log`、`npm-test.exit`、`npm-check.exit`：命令输出与退出码。

# Praxis v0.2.1 实现契约（内部，供并行开发对齐）

依据 `Praxis-DESIGN-v0.2.1.md`。纯 ESM JS（Node >= 20，无第三方依赖）。所有模块只 import `./evidence.js`、`./classify.js` 或 node 内置。

## 0. 通用约定

- 错误统一用 `PraxisError`（来自 `src/evidence.js`）：`new PraxisError(code, message, { hint, changed })`，`changed` 表示是否已写状态（默认 false）。
- 工具响应统一：成功 `{ ok: true, code: "ok", data: {...}, warnings: string[] }`；失败 `{ ok: false, code, message, hint?, warnings? }`。`next_hint` 仅需要时给。
- 时间统一 `new Date().toISOString()`；ID 用 `crypto.randomUUID()`（任务/经验/验证）与 `obs-<序号>`（观察）。
- 所有字符串写入前 `clip(s, LIMITS.x)`；敏感信息脱敏见 §5。
- 测试一律 `node --test`，每个测试文件用临时目录并 `process.env.DSH_PRAXIS_DATA_DIR = tmpdir`。

## 1. 数据模型（state.json，version 2）

完全按设计稿 §3 的字段；`tasks`、`observations`、`requests`、`lessons` 均为**数组**（不是对象）。

```js
const emptyState = () => ({
  version: 2,
  nextObservation: 1,
  tasks: [],
  observations: [],
  requests: [],
  lessons: [],
  sessions: {},   // 宿主会话诊断（非契约核心）：{ lastReminderTurn, reminderCount, turnStops }
});
```

## 2. `src/store.js`

```js
export function defaultDir()                       // DSH_PRAXIS_DATA_DIR 或 ~/.dsh/praxis
export function createStore({ dir } = {})          // 返回 store
// store.load(): Promise<state>                     只读；损坏抛 state-corrupt / unsupported-version
// store.mutate(fn): Promise<state>                 fn(state) 可同步改 state 并返回任意值；
//                                                  整体算一次事务：加锁 → 重读 → fn → 原子写 → 解锁
// store.read(): state                              最近一次 load/mutate 的内存快照（无 IO）
```

要求：
- 锁文件 `state.lock`，`open(..., 'wx')` 写入 `{pid,host,at}`。锁存在且 mtime 距今 < 10 分钟 → 抛 `lock-busy`；超过 10 分钟且（非本机 或 pid 不存活）→ 删除后重试一次；仍失败 → `lock-busy`。**失败不得写 state**。
- 原子写：同目录 `state.json.tmp-<rand>` → `writeFile` + `fsync` → `rename`；rename 失败回退 `copyFile(tmp, state)` + `rm(tmp)`。写失败不得破坏原文件。
- JSON 解析失败 → `PraxisError('state-corrupt', ...)`，绝不置空重建。
- 版本不是 2：文件不存在或文件为空 → 初始化 v2；`version` 缺失但有数据、或 version=1 → 抛 `unsupported-version`（首版不做自动迁移，保留原文件）；version>2 → 同样拒绝。
- 目录 `0o700`、文件 `0o600`（Windows 上 mode 尽力而为）。
- 每次 `mutate` 后把 state 在内存缓存；并发调用用进程内串行队列（Promise 链）**且**跨进程锁，二者都要。
- 不写 Praxis 目录之外的任何文件。

## 3. `src/evidence.js`

```js
export const LIMITS = { goal: 2000, evidence: 3000, lesson: 1500, trigger: 700,
  reusableBecause: 1000, note: 1000, reason: 1000, plan: 1000, target: 300,
  projectKey: 200, tag: 40, query: 500, scope: 500, acceptance: 300,
  summary: 500, stdout: 400 };
export class PraxisError extends Error { constructor(code, message, options) { ... this.code; this.hint; this.changed } }
export function clip(value, max)
export function normalize(text)          // 小写、Unicode 字母数字保留、空白折叠
export function evidenceSignals(text)    // { file, line, command, output, quote, result }
export function evidenceStrength(text)   // 'concrete' | 'weak' | 'none'
export function evidenceGaps(text)       // 缺失提示字符串数组
export function similarity(a, b)         // 字符二元组 Jaccard，0..1
export function relevance(query, text)   // 0..1，关键词覆盖为主
export function id(prefix)               // 兼容旧调用；优先 crypto.randomUUID
```

`concrete` 规则（格式分级，不证明执行）：`(file && line) || (command && (output || result)) || (quote && result) || (file && command)`；空串 → `none`；其余 → `weak`。孤立行号、孤立 `passed`、单独命令名都不得 concrete。

## 4. `src/classify.js`

```js
export const WRITE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit', 'apply_patch', 'str_replace_editor']);
export function classifyTool(name, args)     // 'read'|'write'|'test'|'build'|'lint'|'other'
export function summarizeCall(name, args)    // 脱敏 + clip 到 300 字的命令/目标摘要
export function summarizeResult(result)      // { outcome, exitCode, summary } 脱敏摘要，clip 到 500
export function changeImpact(name, args)     // 'confirmed'|'possible'|'irrelevant'|'not_applicable'
```

`changeImpact`：
- write/edit/patch 类工具 → `confirmed`。
- `read/ls/cat/grep/glob/status/diff/log/show` 等只读工具 → `not_applicable`。
- `bash/pwsh/shell/exec`：命令文本先去掉引号内内容再匹配。
  - 只读命令（`git status|diff|log|show|branch|rev-parse`、`ls`、`cat`、`grep`、`rg`、`find`、`node --version`、`npm ls`、`pwd`、`echo` 等）→ `irrelevant`；
  - 测试/检查命令（`node --test`、`npm test`、`pytest`、`vitest`、`jest`、`go test`、`cargo test`、`eslint`、`prettier --check`、`tsc`、`lint`、`typecheck`）→ `irrelevant`（只读检查）；
  - 可能写入的命令（`npm install|ci`、`npm run build`、`yarn`、`pnpm`、`make`、`mkdir`、`touch`、`cp`、`mv`、`rm`、`sed -i`、`tee`、`>`、`>>`、`git checkout|reset|stash|apply|commit`、`curl -o`、`python -m build`、docker build）→ `possible`；
  - 未知命令 → `possible`（保守）。
- 其余工具 → `possible`（不得默认 not_applicable）。

`summarizeResult`：`outcome` 从 `result.isError` 判断；`exitCode` 从 `result.meta?.exitCode` 或 `result.value?.exitCode` 取，取不到 null；summary 只保留末尾若干行并按 `LIMITS.stdout`/`LIMITS.summary` 截断；过滤 `api[_-]?key|token|password|secret|authorization|cookie` 等键值。

## 5. `src/observer.js`

```js
export function attachObserver(ctx, store)   // 注册 tools/result 监听，返回 dispose；ctx 是插件 ctx（有 ctx.on）
export function recordObservation(state, { sessionId, agentId, toolCallId, tool, args, result })  // 纯函数：追加 observation 并应用写入影响，返回 observation|null
```

- 缺少 `sessionId` 或 `toolCallId` 或 `tool` → 返回 null（不可信，不落盘）。
- 去重键 `(sessionId, toolCallId)`：已存在则直接返回既有观察，不新增。
- 归属：`state.tasks` 中 `status === 'open' && sessionId === 当前会话` 的任务**恰好一个** → `taskId=该任务`；否则 `null`。
- `occurredAt` 用 `new Date().toISOString()`；`sequence` 取 `state.nextObservation` 自增；`id = 'obs-' + sequence`。
- `changeImpact` 为 `confirmed` 且绑定任务：`task.revision += 1`，把该任务所有 `revision < task.revision` 的验证标 `valid=false`，`task.updatedAt` 更新；写一条 `events` kind `invalidate`。
- `changeImpact` 为 `possible` 且绑定任务：`task.pendingChangeIds.push(id)`、`task.reviewStatus='unverified'`、写 `events` kind `invalidate`（detail 说明）。
- 观察容量上限 1000：清理最旧且未被任何任务/经验/验证引用的观察；无法清理则丢弃新观察并累加诊断计数 `state.droppedObservations`（不得删被引用记录）。
- `attachObserver` 内部用 `store.mutate` 写；异常被 contained（记录 `state.observerErrors` 计数），不得影响宿主工具结果。

事件签名（已在 DSH 0.2.1-rc.2 验证）：`ctx.on('tools/result', (exec, result) => {...})`，`exec` 有 `callId/name/arguments/agent?`，`result` 有 `isError/value/content/meta`。

## 6. `src/context.js`

```js
export function contextOf(exec, ctx, store)   // async → { sessionId, agentId, projectKey, cwd }
```

- `sessionId = exec?.agent?.id ?? null`；`agentId` 同值（宿主只给 SessionId）。
- `ctx.sessions.get(sessionId)` 拿 `session.header.cwd`；取不到 → `cwd=null`。
- `projectKey`：cwd 非空时 `git -C cwd rev-parse --show-toplevel`（缓存 60s，失败则 null）；不得用 `unspecified` 兜底。

## 7. `src/lifecycle.js`

```js
export function attachLifecycle(ctx, store)   // systemPrompt.section + agent/pre-step + agent/turn-stopping，返回 dispose
export const GUIDANCE                       // 静态段落文本
export function classifyRequest(text)       // 'applicable' | 'not_applicable' | 'uncertain'
```

- `ctx.systemPrompt.section({ name: 'praxis', order: 9500, text: GUIDANCE })`；`ctx.systemPrompt` 不存在时返回 `{ degraded: 'hook-unavailable' }` 且不抛。
- `ctx.on('agent/pre-step', async (payload, next) => {...})`：只对 `classifyRequest(...) === 'applicable'` 的**用户轮次**注入一次紧凑提醒；去重键 `sessionId + turn`，存 `state.sessions[sessionId]`；注入返回 `{ kind: 'enter', messages: [...] }`，提醒文本使用 `REMINDER` 常量；注入失败/不适用 → 调 `next()`。**不要每个 step 注入。**
- `ctx.on('agent/turn-stopping', async (payload) => {...})`：`observe` 模式，只记录诊断，不发消息、不续步。
- 任一钩子接线抛错 → 返回 degraded 标识，不吞错假装启用。

## 8. `src/engine.js`（Lead 负责，接口供 tools.js 使用）

```js
export function createEngine(store)
// engine.task(ctx, args)  → Promise<{ok,...}>
// engine.lesson(ctx, args) → Promise<{ok,...}>
// ctx: { sessionId, agentId, projectKey }
```

动作、参数与状态转换严格按设计稿 §4/§4.1/§4.2/§4.3/§5。`engine.task` 内部通过 `store.mutate` 实现单事务；返回统一响应。

v0.2.3 增补：只读动作 `summary` 提供跨任务聚合（`tasks.byPhase`/`byOutcome`/`byImplementationStatus`/`byProject`、未结任务前 `MAX_SUMMARY_TASKS`=20 条及其 `blockers`、`lessons` 标签热度、`observations` 可用性统计）。它走 `store.load` 只读路径，不进 `store.mutate`、不写 `requests`、不产生观察；`byPhase`/`byImplementationStatus` 统计全部任务（含已关闭任务，停在关闭时的阶段）。

## 9. `src/tools.js` / `index.js`（Lead 负责）

- `praxis_task` / `praxis_lesson` 两个工具，schema 按设计稿 §4/§5，`output.schema` 为 `{ type: 'object', ... }`，`render()` 返回 `[{ type: 'text', text }]`。
- `index.js`：`export const name = 'dsh-plugin-praxis'`，`inject = ['tools', 'sessions', 'systemPrompt']` 中不存在的可选依赖用 `ctx.get(...)` 兜底。
- 兜底前提：Cordis 对未在 `inject` 声明的服务**属性访问本身就会抛错**（如 `ctx.sessions` → `cannot get property "sessions" without inject`）。`src/context.js` 的 `resolveSessions` 必须先把属性访问包在 `try` 里，失败再退回 `ctx.get(...)`；`src/lifecycle.js` 的 systemPrompt 解析同理。回归用例见 `test/context.test.js`。

## 10. 测试

- `test/store.test.js`（队友 A）：锁竞争、损坏拒写、版本拒绝、原子写失败不破坏原文件、并发 mutate。
- `test/observer.test.js`（队友 B）：缺身份不记录、去重、唯一活动任务归属、confirmed 使验证失效、possible 进 pending、容量不删被引用。
- `test/lifecycle.test.js`（队友 C）：适用性分类、pre-step 每轮只注入一次、section 注册、钩子缺失降级。
- `test/engine.test.js`、`test/lesson.test.js`、`test/tools.test.js`（Lead）：A/B/D/E 组契约。

## 11. 硬性禁止

- 不新增第三方依赖；不读用户仓库文件（除 `git rev-parse`）；不启动子代理/浏览器/测试命令。
- 不修改本目录之外的文件；测试用临时目录覆写 `DSH_PRAXIS_DATA_DIR`。

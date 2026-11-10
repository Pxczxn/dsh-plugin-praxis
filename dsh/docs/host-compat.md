# 宿主适配检查（DSH 0.2.x）

> 首次记录：2026-11-10（UTC+8）
> 本机宿主：`@deepseek-ai/dsh` **0.2.2-rc.1**（Electron `app.asar`，随包 Node 24.21.0）
> 插件：`dsh-plugin-praxis` 1.1.0-beta.2
> 性质：源码级核对 + 运行态旁证；不替代真机行为测试（见 `phase-a-e2e.md`）。

## 1. 结论

插件依赖的 17 条宿主接缝在 0.2.2-rc.1 上**全部存在且形态一致**，不需要改运行时代码。
本轮真正的改动是两件事：把停在校验时期的版本下限纠正过来，以及把这次人工核对固化成可重复执行的 `npm run check:host`。

| 项 | 旧 | 新 | 理由 |
| --- | --- | --- | --- |
| `engines.dsh` | `>=0.1.0-rc.6` | `>=0.2.1-rc.2` | 0.1.0-rc.6 是早期占位，与 0.2 线的实际验证结论不符；0.2.1-rc.2 是首个跑通同一批接缝的版本 |
| `peerDependencies['@deepseek-ai/dsh-tools']` | `*` | `>=0.2.1-rc.2` | 同一条下限，避免 0.1 线被误认为受支持 |
| `version` | `1.1.0-beta.1` | `1.1.0-beta.2` | 安装期门禁变化会让低于下限的宿主装不上，属于对外可见变化 |

**为什么不写 `>=0.2.2-rc.1`**：本机只验证过 0.2.2-rc.1 的形态。下限写成首个验证版本（0.2.1-rc.2）更诚实；下限放行不等于更高版本也适配 —— 每次升级宿主后都要重跑 `npm run check:host`。

## 2. 怎么复核

```bash
npm run check:host                                  # 自动找本机安装位置
npm run check:host -- --host "<app.asar 或解包目录>"
npm run check:host -- --json                        # 机器可读
```

判定语义：包里找不到文件是 `UNVERIFIED`（发行方式可能变，例如 macOS 的 `.app`、解包目录），只有"文件在、接缝片段不见了"才是 `FAIL`；有 `FAIL` 时退出码 1。
脚本不进入 `npm test`：它读的是本机装好的发行体，属于环境相关检查，而 `test/` 必须保持用假 ctx 的可重复性。

想手工看宿主源码时，不必装 Electron：`app.asar` 的格式就是 `8 字节头 → JSON 索引 → 按偏移取文件`，用几十行 Node 就能抽出来（`scripts/check-host.mjs` 里的 `AsarReader` 即实现）。

## 3. 逐条对照（0.2.2-rc.1）

路径均相对 `app.asar` 内的 `dsh/node_modules/@deepseek-ai/`。

| # | 接缝 | 插件侧用法 | 宿主侧实现 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `tools.register` | `index.js` 传 `{name, description, parameters, output:{schema,render}, execute}` | `dsh-tools/lib/index.js:433-444` 要求 `output` 含 `schema` + `render`；`parameters` 原样作为 JSON Schema 使用（`defineTool` 的 `parameterSchemaSpecToJsonSchema` 只作用于另一条路径） | PASS |
| 2 | `tools/result` | `observer.js` 以 `(exec, result)` 收工具结果 | `dsh-tools/lib/pipeline.js:586`；`dsh-agent-instructions/lib/index.js:1499` 同款两参写法 | PASS |
| 3 | `agent/pre-step` payload | `lifecycle.js:589-593` 读 `payload.agent.id` / `payload.turn` / `payload.step` / `payload.messages` | `dsh-agent-loop/lib/index.js:685-697`（`{messages, turn, step, signal, modelSelection}`），`742-745` 传入 `{turn, step}` | PASS |
| 4 | `agent/pre-step` 放行 | 每个分支 `return next()` | 默认 fallback 返回 `{kind:'enter', messages}`（`agent-loop:690-697`） | PASS |
| 5 | 事件主体注入 | 上面两个事件的 payload 里没有 `agent` 字段，靠宿主注入 | `dsh-agent/lib/index.js:330-337` 的 fused 分发器：`payload` 的 `agent` 与 scope 不可分歧；`fused(payload)` 见 `:382` | PASS |
| 6 | `agent/turn-stopping` | `lifecycle.js:669-696` 记录闭环缺口 | `agent-loop:791` 以 serial 触发，payload 含 `turn`/`signal`/`agent` | PASS |
| 7 | `agent/created` | `lifecycle.js:571` 按 `payload.agent` 注册 scoped 上下文 | `dsh-agent/lib/index.js:710`：`{agent: entry.agent, source, signal?}` | PASS |
| 8 | `agent/disposed` | `lifecycle.js:572` 只撤该 agent 对象的注册 | `dsh-agent/lib/types/index.js:312`：`{agent: entry.agent}` | PASS |
| 9 | `agents.list()` | `lifecycle.js:577-580` 热加载后补注册 | `dsh-agent/lib/index.js:743` | PASS |
| 10 | `sessions.get(id)` | `context.js:37-41` 取 `session.header.cwd` | `dsh-session/lib/index.js:1999-2000` | PASS |
| 11 | header `cwd` | 绝对路径字符串，子会话按 `origin`/`parentSession`/`delegationDepth` 判空 | `dsh-session/lib/index.js:1048`（header version 4） | PASS |
| 12 | `ctx.on(..., {global:true})` | `trust.js:270` 收 `session/event` | `cordis/lib/index.js:834`：`hook.global \|\| !filter \|\| filter(...)` | PASS |
| 13 | `systemPrompt.section()` | `lifecycle.js:472` 注册 `praxis` 段落（order 9500） | `dsh-system-prompt/lib/index.js:255` | PASS |
| 14 | `systemPrompt.context()` | `lifecycle.js:493/539` 注册 `praxis:hint` | `dsh-system-prompt/lib/index.js:281` | PASS |
| 15 | `interpolate: false` | 两处注册都显式关闭插值 | `dsh-system-prompt/lib/index.js:156` | PASS |
| 16 | `user-question-reply` 事件 | `trust.js:28-93` 只认 `source.kind === 'user-question-reply'` 且 `outcome === 'answered'` | `dsh-user-questions/lib/index.js:570-573` | PASS |
| 17 | 来源类型声明 | 按 `callId` 精确配对 | `dsh-user-questions/lib/typert.host.js` 的 `MessageSourceMap`：`'user-question-reply': { kind; callId: ToolCallId; outcome: 'answered' }` | PASS |

### 运行态旁证（同一台机器、同一版本）

- `~/.dsh/praxis/state.json` 中 `observerErrors: 0`、`droppedObservations: 0`，`observations` 连续递增且 `changeImpact` 分级正确（`write` → `confirmed`，`pwsh` → `possible`，`praxis_task` 自身 → `not_applicable`）→ 接缝 2 在真机上生效。
- 同一文件 `sessions[*].turnStops` 在本次核对期间递增、`lastTurnStopAt` 落在本机当前时间 → 接缝 6 生效。
- 系统提示里可见 `praxis` 段落原文 → 接缝 13 生效；`praxis_task` / `praxis_lesson` 两个工具可见且可调用 → 接缝 1 生效。

## 4. 不在检查范围

- **提示的实际渲染时机**：`agent/pre-step` 写入与宿主求值 `context` 的先后顺序由宿主保证，脚本只能确认接口在，不能确认时序。
- **`classifyRequest` 的判定质量**：属于插件自身语义，与宿主版本无关；它决定"这一轮要不要提示"，所以提示没出现时先看分类结果，不要先怀疑接缝。
- **web/client 侧**：插件只用宿主侧服务，不碰前端 bundle。
- **宿主日志**：桌面版不落盘 praxis 的 `logger.warn`，降级信息只能通过 `state.json` 计数器与工具可见性间接判断。

## 5. 升级宿主之后

1. `npm run check:host` —— 有 `FAIL` 就先按失败的条目查宿主实现，再决定改插件还是抬下限。
2. `npm test` —— 接缝没变时的插件自检。
3. 真机开一个新会话，确认「系统提示里有 praxis 段落」「`praxis_task start` 返回 ok」「`state.json` 的 `observerErrors` 不涨」。
4. 把新版本号与结果补进本文，替换日期与本机版本，别让这份表变成过期断言。

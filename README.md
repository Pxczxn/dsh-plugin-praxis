# dsh-plugin-praxis

Praxis 给 DSH 加上一套**任务台账**与**可检索的错题本**：它不替模型写代码，只强制三件事有据可查——需求判断有证据、完成声明有验证、经验沉淀可复用也能被修正。

## 它解决什么

| 常见问题 | Praxis 的做法 |
| --- | --- |
| 没调查就动手，把已有能力重写一遍 | `need` 记录「复用 / 扩展 / 新增」判断，必须附可复核证据 |
| 说「已完成」，但没有跑过验证 | `verify` 的 `passed` 只能引用宿主记录的观察 ID |
| 验证完又改代码，报告却还是旧的 | 后续写入会让先前验证失效，需要重新验证 |
| 错题本越写越像日志，查不到也改不动 | 保存门槛、近似查重、`supersedes` 取代链、`retire` 退役 |

## 安装

插件以 Cordis bundle patch 形式挂载，profile 的 `package.json` 声明依赖即可：

```json
{
  "dependencies": {
    "dsh-plugin-praxis": "link:../../plugins/praxis"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-plugin-praxis"]
    }
  }
}
```

`cordis.patch.yml` 会插入一行 `tool-praxis`。安装后需要新开一个会话（或重启 Harness）让宿主重新装配。

## 两个工具

### `praxis_task` — 任务台账

| 动作 | 用途 |
| --- | --- |
| `start` | 建任务，记录目标与已知验收项，初始阶段 `understand` |
| `need` | 调查结论：目标、`reuse`/`extend`/`new`、证据 |
| `inventory` | 批量调整调查结论与验收项（改动验收项要带 `change_reason`） |
| `step` | 阶段流转 `understand` → `implement` → `verify`；前进或回退都按状态表校验 |
| `verify` | 记录一次验证：`level`、`scope`、逐项 `coverage[]` 与观察 ID |
| `close` | 结项：`outcome`（`done`/`partial`/`abandoned`）+ `implementationStatus` |
| `status` | 查看任务现状、未覆盖验收项、候选观察与阻断原因 |
| `summary` | 跨任务只读概览：阶段/结局/项目计数、未结任务及其收尾阻碍、经验与观察统计 |

`status` 与 `summary` 的分工：前者一次只看一个任务（含候选观察分页），后者回答「整体到哪了」。`summary` 是纯读动作——不改状态、不产生观察、不需要 `request_id`；`byPhase`/`byImplementationStatus` 统计全部任务（含已关闭任务，它们停在关闭时的阶段），未结任务只展开最近活跃的 20 条，其余用 `openRemaining` 计数。

关键门槛：

- 进入 `implement` 前，至少一条 `need` 的 `evidence` 必须是具体证据（文件+行号、命令+输出等）；弱证据不放行。
- 进入 `verify` 前必须有活跃验收项；从 `understand` 直接跳到 `verify` 要在 `note` 里写明为何无需实现。
- 回退阶段（`implement`/`verify` → 更早）必须给 `note`，计入 `corrections`，并让本轮验证失效。
- `verify` 的 `passed` 必须满足：每一项 `coverage` 都指向当前活跃的验收项，且引用一条成功执行的 `test`/`build`/`lint` 类观察；失败或只读的观察不能当验收证明。
- `close(done)` 要求：阶段已在 `verify`、`implementationStatus=complete`、没有待复核的写入、当前 revision 的每条活跃验收项都有 `passed` 覆盖，且验证之后没有新的确认写入。
- 等待人工验收用 `close(partial)` + `implementationStatus=complete` + `closureReason=awaiting_manual`。

### `praxis_lesson` — 错题本

| 动作 | 用途 |
| --- | --- |
| `search` | 按关键词、项目、标签检索（只读，不改使用数据） |
| `save` | 保存经验，证据必须是具体证据（文件+行号、命令+输出等） |
| `update` | 修正已保存经验；必须给 `reason`，改弱证据或与其它活跃经验高度重合会被拒绝 |
| `retire` | 退役过期经验，必须给 `reason` |

查重分三档：完全相同不重复保存；相似度 ≥ 0.85 要求 `difference_reason`；≥ 0.6 仅提示相关条目。`supersedes` 可以显式取代旧经验，被取代的条目从检索中消失但保留可追溯性。

## 证据规则

`concrete`（具体证据）满足任一组：

- 文件 + 行号，如 `src/store.js:120`
- 命令 + 输出 / 结果，如 `node --test` 加 `17 passed`，或 `node --test → 113 pass 0 fail`
- 原样引用 + 可核对结果
- 文件 + 命令，如 `src/store.js 由 npm test 覆盖`

只写「我试过了」「应该可以」不算证据；URL 里的路径不会被当成本地文件定位。

## 自动观察

插件监听 `tools/result`，把工具调用与结果记录为观察（脱敏并截断），供 `verify` 与经验引用：

- 确认写入（`write`/`edit`/`patch` 等）会让任务 `revision` 递增，并让先前的验证失效；
- 每条观察都记下采集时的**实现版本**。实现变更后，变更前采集的观察不能再作为通过证据（`verify` 报 `stale-verification`），必须重跑检查；
- 无法确认是否改动了实现的命令会进入待复核写入，阻断 `close(done)`，直到满足解除条件：**一次覆盖全部活跃验收项的 `verify(passed)`**（引用发生在这些写入之后的观察）会解除它们——局部验证不会；先后顺序按观察序号判定，系统时钟回拨不会把「验证之后才发生的写入」误判成「验证之前」；被这次验证引用、同时又留在待复核队列里的观察会被一并解除（否则这条验证自己就把 `close(done)` 挡死了），但前提是这条观察本身够干净——见下一条；期间实现被改过多次、这些写入停留在旧版本上，也照样会被下一次有效验证解除——解除只看先后，不要求实现版本号相同，否则这类旧记录永远等不到匹配的版本号，`close(done)` 会被历史数据永久阻断；真正拦住的是「验证之后才发生的写入」，它们序号更大，不会被这次验证解除；
- 可能包含实现写入的观察不能充当通过证据（引用它会得到「这条观察可能包含实现写入」的拒绝），必须另跑一条只含检查的命令。一条命令里既有检查又有源码改动（`npm test && echo … > src/a.js`）就属于这一类：整条命令降级为过程证据，因为检查和写入挤在同一次调用里，测试结果证明不了随后的实现；
- 只含检查的管道仍然算检查：`npm test | grep …`、`npm test 2>&1 | Select-String …` 这类只读过滤器不会被当成写入；`tee`、重定向等真正落盘的部分照旧算写入；
- `npm run <script>` 会去项目根读 `package.json`：只有脚本体全部落在已知检查命令上（`node --test`、`eslint .`、`tsc -p .`/`vite build` 这类构建）才按测试/lint/build 处理；自定义脚本（benchmark、部署脚本）与脚本体含写命令时仍算可能的写入。读不到 `package.json`、脚本不存在时一律保持保守判定；
- 只为检查而读的命令（测试、构建、lint、只读查看）不会让验证失效；其中 test/build/lint 还可以直接引用为通过证据 —— 构建只写 dist/target 这类派生产物，不算实现变更；
- `isError: false` 但退出码非零的观察不算通过证据；`praxis_task` / `praxis_lesson` 自身的调用、计划类工具（`todo_write` 等）与上下文类工具（`compress`、`ask_user_question` 等）都不参与写入分级；
- 把输出重定向进系统临时目录（造测试 fixture、抓测试日志）按验证动作处理，只有写到工作区里的文件才算变更。

宿主事件通道不可用时自动降级为**手动工具模式**，并在日志里明确说明，不会假装已经观察。

轮次结束时插件只做诊断：若本会话仍有未闭环任务，下一轮的第一步会通过宿主的运行时上下文通道送一条具体提醒（点明缺哪一环），不替模型结项，也不重复刷屏。

三种提示（未闭环提醒、经验提示、改动提醒）都写进 `systemPrompt.context()` 注册的 `praxis:hint` 上下文，不再往消息列表里塞一条 user 消息：聊天界面不会出现冒名的用户气泡，对话历史也不被污染。文本由 `agent/pre-step` 写入状态、请求前按 `context.agent.session` 求值，因此会话之间、父子代理之间互不串扰。

改代码提醒只在请求被判为**改动意图**时出现：以整理、梳理、说明、介绍、解释、总结、盘点、评估、讲解、列出、看看、查看、显示、分析、讨论、检查、复查、对比、回顾开头的请求（例如「整理一下这个项目的开发规划」「分析一下 src/lifecycle.js 的实现」）即使句子里出现「开发」「实现」这类词，也按说明类请求跳过；「开发计划」「实现思路」「设计文档」「开发进度」这类名词短语同样不算动手意图。反过来，口语化的改动请求（「给插件加个配置」「给 README 补一段说明」「优化一下这个判断」）要能识别成改动。

经验提示要求措辞真的对得上：英文标识符一个就够（`pre-step`、`rename`），中文则至少要两个二元组重合——只重合「插件」「动作」这类高频词属于噪声，不提示。宁可漏提示，也不每轮催检索。

## 数据与安全

- 数据默认在 `~/.dsh/praxis/state.json`；优先级是插件配置 `dataDir` > 环境变量 `DSH_PRAXIS_DATA_DIR` > 默认目录。
- 需要隔离验证时，在 profile 的 `cordis.patch.yml` 给 `tool-praxis` 加 `config: { dataDir: <目录> }`，重启后生效。宿主里插件是单例，改环境变量或传临时参数都不会切换已有实例，所以只能走配置 + 重启。
- 写入走「临时文件 + fsync + rename」，并持有 `state.lock` 跨进程串行。替换失败时先把旧状态原子挪到 `state.json.bak` 再替换：任何一步失败都会把旧状态放回原位、新状态完整留在临时文件里；崩溃留下的「有备份、没状态文件」窗口，下次加载会自动从备份恢复。同机持锁进程已退出时锁立即回收，跨机只在超过 10 分钟后回收。
- 状态文件损坏、版本不支持时**拒绝覆盖**，保留现场并报错，而不是重建空状态。
- 会话与项目作用域：项目经验只在同项目检索到，`global` 经验对所有项目可见。
- 子代理会话的工作目录是从父会话继承来的，不能当成项目证据：这类会话的 `projectKey` 一律为空，既不会把子任务记到父项目名下，也不会把父项目的经验混进来。需要项目归属时由调用方显式传 `projectKey`。

## 开发

```bash
npm test          # node --test，全部用例
npm run check     # 对每个源文件做 node --check
```

模块划分：`src/evidence.js`（证据分级、相似度、相关性）、`src/store.js`（原子存储与锁）、`src/engine.js`（任务与经验规则）、`src/tools.js`（工具 schema 与处理器）、`src/observer.js` + `src/classify.js`（工具观察与写入影响分级）、`src/lifecycle.js`（指引段落与提醒）、`src/context.js`（会话/项目上下文）。

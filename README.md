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

插件监听 `tools/pre-execute` 与 `tools/result`，把工具调用与结果记录为观察（脱敏并截断），供 `verify` 与经验引用：

- 确认写入（`write`/`edit`/`patch` 等）会让任务 `revision` 递增，并让先前的验证失效；
- 无法确认是否改动了实现的命令会进入待复核写入，阻断 `close(done)`，直到重新确认或复验；
- 只为检查而读的命令（测试、构建、lint、只读查看）只作为过程证据，不会让验证失效。

宿主事件通道不可用时自动降级为**手动工具模式**，并在日志里明确说明，不会假装已经观察。

## 数据与安全

- 数据默认在 `~/.dsh/praxis/state.json`，可用 `DSH_PRAXIS_DATA_DIR` 覆盖。
- 写入走「临时文件 + fsync + rename」，并持有 `state.lock` 跨进程串行；崩溃留下的陈旧锁（超过 10 分钟且持有者不在）会被回收。
- 状态文件损坏、版本不支持时**拒绝覆盖**，保留现场并报错，而不是重建空状态。
- 会话与项目作用域：项目经验只在同项目检索到，`global` 经验对所有项目可见。

## 开发

```bash
npm test          # node --test，全部用例
npm run check     # 对每个源文件做 node --check
```

模块划分：`src/evidence.js`（证据分级、相似度、相关性）、`src/store.js`（原子存储与锁）、`src/engine.js`（任务与经验规则）、`src/tools.js`（工具 schema 与处理器）、`src/observer.js` + `src/classify.js`（工具观察与写入影响分级）、`src/lifecycle.js`（指引段落与提醒）、`src/context.js`（会话/项目上下文）。

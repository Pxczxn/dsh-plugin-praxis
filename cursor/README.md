# cursor-plugin-praxis

Praxis 的 Cursor Plugin 版本：一套**任务台账**与**可检索的错题本**。它不替模型写代码，只要求需求判断有证据、完成声明有验证、经验沉淀可复用也能被修正。

规则引擎与 DSH 版共用：`dsh/src` 是唯一事实来源，安装/测试前由 `scripts/sync-core.mjs` 复制到 `server/core/`（生成物，不提交）。

## 组件

| 组件 | 位置 | 作用 |
| --- | --- | --- |
| MCP server `praxis` | `mcp.json` → `server/index.js` | 提供 `praxis_task`（任务台账）与 `praxis_lesson`（错题本） |
| Hooks | `hooks/hooks.json` | `sessionStart` / `sessionEnd` 维护会话指针；`afterFileEdit`、`postToolUse`、`postToolUseFailure` 把编辑与命令记成观察；`beforeSubmitPrompt` 写入轮次提醒；`stop` 在轮次结束时诊断未闭环任务 |
| Rule | `rules/praxis.mdc` | 常驻的工程纪律说明（`alwaysApply: true`） |
| Skill | `skills/praxis/SKILL.md` | 何时建任务、如何走 `need` / `step` / `verify` / `close`，以及经验检索流程 |
| 引擎副本 | `server/core/` | 由 `dsh/src` 生成，供 MCP server 与 hooks 共用 |

Cursor 没有 DSH 的宿主确认链，因此验收项不要标 `protected: true`，也不要用 `source: user_explicit`；需要人工确认的项用 `kind: manual` + `agent_proposed`。

## 安装

需要 Node.js ≥ 20，以及支持本地插件的 Cursor（插件目录为 `~/.cursor/plugins/local`）。

**一键安装**：把下面这段话复制发给 Cursor，让 Agent 替你完成安装：

```text
帮我一键安装 Praxis 的 Cursor 插件（cursor-plugin-praxis）：
1. 若本机还没有克隆 https://github.com/Pxczxn/dsh-plugin-praxis，先克隆到本地；已有克隆则进入该仓库并 git pull 更新 main；
2. 确认 Node.js ≥ 20；
3. 在仓库根目录按当前系统运行安装脚本：Windows 用 pwsh -File cursor/scripts/install.ps1（没有 pwsh 时 powershell -File 也可以），macOS / Linux 用 sh cursor/scripts/install.sh；
4. 脚本会把插件复制到 ~/.cursor/plugins/local/praxis。装好后提醒我：需要重启 Cursor 或执行 Developer: Reload Window 才生效，praxis 的 MCP 首次调用需要手动批准。
```

也可以手动在仓库根执行：

```powershell
pwsh -File cursor/scripts/install.ps1
```

```sh
sh cursor/scripts/install.sh
```

在 `cursor/` 目录内执行时去掉路径前缀即可。可用参数：

| 参数 | 作用 |
| --- | --- |
| `--dest <dir>` | 安装目录，默认 `~/.cursor/plugins/local/praxis` |
| `--dry-run` | 只打印将要做出的改动，不生成 `server/core`、不复制文件 |
| `--skip-sync` | 不重新生成 `server/core`（默认先用 `../../dsh/src` 生成） |

安装脚本做三件事：

1. 运行 `scripts/sync-core.mjs`，把 `dsh/src/*.js` 复制到 `server/core/`；
2. 把整个 `cursor/` 复制到 `~/.cursor/plugins/local/praxis`，重复安装会整体替换旧副本；
3. 提示重启 Cursor。

这里用复制而不是符号链接：Cursor 只加载 `~/.cursor/plugins/local` 内部目录里的插件，指向仓库外部的符号链接会被跳过。

安装后重启 Cursor（或执行 **Developer: Reload Window**），在 **Customize** 里确认 praxis 的 MCP server、Hooks、Rules、Skills 已加载。MCP 的首次调用需要手动批准；插件里的 MCP server 在审批提示中带 `plugin-` 前缀。

## 验证

```powershell
cd cursor
npm test        # 先 sync-core，再跑 node --test
npm run check   # 对每个源文件做 node --check
```

`test/` 用于本地验证，不会被安装脚本复制。

## 数据

默认数据目录是 `~/.cursor/praxis/`，与 DSH 版的 `~/.dsh/praxis/` 分开，避免两个宿主互相写入对方的会话归属。

- `state.json`：任务、经验、观察与确认记录；
- `session.json`：hook 写入的活跃会话指针，MCP server 每次调用时读回；
- 环境变量 `CURSOR_PRAXIS_DATA_DIR` 或 `PRAXIS_DATA_DIR` 可以改到其它目录。

## 卸载

```powershell
pwsh -File cursor/scripts/uninstall.ps1
```

```sh
sh cursor/scripts/uninstall.sh
```

卸载只删除插件目录，不删除 `~/.cursor/praxis/`。需要清空数据时手动删除该目录。

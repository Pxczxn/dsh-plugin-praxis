# praxis

Praxis 给 AI 编码代理加上一套**任务台账**与**可检索的错题本**：不替模型写代码，只要求三件事有据可查——需求判断有证据、完成声明有验证、经验沉淀可复用也能被修正。

同一个引擎（`dsh/src`）有两个宿主版本：

| 目录 | 宿主 | 形态 | 安装脚本 |
| --- | --- | --- | --- |
| [`dsh/`](dsh/README.md) | DeepSeek Harness | Cordis bundle 插件，提供 `praxis_task` / `praxis_lesson` 两个工具 | `dsh/scripts/install.ps1` / `install.sh` |
| [`cursor/`](cursor/README.md) | Cursor | Cursor Plugin：MCP 任务台账 + hooks + skill + rule | `cursor/scripts/install.ps1` / `install.sh` |

## 安装

DSH（把 `dsh/` 链接进目标 profile，并装配 bundle）：

```powershell
pwsh -File dsh/scripts/install.ps1            # 可选：--profile <dir> --dry-run --skip-install
```

```sh
sh dsh/scripts/install.sh
```

Cursor（把 `cursor/` 复制到 `~/.cursor/plugins/local/praxis`，先由 `dsh/src` 生成引擎副本）：

```powershell
pwsh -File cursor/scripts/install.ps1         # 可选：--dest <dir> --dry-run --skip-sync
```

```sh
sh cursor/scripts/install.sh
```

两个版本在运行时互不依赖，可以只装其中一个。安装 Cursor 版时需要仓库里的 `dsh/src`：安装脚本会先把引擎复制到 `cursor/server/core/`，再复制整个插件目录。卸载分别用各自 `scripts/` 下的 `uninstall.ps1` / `uninstall.sh`。

## 目录说明

- `dsh/`：DSH 插件本体、契约与设计稿。`dsh/src` 是引擎的唯一事实来源。
- `cursor/`：Cursor 插件。安装/测试前由 `cursor/scripts/sync-core.mjs` 把 `dsh/src` 复制到 `cursor/server/core/`（生成物，不提交），因此两个宿主的任务规则、证据分级和门槛始终一致。
- `dsh/CONTRACT.md`、`dsh/Praxis-DESIGN-v0.2.1.md`：两个版本共用的行为契约与设计基线。

# tabby-cmd-history

`tabby-cmd-history` 是面向 [Tabby](https://github.com/Eugeny/tabby) 桌面端的 connection 隔离命令历史与输入预测插件。它参考 PowerShell [about_History](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_history) 和 [PSReadLine](https://learn.microsoft.com/powershell/module/psreadline/about/about_psreadline) 的历史预测体验，但不依赖 PowerShell，也不会替换 Shell 自己的历史机制。

当前版本是 `0.1.0` 发布候选，尚未发布到 npm。支持 Tabby desktop 1.x，peer range 为 `>=1.0.231-nightly.0 <2`；不支持 Tabby Web，因为浏览器环境不能满足原生用户目录文件持久化要求。

## 功能

- 记录用户在终端中提交过、且通过捕获安全检查的命令。
- 首次访问 persistent key 时，插件异步把该 connection 的隔离 JSONL 加载到进程内共享索引；后续匹配和排序面向该内存索引。收到仓储 mutation 通知时会异步刷新对应 key 的内存快照。
- Up/Down 选择候选，Right 只把候选填入当前命令行，绝不附加 Enter 或自动执行。
- 每个 connection 独立存储和查询；相同 connection key 的多个 tab 共享历史，不同 key 之间不会互相推荐。
- 历史以 JSONL 保存在本机当前用户的数据目录，不写入项目目录、Tabby 安装目录或 Tabby 配置文件。
- 设置页可调整展示、匹配、容量、安全策略、按键和数据目录，并可二次确认后清空当前 connection。

## 预测模式

三种模式全部可在设置中切换，默认是 **B（list）**。设置界面中的枚举值如下：

| 模式 | 设置值 | 行为 |
|---|---|---|
| A | `inline` | 在当前行显示选中候选的 ghost suffix。 |
| B（默认） | `list` | 在光标附近显示候选列表，默认最多 5 条。 |
| C | `hybrid` | 默认显示 inline 预测，按 Down 展开列表。 |

## 默认配置和按键

| 项目 | 默认值 |
|---|---|
| 插件 | 启用 |
| 展示 | B / `list` |
| 最短查询长度 | 1 |
| 最大可见候选数 | 5 |
| 匹配大小写 | 不区分 |
| 每个 connection 唯一命令容量 | 4096 |
| recency / frequency / matchCloseness | 55% / 30% / 15% |
| 捕获 | `strict` |
| 敏感过滤 | 启用 |
| 上一条 / 下一条 | Up / Down |
| 采纳 / 关闭 | Right / Escape |

导航和采纳按键可以改为设置页列出的 Arrow 或 Ctrl+Arrow 组合。插件拒绝普通可打印字符和 `Ctrl+C` 作为绑定。只有存在活动候选时，导航、采纳和关闭按键才由插件消费；没有候选时原始字节仍交给 Shell。Tab 始终交给 Shell；插件随后清空自己的重建 buffer 以丢弃可能已过期的文本，并按 Enter 时从可见行恢复完整命令。

`Ctrl+C` 是不可配置的安全边界：

- 有候选时，候选、选择、插件 buffer、粘贴/关闭状态和尚未提交的持久化请求立即清空，同时 `Ctrl+C` 原样传给终端。
- 没有候选或进程正在运行时，插件仍不拦截 `Ctrl+C`，并同步清空自己的状态。

## 捕获语义和限制

默认 `strict` 模式只考虑插件能够可信重建、且提交前能在 xterm 中看到对应可见回显的非空 buffer。这用于降低密码提示或无回显程序输入被保存的风险。记录表示“插件观察到用户提交了这段输入，并通过了严格可见回显检查”，**不表示命令已经启动、执行完成或执行成功**。

`permissive` 模式会记录所有能够可信重建并以 Enter 分隔的输入，即使无法验证可见回显；这可能包括 Shell 提示符之外的输入。只有明确接受此风险时才应启用。

通用捕获器无需向本地或远端 Shell 注入脚本，因此有以下边界：

- bracketed paste 的多行内容可作为一次编辑；只有终端报告支持 bracketed paste 时，多行历史才参与预测和安全采纳。
- 通用模式不能可靠识别所有 Shell 续行提示。逐次 Enter 的续行可能被学习成多条提交，而不是最终 Shell 命令。
- Shell 原生补全、未知控制序列或插件无法观察的命令行重写会立即使 buffer 清空并进入不可信状态：不展示预测，也不再把过期文本当作当前命令。按 Enter 时，插件尝试用重写前的文本作为锚点从可见行恢复完整命令（例如 `systemctl stat` 被补全为 `systemctl status`），恢复结果仍必须通过严格可见回显检查才会记录；无法恢复时不记录该 buffer，直到 Enter 或 `Ctrl+C` 重置。
- alternate screen（例如 Vim、less、top）期间完全禁用捕获和预测，所有输入直接透传；回到 normal screen 后从空 buffer 重新开始。
- 未来可通过 `CommandCaptureAdapter` 接入 Shell 专用最终命令边界；`0.1.0` 不安装或注入任何 Shell hook。

## 敏感历史策略

敏感过滤默认启用。在事件进入磁盘队列之前，插件以不区分大小写的内置关键词过滤 `password`、`asplaintext`、`token`、`apikey` 和 `secret`，并应用用户逐行配置的正则表达式。用户表达式使用 JavaScript `iu` flags；无效表达式不能保存。

命中时整条命令会被丢弃，不会写入保留凭据片段的“脱敏版本”。但这只是保守的关键词/正则策略，**不是秘密扫描器，也不能保证发现所有凭据**。对于会在命令行中出现秘密的工具，建议避免把秘密作为参数、为其增加 exclusion pattern，或在确有需要时关闭持久化环境中的插件。

关闭敏感过滤不会关闭严格可见回显检查；反之亦然。

## Connection 身份和隔离

仓储的每次 load、query、append、compact 和 clear 都必须显式携带 connection key。持久化文件名只使用规范身份的 SHA-256 小写十六进制摘要，不包含 profile 名、主机、用户名、密码、Token、当前目录或命令文本。

- 保存的 profile 使用稳定的 profile type 和 ID，重命名不会合并或移动历史。
- SSH Quick Connect 使用规范化的用户、主机和实际端口。
- 当前 Tabby 的临时 Serial connection 保留 `port` 大小写，并使用规范化的 `baudrate`、`databits`、`stopbits` 和 `parity`；旧 `device/baud` shape 仅保留兼容。
- 当前 Tabby 的临时 Local connection 保留 `command` 与各项 `args` 的文本和大小写，并规范化 `shellType`；旧 `path/provider/shell` shape 仅保留兼容。
- generic provider 仅在 type、稳定名称及递归清理后的安全 options 足以形成稳定身份时持久化。
- 密码、Token、私钥、环境变量值、当前目录、窗口大小、PID、PTY/session 恢复信息等会从 generic identity 输入中移除。
- 无法安全、稳定解析时退化为该 terminal 对象生命周期内的 `memory-only` key，绝不读取其他 connection 的文件。

使用同一 key 的已打开 tab 会收到仓储变更通知并共享更新；清空只影响当前聚焦 connection。

## 数据目录和格式

默认根目录：

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\tabby\cmd-history` |
| macOS | `~/Library/Application Support/tabby/cmd-history` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/tabby/cmd-history` |

每个 connection 文件位于 `connections/<sha256>.jsonl`。高级设置中的自定义目录必须是当前用户主目录内的绝对路径；空值恢复默认目录，保存后需重启 Tabby 才会由仓储实例采用。

追加事件示例：

```json
{"v":1,"kind":"use","command":"git status","at":"2026-08-12T12:00:00.000Z"}
```

压缩后的聚合记录示例：

```json
{"v":1,"kind":"entry","command":"git status","lastUsedAt":"2026-08-12T12:00:00.000Z","useCount":7}
```

加载会跳过损坏、未知或最后一行被截断的 JSONL 记录，并继续使用其余有效记录。追加或读取不可用时，插件按 connection 保留本进程内的 memory-only 历史，并对同一 connection/阶段最多记录一次不包含原始命令的警告；输入链路继续 fail-open。清空文件失败时设置页会显示失败，不会声称已清空持久化历史。

JSONL 在事件数达到容量阈值时压缩；文件超过 2 MiB 时，还必须自上次成功压缩后累计 512 条成功写入的 `use` 事件才会再次压缩，避免大文件在每次追加后重复改写。

卸载插件不会自动删除历史。若要删除数据，请先关闭 Tabby，确认是否需要备份，然后用文件管理器手工删除上述默认目录或设置过的自定义目录；插件和安装流程不会替你执行删除。

## 安装

### Tabby 插件管理器（npm 发布后）

此版本尚未发布。发布到 npm 后，可在 Tabby 的 Plugins 页面搜索 `tabby-cmd-history` 并安装；安装后按 Tabby 提示重启。请先核对包名、版本和发布者，不要把本节视为“现已发布”的声明。

发布后若需要从 npm 手工安装，可先在 Tabby 的 Plugins 页面选择 **Open Plugins Directory**，在打开的目录中执行 `npm install tabby-cmd-history`，然后重启 Tabby。该命令在包正式发布前不会获得本发布候选；日常安装仍优先使用 Tabby Plugin Manager。

### 本地开发加载

需要 Node.js 20 或更高版本。先在仓库根目录安装依赖并构建：

```powershell
npm ci
npm run build
$env:TABBY_PLUGINS = (Get-Location).Path
& "$env:LOCALAPPDATA\Programs\Tabby\Tabby.exe" --debug
```

Unix-like 环境：

```bash
npm ci
npm run build
TABBY_PLUGINS="$(pwd)" tabby --debug
```

本地 debug 会让 Tabby 从 `TABBY_PLUGINS` 指向的位置发现开发插件。不要把个人配置、历史文件或 debug 日志提交到仓库。

## 开发、测试和发布检查

```bash
npm ci
npm test
npm run lint
npm run typecheck
npm run typecheck:test
npm run build
npm run pack:check
npm run verify
```

`npm run verify` 依次执行 ESLint、插件与测试 TypeScript 类型检查、Jest、production webpack build 和真实 `npm pack --dry-run --json` allowlist 检查。发布包只允许 `dist/**`、`README.md`、`LICENSE` 和 `package.json`。

2026-08-13 的自动化基线为 18 个 suite、305 个 test；4096 条唯一历史的查询 benchmark p95 为 0.204 ms，低于 10 ms 门槛。该数字来自自动测试，不等同于真实 Tabby GUI 验收。发布包不包含 `docs/`；请从源码 checkout 查看 `docs/manual-acceptance.md` 中的真实环境状态和复验步骤。

## 界面截图

当前仓库没有经过真实 Tabby 验证的截图，因此不提供生成图或示意图冒充产品截图。后续人工采集的真实截图预留在 `docs/images/`，但该目录不会进入 `0.1.0` npm 包。

## 安全边界摘要

- 终端输入 fail-open；插件故障不应阻断非活动历史快捷键或其他原始输入。
- 采纳只编辑命令行，不执行命令。
- 严格捕获、敏感过滤和 identity 清理是分层减风险措施，不是绝对防泄漏保证。
- 诊断日志不得包含原始命令、密码、Token 或文件中的 JSONL 内容。
- 如果存储、解析、匹配或 overlay 失败，插件隐藏预测或退化到隔离内存状态，不退化成跨 connection 共享。

## License

本项目采用 [MIT License](LICENSE)。`LICENSE` 保留标准英文法律文本，不做翻译；本 README 的中文说明不替代许可证原文。

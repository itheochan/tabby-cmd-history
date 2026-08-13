# tabby-cmd-history 手工与真实环境验收记录

## 验收元数据

| 项目 | 值 |
|---|---|
| 日期 | 2026-08-13（Asia/Singapore） |
| 官方当前稳定版 | Tabby v1.0.235（GitHub Releases，2026-07-22 发布） |
| 本机实际载入版 | Tabby 1.0.235（本次隔离 debug 日志中的 core version；与官方版本号相同但证据来源独立） |
| 操作系统 | Microsoft Windows 10.0.26200，x64 |
| Node.js | v22.14.0 |
| 验收对象 | 当前 release candidate 源码（含最终审计修复） |
| 自动化基线 | 18 suites / 312 tests；4096 entries query p95 0.204 ms |

状态含义：

- `PASS`：本次验收有真实环境证据；自动化测试不会被写成 GUI PASS。
- `FAIL`：本次真实操作已观察到功能错误，需要阻断发布并修复。
- `ENVIRONMENT UNAVAILABLE`：本机缺少所需 Shell/SSH target/权限，或安全规则禁止向终端应用自动输入；列出自动覆盖和人工复验步骤。
- `NOT RUN`：本可执行但尚未执行，属于发布阻断。

本次记录没有把自动测试换算成 GUI PASS，也没有 `NOT RUN`。Codex 的 computer-use 安全边界禁止自动化 terminal app，因而所有需要在 Tabby 终端内输入命令的行均记为 `ENVIRONMENT UNAVAILABLE`。这些状态不是功能通过证据；公开发布前仍建议由人工操作者按最后一列复验。

## 真实 Tabby 插件载入

| 项目 | 状态 | 本次证据 |
|---|---|---|
| 隔离启动与插件发现 | PASS | 使用仅属于本次任务的临时 `APPDATA`、`LOCALAPPDATA` 和 `--user-data-dir`，并用 Tabby 在 Windows 支持的 `/cygdrive/d/...` 绝对路径表达设置 `TABBY_PLUGINS`；debug 日志先后出现 `Found cmd-history` 和 `Loading cmd-history: ...\dist\index.js`。 |
| Angular module / DI 初始化 | PASS | 插件加载后继续运行 20 秒，日志中未出现 `Could not load cmd-history`、`NullInjectorError`、Angular `NG0...` 或未捕获异常。 |
| 用户状态保护 | PASS | 最终复验启动前已有的 Tabby PID 为 `7364, 24532, 26340, 27740, 41564`；只停止本次启动 PID `59116`，停止后没有本次新增残留进程。未读取或修改用户配置，未向任何终端输入。 |

Task 12 的首次隔离启动曾真实暴露 `Cannot load package info for tabby-cmd-history`。依据 Tabby 的公开 loader 源码定位为 `package.json` 缺少 `author`，补齐后用全新隔离目录复跑通过。最终审计后又用新隔离目录、当前构建和 `ELECTRON_ENABLE_LOGGING=1` 复验得到以上 PASS。debug 日志在运行时仅写入本次 task temp；核验后相关目录已清理，原始日志未跟踪、未提交。

日志中另有 Chromium DevTools 的 `Autofill.enable` / `Autofill.setAddresses` 协议方法不存在消息；它们没有引用本插件、Angular 或 DI，作为环境噪声记录，不计为插件功能 PASS 或 FAIL。

## Shell、connection 与交互矩阵

| 场景 | 状态 | 自动化证据（非 GUI PASS） | 人工复验步骤 |
|---|---|---|---|
| PowerShell | ENVIRONMENT UNAVAILABLE | controller、strict echo、持久化和 fail-open 集成测试覆盖通用终端路径；本机有 PowerShell 7.6.3。 | 在隔离 profile 中提交一个非敏感命令，重新输入前缀，确认 B 列表出现；Right 只填入、不执行；重启 Tabby 后仍可预测。 |
| cmd.exe | ENVIRONMENT UNAVAILABLE | 与 PowerShell 共用不依赖 Shell hook 的 controller/middleware 测试路径；本机有 `cmd.exe`。 | 创建 cmd profile，提交非敏感命令；验证前缀预测、只采纳不执行和重启持久化。 |
| WSL Bash | ENVIRONMENT UNAVAILABLE | 通用捕获及 connection identity 有自动测试；本机 `wsl -l -q` 只有 `docker-desktop`，没有用于人工验收的用户发行版。 | 在有用户 WSL 发行版的机器创建 Bash profile，重复 PowerShell 的提交、预测、采纳和重启检查。 |
| 本地 Bash / Zsh | ENVIRONMENT UNAVAILABLE | Unicode、paste、未知控制序列、Tab 补全后锚点恢复和通用终端集成测试覆盖协议行为；本机有 Git Bash，但没有 Zsh，且禁止自动输入 Git Bash。 | 在 Git Bash 及可用的 macOS/Linux Zsh 中各提交命令，验证预测；触发 Shell 原生补全（例如 `systemctl stat` + Tab）后继续输入并 Enter，确认预测暂时隐藏、缓存不再携带过期文本，且完整命令仍被记录并可在下次输入前缀时提示。 |
| 保存的 SSH profile | ENVIRONMENT UNAVAILABLE | identity 测试覆盖保存 profile 的 type + ID；隔离测试覆盖 key 仓储边界；本次没有安全的 SSH target。 | 连接测试主机，提交非敏感命令；重连同一保存 profile 后应出现历史，其他 profile 不应出现。 |
| SSH Quick Connect | ENVIRONMENT UNAVAILABLE | identity 测试覆盖规范化 user/host/effective port 和敏感字段清理；本次没有安全的 SSH target。 | 两次 Quick Connect 同一 user/host/port，验证共享；改变 user、host 或 port，验证隔离。 |
| split pane | ENVIRONMENT UNAVAILABLE | decorator/controller 测试覆盖多终端 attach/detach，settings 测试覆盖 split 中 focused terminal。 | 分屏两个终端；分别输入并预测，确认 overlay 定位到各自 viewport，设置页清空作用于最后聚焦 pane。 |
| 同 connection 多 tab | ENVIRONMENT UNAVAILABLE | `connectionIsolation.test.ts` 覆盖 same-key controller 变更链、共享 cache 和 clear 刷新。 | 打开同一保存 profile 的两个 tab；在 A 提交后于 B 输入前缀，确认更新；在设置清空后两边候选都消失。 |
| 不同 connection 的相同命令 | ENVIRONMENT UNAVAILABLE | 真实临时目录集成测试断言另一个 key 的文件和 cache byte-for-byte 不变。 | 在 connection A/B 分别提交同文本，再添加各自独有命令；确认独有命令绝不跨 connection 出现。 |
| password / 无回显提示 | ENVIRONMENT UNAVAILABLE | `visibleEchoVerifier` 和 controller strict tests 覆盖隐藏输入 fails closed；sensitive filter 在仓储前过滤。 | 在 strict 模式触发 SSH/sudo 等无回显提示，输入一次性测试值；确认它不出现在 JSONL 或预测中。不要使用真实秘密。 |
| alternate screen | ENVIRONMENT UNAVAILABLE | buffer/controller tests 覆盖进入时清空并 raw pass-through、退出后空且可信。 | 运行 Vim/less/top；输入与导航不得出现预测或历史拦截；退出后从空 buffer 开始。 |
| multiline bracketed paste | ENVIRONMENT UNAVAILABLE | decoder/middleware/controller tests 覆盖跨 chunk paste、多行过滤、bracketed safe replace 且无终止符。 | 启用 bracketed paste 的 Shell 中粘贴多行非破坏性文本，确认作为一次编辑；采纳多行候选不得执行。 |
| A / B / C 展示 | ENVIRONMENT UNAVAILABLE | overlay reducer/controller tests 覆盖 inline、list、hybrid 展开、选择和关闭；默认配置测试断言 B/list。 | 逐一切换 `inline`、`list`、`hybrid`，输入相同前缀，按各模式描述核对 ghost/list、Down 展开和 Escape 关闭。 |
| runtime config | ENVIRONMENT UNAVAILABLE | controller test 覆盖 mode、max results 和 bindings 无重启更新；settings tests 覆盖保存、归一化和错误回滚。 | 终端保持打开时修改模式、候选数和绑定，保存后立即输入；除数据目录外均应即时生效。数据目录需重启。 |
| `Ctrl+C`（有候选/编辑中） | ENVIRONMENT UNAVAILABLE | controller、buffer、middleware tests 覆盖精确透传、同步清空候选/buffer，以及进行中的 bracketed paste。 | 输入到候选出现后按 `Ctrl+C`；Shell 应收到中断字节，候选和 buffer 立即清空，再输入不应恢复旧候选状态。 |
| `Ctrl+C`（无候选/进程运行中） | ENVIRONMENT UNAVAILABLE | fail-open integration 覆盖 matcher/repository 异常下 `Ctrl+C` 仍精确透传。 | 运行可安全中断的长任务，确认 `Ctrl+C` 行为与未装插件一致；随后新输入从空 buffer 开始。 |
| unwritable data directory | ENVIRONMENT UNAVAILABLE | repository tests 用物理/注入失败覆盖 read/append 降级、每阶段一次脱敏 warning、当前进程隔离内存历史和 clear 错误可见。 | 在一次性测试账号/目录中制造不可写条件，不要改真实历史；确认终端输入不受阻、仅本 connection 保留进程内历史，clear 显示失败。 |
| truncated JSONL | ENVIRONMENT UNAVAILABLE | repository tests 覆盖损坏行跳过、有效行继续重放且 load 不自动重写源字节。 | 备份测试 connection 文件，在关闭 Tabby 时截断最后一行；重启后确认其他有效历史可预测且文件未被仅因 load 自动重写。 |

## 自动发布门禁

以下命令是可重复的自动证据，不代替上表的 GUI 人工验收：

```powershell
npm run verify
npm pack --dry-run --json
npm run pack:check
npm ci --dry-run
git diff --check
```

`pack:check` 对真实 `npm pack --dry-run --json` 做程序化解析，要求 top-level 精确为 `LICENSE`、`README.md`、`dist` 和 `package.json`，并要求 `dist/index.js`、`dist/index.d.ts` 存在。最终复跑结果及文件数记录在任务交付报告中。

## 当前结论

- 本次真实证据确认 Tabby 1.0.235 能发现并加载插件产物，未观察到插件 module/DI 异常。
- 自动测试覆盖核心捕获、隔离、预测、设置、失败降级和包清单，但不冒充 Shell/GUI 人工结果。
- 因 terminal app 自动输入安全限制与缺少 SSH、用户 WSL、Zsh 环境，本次无法生成交互场景 PASS；没有观察到真实功能 FAIL，也没有把可运行项记为 NOT RUN。
- 公开发布前，人工操作者应在可控测试环境按本矩阵逐项复验，尤其是密码提示、不同 Shell 的续行行为和跨重启持久化。

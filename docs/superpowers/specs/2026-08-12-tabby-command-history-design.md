# Tabby 命令历史插件设计

## 1. 产品目标

构建一个运行于 Tabby 桌面端的插件，用于学习用户在终端标签页中输入的命令，将历史保存在操作系统的用户数据目录中，按 Tabby connection 隔离，并在用户编辑命令行时预测匹配的历史命令。用户可以浏览和采纳预测，但采纳操作绝不执行命令。

该功能参考 PowerShell PSReadLine 的历史预测体验，但基于 Tabby 的终端与插件 API 实现，不与 PowerShell 绑定。

## 2. 支持范围

首个完整版本支持 Windows、macOS 和 Linux 上的 Tabby 桌面端，并接入所有提供可写终端 session 和 xterm 兼容 frontend 的 `BaseTerminalTabComponent`。

包含以下功能：

- 无需修改本地或远端 Shell 的通用命令缓冲区重建。
- 按 connection 持久化，并在内存中完成匹配。
- 三种可配置的预测展示模式。
- 可配置的匹配、排序、快捷键、容量及敏感命令过滤。
- 在设置中经确认后仅清空当前 connection 历史。
- 为未来 PowerShell、Bash 和 Zsh 命令边界 hook 预留扩展接口。

不包含以下功能：

- 跨 connection 推荐或全局历史池。
- 历史浏览器、批量编辑、跨 connection 清理、导入或导出界面。
- 首个版本中的 Shell hook 实现。
- Tabby Web，因为浏览器插件无法满足原生用户目录文件持久化要求。
- Shell 执行插件无法观察的编辑后仍保证捕获准确，例如 Shell 原生补全重写命令行。
- 在通用模式下精确识别 Shell 续行提示。没有增强 Shell hook 时，按 Enter 分隔的续行可能被学习为多条提交记录，而不是一条实际执行命令。

## 3. 设计原则

1. 终端输入必须 fail-open。除非某个字节当前对应已启用且有明确文档的历史导航快捷键，否则插件故障不得阻止该字节到达终端。
2. connection 隔离必须在仓储边界执行，不能只依靠 UI 结果过滤。
3. 每次按键触发的查询链路不得访问磁盘。
4. 只有捕获结果可信、通过可见回显安全检查且敏感命令策略允许时，命令才可持久化。
5. 采纳预测只编辑当前行，绝不追加 Enter 或其他命令终止符。
6. 捕获、匹配、排序及持久化核心逻辑与 Angular 和 xterm 渲染细节相互独立。

## 4. 架构

### 4.1 Tabby 模块

插件导出单一 Angular `NgModule`，并注册：

- 通过 Tabby `ConfigProvider` 扩展点注册 `CommandHistoryConfigProvider`。
- 通过 `SettingsTabProvider` 注册 `CommandHistorySettingsTabProvider`。
- 通过 `TerminalDecorator` 注册 `CommandHistoryTerminalDecorator`。
- 用于身份解析、仓储访问、匹配、过滤和运行时协调的单例服务。

插件面向 Tabby 桌面端 1.x API 线中的 1.0.234 或更高版本，并尽可能只使用 `tabby-core`、`tabby-terminal` 和 `tabby-settings` 导出的公共 API。

### 4.2 单终端运行时

`CommandHistoryTerminalDecorator` 为每个符合条件的终端附加一个 `CommandHistoryController`。控制器持有：

- 插入 session middleware 栈的 `CommandInputMiddleware`。
- 包含文本、光标位置、捕获可信度、粘贴状态和关闭状态的 `CommandBuffer` 状态机。
- 挂载在终端组件内的 `PredictionOverlay`。
- 对 session 变更、alternate screen 变更、frontend 销毁及配置变更的订阅。

执行 detach 或替换 session 时，控制器移除 middleware、DOM 和全部订阅，不在已销毁终端上遗留事件处理器。

### 4.3 运行时数据流

1. 终端输入到达 `CommandInputMiddleware`。
2. 可识别的编辑输入更新 `CommandBuffer`，并原样转发给 session。
3. 可信且非空的缓冲区触发针对当前 connection key 的内存查询。
4. `HistoryMatcher` 将结果划分为前缀匹配和包含匹配，分别排序后返回有数量上限的结果。
5. `PredictionOverlay` 在当前 xterm 光标位置渲染配置的 A、B 或 C 展示模式。
6. 候选处于活动状态时，导航快捷键只更新选择而不转发对应字节；其他输入全部转发。
7. 采纳操作发送最小编辑序列，使 Shell 当前行等于选中命令，同时将 `CommandBuffer` 更新为相同内容；不发送 Enter。
8. 用户按 Enter 后，控制器生成一条待处理命令、清空预测状态，并仅在所有安全检查通过后异步请求仓储持久化。

### 4.4 Shell hook 扩展边界

`CommandCaptureAdapter` 为未来增强捕获定义生命周期和最终命令回调：

```ts
export interface CommandCaptureAdapter {
    supports (context: ConnectionContext): boolean
    attach (terminal: BaseTerminalTabComponent<any>): Promise<CommandCaptureHandle>
}

export interface CommandCaptureHandle {
    finalCommand$: Observable<string>
    detach (): Promise<void>
}
```

通用输入重建器始终为默认实现。未来可通过 connection 级设置选择已安装的 adapter，但首个版本不安装或注入 Shell 脚本。

## 5. Connection 身份与隔离

### 5.1 已保存 profile

已保存或内置 profile 使用以下规范身份输入：

```text
profile:<profile.type>\0<profile.id>
```

profile 名称仅作为元数据。重命名已保存 profile 不会移动或合并其历史。

### 5.2 临时 connection

Quick Connect 或其他临时 profile 没有稳定 ID 时，`ConnectionIdentityResolver` 根据不含敏感信息的 connection 选项生成规范端点身份：

- SSH：规范化用户名、小写主机名和实际端口。
- Serial：规范化端口，以及波特率、数据位、停止位和奇偶校验。
- Local：规范化可执行文件路径、参数和声明的 Shell 类型。
- 其他终端 provider：profile 类型、稳定名称，以及移除敏感和易变字段后按键递归排序的选项对象。

通用清理器移除匹配密码、口令、Token、Secret、API key、私钥材料、环境变量值、当前工作目录、窗口大小、进程 ID、PTY 恢复 ID 和其他仅属于 session 的字段。如果无法生成安全且稳定的身份，则为该终端分配随机的 tab 生命周期 key，并仅使用内存历史。

### 5.3 文件系统 key

使用 SHA-256 对规范身份进行哈希。历史文件名只使用小写十六进制摘要。查询、追加、压缩、容量控制和清空操作都必须显式提供 connection key，因此调用方无法意外查询全部文件。

## 6. 持久化

### 6.1 用户数据根目录

默认根目录按平台确定。只有高级插件设置可以覆盖该路径，且覆盖值必须解析为当前用户主目录下的绝对路径：

- Windows：`%APPDATA%\tabby\cmd-history`
- macOS：`~/Library/Application Support/tabby/cmd-history`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/tabby/cmd-history`

connection 文件保存在 `connections/<sha256>.jsonl`。项目仓库和 Tabby 安装目录绝不用于保存历史。

### 6.2 JSONL 记录

追加记录格式带版本号：

```json
{"v":1,"kind":"use","command":"git status","at":"2026-08-12T12:00:00.000Z"}
```

压缩后的文件为每条保留的唯一命令保存一条记录：

```json
{"v":1,"kind":"entry","command":"git status","lastUsedAt":"2026-08-12T12:00:00.000Z","useCount":7}
```

加载时将两种记录重放到同一个聚合结果中。无效或被截断的行会被跳过并记录日志，周围的有效记录仍可使用。

### 6.3 写入与压缩

每个 connection 都有一个异步串行追加队列，同一插件进程内使用该 connection 的所有 tab 共享此队列。终端输入不会等待该队列。

满足以下任一条件时执行压缩：

- 事件数超过配置的唯一命令容量两倍；或
- 文件超过 2 MiB，且自上次压缩记录集合之后又累积至少 512 条 use 事件。

压缩过程将保留的 `entry` 记录写入同目录临时文件，完成 flush 并关闭文件后，以原子替换方式更新原文件。压缩失败时保留原文件。启动检查只移除属于同一 connection 的过期临时文件，绝不删除有效历史文件。

持久化不可用时，仓储只警告一次，并保留当前进程内按 connection 隔离的内存历史，绝不退化为共享存储。

### 6.4 容量与去重

每个 connection 默认保留 4096 条唯一命令。比较命令身份前执行以下规范化：

- 将 CRLF 和 CR 转换为 LF。
- 移除首尾空白。
- 保留内部空白、引号、转义和大小写。

再次执行相同的规范化命令时，更新 `lastUsedAt`、增加 `useCount`，并保留最近一次观察到的原始文本。超过容量后，优先移除 `lastUsedAt` 最早的条目。

## 7. 捕获状态机

### 7.1 可识别编辑

通用状态机支持可打印 Unicode 文本、bracketed paste、Backspace、Delete、Left、Right、Home、End，以及常见的 `Ctrl+A`、`Ctrl+E`、`Ctrl+U`、`Ctrl+K` 和 `Ctrl+W` 编辑。光标索引使用 Unicode 字素边界，避免一次编辑拆分一个可见字符。

bracketed paste 内容作为一次编辑操作处理。粘贴的多行块在用户随后提交时仍作为一条历史命令；分别提交的普通行则保存为不同命令。

### 7.2 可信度丢失

出现无法识别的控制序列，或执行结果无法由插件观察的操作（包括 Shell 原生 Tab 补全）后，缓冲区标记为不可信并隐藏预测。不可信缓冲区不得持久化。Enter 或 `Ctrl+C` 将状态重置为空且可信的新缓冲区。

### 7.3 Enter 与可见回显安全检查

仅当缓冲区可信且非空时，Enter 才会产生待处理命令。在默认严格捕获模式下，提交前 xterm 的逻辑行或逻辑多行区域必须能与重建命令对应，从而避免持久化隐藏密码输入和无回显程序输入。

通用模式将此事件定义为观察到的命令行提交，而不是 Shell 已启动或完成进程的证明。不同本地和远端 Shell 的续行提示无法可靠统一识别。精确的最终多行命令需要未来增强的 `CommandCaptureAdapter`；通用模式明确保留按 Enter 分隔的尽力捕获行为，不猜测 Shell 语法。

高级设置可以全局启用宽松捕获。该设置必须提示：所有成功重建并以 Enter 分隔的输入都可能被记录，其中也包括 Shell 提示符之外的输入。除非另行关闭，敏感过滤仍会执行。

### 7.4 Ctrl+C

`Ctrl+C` 始终转发给终端，同时立即清空内部命令缓冲区、候选、选择、关闭状态、粘贴状态以及待持久化请求。插件不替换或延迟终端原有的中断行为。

### 7.5 Alternate screen

终端处于 alternate-screen 模式期间，捕获和预测均禁用，运行时状态被清空，所有输入字节直接透传。返回 normal screen 后，从空且可信的缓冲区重新开始。

## 8. 匹配与排序

默认输入 1 个字符后开始预测。空缓冲区或仅包含空白的缓冲区不返回候选。

默认匹配不区分大小写，并允许配置。结果分为：

1. 以查询文本开头的命令。
2. 在其他位置包含查询文本的命令。

所有前缀匹配始终排在所有包含匹配之前。同一分组内组合规范化后的各项得分：

```text
score = 0.55 * recency + 0.30 * frequency + 0.15 * matchCloseness
```

- recency 根据 `lastUsedAt` 距当前时间的间隔衰减。
- frequency 使用对数缩放，避免重复命令永久占据最高优先级。
- matchCloseness 奖励更靠前的匹配位置和更少的未匹配文本。

得分相同时，依次按更新的 `lastUsedAt`、更高的 `useCount` 和命令文本确定稳定顺序。三个权重属于高级设置且总和必须为 1，设置 UI 在保存前对用户输入值执行归一化。

## 9. 预测 UI 与采纳

### 9.1 展示模式

三种模式全部提供，默认使用 B。

- A（inline）：只以 ghost text 显示当前选中命令剩余的文本；Up 和 Down 每次切换一条候选。
- B（list）：存在匹配时，在光标附近的列表中显示最多 5 条候选，并高亮当前项。
- C（hybrid）：显示首条 inline 预测，默认收起列表；按 Down 展开列表，按 Escape 收起或关闭。

B 和 C 默认最多显示 5 条候选，并允许配置。overlay 通过独立的 `TerminalGeometryAdapter` 使用 xterm 缓冲区光标坐标和屏幕边界定位，渲染版本兼容处理只存在于该 adapter 内。

输入、终端缩放、字体缩放、滚动和选择变化后，overlay 都会重新定位。光标下方空间不足时改为显示在上方，并始终限制在终端 viewport 内。

### 9.2 默认按键行为

- 只有候选处于活动状态时，Up 和 Down 才切换候选；否则将对应字节转发给 Shell。
- 只有候选处于活动状态时，Right 才采纳当前候选；否则转发给 Shell。
- Escape 关闭当前缓冲区的预测；再次编辑文本后允许重新显示。
- Tab 始终转发给 Shell，并将通用重建缓冲区标记为不可信。
- `Ctrl+C` 始终透传并清空插件状态。

导航和采纳快捷键允许配置。配置必须拒绝与 `Ctrl+C` 或普通可打印输入冲突的按键。

### 9.3 安全采纳

对于光标位于末尾的单行前缀预测，采纳时只发送尚未匹配的后缀。其他情况下，先从已知光标位置移动到末尾，再按字素删除已知缓冲区并插入完整候选命令。middleware 直接向下游发送这些字节，不将其再次当作用户输入处理，随后将自身缓冲区设置为已采纳命令。

只有终端报告支持 bracketed paste 时，才提供多行命令候选。采纳时使用 bracketed-paste 标记包裹文本，使其中的换行只编辑命令缓冲区而不执行命令。不支持 bracketed paste 时，多行条目仍保留在历史中，但不参与预测。

任何采纳路径都不得发送 Enter、回车、bracketed-paste 框架之外的换行或 Shell 命令分隔符。

## 10. 敏感历史策略

敏感过滤在事件进入磁盘队列之前执行，默认启用。

初始内置指示词不区分大小写：

- `password`
- `asplaintext`
- `token`
- `apikey`
- `secret`

用户可以添加排除正则表达式。无效表达式必须在 UI 中被拒绝，并继续使用最近一次有效的已保存配置。命中规则时丢弃完整命令；插件不得写入可能保留凭据片段的脱敏版本。

用户可以显式关闭敏感过滤。除非用户另行修改捕获模式，否则严格可见回显捕获仍独立保持启用。

## 11. 设置

Tabby 设置页包含：

- 插件启用开关。
- A、B 或 C 展示模式，默认 B。
- 最大可见候选数，默认 5。
- 最短查询长度，默认 1。
- 是否区分大小写，默认关闭。
- 每个 connection 的唯一历史容量，默认 4096。
- recency、frequency 和 matchCloseness 权重，默认分别为 55、30 和 15。
- 严格或宽松捕获，默认严格。
- 敏感过滤启用开关，默认开启。
- 用户排除正则表达式。
- 候选导航、采纳和关闭快捷键。
- 清空当前 connection 历史。

没有活动且符合条件的终端时，清空操作禁用。否则显示当前 connection 名称、要求二次确认、只清除其内存索引和哈希文件，并刷新使用相同 key 的所有已打开 tab 的预测。

设置保存在 Tabby 配置中；命令历史绝不保存在 Tabby 配置文档中。

## 12. 故障处理

- middleware 和 controller 异常只记录不含原始命令文本的诊断上下文，并透传原始输入。
- matcher 失败时隐藏本次输入对应的预测，不修改命令缓冲区。
- overlay 失败时移除 overlay，捕获和终端输入仍可正常工作。
- 仓储读写失败时，每个故障阶段只警告一次，并仅使用当前 connection 的内存历史。
- 无效 JSONL 记录会被跳过，不因源文件包含错误就自动重写它。
- frontend 缺失或不受支持时，对该终端禁用视觉预测并透传所有输入。
- connection 身份无法解析时，只使用 tab 生命周期内存，不得访问其他 connection 的仓储。
- 插件 detach 时等待待追加任务完成后关闭队列、取消订阅、移除 middleware 和 overlay 节点。

## 13. 性能要求

- 在自动化基准环境中，查询并排序 4096 条唯一命令的第 95 百分位耗时必须不超过 10 ms。
- 输入链路上不得同步执行文件系统操作。
- 每个插件进程和 connection key 最多加载一次历史文件，随后由使用该 key 的 tab 共享。
- 渲染更新合并到每个 animation frame 最多一次。
- 压缩异步执行，不持有终端输入锁或匹配锁。

## 14. 测试策略

### 14.1 单元测试

- `CommandBuffer`：可打印输入、Unicode 字素、粘贴、光标编辑、删除、控制键编辑、未知序列、Enter、`Ctrl+C`、可信度和 alternate screen。
- `ConnectionIdentityResolver`：已保存 profile、SSH Quick Connect、Serial、Local、清理器覆盖、稳定哈希及不安全身份回退。
- `SensitiveCommandFilter`：内置指示词、自定义表达式、禁用模式和无效表达式处理。
- `HistoryMatcher`：前缀分组、包含分组、大小写规则、时效性、对数频次、匹配紧密度、稳定同分排序和结果上限。
- `JsonlHistoryRepository`：追加、重放、聚合、容量、隔离、损坏行、写入失败、内存回退和原子压缩。
- A、B、C 展示模式 reducer 及其选择行为。

### 14.2 集成测试与组件测试

- 使用假 Tabby 终端和 session 验证 middleware attach/detach、输入转发、活动快捷键拦截、无 Enter 采纳、session 替换及相同 key 的 tab 共享。
- 使用 xterm 兼容缓冲区 fixture 验证可见回显安全检查和几何位置计算。
- 使用 Angular 组件测试验证默认配置、校验、确认操作、清空当前 connection 及实时配置更新。
- 使用真实临时目录验证两个 connection key 绝不读取、修改、压缩或清空对方文件。

### 14.3 构建与打包测试

- TypeScript 类型检查。
- Lint。
- 完整自动化测试套件。
- Webpack 生产构建。
- 检查 npm 包，确认包含 `tabby-plugin` keyword、编译后的 `dist`、类型声明、README 和 license，且不意外发布源历史数据或测试 fixture。

### 14.4 Tabby 手工验收矩阵

在当前稳定版 Tabby 桌面端中使用打包插件测试：

- Windows PowerShell 和 `cmd.exe`。
- WSL Bash。
- 条件允许时测试 macOS/Linux 本地 Bash 或 Zsh。
- 已保存 SSH 和 SSH Quick Connect。
- 分屏和使用同一 connection 的多个 tab。
- 包含相同命令文本的两个不同 connection。
- 密码/无回显提示。
- Vim、less、top 或其他 alternate-screen 应用。
- bracketed 多行粘贴。
- 三种展示模式，以及无需重启即可生效的配置变更。
- 编辑命令期间和进程运行期间的 `Ctrl+C`。
- 存储不可用，以及历史文件最后一行被截断的场景。

## 15. 验收标准

满足以下条件时，版本才算完成：

1. 一个 connection 的命令绝不出现在另一个 connection 的预测中。
2. 重启 Tabby 后，历史仍保存在文档约定的用户数据目录中。
3. 输入文本后，默认 B 模式生成前缀优先且经过综合排序的预测。
4. 可以在设置中选择 A、B 和 C 模式，并实时更新活动终端。
5. Up 和 Down 导航候选，Right 只采纳不执行，Escape 关闭候选，Tab 仍作为 Shell 输入。
6. `Ctrl+C` 保留原有中断行为，并清空插件全部命令状态。
7. 严格捕获不会保存验收中测试的无回显密码输入或 alternate-screen 输入。
8. 启用敏感过滤时，命中规则的内容不会到达文件系统。
9. 经确认清空历史时，只影响当前 connection。
10. 存储、解析器、matcher 或 overlay 故障不会导致终端无法输入。
11. 自动化测试、Lint、类型检查、生产构建和包检查全部通过。
12. 真实 Tabby 验收矩阵中不存在未解决的发布阻断问题。

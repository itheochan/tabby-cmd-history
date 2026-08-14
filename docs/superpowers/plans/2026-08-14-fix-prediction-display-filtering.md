# 修复预测展示过滤（inline/hybrid）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行。步骤使用 checkbox（`- [ ]`）语法跟踪。

**Goal:** 修复代码审查发现的两处预测展示缺陷——(1) hybrid 展开后的列表缺失精确匹配与 contains 匹配；(2) inline/hybrid 折叠态会把 contains 匹配渲染成误导性的 ghost 后缀。

**Architecture:** 让 `CommandHistoryController.predictions` 始终保存完整候选集（仅过滤多行能力），新增 `displayedPredictions()` 按「展示模式 + 是否展开」决定当前可见子集；导航/采纳/关闭改为按可见子集操作，并让未消费的导航键自然回落到既有 shell-managed/编辑处理分支。渲染层 `PredictionOverlay` 保持纯渲染器，不改动。

**Tech Stack:** TypeScript 4.9.5、Angular 15、RxJS 7、Jest 29 + ts-jest。

## Global Constraints

- 终端输入必须 fail-open：非活动导航键不得被消费，原始字节必须原样到达 Shell。
- 采纳预测只编辑命令行，绝不发送 Enter / 换行 / 命令分隔符。
- 诊断日志不得包含命令文本、密码、Token 或 JSONL 内容（沿用现有 `describeError` 约定）。
- 改动后必须通过：`npm run lint`、`npm run typecheck`、`npm run typecheck:test`、`npm test`（当前基线 18 suites / 315 tests）。
- Tabby peer range `>=1.0.231-nightly.0 <2`；TypeScript `strict: true`。
- 现有测试 `tests/terminal/commandHistoryController.test.ts` 的用例语义不得回退（仅新增用例，不删改既有断言）。

---

### Task 1: 按展示模式与展开状态决定可见候选

**Files:**
- Modify: `src/terminal/commandHistoryController.ts:181-215`（route 导航块）、`:432-468`（queryFromBuffer）、`:469-513`（previous/next/dismiss/accept）、`:699-726`（renderPredictions）
- Test: `tests/terminal/commandHistoryController.test.ts`（在 `describe('CommandHistoryController', ...)` 末尾追加 3 个用例）

**Interfaces:**
- Consumes: 既有的 `Prediction`（含 `matchKind: 'prefix' | 'contains'`、`matchIndex`、`command`）、`hasInlineRemainder(prediction, query)`（模块级函数，本文件已存在）。
- Produces: 新增私有方法 `private displayedPredictions(): Prediction[]`——`list` 或 `expanded` 时返回 `this.predictions` 全集，否则返回 `matchKind === 'prefix' && hasInlineRemainder(item, query)` 的子集。`previous/next/dismiss` 返回值类型从 `void` 改为 `boolean`（true=已消费）。

- [ ] **Step 1: 写失败的测试**

在 `tests/terminal/commandHistoryController.test.ts` 的 `describe('CommandHistoryController', ...)` 块内、最后一个 `test(...)` 之后追加：

```ts
test.each(['inline', 'hybrid'] as const)('%s collapsed never renders a contains match as a ghost', async (presentation) => {
    const history = {
        query: jest.fn(async () => [
            { ...prediction('git status'), matchKind: 'prefix', matchIndex: 0 },
            { ...prediction('sudo git checkout'), matchKind: 'contains', matchIndex: 5 },
        ]),
        record: jest.fn(async () => undefined),
    }
    const fixture = createFixture([], { history })
    fixture.changeConfig({ presentation })
    fixture.terminal.send('git')
    await settle()

    const ghost = fixture.terminal.element.nativeElement.querySelector('.cmd-history-ghost')
    expect(ghost?.textContent).toBe(' status')
})

test('hybrid expanded list includes exact and contains matches', async () => {
    const history = {
        query: jest.fn(async () => [
            { ...prediction('git'), matchKind: 'prefix', matchIndex: 0 },
            { ...prediction('sudo git status'), matchKind: 'contains', matchIndex: 5 },
        ]),
        record: jest.fn(async () => undefined),
    }
    const fixture = createFixture([], { history })
    fixture.changeConfig({ presentation: 'hybrid' })
    fixture.terminal.send('git')
    await settle()

    expect(fixture.terminal.element.nativeElement.querySelector('.cmd-history-ghost')).toBeNull()

    fixture.terminal.send('\x1b[B')
    const options = Array.from(fixture.terminal.element.nativeElement.querySelectorAll('[role="option"]'))
    expect(options.map(option => option.textContent)).toEqual(['git', 'sudo git status'])
})

test('inline mode forwards navigation keys when no prefix candidate is visible', async () => {
    const history = {
        query: jest.fn(async () => [
            { ...prediction('sudo git checkout'), matchKind: 'contains', matchIndex: 5 },
        ]),
        record: jest.fn(async () => undefined),
    }
    const fixture = createFixture([], { history })
    fixture.changeConfig({ presentation: 'inline' })
    fixture.terminal.send('git')
    await settle()

    expect(fixture.terminal.element.nativeElement.querySelector('.cmd-history-ghost')).toBeNull()
    fixture.terminal.send('\x1b[B')
    expect(fixture.bytes()).toEqual(Buffer.from('git\x1b[B'))
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/terminal/commandHistoryController.test.ts --silent`
Expected: 3 个新用例 FAIL（当前实现会把 contains 也渲染成 ghost、hybrid 展开列表不完整、且 Down 在无可见候选时被消费）。

- [ ] **Step 3: 实现最小改动**

**3a. `queryFromBuffer`（约 455-459 行）删除第二条 filter，保留完整候选集：**

```ts
                const supportsMultiline = this.supportsBracketedPaste()
                this.predictions = predictions
                    .filter(item => supportsMultiline || !/[\r\n]/u.test(item.command))
                this.selectedIndex = 0
                this.expanded = config.presentation === 'list'
                this.renderPredictions()
```

**3b. 在 `queryFromBuffer` 之后、`previous` 之前新增 `displayedPredictions`：**

```ts
    private displayedPredictions (): Prediction[] {
        if (this.config.presentation === 'list' || this.expanded) {
            return this.predictions
        }
        const query = this.buffer.snapshot().text
        return this.predictions.filter(item => item.matchKind === 'prefix' && hasInlineRemainder(item, query))
    }
```

**3c. `route` 导航块（194-209 行）改为按返回值消费，未消费则回落：**

```ts
        const key = keyFor(action)
        if (this.predictions.length && key) {
            if (key === this.config.bindings.previous && this.previous()) {
                return { consume: true, action }
            }
            if (key === this.config.bindings.next && this.next()) {
                return { consume: true, action }
            }
            if (key === this.config.bindings.accept && this.accept()) {
                return { consume: true, action }
            }
            if (key === this.config.bindings.dismiss && this.dismiss()) {
                return { consume: true, action }
            }
        }
```

**3d. `previous` 返回 boolean 并按可见子集导航：**

```ts
    private previous (): boolean {
        const displayed = this.displayedPredictions()
        if (!displayed.length) {
            return false
        }
        this.selectedIndex = (this.selectedIndex - 1 + displayed.length) % displayed.length
        this.renderPredictions()
        return true
    }
```

**3e. `next` 返回 boolean，hybrid 折叠态 Down 始终先展开：**

```ts
    private next (): boolean {
        if (this.config.presentation === 'hybrid' && !this.expanded) {
            this.expanded = true
            this.renderPredictions()
            return true
        }
        const displayed = this.displayedPredictions()
        if (!displayed.length) {
            return false
        }
        this.selectedIndex = (this.selectedIndex + 1) % displayed.length
        this.renderPredictions()
        return true
    }
```

**3f. `dismiss` 返回 boolean，无可见候选时不消费 Escape：**

```ts
    private dismiss (): boolean {
        if (this.config.presentation === 'hybrid' && this.expanded) {
            this.expanded = false
            this.renderPredictions()
            return true
        }
        if (!this.displayedPredictions().length) {
            return false
        }
        this.buffer.dismiss()
        this.invalidatePredictions()
        return true
    }
```

**3g. `accept` 第一行改用可见子集（其余不变）：**

```ts
    private accept (): boolean {
        const candidate = this.displayedPredictions()[this.selectedIndex]?.command
        const middleware = this.middleware
        if (!candidate || !middleware) {
            return false
        }
```

**3h. `renderPredictions` 使用可见子集渲染，空显示时不清空完整候选集：**

```ts
    private renderPredictions (): void {
        const displayed = this.displayedPredictions()
        if (!displayed.length || !this.overlay) {
            this.selectedIndex = 0
            if (!this.predictions.length) {
                this.expanded = false
            }
            this.hideOverlay()
            return
        }
        let stage = 'frontend-measure'
        try {
            const frontend = this.frontend()
            if (!frontend) {
                this.disablePresentation('frontend-measure')
                return
            }
            const active = frontend.xterm.buffer.active
            stage = 'geometry-measure'
            const position = this.geometry.measure(
                this.host(),
                {
                    cursorX: active.cursorX,
                    cursorY: active.cursorY,
                    cols: frontend.xterm.cols,
                    rows: frontend.xterm.rows,
                },
                { width: 480, height: Math.max(24, this.config.maxVisible * 28) },
            )
            if (!position) {
                this.invalidatePredictions()
                return
            }
            stage = 'overlay-render'
            this.overlay.render({
                mode: this.config.presentation,
                query: this.buffer.snapshot().text,
                predictions: displayed,
                selectedIndex: this.selectedIndex,
                expanded: this.expanded,
                maxResults: this.config.maxVisible,
                position,
            })
        } catch {
            this.disablePresentation(stage)
        }
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/terminal/commandHistoryController.test.ts --silent`
Expected: 新增 3 个用例 PASS，且全部既有用例仍 PASS。

- [ ] **Step 5: 全量验证**

Run: `npm run lint && npm run typecheck && npm run typecheck:test && npm test -- --silent`
Expected: lint 0 error；typecheck 0 error；18 suites / 318 tests 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/terminal/commandHistoryController.ts tests/terminal/commandHistoryController.test.ts
git commit -m "fix: show full candidate list when hybrid expands and stop contains ghost in inline"
```

---

## 明确不在本计划内（需另行决策，勿在此任务顺带改动）

- **未加盐 SHA-256 身份哈希**：设计级取舍（文档已声明），改 HMAC 会迁移全部既有文件名，需单独决策。
- **模块级 `states` / `warnedFailures` Map 无清理**：低风险，独立小任务。
- **降低 capacity 后内存索引不即时裁剪**：与 generation/cache 逻辑耦合，单独小任务。
- **25ms 转义超时**：需真实 SSH 延迟测量后再调参。
- **设置叶子赋值非原子**：仅损坏配置边角，低优先级。
- **Local 连接缺 shellType 降级 memory-only**：需先确认真实 Tabby profile shape，再做默认值决策。
- **用户正则 ReDoS**：自担风险的已知边界。

# Enter 作为 Accept candidate 可选快捷键 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `Enter` 加入 `accept` 绑定的可选键列表：当 `bindings.accept === 'Enter'` 且有候选时，Enter 只填入候选（不执行、不转发给 shell），无候选时 Enter 行为不变。

**Architecture:** 配置层把 `'Enter'` 加入 `HistoryKeyName` 并校验其仅可用于 accept；控制器在 `route()` 的 enter 分支先尝试 `accept()`，成功则 consume；设置界面仅为 accept 下拉追加 Enter 选项。

**Tech Stack:** TypeScript 4.9.5、Jest 29（`--runInBand`）、Angular 组件（pug 模板）、webpack。

## Global Constraints

- 代码风格：4 空格缩进、单引号、无分号（匹配现有文件）。
- `HistoryKeyName` 增加 `'Enter'`；Enter 只能用于 `accept` 绑定，用于 previous/next/dismiss 必须抛错。
- `keyFor()` 不改：enter 动作不进入通用绑定检查。
- 采纳候选只编辑当前行，绝不附加 Enter 或自动执行。
- 默认绑定保持 `ArrowRight`。
- 每次提交使用 conventional commit（`feat:` / `test:` / `docs:`），中文消息，与本仓库历史一致。
- 最终门禁：`npm run verify` 全绿。

---

### Task 1: 配置层支持 Enter

**Files:**
- Modify: `src/config/historyConfig.ts`（`HistoryKeyName` 类型第 3-4 行；`validateBindings` 第 75-92 行）
- Test: `tests/config/defaults.test.ts`

**Interfaces:**
- Produces: `HistoryKeyName` 包含 `'Enter'`；`validateHistoryConfig` 接受 `bindings.accept === 'Enter'`，拒绝 `bindings.previous === 'Enter'`（错误消息 `Command history binding Enter can only be used for accept`）。

- [ ] **Step 1: 写失败测试**

在 `tests/config/defaults.test.ts` 的 `describe` 块末尾追加：

```ts
    test('accepts Enter as the accept binding and rejects it elsewhere', () => {
        expect(() => validateHistoryConfig({
            ...DEFAULT_COMMAND_HISTORY_CONFIG,
            bindings: { ...DEFAULT_COMMAND_HISTORY_CONFIG.bindings, accept: 'Enter' },
        })).not.toThrow()
        expect(() => validateHistoryConfig({
            ...DEFAULT_COMMAND_HISTORY_CONFIG,
            bindings: { ...DEFAULT_COMMAND_HISTORY_CONFIG.bindings, previous: 'Enter' },
        })).toThrow('Command history binding Enter can only be used for accept')
    })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/config/defaults.test.ts --runInBand`

Expected: 新测试 FAIL——`accept: 'Enter'` 抛出 `Command history binding is not supported`（`'Enter'` 尚不在允许集合），`not.toThrow()` 断言失败。其余测试 PASS。

- [ ] **Step 3: 实现**

修改 `src/config/historyConfig.ts`：

把 `HistoryKeyName` 类型（第 3-4 行）改为：

```ts
export type HistoryKeyName = 'ArrowUp' | 'ArrowDown' | 'ArrowRight' | 'Escape' | 'Enter' |
    'Ctrl+ArrowUp' | 'Ctrl+ArrowDown' | 'Ctrl+ArrowRight'
```

把 `validateBindings`（第 75-92 行）整体替换为：

```ts
function validateBindings (bindings: CommandHistoryConfig['bindings']): void {
    const allowed = new Set<HistoryKeyName>([
        'ArrowUp', 'ArrowDown', 'ArrowRight', 'Escape', 'Enter',
        'Ctrl+ArrowUp', 'Ctrl+ArrowDown', 'Ctrl+ArrowRight',
    ])
    const entries = Object.entries(bindings) as Array<[keyof CommandHistoryConfig['bindings'], HistoryKeyName]>
    for (const [name, binding] of entries) {
        const bindingName: string = binding
        if (bindingName === 'Ctrl+C') {
            throw new Error('Ctrl+C cannot be used as a command history binding')
        }
        if (binding === 'Enter' && name !== 'accept') {
            throw new Error('Command history binding Enter can only be used for accept')
        }
        if (isPrintableCharacter(bindingName)) {
            throw new Error(`Printable character cannot be used as a command history binding: ${bindingName}`)
        }
        if (!allowed.has(binding)) {
            throw new Error('Command history binding is not supported')
        }
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/config/defaults.test.ts --runInBand`

Expected: 全部 PASS（含新测试）。

- [ ] **Step 5: 提交**

```bash
git add src/config/historyConfig.ts tests/config/defaults.test.ts
git commit -m "feat(config): accept 绑定支持 Enter 且仅限 accept 使用"
```

---

### Task 2: 控制器 Enter 接受候选

**Files:**
- Modify: `src/terminal/commandHistoryController.ts`（`route()` 第 210-213 行的 enter 分支）
- Test: `tests/terminal/commandHistoryController.test.ts`

**Interfaces:**
- Consumes: `this.config.bindings.accept`（`HistoryKeyName`，Task 1 已含 `'Enter'`）；`this.accept()`（已有，返回 boolean）。
- Produces: 无新导出；行为：enter 动作在 `bindings.accept === 'Enter'` 且 `accept()` 返回 true 时被 consume。

- [ ] **Step 1: 写失败测试**

在 `tests/terminal/commandHistoryController.test.ts` 中 `test('routes configured Ctrl+Arrow bindings while candidates are active', ...)`（第 723 行）之后追加两个测试：

```ts
    test('accept bound to Enter fills the candidate without executing, then Enter submits', async () => {
        const fixture = createFixture(['git checkout main', 'git cherry-pick a'])
        fixture.changeConfig({ bindings: { ...config().bindings, accept: 'Enter' } })
        fixture.terminal.send('git ch')
        await settle()

        fixture.terminal.send('\r')
        expect(fixture.bytes().toString()).toBe('git checkout main')
        expect(fixture.bytes().includes(0x0d)).toBe(false)
        expect(fixture.controller.state()).toMatchObject({
            buffer: { text: 'git checkout main', confident: true },
            predictions: [],
        })

        fixture.terminal.send('\r')
        expect(fixture.bytes().subarray(-1)).toEqual(Buffer.from([0x0d]))
        await settle()
        expect(fixture.history.record).toHaveBeenCalledWith(
            expect.anything(),
            'git checkout main',
            expect.anything(),
            expect.anything(),
            expect.anything(),
        )
    })

    test('accept bound to Enter submits normally when no candidate exists', async () => {
        const fixture = createFixture()
        fixture.changeConfig({ bindings: { ...config().bindings, accept: 'Enter' } })
        fixture.terminal.send('pwd\r')
        expect(fixture.bytes().toString()).toBe('pwd\r')
        await settle()
        expect(fixture.history.record).toHaveBeenCalledWith(
            expect.anything(),
            'pwd',
            expect.anything(),
            expect.anything(),
            expect.anything(),
        )
    })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/terminal/commandHistoryController.test.ts --runInBand -t "accept bound to Enter"`

Expected: 第一个测试 FAIL——第一次 `\r` 未被拦截，bytes 为 `git ch\r` 且含 `0x0d`。第二个测试 PASS（无候选时行为本就正确）。

- [ ] **Step 3: 实现**

修改 `src/terminal/commandHistoryController.ts` 第 210-213 行：

```ts
        if (action.type === 'enter') {
            if (this.config.bindings.accept === 'Enter' && this.accept()) {
                return { consume: true, action }
            }
            this.submit()
            return { consume: false, action }
        }
```

- [ ] **Step 4: 运行测试确认通过 + 回归**

Run: `npx jest tests/terminal/commandHistoryController.test.ts --runInBand`

Expected: 全部 PASS（含两个新测试；默认绑定 ArrowRight 的既有 accept/enter 测试不受影响）。

- [ ] **Step 5: 提交**

```bash
git add src/terminal/commandHistoryController.ts tests/terminal/commandHistoryController.test.ts
git commit -m "feat(terminal): accept 绑定为 Enter 时有候选拦截为只填入不执行"
```

---

### Task 3: 设置界面 accept 下拉提供 Enter

**Files:**
- Modify: `src/settings/settingsTab.component.ts`（第 45-53 行字段；新增 `acceptBindingOptions`、`bindingOptionsFor`）
- Modify: `src/settings/settingsTab.component.pug`（第 63-66 行 option 绑定）
- Test: `tests/settings/settingsTab.component.test.ts`

**Interfaces:**
- Produces: 组件公开方法 `bindingOptionsFor(key: string): readonly HistoryKeyName[]`——`key === 'accept'` 返回含 `'Enter'` 的列表，其余返回不含 `'Enter'` 的 `bindingOptions`。

- [ ] **Step 1: 写失败测试**

在 `tests/settings/settingsTab.component.test.ts` 的 `describe` 块中 `test('saves normalized weights and replaces config only after validation', ...)`（第 146 行）之后追加：

```ts
    test('offers Enter only for the accept binding', () => {
        const fixture = createSettingsFixture()
        expect(fixture.component.bindingOptionsFor('accept')).toContain('Enter')
        expect(fixture.component.bindingOptionsFor('previous')).not.toContain('Enter')
        expect(fixture.component.bindingOptionsFor('next')).not.toContain('Enter')
        expect(fixture.component.bindingOptionsFor('dismiss')).not.toContain('Enter')
    })

    test('saves Enter as the accept binding', async () => {
        const fixture = createSettingsFixture()
        fixture.component.draft.bindings.accept = 'Enter'

        await fixture.component.save()

        expect(fixture.config.store.cmdHistory.bindings.accept).toBe('Enter')
        expect(fixture.component.validationError).toBe('')
        expect(fixture.config.save).toHaveBeenCalledTimes(1)
    })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest tests/settings/settingsTab.component.test.ts --runInBand -t "Enter"`

Expected: 两个新测试 FAIL——`bindingOptionsFor` 尚不存在；保存 `accept: 'Enter'` 因 `validateHistoryConfig` 旧实现仍抛错（此时 Task 1 已合入则此处应 PASS，`bindingOptionsFor` 测试仍 FAIL）。

- [ ] **Step 3: 实现**

修改 `src/settings/settingsTab.component.ts` 第 45-53 行：

```ts
    readonly bindingOptions: readonly HistoryKeyName[] = [
        'ArrowUp',
        'ArrowDown',
        'ArrowRight',
        'Escape',
        'Ctrl+ArrowUp',
        'Ctrl+ArrowDown',
        'Ctrl+ArrowRight',
    ]
    readonly acceptBindingOptions: readonly HistoryKeyName[] = [...this.bindingOptions, 'Enter']

    bindingOptionsFor (key: string): readonly HistoryKeyName[] {
        return key === 'accept' ? this.acceptBindingOptions : this.bindingOptions
    }
```

修改 `src/settings/settingsTab.component.pug` 第 66 行：

```pug
                    option('*ngFor'='let key of bindingOptionsFor(binding.key)' '[ngValue]'='key') {{ key }}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest tests/settings/settingsTab.component.test.ts --runInBand`

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/settings/settingsTab.component.ts src/settings/settingsTab.component.pug tests/settings/settingsTab.component.test.ts
git commit -m "feat(settings): accept 绑定下拉提供 Enter 可选键"
```

---

### Task 4: 文档与全量验证

**Files:**
- Modify: `README.md`（第 11 行、按键表格第 31 行）
- Modify: `docs/manual-acceptance.md`（runtime config 行，第 53 行）

- [ ] **Step 1: 更新 README 功能说明**

把第 11 行：

```
- Up/Down 选择候选，Right 只把候选填入当前命令行，绝不附加 Enter 或自动执行。
```

改为：

```
- Up/Down 选择候选，Right（或在设置中把「采纳」绑定为 Enter）只把候选填入当前命令行，绝不附加 Enter 或自动执行。
```

- [ ] **Step 2: 更新 README 按键表格**

把第 31 行：

```
| 采纳 / 关闭 | Right / Escape |
```

改为：

```
| 采纳 / 关闭 | Right / Escape（Enter 可选） |
```

- [ ] **Step 3: 更新 manual-acceptance**

把 `docs/manual-acceptance.md` 第 53 行人工复验步骤列追加 Enter 绑定说明，改为：

```
| runtime config | ENVIRONMENT UNAVAILABLE | controller test 覆盖 mode、max results 和 bindings 无重启更新；settings tests 覆盖保存、归一化和错误回滚。 | 终端保持打开时修改模式、候选数和绑定，保存后立即输入；除数据目录外均应即时生效。数据目录需重启。将「采纳」绑定设为 Enter 后，有候选时按 Enter 只填入不执行，再按 Enter 提交。 |
```

（注：表格行需要与现有 `|` 对齐格式保持一致，替换整行为单行。）

- [ ] **Step 4: 全量验证**

Run: `npm run verify`

Expected: lint、typecheck、typecheck:test、jest 全部 PASS，webpack 构建成功，`pack:check` PASS。

Run: `git diff --check`

Expected: 无空白错误。

- [ ] **Step 5: 提交**

```bash
git add README.md docs/manual-acceptance.md
git commit -m "docs: 记录 Enter 作为采纳可选绑定"
```

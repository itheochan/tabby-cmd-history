# Enter 作为 Accept candidate 可选快捷键设计

## 1. 目标

把 `Enter` 加入 `accept` 绑定的可选键列表。用户将「Accept candidate」绑定设为 `Enter` 后，在有预测候选时按 Enter 只把候选填入当前命令行（不执行、不转发 Enter 给 shell），可继续编辑；再次按 Enter 时（候选已清空）正常提交。无候选时 Enter 行为完全不变。

默认绑定保持 `ArrowRight`，现有用户行为不受影响。

## 2. 设计原则

1. Enter 只有在 `bindings.accept === 'Enter'` 且存在可采纳候选时才被拦截；其余情况一律按原路径转发给 shell 执行提交。
2. 采纳候选只编辑当前行，绝不附加 Enter 或自动执行（与现有 accept 语义一致，参考 README 第 11 行）。
3. Enter 不进入通用绑定检查（`keyFor` 保持对 enter 返回 null），避免被 previous/next/dismiss 误匹配，杜绝「按 Enter 永远无法提交」的配置。
4. 校验层保证 Enter 只能用于 accept 绑定：Enter 用作 previous/next/dismiss 没有任何语义，若通过校验会导致「静默无效绑定」回归（当前这些键设为 Enter 会直接校验失败）。

## 3. 改动

### 3.1 配置（`src/config/historyConfig.ts`）

- `HistoryKeyName` 类型增加 `'Enter'`。
- `validateBindings`：
  - allowed 集合加入 `'Enter'`。
  - 新增校验：`Enter` 仅可用于 `accept`，否则抛错 `Command history binding Enter can only be used for accept`（前缀与现有 `Command history binding` 校验消息一致，可被设置页 `safeValidationMessage` 原样展示）。

### 3.2 控制器（`src/terminal/commandHistoryController.ts`）

`route()` 的 `action.type === 'enter'` 分支改为：

```ts
if (action.type === 'enter') {
    if (this.config.bindings.accept === 'Enter' && this.accept()) {
        return { consume: true, action }
    }
    this.submit()
    return { consume: false, action }
}
```

- `accept()` 在 `displayedPredictions()[selectedIndex]` 存在时填入候选并返回 true；候选不存在时返回 false，此时 Enter 走原 `submit()` 逻辑。
- multiline 候选沿用现有 bracketed paste 注入路径，Enter 字节本身不转发给 shell。
- `keyFor()` 不修改。

### 3.3 设置界面（`src/settings/settingsTab.component.ts` + `.pug`）

- 通用 `bindingOptions` 保持不变（不含 Enter）。
- 组件新增 `acceptBindingOptions: readonly HistoryKeyName[] = [...this.bindingOptions, 'Enter']`，并提供 `bindingOptionsFor(key)` 方法：`key === 'accept'` 时返回 `acceptBindingOptions`，否则返回 `bindingOptions`。
- pug 中 select 的 option 列表改为 `bindingOptionsFor(binding.key)`，使只有 accept 下拉显示 Enter。

### 3.4 测试

- `tests/config/defaults.test.ts`：
  - `accept: 'Enter'` 通过 `validateHistoryConfig`。
  - `previous: 'Enter'` 被拒绝（错误消息以 `Command history binding` 开头）。
- `tests/terminal/commandHistoryController.test.ts`：
  - accept 绑定为 Enter 且有候选时，按 Enter 只填入候选、不执行、Enter 字节不转发到 shell；再按 Enter 正常提交并记录完整命令。
  - accept 绑定为 Enter 但无候选时，Enter 正常提交。
- `tests/settings/settingsTab.component.test.ts`：
  - accept 绑定可选项包含 Enter。

### 3.5 文档

- README.md 按键说明补充：Enter 可作为「采纳」的可选绑定（在设置中选择）。
- `docs/manual-acceptance.md` 键盘相关行若描述绑定行为，补充 Enter 可选绑定条目（真实环境步骤不变）。

## 4. 验证

- `npm run verify`（lint、类型检查、jest、webpack 构建、pack 检查）通过。
- 手工验收：设置中把 Accept candidate 设为 Enter，输入命令前缀出现候选后按 Enter —— 候选填入且命令不执行、shell 未收到额外 Enter；再按 Enter 命令执行并被记录。无候选时 Enter 行为与之前一致。

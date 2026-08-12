# Tabby 命令历史插件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从空仓库构建一个可安装到 Tabby 桌面端的命令历史插件，按 connection 隔离持久历史，在用户输入时提供三种可配置候选模式，并安全地将候选填入当前命令行而不执行。

**Architecture:** 使用 `TerminalDecorator` 为每个终端 session 注入输入 middleware，由纯 TypeScript 状态机重建命令缓冲；connection 级单例服务在内存中匹配并通过独立 JSONL 文件持久化。xterm 几何适配器与 DOM overlay 只负责展示，设置组件通过 Tabby `ConfigProvider` 和 `SettingsTabProvider` 接入。

**Tech Stack:** TypeScript 4.9、Angular 15、RxJS 7、Tabby 1.0.231-nightly.0 1.x API、xterm、Webpack 5、Jest 29、ts-jest、ESLint、Pug、SCSS、Node.js 文件系统 API。

## Global Constraints

- 支持 Windows、macOS 和 Linux 上的 Tabby 桌面端 1.0.231-nightly.0 或更高 1.x 版本；不支持 Tabby Web。
- 历史只保存在用户数据目录，默认根目录分别为 `%APPDATA%\tabby\cmd-history`、`~/Library/Application Support/tabby/cmd-history`、`${XDG_DATA_HOME:-~/.local/share}/tabby/cmd-history`。
- 每个 connection 使用独立 `connections/<sha256>.jsonl`；任何查询、追加、压缩和清空接口都必须显式接收 connection key。
- 默认展示模式为 B（list），同时完整提供 A（inline）和 C（hybrid）。
- 默认容量为每个 connection 4096 条唯一命令，默认最多显示 5 条候选，最短查询长度为 1。
- 匹配先严格分为前缀和包含两层；层内默认权重为 recency 0.55、frequency 0.30、matchCloseness 0.15。
- Right 只采纳候选，不得发送 Enter；Tab 始终透传；`Ctrl+C` 始终透传并清空插件缓冲和待写入状态。
- 默认严格捕获要求可见回显；alternate screen、隐藏输入和不可信缓冲不得落盘。
- 敏感过滤默认启用，内置不区分大小写的 `password`、`asplaintext`、`token`、`apikey`、`secret` 指示词，并支持用户排除正则。
- 终端输入必须 fail-open；插件内部异常不得使终端无法输入。
- 输入路径不得同步访问文件系统；4096 条历史查询与排序的第 95 百分位耗时不得超过 10 ms。
- 所有生产行为遵守测试先行：先观察目标测试因缺少行为而失败，再编写最小实现。

---

## 文件结构

```text
.
├── .eslintrc.cjs
├── .gitignore
├── LICENSE
├── README.md
├── jest.config.cjs
├── package.json
├── tsconfig.json
├── tsconfig.test.json
├── webpack.config.cjs
├── src
│   ├── api.ts
│   ├── index.ts
│   ├── config
│   │   ├── configProvider.ts
│   │   └── historyConfig.ts
│   ├── history
│   │   ├── commandPolicy.ts
│   │   ├── connectionIdentity.ts
│   │   ├── historyMatcher.ts
│   │   ├── historyService.ts
│   │   ├── jsonlHistoryRepository.ts
│   │   └── types.ts
│   ├── terminal
│   │   ├── captureAdapter.ts
│   │   ├── commandBuffer.ts
│   │   ├── commandHistoryController.ts
│   │   ├── commandHistoryDecorator.ts
│   │   ├── inputDecoder.ts
│   │   ├── inputMiddleware.ts
│   │   ├── terminalGeometryAdapter.ts
│   │   └── visibleEchoVerifier.ts
│   ├── settings
│   │   ├── settingsTab.component.pug
│   │   ├── settingsTab.component.scss
│   │   ├── settingsTab.component.ts
│   │   └── settingsTabProvider.ts
│   └── ui
│       ├── predictionOverlay.scss
│       └── predictionOverlay.ts
└── tests
    ├── setup.ts
    ├── stubs
    ├── config
    ├── history
    ├── terminal
    ├── settings
    ├── ui
    └── integration
```

每个文件只承担上图对应职责；测试目录按生产模块镜像组织。

### Task 1: 建立可构建插件骨架与默认配置

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.test.json`
- Create: `webpack.config.cjs`
- Create: `jest.config.cjs`
- Create: `.eslintrc.cjs`
- Create: `.gitignore`
- Create: `tests/setup.ts`
- Create: `tests/stubs/tabby-core.ts`
- Create: `tests/stubs/tabby-terminal.ts`
- Create: `tests/stubs/tabby-settings.ts`
- Create: `tests/config/defaults.test.ts`
- Create: `src/config/historyConfig.ts`
- Create: `src/config/configProvider.ts`
- Create: `src/history/types.ts`
- Create: `src/index.ts`

**Interfaces:**
- Consumes: Tabby `ConfigProvider` 和 Angular `NgModule`。
- Produces: `CommandHistoryConfig`、`DEFAULT_COMMAND_HISTORY_CONFIG`、`CommandHistoryConfigProvider`、`HistoryEntry`、`Prediction`。

- [ ] **Step 1: 创建构建和测试配置，不创建生产行为**

`package.json` 使用以下精确内容；其他配置文件随后按本步骤说明创建。

```json
{
  "name": "tabby-cmd-history",
  "version": "0.1.0",
  "description": "Per-connection command history predictions for Tabby",
  "keywords": ["tabby-plugin", "terminal", "history"],
  "main": "dist/index.js",
  "typings": "dist/index.d.ts",
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "test": "jest --runInBand",
    "test:watch": "jest --watch",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src tests --ext .ts",
    "build": "webpack --mode production",
    "verify": "npm run lint && npm run typecheck && npm test && npm run build",
    "prepublishOnly": "npm run verify"
  },
  "peerDependencies": {
    "@angular/common": "^15.2.0",
    "@angular/core": "^15.2.0",
    "@angular/forms": "^15.2.0",
    "@ng-bootstrap/ng-bootstrap": "^14.1.0",
    "rxjs": "^7.5.0",
    "tabby-core": "1.0.231-nightly.0",
    "tabby-settings": "1.0.231-nightly.0",
    "tabby-terminal": "1.0.231-nightly.0"
  },
  "devDependencies": {
    "@angular/common": "^15.2.6",
    "@angular/core": "^15.2.6",
    "@angular/forms": "^15.2.6",
    "@ng-bootstrap/ng-bootstrap": "^14.1.0",
    "@types/jest": "^29.5.14",
    "@types/node": "^20.17.0",
    "@typescript-eslint/eslint-plugin": "^6.21.0",
    "@typescript-eslint/parser": "^6.21.0",
    "apply-loader": "^2.0.0",
    "css-loader": "^6.10.0",
    "eslint": "^8.57.1",
    "jest": "^29.7.0",
    "jest-environment-jsdom": "^29.7.0",
    "pug": "^2.0.4",
    "pug-loader": "^2.4.0",
    "rxjs": "^7.5.7",
    "sass": "^1.77.0",
    "sass-loader": "^13.3.3",
    "style-loader": "^3.3.4",
    "tabby-core": "1.0.231-nightly.0",
    "tabby-settings": "1.0.231-nightly.0",
    "tabby-terminal": "1.0.231-nightly.0",
    "ts-jest": "^29.2.5",
    "ts-loader": "^9.5.1",
    "typescript": "4.9.5",
    "webpack": "^5.90.0",
    "webpack-cli": "^5.1.4"
  },
  "engines": { "node": ">=20" },
  "license": "MIT",
  "repository": "https://github.com/itheochan/cmd-history"
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2020", "ES2022.Intl", "DOM"],
    "strict": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "useDefineForClassFields": false,
    "esModuleInterop": true,
    "declaration": true,
    "outDir": "dist",
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

`tsconfig.test.json`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "declaration": false, "outDir": ".test-dist", "types": ["jest", "node"] },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

`jest.config.cjs`：

```js
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'jsdom',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/*.test.ts'],
    setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
    globals: { 'ts-jest': { tsconfig: 'tsconfig.test.json' } },
    moduleNameMapper: {
        '^tabby-core$': '<rootDir>/tests/stubs/tabby-core.ts',
        '^tabby-terminal$': '<rootDir>/tests/stubs/tabby-terminal.ts',
        '^tabby-settings$': '<rootDir>/tests/stubs/tabby-settings.ts',
    },
}
```

`webpack.config.cjs`：

```js
const path = require('node:path')

module.exports = {
    target: 'electron-renderer',
    entry: './src/index.ts',
    output: { path: path.resolve(__dirname, 'dist'), filename: 'index.js', libraryTarget: 'commonjs2' },
    resolve: { extensions: ['.ts', '.js'] },
    externals: [/^(?:@angular\/|rxjs(?:\/|$)|tabby-(?:core|terminal|settings)$)/],
    module: {
        rules: [
            { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
            { test: /\.pug$/, use: 'pug-loader' },
            { test: /\.s[ac]ss$/, use: ['style-loader', 'css-loader', 'sass-loader'] },
        ],
    },
}
```

`.eslintrc.cjs` 使用 `@typescript-eslint/parser` 和 `@typescript-eslint/recommended`，parserOptions.project 同时指向两个 tsconfig；`.gitignore` 精确忽略 `node_modules/`、`dist/`、`.test-dist/`、`coverage/`、`*.tgz`。三个 stub 只暴露当前测试所需的抽象类、token 和最小可观察对象，新增测试需要能力时再显式扩展。

- [ ] **Step 2: 写默认配置失败测试**

```ts
import { DEFAULT_COMMAND_HISTORY_CONFIG, validateHistoryConfig } from '../../src/config/historyConfig'

describe('command history defaults', () => {
    test('uses list mode and safe limits', () => {
        expect(DEFAULT_COMMAND_HISTORY_CONFIG).toMatchObject({
            enabled: true, presentation: 'list', maxVisible: 5,
            minQueryLength: 1, caseSensitive: false, capacity: 4096,
            captureMode: 'strict', sensitiveFiltering: true,
        })
        expect(DEFAULT_COMMAND_HISTORY_CONFIG.weights).toEqual({ recency: 0.55, frequency: 0.30, matchCloseness: 0.15 })
    })

    test('normalizes weights and rejects Ctrl+C bindings', () => {
        expect(validateHistoryConfig({
            ...DEFAULT_COMMAND_HISTORY_CONFIG,
            weights: { recency: 55, frequency: 30, matchCloseness: 15 },
        }).weights).toEqual({ recency: 0.55, frequency: 0.30, matchCloseness: 0.15 })
        expect(() => validateHistoryConfig({
            ...DEFAULT_COMMAND_HISTORY_CONFIG,
            bindings: { ...DEFAULT_COMMAND_HISTORY_CONFIG.bindings, accept: 'Ctrl+C' as never },
        })).toThrow('Ctrl+C')
    })
})
```

- [ ] **Step 3: 运行测试并确认因模块缺失而失败**

Run: `npm install && npm test -- tests/config/defaults.test.ts`

Expected: FAIL，错误包含 `Cannot find module '../../src/config/historyConfig'`。

- [ ] **Step 4: 实现最小配置、领域类型和 NgModule**

```ts
export type PresentationMode = 'inline' | 'list' | 'hybrid'
export type CaptureMode = 'strict' | 'permissive'
export type HistoryKeyName = 'ArrowUp' | 'ArrowDown' | 'ArrowRight' | 'Escape' |
    'Ctrl+ArrowUp' | 'Ctrl+ArrowDown' | 'Ctrl+ArrowRight'

export interface CommandHistoryConfig {
    enabled: boolean
    presentation: PresentationMode
    maxVisible: number
    minQueryLength: number
    caseSensitive: boolean
    capacity: number
    captureMode: CaptureMode
    sensitiveFiltering: boolean
    exclusionPatterns: string[]
    weights: { recency: number; frequency: number; matchCloseness: number }
    bindings: { previous: HistoryKeyName; next: HistoryKeyName; accept: HistoryKeyName; dismiss: HistoryKeyName }
    dataRoot: string | null
}

export const DEFAULT_COMMAND_HISTORY_CONFIG: Readonly<CommandHistoryConfig> = Object.freeze({
    enabled: true,
    presentation: 'list',
    maxVisible: 5,
    minQueryLength: 1,
    caseSensitive: false,
    capacity: 4096,
    captureMode: 'strict',
    sensitiveFiltering: true,
    exclusionPatterns: [],
    weights: { recency: 0.55, frequency: 0.30, matchCloseness: 0.15 },
    bindings: { previous: 'ArrowUp', next: 'ArrowDown', accept: 'ArrowRight', dismiss: 'Escape' },
    dataRoot: null,
})
```

`validateHistoryConfig` 限制 maxVisible 1–20、minQueryLength 1–20、capacity 1–100000，归一化权重并拒绝 Ctrl+C 与可打印字符。`src/history/types.ts` 导出：

```ts
export interface HistoryEntry { command: string; lastUsedAt: string; useCount: number }
export interface Prediction extends HistoryEntry { matchKind: 'prefix' | 'contains'; score: number; matchIndex: number }
export interface ConnectionIdentity { key: string; persistent: boolean; label: string }
```

`CommandHistoryConfigProvider.defaults` 为 `{ cmdHistory: structuredClone(DEFAULT_COMMAND_HISTORY_CONFIG) }`。初始 `src/index.ts` 只注册该 ConfigProvider。

- [ ] **Step 5: 验证并提交**

Run: `npm test -- tests/config/defaults.test.ts && npm run typecheck && npm run build`

Expected: 2 tests PASS；typecheck exit 0；生成 `dist/index.js` 和 `dist/index.d.ts`。

```bash
git add package.json package-lock.json tsconfig.json tsconfig.test.json webpack.config.cjs jest.config.cjs .eslintrc.cjs .gitignore src tests
git commit -m "build(plugin): 建立 Tabby 历史插件骨架"
```

### Task 2: 实现稳定 connection 身份和用户数据路径

**Files:**
- Create: `src/history/connectionIdentity.ts`
- Test: `tests/history/connectionIdentity.test.ts`

**Interfaces:**
- Consumes: `ConnectionIdentity`。
- Produces: `ProfileLike`、`ConnectionIdentityResolver.resolve(profile, tabLifetimeKey)`、`resolveDefaultDataRoot(platform, env, home)`。

- [ ] **Step 1: 写身份隔离和敏感字段失败测试**

```ts
import { ConnectionIdentityResolver, resolveDefaultDataRoot } from '../../src/history/connectionIdentity'

const resolver = new ConnectionIdentityResolver()

test('saved profiles use type and stable id, not display name', () => {
    const a = resolver.resolve({ id: 'ssh:custom:abc', type: 'ssh', name: 'Old', options: { host: 'a' } }, 'tab-a')
    const b = resolver.resolve({ id: 'ssh:custom:abc', type: 'ssh', name: 'New', options: { host: 'b' } }, 'tab-b')
    expect(a.key).toBe(b.key)
    expect(a.persistent).toBe(true)
    expect(a.key).toMatch(/^[a-f0-9]{64}$/)
})

test('quick connect excludes passwords and separates endpoints', () => {
    const a = resolver.resolve({ type: 'ssh', name: 'temp', options: { user: 'root', host: 'Example.COM', port: 22, password: 'one' } }, 'a')
    const b = resolver.resolve({ type: 'ssh', name: 'temp', options: { user: 'root', host: 'example.com', port: 22, password: 'two' } }, 'b')
    const c = resolver.resolve({ type: 'ssh', name: 'temp', options: { user: 'root', host: 'other', port: 22 } }, 'c')
    expect(a.key).toBe(b.key)
    expect(a.key).not.toBe(c.key)
})

test('unsafe anonymous profiles use tab-lifetime memory', () => {
    expect(resolver.resolve({ type: '', name: '', options: { password: 'x' } }, 'tab-7')).toEqual({
        key: 'memory:tab-7', persistent: false, label: 'Temporary terminal',
    })
})

test('resolves documented roots', () => {
    expect(resolveDefaultDataRoot('win32', { APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }, 'C:\\Users\\t'))
        .toBe('C:\\Users\\t\\AppData\\Roaming\\tabby\\cmd-history')
    expect(resolveDefaultDataRoot('linux', {}, '/home/t')).toBe('/home/t/.local/share/tabby/cmd-history')
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/history/connectionIdentity.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现规范化、递归清理和 SHA-256**

```ts
export interface ProfileLike { id?: string; type?: string; name?: string; options?: Record<string, unknown> }

export class ConnectionIdentityResolver {
    resolve (profile: ProfileLike, tabLifetimeKey: string): ConnectionIdentity
}

export function resolveDefaultDataRoot (
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    home: string,
): string
```

保存 profile 的规范串为 `profile:${type}` 加 NUL 分隔符和 id；SSH 使用小写 host、user 和默认端口 22；Serial 使用 port/baudrate/databits/stopbits/parity；Local 使用 command/args/shellType；其他 provider 对移除敏感及易变键后的对象递归排序并 JSON 序列化。用 `createHash('sha256').update(canonical).digest('hex')` 生成 key，空结果返回 memory key。

- [ ] **Step 4: 验证并提交**

Run: `npm test -- tests/history/connectionIdentity.test.ts`

Expected: 4 tests PASS。

```bash
git add src/history/connectionIdentity.ts tests/history/connectionIdentity.test.ts
git commit -m "feat(identity): 隔离每个 connection 的历史身份"
```

### Task 3: 实现命令规范化和敏感过滤

**Files:**
- Create: `src/history/commandPolicy.ts`
- Test: `tests/history/commandPolicy.test.ts`

**Interfaces:**
- Consumes: sensitiveFiltering 和 exclusionPatterns。
- Produces: `normalizeCommand`、`SensitiveCommandFilter.replacePatterns/allows`。

- [ ] **Step 1: 写失败测试**

```ts
import { normalizeCommand, SensitiveCommandFilter } from '../../src/history/commandPolicy'

test('normalizes outer whitespace and line endings only', () => {
    expect(normalizeCommand('  git  commit\r\n-m x  ')).toBe('git  commit\n-m x')
})

test.each(['--password x', '-AsPlainText', '--token=x', '--apiKey x', 'set-secret x'])(
    'blocks %s', command => expect(new SensitiveCommandFilter([]).allows(command, true)).toBe(false),
)

test('custom rules can be disabled explicitly', () => {
    const filter = new SensitiveCommandFilter(['^mysql .*--password'])
    expect(filter.allows('mysql db --password x', true)).toBe(false)
    expect(filter.allows('mysql db --password x', false)).toBe(true)
})

test('invalid replacement preserves prior rules', () => {
    const filter = new SensitiveCommandFilter(['private-host'])
    expect(() => filter.replacePatterns(['['])).toThrow('Invalid exclusion pattern')
    expect(filter.allows('ssh private-host', true)).toBe(false)
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/history/commandPolicy.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现过滤器**

```ts
const BUILT_IN = /password|asplaintext|token|apikey|secret/i

export function normalizeCommand (command: string): string {
    return command.replace(/\r\n?/g, '\n').trim()
}

export class SensitiveCommandFilter {
    private patterns: RegExp[] = []
    constructor (patterns: string[]) { this.replacePatterns(patterns) }
    replacePatterns (patterns: string[]): void {
        const next = patterns.map(source => {
            try { return new RegExp(source, 'i') } catch { throw new Error(`Invalid exclusion pattern: ${source}`) }
        })
        this.patterns = next
    }
    allows (command: string, enabled: boolean): boolean {
        return !enabled || !BUILT_IN.test(command) && !this.patterns.some(pattern => pattern.test(command))
    }
}
```

- [ ] **Step 4: 验证并提交**

Run: `npm test -- tests/history/commandPolicy.test.ts`

Expected: 全部测试 PASS。

```bash
git add src/history/commandPolicy.ts tests/history/commandPolicy.test.ts
git commit -m "feat(policy): 过滤敏感命令历史"
```

### Task 4: 实现前缀优先的综合排序

**Files:**
- Create: `src/history/historyMatcher.ts`
- Test: `tests/history/historyMatcher.test.ts`

**Interfaces:**
- Consumes: HistoryEntry、查询、配置和当前时间。
- Produces: `HistoryMatcher.query(entries, query, config, now, limit)`。

- [ ] **Step 1: 写失败测试**

```ts
import { HistoryMatcher } from '../../src/history/historyMatcher'
import { DEFAULT_COMMAND_HISTORY_CONFIG as defaults } from '../../src/config/historyConfig'

const entries = [
    { command: 'sudo git checkout main', lastUsedAt: '2026-08-12T11:59:00Z', useCount: 100 },
    { command: 'git checkout feature', lastUsedAt: '2026-08-10T00:00:00Z', useCount: 1 },
    { command: 'git cherry-pick abc', lastUsedAt: '2026-08-12T11:00:00Z', useCount: 4 },
]

test('prefix results always precede contains results', () => {
    const result = new HistoryMatcher().query(entries, 'git ch', defaults, new Date('2026-08-12T12:00:00Z'))
    expect(result.map(x => x.command)).toEqual(['git cherry-pick abc', 'git checkout feature', 'sudo git checkout main'])
    expect(result.map(x => x.matchKind)).toEqual(['prefix', 'prefix', 'contains'])
})

test('honors case and limit', () => {
    expect(new HistoryMatcher().query(entries, 'GIT', { ...defaults, caseSensitive: true }, new Date(), 2)).toEqual([])
    expect(new HistoryMatcher().query(entries, 'git', defaults, new Date(), 2)).toHaveLength(2)
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/history/historyMatcher.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现评分和稳定排序**

先分别收集 matchIndex 等于 0 和大于 0 的结果。组内计算：

```ts
const ageHours = Math.max(0, (now.getTime() - Date.parse(entry.lastUsedAt)) / 3_600_000)
const recency = 1 / (1 + ageHours / 24)
const frequency = Math.log1p(entry.useCount) / Math.log1p(maxUseCount)
const matchCloseness = (queryLength / commandLength) * (1 - matchIndex / commandLength)
const score = weights.recency * recency + weights.frequency * frequency + weights.matchCloseness * matchCloseness
```

同分按 lastUsedAt 降序、useCount 降序、command 升序；返回 prefix 与 contains 拼接后截取 limit。

- [ ] **Step 4: 验证并提交**

Run: `npm test -- tests/history/historyMatcher.test.ts`

Expected: 2 tests PASS。

```bash
git add src/history/historyMatcher.ts tests/history/historyMatcher.test.ts
git commit -m "feat(matcher): 添加前缀优先的历史排序"
```

### Task 5: 实现 Unicode 命令缓冲状态机

**Files:**
- Create: `src/terminal/commandBuffer.ts`
- Test: `tests/terminal/commandBuffer.test.ts`

**Interfaces:**
- Consumes: `EditAction`。
- Produces: `CommandBuffer.apply/snapshot/reset/dismiss`。

- [ ] **Step 1: 写失败测试**

```ts
import { CommandBuffer } from '../../src/terminal/commandBuffer'

test('edits Unicode graphemes', () => {
    const buffer = new CommandBuffer()
    buffer.apply({ type: 'insert', text: 'git 👨‍👩‍👧‍👦x' })
    buffer.apply({ type: 'left' })
    buffer.apply({ type: 'backspace' })
    expect(buffer.snapshot()).toMatchObject({ text: 'git x', cursor: 4, confident: true })
})

test('unknown input loses confidence until Enter', () => {
    const buffer = new CommandBuffer()
    buffer.apply({ type: 'insert', text: 'git' })
    buffer.apply({ type: 'unknown' })
    expect(buffer.apply({ type: 'enter' })).toEqual({ submitted: null })
    expect(buffer.snapshot()).toEqual({ text: '', cursor: 0, confident: true, dismissed: false })
})

test('Ctrl+C clears all state', () => {
    const buffer = new CommandBuffer()
    buffer.apply({ type: 'insert', text: 'danger' })
    buffer.dismiss()
    expect(buffer.apply({ type: 'interrupt' })).toEqual({ interrupted: true })
    expect(buffer.snapshot()).toEqual({ text: '', cursor: 0, confident: true, dismissed: false })
})

test('alternate screen ignores edits', () => {
    const buffer = new CommandBuffer()
    buffer.apply({ type: 'alternate', active: true })
    buffer.apply({ type: 'insert', text: ':q' })
    expect(buffer.snapshot().text).toBe('')
    buffer.apply({ type: 'alternate', active: false })
    buffer.apply({ type: 'insert', text: 'pwd' })
    expect(buffer.snapshot().text).toBe('pwd')
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/terminal/commandBuffer.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现动作和字素编辑**

```ts
export type EditAction =
    | { type: 'insert' | 'paste'; text: string }
    | { type: 'left' | 'right' | 'home' | 'end' | 'backspace' | 'delete' }
    | { type: 'deleteStart' | 'deleteEnd' | 'deleteWord' }
    | { type: 'unknown' | 'enter' | 'interrupt' }
    | { type: 'alternate'; active: boolean }

export interface BufferState { text: string; cursor: number; confident: boolean; dismissed: boolean }
export type BufferEffect = { submitted?: string | null; interrupted?: true }
```

内部用 `Intl.Segmenter(undefined, { granularity: 'grapheme' })` 保存字素数组。全部光标和删除动作只操作字素；unknown 将 confident 设为 false；enter 仅在可信且非空时返回文本并总是 reset；interrupt reset 并返回 interrupted；alternate active 时 reset 并忽略编辑。

- [ ] **Step 4: 验证并提交**

Run: `npm test -- tests/terminal/commandBuffer.test.ts`

Expected: 4 tests PASS。

```bash
git add src/terminal/commandBuffer.ts tests/terminal/commandBuffer.test.ts
git commit -m "feat(buffer): 重建终端命令编辑状态"
```

### Task 6: 实现 JSONL connection 仓储

**Files:**
- Create: `src/history/jsonlHistoryRepository.ts`
- Test: `tests/history/jsonlHistoryRepository.test.ts`

**Interfaces:**
- Consumes: data root、connection key、capacity、命令和时间。
- Produces: `load`、`record`、`clear`、`updates$`。

- [ ] **Step 1: 写隔离、损坏行、容量和清空失败测试**

```ts
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlHistoryRepository } from '../../src/history/jsonlHistoryRepository'

test('aggregates independently by connection key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tabby-history-test-'))
    const repo = new JsonlHistoryRepository(root)
    await repo.record('a'.repeat(64), 'git status', new Date('2026-08-12T10:00:00Z'), 4096)
    await repo.record('a'.repeat(64), 'git status', new Date('2026-08-12T11:00:00Z'), 4096)
    await repo.record('b'.repeat(64), 'pwd', new Date('2026-08-12T12:00:00Z'), 4096)
    expect(await repo.load('a'.repeat(64), 4096)).toEqual([
        { command: 'git status', lastUsedAt: '2026-08-12T11:00:00.000Z', useCount: 2 },
    ])
    expect((await repo.load('b'.repeat(64), 4096))[0].command).toBe('pwd')
})

test('skips corrupt lines and evicts least recently used', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tabby-history-test-'))
    const key = 'c'.repeat(64)
    const file = join(root, 'connections', `${key}.jsonl`)
    await mkdir(join(root, 'connections'), { recursive: true })
    await writeFile(file, [
        JSON.stringify({ v: 1, kind: 'entry', command: 'old', lastUsedAt: '2026-01-01T00:00:00Z', useCount: 9 }),
        '{broken',
        JSON.stringify({ v: 1, kind: 'use', command: 'new', at: '2026-08-12T00:00:00Z' }),
    ].join('\n'))
    expect(await new JsonlHistoryRepository(root).load(key, 1)).toEqual([
        { command: 'new', lastUsedAt: '2026-08-12T00:00:00Z', useCount: 1 },
    ])
})

test('clear removes only one connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tabby-history-test-'))
    const repo = new JsonlHistoryRepository(root)
    await repo.record('d'.repeat(64), 'one', new Date(), 10)
    await repo.record('e'.repeat(64), 'two', new Date(), 10)
    await repo.clear('d'.repeat(64))
    expect(await repo.load('d'.repeat(64), 10)).toEqual([])
    expect(await repo.load('e'.repeat(64), 10)).toHaveLength(1)
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/history/jsonlHistoryRepository.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现安全路径、队列、重放和压缩**

```ts
export class JsonlHistoryRepository {
    readonly updates$: Observable<string>
    constructor (root: string, options?: { compactBytes?: number; compactEvents?: number; warn?: (message: string) => void })
    load (key: string, capacity: number): Promise<HistoryEntry[]>
    record (key: string, command: string, at: Date, capacity: number): Promise<HistoryEntry[]>
    clear (key: string): Promise<void>
}
```

入口用 `/^[a-f0-9]{64}$/` 校验持久 key，文件路径只能是 `join(root, 'connections', key + '.jsonl')`。load 重放 use/entry、规范化聚合、跳过无效记录并按 lastUsedAt 保留最新 capacity 条。record 用 `Map<string, Promise<void>>` 串行化同 key 写入，先更新内存再 appendFile。压缩写同目录 tmp，执行 sync/close 后 rename。clear 等待该 key 队列、删除目标、清理缓存并发出 updates$。

- [ ] **Step 4: 增加压缩和不可写回退测试**

```ts
test('compacts events into aggregate entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tabby-history-test-'))
    const key = 'f'.repeat(64)
    const repo = new JsonlHistoryRepository(root, { compactEvents: 3 })
    await repo.record(key, 'git status', new Date('2026-08-12T10:00:00Z'), 10)
    await repo.record(key, 'git status', new Date('2026-08-12T11:00:00Z'), 10)
    await repo.record(key, 'pwd', new Date('2026-08-12T12:00:00Z'), 10)
    const records = (await readFile(join(root, 'connections', `${key}.jsonl`), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line))
    expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'entry', command: 'git status', useCount: 2 }),
        expect.objectContaining({ kind: 'entry', command: 'pwd', useCount: 1 }),
    ]))
})

test('keeps memory history and warns once when storage is unavailable', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tabby-history-test-'))
    const blocker = join(parent, 'not-a-directory')
    await writeFile(blocker, 'x')
    const warn = jest.fn()
    const key = '0'.repeat(64)
    const repo = new JsonlHistoryRepository(join(blocker, 'child'), { warn })
    await expect(repo.record(key, 'one', new Date('2026-08-12T10:00:00Z'), 10)).resolves.toHaveLength(1)
    await expect(repo.record(key, 'two', new Date('2026-08-12T11:00:00Z'), 10)).resolves.toHaveLength(2)
    expect(await repo.load(key, 10)).toHaveLength(2)
    expect(warn).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 5: 验证并提交**

Run: `npm test -- tests/history/jsonlHistoryRepository.test.ts`

Expected: 5 tests PASS；每个测试只删除自身创建的精确临时目录。

```bash
git add src/history/jsonlHistoryRepository.ts tests/history/jsonlHistoryRepository.test.ts
git commit -m "feat(storage): 按 connection 持久化 JSONL 历史"
```

### Task 7: 实现输入 decoder、middleware 和安全采纳

**Files:**
- Create: `src/terminal/inputDecoder.ts`
- Create: `src/terminal/inputMiddleware.ts`
- Test: `tests/terminal/inputDecoder.test.ts`
- Test: `tests/terminal/inputMiddleware.test.ts`
- Modify: `tests/stubs/tabby-terminal.ts`

**Interfaces:**
- Consumes: 原始 Buffer、EditAction 和按键路由决定。
- Produces: `TerminalInputDecoder.decode`、`CommandInputMiddleware.feedFromTerminal/injectReplacement/injectBracketedPaste`。

- [ ] **Step 1: 写解码、透传和无 Enter 采纳失败测试**

```ts
test('decodes text, editing keys, bracketed paste and Ctrl+C', () => {
    const decoder = new TerminalInputDecoder()
    expect(decoder.decode(Buffer.from('git'))[0].action).toEqual({ type: 'insert', text: 'git' })
    expect(decoder.decode(Buffer.from([0x1b, 0x5b, 0x44]))[0].action).toEqual({ type: 'left' })
    expect(decoder.decode(Buffer.from([0x03]))[0].action).toEqual({ type: 'interrupt' })
    decoder.decode(Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]))
    expect(decoder.decode(Buffer.from('a\nb'))[0].action).toEqual({ type: 'paste', text: 'a\nb' })
})

test('middleware forwards ordinary input and Ctrl+C', () => {
    const routes: Buffer[] = []
    const middleware = new CommandInputMiddleware(action => ({ consume: false, action }))
    middleware.outputToSession$.subscribe(data => routes.push(data))
    middleware.feedFromTerminal(Buffer.from('x'))
    middleware.feedFromTerminal(Buffer.from([0x03]))
    expect(Buffer.concat(routes)).toEqual(Buffer.from([0x78, 0x03]))
})

test('replacement injection never contains a command terminator', () => {
    const routes: Buffer[] = []
    const middleware = new CommandInputMiddleware(() => ({ consume: false }))
    middleware.outputToSession$.subscribe(data => routes.push(data))
    middleware.injectReplacement({ current: 'git ch', cursor: 6, candidate: 'sudo git checkout' })
    const bytes = Buffer.concat(routes)
    expect(bytes.includes(0x0d)).toBe(false)
    expect(bytes.includes(0x0a)).toBe(false)
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/terminal/inputDecoder.test.ts tests/terminal/inputMiddleware.test.ts`

Expected: FAIL，decoder 和 middleware 模块不存在。

- [ ] **Step 3: 实现 decoder 和 middleware**

decoder 识别 UTF-8 文本、回车、换行、Ctrl+C、Backspace、四个方向键、Home、End、Delete、Ctrl+A/E/U/K/W，以及 bracketed-paste 起止序列；其他完整 ESC 序列产生 unknown 动作。middleware 继承 Tabby `SessionMiddleware`，逐 token 调用 router；`consume: true` 时不发出原始字节，否则原样发送。

`injectReplacement` 在当前文本是候选前缀且光标位于末尾时只发送后缀；否则先发 Right 序列移动到末尾，再按当前字素数发 Backspace，最后发完整候选。`injectBracketedPaste` 仅用 bracketed-paste 起止字节包裹候选，不附加命令终止符。

- [ ] **Step 4: 验证并提交**

Run: `npm test -- tests/terminal/inputDecoder.test.ts tests/terminal/inputMiddleware.test.ts`

Expected: 全部测试 PASS；Ctrl+C 输出字节与输入严格相同。

```bash
git add src/terminal/inputDecoder.ts src/terminal/inputMiddleware.ts tests/terminal tests/stubs/tabby-terminal.ts
git commit -m "feat(input): 捕获并安全重放终端编辑输入"
```

### Task 8: 实现历史服务、可见回显和三模式 overlay

**Files:**
- Create: `src/history/historyService.ts`
- Create: `src/terminal/visibleEchoVerifier.ts`
- Create: `src/terminal/terminalGeometryAdapter.ts`
- Create: `src/ui/predictionOverlay.ts`
- Create: `src/ui/predictionOverlay.scss`
- Test: `tests/history/historyService.test.ts`
- Test: `tests/terminal/visibleEchoVerifier.test.ts`
- Test: `tests/ui/predictionOverlay.test.ts`

**Interfaces:**
- Consumes: repository、matcher、filter、配置、xterm buffer 和候选。
- Produces: `HistoryService.query/record/clear`、`VisibleEchoVerifier.matches`、`TerminalGeometryAdapter.measure`、`PredictionOverlay.render/hide/destroy`。

- [ ] **Step 1: 写安全门和 connection 缓存失败测试**

```ts
test('records only commands accepted by all gates', async () => {
    const repository = fakeRepository()
    const service = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))
    await service.record(identity('a'), ' git status ', true, defaults, new Date())
    await service.record(identity('a'), '--token secret', true, defaults, new Date())
    await service.record(identity('a'), 'hidden', false, defaults, new Date())
    expect(repository.record).toHaveBeenCalledTimes(1)
    expect(repository.record).toHaveBeenCalledWith('a', 'git status', expect.any(Date), 4096)
})

test('queries only the requested connection cache', async () => {
    const service = serviceWithEntries({ a: ['git status'], b: ['git push'] })
    expect((await service.query(identity('a'), 'git', defaults)).map(x => x.command)).toEqual(['git status'])
})
```

- [ ] **Step 2: 写回显和 A/B/C DOM 失败测试**

```ts
test('visible echo rejects hidden input', () => {
    const verifier = new VisibleEchoVerifier()
    expect(verifier.matches(['PS C:\\> git status'], 'git status')).toBe(true)
    expect(verifier.matches(['Password:'], 'hunter2')).toBe(false)
})

test.each(['inline', 'list', 'hybrid'] as const)('renders %s mode', mode => {
    const host = document.createElement('div')
    const overlay = new PredictionOverlay(host)
    overlay.render({ mode, query: 'git ch', predictions, selectedIndex: 0, expanded: mode === 'list', position: { left: 20, top: 30, above: false } })
    expect(host.querySelector('.cmd-history-overlay')?.textContent).toContain('eckout main')
    expect(host.querySelector('.cmd-history-overlay')?.getAttribute('data-mode')).toBe(mode)
})
```

DOM 断言通过 role、class 和 `textContent` 验证展示；命令文本不得复制到 `data-*`、ARIA 或其他属性。这是 `textContent`-only 安全边界的一部分，避免扩大命令内容的 DOM 绑定面。

- [ ] **Step 3: 运行并确认失败**

Run: `npm test -- tests/history/historyService.test.ts tests/terminal/visibleEchoVerifier.test.ts tests/ui/predictionOverlay.test.ts`

Expected: FAIL，相关模块不存在。

- [ ] **Step 4: 实现服务和展示适配器**

`HistoryService` 用 `Map<key, Promise<HistoryEntry[]>>` 保证每个文件每进程只加载一次；record 依次执行可信度、回显、规范化、空值和敏感过滤；memory identity 使用独立 Map。query 只读取传入 key。

`VisibleEchoVerifier.matches` 统一换行和行尾空白，将命令行与 xterm 最近逻辑行的后缀比较，不完整可见时返回 false。`TerminalGeometryAdapter.measure` 使用 cursorX/cursorY、cols/rows 和 `.xterm-screen` 边界计算位置，下方不足时返回 above。

`PredictionOverlay` 只创建一个根节点；inline 显示剩余 ghost text，list 显示有上限的行，hybrid 未展开时显示 inline、展开后显示 list。命令必须通过 `textContent` 写入，不允许由命令内容构造 HTML。

- [ ] **Step 5: 验证并提交**

Run: `npm test -- tests/history/historyService.test.ts tests/terminal/visibleEchoVerifier.test.ts tests/ui/predictionOverlay.test.ts`

Expected: 全部测试 PASS。

```bash
git add src/history/historyService.ts src/terminal/visibleEchoVerifier.ts src/terminal/terminalGeometryAdapter.ts src/ui tests/history/historyService.test.ts tests/terminal/visibleEchoVerifier.test.ts tests/ui
git commit -m "feat(prediction): 查询并展示 connection 历史候选"
```

### Task 9: 接入 TerminalDecorator 生命周期和快捷键

**Files:**
- Create: `src/terminal/captureAdapter.ts`
- Create: `src/terminal/commandHistoryController.ts`
- Create: `src/terminal/commandHistoryDecorator.ts`
- Test: `tests/terminal/commandHistoryController.test.ts`
- Test: `tests/integration/terminalDecorator.test.ts`
- Modify: `src/index.ts`
- Modify: `src/api.ts`
- Modify: `tests/stubs/tabby-core.ts`
- Modify: `tests/stubs/tabby-terminal.ts`

**Interfaces:**
- Consumes: terminal、identity resolver、history service、buffer、middleware、overlay 和配置。
- Produces: `ConnectionContext`、`CommandHistoryController`、`CommandHistoryTerminalDecorator`、`CommandCaptureAdapter`。

- [ ] **Step 1: 写候选拦截、Ctrl+C、fail-open 和 detach 失败测试**

```ts
test('intercepts candidate keys only while predictions are active', async () => {
    const fixture = createTerminalControllerFixture(['git checkout main', 'git cherry-pick a'])
    await fixture.type('git ch')
    await fixture.key('ArrowDown')
    expect(fixture.sessionBytes()).toBe('git ch')
    await fixture.key('ArrowRight')
    expect(fixture.sessionBytes()).toContain('erry-pick a')
    expect(fixture.sessionBuffer()).not.toContain(0x0d)
})

test('Ctrl+C reaches the session and clears state', async () => {
    const fixture = createTerminalControllerFixture(['danger command'])
    await fixture.type('danger')
    await fixture.raw(Buffer.from([0x03]))
    expect(fixture.sessionBuffer().at(-1)).toBe(0x03)
    expect(fixture.controller.state().buffer.text).toBe('')
    expect(fixture.overlayVisible()).toBe(false)
})

test('unknown input fails open and detach removes resources', async () => {
    const fixture = createTerminalControllerFixture([])
    const unknown = Buffer.from([0x1b, 0x5b, 0x39, 0x39, 0x7e])
    await fixture.raw(unknown)
    expect(fixture.sessionBuffer()).toEqual(expect.arrayContaining([...unknown]))
    fixture.decorator.detach(fixture.terminal)
    expect(fixture.middlewareCount()).toBe(0)
    expect(fixture.host.querySelector('.cmd-history-overlay')).toBeNull()
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/terminal/commandHistoryController.test.ts tests/integration/terminalDecorator.test.ts`

Expected: FAIL，controller/decorator 不存在。

- [ ] **Step 3: 实现 controller**

attach 时解析 terminal.profile 并加载当前历史；每次可信编辑后查询；用递增 generation 丢弃过期异步结果；候选活动时消费 previous/next/accept/dismiss；Tab 透传并标记不可信；Enter 获取可见行快照后透传并异步记录；Ctrl+C 透传并同步清空；alternate active 时隐藏并清空；session 替换时移除旧 middleware 后接入新 session。

单行采纳调用 injectReplacement；多行只有 supportsBracketedPaste 为 true 时调用 injectBracketedPaste。回调异常必须透传原始输入、隐藏 overlay，日志不得包含命令文本。

- [ ] **Step 4: 实现 decorator 和 adapter 接口**

```ts
export interface ConnectionContext {
    identity: ConnectionIdentity
    profile: ProfileLike
}

export interface CommandCaptureAdapter {
    supports (context: ConnectionContext): boolean
    attach (terminal: BaseTerminalTabComponent<any>): Promise<CommandCaptureHandle>
}

export interface CommandCaptureHandle {
    finalCommand$: Observable<string>
    detach (): Promise<void>
}
```

decorator 用 WeakMap 保证一个 terminal 对应一个 controller。detach 先 destroy controller、删除 WeakMap 项，再调用 super.detach。`src/index.ts` 通过 multi provider 注册。

- [ ] **Step 5: 验证并提交**

Run: `npm test -- tests/terminal/commandHistoryController.test.ts tests/integration/terminalDecorator.test.ts && npm run typecheck`

Expected: 全部测试 PASS；typecheck exit 0。

```bash
git add src/terminal src/index.ts src/api.ts tests/terminal tests/integration tests/stubs
git commit -m "feat(terminal): 接入 Tabby 终端历史生命周期"
```

### Task 10: 实现设置页和清空当前 connection

**Files:**
- Create: `src/settings/settingsTab.component.ts`
- Create: `src/settings/settingsTab.component.pug`
- Create: `src/settings/settingsTab.component.scss`
- Create: `src/settings/settingsTabProvider.ts`
- Test: `tests/settings/settingsTab.component.test.ts`
- Modify: `src/index.ts`
- Modify: `tests/stubs/tabby-settings.ts`

**Interfaces:**
- Consumes: ConfigService、AppService.activeTab、PlatformService.showMessageBox、identity resolver 和 history service。
- Produces: 配置 UI、校验、`clearActiveConnection`。

- [ ] **Step 1: 写保存、无效正则和精确清空失败测试**

```ts
test('saves validated presentation mode', async () => {
    const fixture = createSettingsFixture()
    fixture.component.draft.presentation = 'inline'
    await fixture.component.save()
    expect(fixture.config.store.cmdHistory.presentation).toBe('inline')
    expect(fixture.config.save).toHaveBeenCalled()
})

test('does not save invalid exclusion expression', async () => {
    const fixture = createSettingsFixture()
    fixture.component.exclusionText = '[broken'
    await fixture.component.save()
    expect(fixture.component.validationError).toContain('Invalid exclusion pattern')
    expect(fixture.config.save).not.toHaveBeenCalled()
})

test('clears only active connection after confirmation', async () => {
    const fixture = createSettingsFixture({ activeKey: 'a', confirm: true })
    await fixture.component.clearActiveConnection()
    expect(fixture.history.clear).toHaveBeenCalledWith(expect.objectContaining({ key: 'a' }))
    expect(fixture.history.clear).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'b' }))
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- tests/settings/settingsTab.component.test.ts`

Expected: FAIL，设置组件不存在。

- [ ] **Step 3: 实现组件、模板和 provider**

模板包含 enabled、A/B/C、maxVisible、minQueryLength、caseSensitive、capacity、三个权重、strict/permissive、sensitiveFiltering、多行 exclusionPatterns、四个快捷键下拉框、dataRoot 和清空按钮。保存时先编译正则再 validateHistoryConfig；失败只设置 validationError，不修改 ConfigService.store。

clearActiveConnection 解析 split pane focused tab，要求 BaseTerminalTabComponent，调用 `showMessageBox({ type: 'warning', buttons: ['Cancel', 'Clear'], defaultId: 0, cancelId: 0, ... })`，只有返回值满足 `result.response === 1` 才调用 `HistoryService.clear(identity)`。

provider 固定为 `id = 'cmd-history'`、`icon = 'fas fa-history'`、`title = 'Command history'`、`weight = 20`。index 导入 CommonModule/FormsModule，声明组件并用 multi provider 注册。

- [ ] **Step 4: 验证并提交**

Run: `npm test -- tests/settings/settingsTab.component.test.ts && npm run build`

Expected: 3 tests PASS；Webpack 成功处理 Pug 和 SCSS。

```bash
git add src/settings src/index.ts tests/settings tests/stubs/tabby-settings.ts
git commit -m "feat(settings): 配置历史预测并清空当前连接"
```

### Task 11: 补齐隔离、故障降级和性能验证

**Files:**
- Create: `tests/integration/connectionIsolation.test.ts`
- Create: `tests/integration/failOpen.test.ts`
- Create: `tests/history/historyMatcher.benchmark.test.ts`
- Modify: `src/history/jsonlHistoryRepository.ts`
- Modify: `src/history/historyService.ts`
- Modify: `src/terminal/commandHistoryController.ts`

**Interfaces:**
- Consumes: Tasks 2–10 全部公开接口。
- Produces: 跨组件回归保护和验收级性能证据。

- [ ] **Step 1: 写 connection 隔离集成测试**

```ts
test('shares updates for one key without leaking or clearing another key', async () => {
    const fixture = await createIsolationFixture({
        a: ['git status'],
        b: ['git push'],
    })
    await fixture.a1.execute('git checkout main')
    await fixture.flushUpdates()
    expect(await fixture.a2.query('git ch')).toEqual(['git checkout main'])
    expect(await fixture.b.query('git')).toEqual(['git push'])
    const bBefore = await fixture.readFileFor('b')
    await fixture.service.clear(fixture.identity('a'))
    expect(await fixture.a1.query('git')).toEqual([])
    expect(await fixture.a2.query('git')).toEqual([])
    expect(await fixture.readFileFor('b')).toEqual(bBefore)
})
```

fixture 必须使用真实临时 JSONL 仓储，A1/A2 共享同一 identity，B 使用不同 identity；不允许用单元测试 mock 代替文件隔离。

- [ ] **Step 2: 写 fail-open 故障注入测试**

```ts
test.each(['matcher', 'repository', 'overlay'] as const)('fails open when %s throws', async fault => {
    const fixture = createFaultFixture(fault)
    await fixture.raw(Buffer.from('do-not-log-this'))
    await fixture.raw(Buffer.from([0x03]))
    expect(fixture.sessionBuffer()).toEqual(Buffer.concat([
        Buffer.from('do-not-log-this'), Buffer.from([0x03]),
    ]))
    expect(fixture.overlayVisible()).toBe(false)
    expect(fixture.logs().join('\n')).not.toContain('do-not-log-this')
    expect(fixture.queriedKeys()).toEqual(expect.arrayContaining([fixture.activeIdentity.key]))
    expect(fixture.queriedKeys().every(key => key === fixture.activeIdentity.key)).toBe(true)
})

test('anonymous identity remains memory-only', async () => {
    const fixture = await createAnonymousIdentityFixture()
    await fixture.execute('echo transient')
    expect(fixture.identity).toEqual(expect.objectContaining({ persistent: false }))
    expect(await fixture.connectionFiles()).toEqual([])
    expect((await fixture.query('echo')).map(x => x.command)).toEqual(['echo transient'])
})
```

- [ ] **Step 3: 写 4096 条性能测试**

```ts
test('ranks 4096 entries under the 10 ms p95 budget', () => {
    for (let warmup = 0; warmup < 10; warmup++) {
        matcher.query(entries4096, 'git ch', defaults, fixedNow)
    }
    const samples: number[] = []
    for (let round = 0; round < 40; round++) {
        const start = performance.now()
        matcher.query(entries4096, 'git ch', defaults, fixedNow)
        samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    const p95Index = Math.ceil(samples.length * 0.95) - 1
    expect(samples[p95Index]).toBeLessThanOrEqual(10)
})
```

`entries4096` 用固定种子构造，包含 64 条 `git ch...` 命令和 4032 条噪声；测试失败时输出实测 p95，不能通过放宽 10 ms 门槛修复。

- [ ] **Step 4: 运行完整测试并修复测试实际暴露的问题**

Run: `npm test`

Expected: 所有测试 PASS；无未处理 rejection 和 Jest open handle。

- [ ] **Step 5: 提交集成验证**

```bash
git add src tests/integration tests/history/historyMatcher.benchmark.test.ts
git commit -m "test(integration): 验证历史隔离和故障透传"
```

### Task 12: 完成文档、打包与真实 Tabby 验收

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `docs/manual-acceptance.md`
- Modify: `package.json`
- Test: npm pack 内容和 Tabby 手工矩阵

**Interfaces:**
- Consumes: 完整插件产物。
- Produces: 可发布 npm 包、安装说明、安全边界和验收记录。

- [ ] **Step 1: 编写 README 和 MIT LICENSE**

README 包含功能截图位置、支持版本、三种模式、默认按键、connection 隔离、三平台目录、敏感过滤、严格捕获、续行限制、安装开发命令，以及卸载不自动删除历史。不得宣称通用模式证明命令已经完成执行。

- [ ] **Step 2: 创建并执行手工验收矩阵**

`docs/manual-acceptance.md` 记录日期、Tabby 版本，并覆盖 PowerShell、cmd.exe、WSL Bash、可用的 Bash/Zsh、保存 SSH、SSH Quick Connect、分屏、同 connection 多 tab、不同 connection 相同命令、密码提示、alternate screen、多行 bracketed paste、A/B/C、运行时配置、两种 Ctrl+C 场景、不可写目录和截断 JSONL。

- [ ] **Step 3: 运行全套自动验证**

Run: `npm run verify`

Expected: lint、typecheck、Jest 和 production build 全部 exit 0。

- [ ] **Step 4: 检查发布包内容**

Run: `npm pack --dry-run --json`

Expected: 只包含 `dist/**`、`README.md`、`LICENSE`、`package.json`；不含 tests、设计文档、`.vscode`、coverage 或 JSONL。

- [ ] **Step 5: 在真实 Tabby 中加载并完成矩阵**

使用 `TABBY_PLUGINS` 指向仓库绝对路径，以 debug 模式启动当前稳定版 Tabby。每项记录 PASS、环境不可用或具体失败证据；功能失败不得标记通过。

- [ ] **Step 6: 最终复跑并提交发布候选**

Run: `npm run verify && npm pack --dry-run --json`

Expected: 自动验证全绿，包清单正确，手工矩阵无未解决的发布阻断失败。

```bash
git add README.md LICENSE docs/manual-acceptance.md package.json package-lock.json
git commit -m "docs(release): 补充安装说明和验收记录"
```

## 规格覆盖映射

| 规格主题 | 实施任务 |
|---|---|
| Tabby 插件入口、配置与兼容版本 | Task 1、10、12 |
| connection 身份、用户目录与隔离 | Task 2、6、11 |
| 命令规范化与敏感过滤 | Task 3、8 |
| 前缀优先、55/30/15 排序与 4096 条性能 | Task 4、11 |
| Unicode 编辑缓冲、快捷键、Ctrl+C | Task 5、7、9 |
| JSONL 写入、聚合、容量、压缩与恢复 | Task 6、11 |
| 严格可见回显、宽松模式和通用捕获边界 | Task 8、9、12 |
| A/B/C 展示、候选导航和只采纳不执行 | Task 7、8、9 |
| alternate screen、分屏、session 替换和 detach | Task 9、11、12 |
| 设置页、运行时配置和清空当前 connection | Task 10、12 |
| fail-open、日志脱敏和不可写降级 | Task 6、9、11 |
| PowerShell/cmd/WSL/SSH 真实验收 | Task 12 |

## 计划完成判定

完成 Task 1–12 后，逐条对照 `docs/superpowers/specs/2026-08-12-tabby-command-history-design.md` 的 12 项验收标准。只有每项都有自动测试、手工证据或明确环境不可用记录，且不存在发布阻断失败时，才能声明插件完成。

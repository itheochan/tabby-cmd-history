/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('@angular/common', () => ({ CommonModule: class CommonModule {} }))
jest.mock('@angular/forms', () => ({ FormsModule: class FormsModule {} }))
jest.mock('@angular/core', () => ({
    Component: (metadata: unknown) => (target: any) => {
        target.ɵcmp = metadata
    },
    NgModule: (metadata: any) => (target: any) => {
        target.ɵmod = { declarations: metadata.declarations ?? [], imports: metadata.imports ?? [] }
        target.ɵinj = { providers: metadata.providers ?? [] }
    },
}))

import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { Subject } from 'rxjs'
import { DEFAULT_COMMAND_HISTORY_CONFIG } from '../../src/config/historyConfig'
import { ConnectionIdentityResolver } from '../../src/history/connectionIdentity'
import { CommandHistorySettingsTabComponent } from '../../src/settings/settingsTab.component'
import { CommandHistorySettingsTabProvider } from '../../src/settings/settingsTabProvider'
import CommandHistoryModule from '../../src/index'
import { SplitTabComponent } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { JsonlHistoryRepository } from '../../src/history/jsonlHistoryRepository'
import { resolveDefaultDataRoot } from '../../src/history/connectionIdentity'
import { ActiveTerminalTracker } from '../../src/terminal/activeTerminalTracker'

function cloneDefaults () {
    return {
        ...DEFAULT_COMMAND_HISTORY_CONFIG,
        exclusionPatterns: [...DEFAULT_COMMAND_HISTORY_CONFIG.exclusionPatterns],
        weights: { ...DEFAULT_COMMAND_HISTORY_CONFIG.weights },
        bindings: { ...DEFAULT_COMMAND_HISTORY_CONFIG.bindings },
    }
}

function terminal (profile: Record<string, unknown> = {
    id: 'saved-a',
    type: 'local',
    name: 'PowerShell',
    options: {},
}): BaseTerminalTabComponent<any> {
    const tab = Object.create(BaseTerminalTabComponent.prototype) as BaseTerminalTabComponent<any>
    tab.profile = profile
    tab.title = 'PowerShell'
    ;(tab as any).focused$ = new Subject<void>()
    ;(tab as any).destroyed$ = new Subject<void>()
    tab.hasFocus = false
    return tab
}

function split (focused: BaseTerminalTabComponent<any>): SplitTabComponent {
    const tab = Object.create(SplitTabComponent.prototype) as SplitTabComponent
    tab.getFocusedTab = () => focused
    tab.getAllTabs = () => [focused]
    return tab
}

function createSettingsFixture (options: {
    activeTab?: unknown
    confirm?: boolean
    resolver?: ConnectionIdentityResolver
    structuralConfig?: boolean | 'throw-capacity'
    tracker?: ActiveTerminalTracker
    tabs?: unknown[]
} = {}) {
    const initial = cloneDefaults()
    const config = options.structuralConfig ? structuralConfig(initial, options.structuralConfig === 'throw-capacity') : {
        store: { cmdHistory: initial },
        save: jest.fn(async () => undefined),
    }
    const activeTab = options.activeTab === undefined ? terminal() : options.activeTab
    const app = {
        activeTab,
        tabs: options.tabs ?? (activeTab ? [activeTab] : []),
    }
    const platform = {
        showMessageBox: jest.fn(async () => ({ response: options.confirm === false ? 0 : 1 })),
    }
    const history = { clear: jest.fn(async () => undefined) }
    const resolver = options.resolver ?? new ConnectionIdentityResolver()
    const tracker = options.tracker ?? new ActiveTerminalTracker()
    const component = new CommandHistorySettingsTabComponent(
        config as any,
        app as any,
        platform as any,
        resolver,
        history as any,
        tracker,
    )
    return { app, component, config, history, initial, platform, resolver, tracker }
}

function structuralConfig (initial: ReturnType<typeof cloneDefaults>, throwOnCapacity = false): {
    store: { cmdHistory: ReturnType<typeof cloneDefaults> }
    save: jest.Mock<Promise<void>, []>
} {
    const weights = { ...initial.weights }
    const bindings = { ...initial.bindings }
    const cmdHistory = { ...initial } as Record<string, unknown>
    Object.defineProperties(cmdHistory, {
        weights: { enumerable: true, get: () => weights },
        bindings: { enumerable: true, get: () => bindings },
    })
    if (throwOnCapacity) {
        let capacity = initial.capacity
        let shouldThrow = true
        Object.defineProperty(cmdHistory, 'capacity', {
            enumerable: true,
            get: () => capacity,
            set: value => {
                if (shouldThrow && value !== initial.capacity) {
                    shouldThrow = false
                    throw new Error('private leaf failure')
                }
                capacity = value as number
            },
        })
    }
    const store = {} as { cmdHistory: ReturnType<typeof cloneDefaults> }
    Object.defineProperty(store, 'cmdHistory', { enumerable: true, get: () => cmdHistory })
    return {
        store,
        save: jest.fn(async () => undefined),
    }
}

describe('CommandHistorySettingsTabComponent', () => {
    test('starts with a deep independent clone of the current config', () => {
        const fixture = createSettingsFixture()
        expect(fixture.component.draft).toEqual(fixture.config.store.cmdHistory)
        expect(fixture.component.draft).not.toBe(fixture.config.store.cmdHistory)
        expect(fixture.component.draft.weights).not.toBe(fixture.config.store.cmdHistory.weights)
        expect(fixture.component.draft.bindings).not.toBe(fixture.config.store.cmdHistory.bindings)
        expect(fixture.component.draft.exclusionPatterns).not.toBe(fixture.config.store.cmdHistory.exclusionPatterns)

        fixture.component.draft.weights.recency = 99
        fixture.component.draft.bindings.accept = 'Escape'
        fixture.component.exclusionText = '^private$'
        expect(fixture.config.store.cmdHistory).toEqual(fixture.initial)
    })

    test('saves normalized weights and replaces config only after validation', async () => {
        const fixture = createSettingsFixture()
        fixture.component.draft.presentation = 'inline'
        fixture.component.draft.weights = { recency: 55, frequency: 30, matchCloseness: 15 }
        fixture.component.exclusionText = '\n ^secret$ \n\n foo '

        await fixture.component.save()

        expect(fixture.config.store.cmdHistory).toMatchObject({
            presentation: 'inline',
            weights: { recency: 0.55, frequency: 0.3, matchCloseness: 0.15 },
            exclusionPatterns: ['^secret$', 'foo'],
        })
        expect(fixture.config.store.cmdHistory).not.toBe(fixture.component.draft)
        expect(fixture.config.save).toHaveBeenCalledTimes(1)
        expect(fixture.component.validationError).toBe('')
    })

    test('saves every leaf in place through a getter-only structural ConfigProxy', async () => {
        const fixture = createSettingsFixture({ structuralConfig: true })
        const root = fixture.config.store.cmdHistory as ReturnType<typeof cloneDefaults>
        const weights = root.weights
        const bindings = root.bindings
        fixture.component.draft = {
            enabled: false,
            presentation: 'hybrid',
            maxVisible: 7,
            minQueryLength: 2,
            caseSensitive: true,
            capacity: 123,
            captureMode: 'permissive',
            sensitiveFiltering: false,
            exclusionPatterns: ['stale'],
            weights: { recency: 2, frequency: 3, matchCloseness: 5 },
            bindings: {
                previous: 'Ctrl+ArrowUp',
                next: 'Ctrl+ArrowDown',
                accept: 'Ctrl+ArrowRight',
                dismiss: 'Escape',
            },
            dataRoot: null,
        }
        fixture.component.exclusionText = '^private$\nsecret'

        await fixture.component.save()

        expect(fixture.config.store.cmdHistory).toBe(root)
        expect(root.weights).toBe(weights)
        expect(root.bindings).toBe(bindings)
        expect(root).toEqual({
            ...fixture.component.draft,
            exclusionPatterns: ['^private$', 'secret'],
            weights: { recency: 0.2, frequency: 0.3, matchCloseness: 0.5 },
        })
        expect(root.exclusionPatterns).not.toBe(fixture.component.draft.exclusionPatterns)
        expect(fixture.config.save).toHaveBeenCalledTimes(1)
    })

    test('restores structural ConfigProxy leaves when persistence fails', async () => {
        const fixture = createSettingsFixture({ structuralConfig: true })
        const root = fixture.config.store.cmdHistory as ReturnType<typeof cloneDefaults>
        const before = cloneDefaults()
        fixture.component.draft.presentation = 'inline'
        fixture.component.draft.weights = { recency: 1, frequency: 1, matchCloseness: 2 }
        fixture.component.draft.exclusionPatterns = ['new']
        fixture.component.exclusionText = 'new'
        fixture.config.save.mockRejectedValueOnce(new Error('private config path'))

        await fixture.component.save()

        expect(fixture.config.store.cmdHistory).toBe(root)
        expect(root).toEqual(before)
        expect(fixture.component.validationError).toBe('Unable to save command history settings.')
        expect(fixture.component.validationError).not.toContain('private')
    })

    test('best-effort restores earlier ConfigProxy leaves when a leaf assignment fails', async () => {
        const fixture = createSettingsFixture({ structuralConfig: 'throw-capacity' })
        const root = fixture.config.store.cmdHistory as ReturnType<typeof cloneDefaults>
        const before = cloneDefaults()
        fixture.component.draft.enabled = false
        fixture.component.draft.presentation = 'hybrid'
        fixture.component.draft.capacity = 123

        await fixture.component.save()

        expect(root).toEqual(before)
        expect(fixture.config.save).not.toHaveBeenCalled()
        expect(fixture.component.validationError).toBe('Unable to save command history settings.')
    })

    test('does not save or expose an invalid exclusion expression', async () => {
        const fixture = createSettingsFixture()
        fixture.component.exclusionText = '[sensitive-pattern'

        await fixture.component.save()

        expect(fixture.component.validationError).toBe('Invalid exclusion pattern.')
        expect(fixture.component.validationError).not.toContain('sensitive-pattern')
        expect(fixture.config.store.cmdHistory).toBe(fixture.initial)
        expect(fixture.config.save).not.toHaveBeenCalled()
    })

    test('saves a Unicode property exclusion accepted by the runtime filter', async () => {
        const fixture = createSettingsFixture()
        fixture.component.exclusionText = '^\\p{L}+$'

        await fixture.component.save()

        expect(fixture.config.store.cmdHistory.exclusionPatterns).toEqual(['^\\p{L}+$'])
        expect(fixture.config.save).toHaveBeenCalledTimes(1)
    })

    test.each([
        ['range', (draft: any) => { draft.capacity = 0 }],
        ['weight', (draft: any) => { draft.weights.recency = -1 }],
        ['weight total', (draft: any) => { draft.weights = { recency: 0, frequency: 0, matchCloseness: 0 } }],
        ['binding', (draft: any) => { draft.bindings.accept = 'NotAHistoryKey' }],
        ['presentation', (draft: any) => { draft.presentation = 'grid' }],
        ['capture mode', (draft: any) => { draft.captureMode = 'unsafe' }],
    ])('keeps config untouched for an invalid %s', async (_name, makeInvalid) => {
        const fixture = createSettingsFixture()
        makeInvalid(fixture.component.draft)

        await fixture.component.save()

        expect(fixture.component.validationError).toBeTruthy()
        expect(fixture.config.store.cmdHistory).toBe(fixture.initial)
        expect(fixture.config.store.cmdHistory).toEqual(cloneDefaults())
        expect(fixture.config.save).not.toHaveBeenCalled()
    })

    test('restores the previous config when persistence fails', async () => {
        const fixture = createSettingsFixture()
        fixture.component.draft.presentation = 'inline'
        fixture.config.save.mockRejectedValueOnce(new Error('disk path'))

        await fixture.component.save()

        expect(fixture.config.store.cmdHistory).toBe(fixture.initial)
        expect(fixture.component.validationError).toBe('Unable to save command history settings.')
    })

    test('normalizes an in-home data root and explains restart', async () => {
        const fixture = createSettingsFixture()
        fixture.component.draft.dataRoot = `  ${resolve(homedir(), 'cmd-history', '..', 'cmd-history-data')}  `

        await fixture.component.save()

        expect(fixture.config.store.cmdHistory.dataRoot).toBe(resolve(homedir(), 'cmd-history-data'))
        expect(fixture.component.actionMessage).toContain('Restart Tabby')
    })

    test('rejects a relative data root without leaking it or changing config', async () => {
        const fixture = createSettingsFixture()
        fixture.component.draft.dataRoot = 'relative/secret-token'

        await fixture.component.save()

        expect(fixture.component.validationError).toBe('Data directory must be an absolute path inside the user home directory.')
        expect(fixture.component.validationError).not.toContain('secret-token')
        expect(fixture.config.store.cmdHistory).toBe(fixture.initial)
        expect(fixture.config.save).not.toHaveBeenCalled()
    })

    test('clears only the active connection after exact confirmation', async () => {
        const active = terminal({ id: 'a', type: 'ssh', name: 'Production', options: {} })
        const fixture = createSettingsFixture({ activeTab: active })
        const expected = fixture.resolver.resolve(active.profile, active)

        await fixture.component.clearActiveConnection()

        expect(fixture.platform.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
            type: 'warning',
            buttons: ['Cancel', 'Clear'],
            defaultId: 0,
            cancelId: 0,
        }))
        expect(fixture.history.clear).toHaveBeenCalledTimes(1)
        expect(fixture.history.clear).toHaveBeenCalledWith(expected)
    })

    test('uses the focused terminal inside an active split pane', async () => {
        const unfocused = terminal({ id: 'a', type: 'local', name: 'A', options: {} })
        const focused = terminal({ id: 'b', type: 'local', name: 'B', options: {} })
        const fixture = createSettingsFixture({ activeTab: split(focused) })
        const expected = fixture.resolver.resolve(focused.profile, focused)

        await fixture.component.clearActiveConnection()

        expect(fixture.history.clear).toHaveBeenCalledWith(expected)
        expect(fixture.history.clear).not.toHaveBeenCalledWith(
            fixture.resolver.resolve(unfocused.profile, unfocused),
        )
    })

    test('clears the last focused open terminal after entering Settings', async () => {
        const tracked = terminal({ id: 'tracked', type: 'local', name: 'Tracked', options: {} })
        const tracker = new ActiveTerminalTracker()
        tracker.track(tracked)
        ;(tracked.focused$ as Subject<void>).next()
        const fixture = createSettingsFixture({ activeTab: {}, tabs: [tracked], tracker })

        await fixture.component.clearActiveConnection()

        expect(fixture.history.clear).toHaveBeenCalledWith(fixture.resolver.resolve(tracked.profile, tracked))
    })

    test('uses the most recently focused pane from an open split', async () => {
        const first = terminal({ id: 'first', type: 'local', name: 'First', options: {} })
        const second = terminal({ id: 'second', type: 'local', name: 'Second', options: {} })
        const tracker = new ActiveTerminalTracker()
        tracker.track(first)
        tracker.track(second)
        ;(first.focused$ as Subject<void>).next()
        ;(second.focused$ as Subject<void>).next()
        const openSplit = split(second)
        openSplit.getAllTabs = () => [first, second]
        const fixture = createSettingsFixture({ activeTab: {}, tabs: [openSplit], tracker })

        await fixture.component.clearActiveConnection()

        expect(fixture.history.clear).toHaveBeenCalledWith(fixture.resolver.resolve(second.profile, second))
    })

    test('disables clear when the tracked terminal is no longer in the open tab tree', async () => {
        const tracked = terminal()
        const tracker = new ActiveTerminalTracker()
        tracker.track(tracked)
        ;(tracked.focused$ as Subject<void>).next()
        const fixture = createSettingsFixture({ activeTab: {}, tabs: [], tracker })

        expect(fixture.component.canClearCurrentConnection).toBe(false)
        await fixture.component.clearActiveConnection()

        expect(fixture.history.clear).not.toHaveBeenCalled()
    })

    test('does not clear when the terminal closes during confirmation', async () => {
        const active = terminal()
        const fixture = createSettingsFixture({ activeTab: active, tabs: [active] })
        let confirm!: (result: { response: number }) => void
        fixture.platform.showMessageBox.mockReturnValueOnce(new Promise(resolve => { confirm = resolve }))

        const clearing = fixture.component.clearActiveConnection()
        fixture.app.tabs = []
        confirm({ response: 1 })
        await clearing

        expect(fixture.history.clear).not.toHaveBeenCalled()
        expect(fixture.component.actionMessage).toBe('No active terminal connection is available.')
    })

    test('does not clear after cancellation', async () => {
        const fixture = createSettingsFixture({ confirm: false })
        await fixture.component.clearActiveConnection()
        expect(fixture.history.clear).not.toHaveBeenCalled()
        expect(fixture.component.actionMessage).toBe('Clear cancelled.')
    })

    test('disables clear and reports safely when no terminal is active', async () => {
        const fixture = createSettingsFixture({ activeTab: null })
        expect(fixture.component.canClearCurrentConnection).toBe(false)
        await fixture.component.clearActiveConnection()
        expect(fixture.platform.showMessageBox).not.toHaveBeenCalled()
        expect(fixture.history.clear).not.toHaveBeenCalled()
        expect(fixture.component.actionMessage).toBe('No active terminal connection is available.')
    })

    test('handles confirmation and clear errors without clearing another identity', async () => {
        const fixture = createSettingsFixture()
        fixture.platform.showMessageBox.mockRejectedValueOnce(new Error('secret path'))
        await fixture.component.clearActiveConnection()
        expect(fixture.history.clear).not.toHaveBeenCalled()
        expect(fixture.component.actionMessage).toBe('Unable to clear command history.')

        fixture.platform.showMessageBox.mockResolvedValueOnce({ response: 1 })
        fixture.history.clear.mockRejectedValueOnce(new Error('private command'))
        await fixture.component.clearActiveConnection()
        expect(fixture.history.clear).toHaveBeenCalledTimes(1)
        expect(fixture.component.actionMessage).toBe('Unable to clear command history.')
    })
})

describe('CommandHistorySettingsTabProvider', () => {
    test('exposes the approved settings metadata and component', () => {
        const provider = new CommandHistorySettingsTabProvider()
        expect(provider).toMatchObject({
            id: 'cmd-history',
            icon: 'fas fa-history',
            title: 'Command history',
            weight: 20,
        })
        expect(provider.getComponentType()).toBe(CommandHistorySettingsTabComponent)
    })

    test('module declares the component, imports forms, and multi-registers the provider', () => {
        const moduleDef = (CommandHistoryModule as any).ɵmod
        const injectorDef = (CommandHistoryModule as any).ɵinj
        expect(moduleDef.declarations).toContain(CommandHistorySettingsTabComponent)
        expect(moduleDef.imports).toEqual(expect.arrayContaining([CommonModule, FormsModule]))
        expect(injectorDef.providers).toContainEqual({
            provide: SettingsTabProvider,
            useClass: CommandHistorySettingsTabProvider,
            multi: true,
        })
    })

    test('module falls back to the default root for unsafe legacy config without leaking it', () => {
        const injectorDef = (CommandHistoryModule as any).ɵinj
        const repositoryProvider = injectorDef.providers.find((provider: any) => provider.provide === JsonlHistoryRepository)
        const warn = jest.fn()
        const repository = repositoryProvider.useFactory(
            { store: { cmdHistory: { dataRoot: '../../secret-token' } } },
            { create: () => ({ warn }) },
        )

        expect((repository as any).root).toBe(resolveDefaultDataRoot(process.platform, process.env, homedir()))
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn.mock.calls.flat().join(' ')).not.toContain('secret-token')
    })
})

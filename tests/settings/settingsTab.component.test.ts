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
import { DEFAULT_COMMAND_HISTORY_CONFIG } from '../../src/config/historyConfig'
import { ConnectionIdentityResolver } from '../../src/history/connectionIdentity'
import { CommandHistorySettingsTabComponent } from '../../src/settings/settingsTab.component'
import { CommandHistorySettingsTabProvider } from '../../src/settings/settingsTabProvider'
import CommandHistoryModule from '../../src/index'
import { SplitTabComponent } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { BaseTerminalTabComponent } from 'tabby-terminal'

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
    return tab
}

function split (focused: BaseTerminalTabComponent<any>): SplitTabComponent {
    const tab = Object.create(SplitTabComponent.prototype) as SplitTabComponent
    tab.getFocusedTab = () => focused
    return tab
}

function createSettingsFixture (options: {
    activeTab?: unknown
    confirm?: boolean
    resolver?: ConnectionIdentityResolver
} = {}) {
    const initial = cloneDefaults()
    const config = {
        store: { cmdHistory: initial },
        save: jest.fn(async () => undefined),
    }
    const app = { activeTab: options.activeTab === undefined ? terminal() : options.activeTab }
    const platform = {
        showMessageBox: jest.fn(async () => ({ response: options.confirm === false ? 0 : 1 })),
    }
    const history = { clear: jest.fn(async () => undefined) }
    const resolver = options.resolver ?? new ConnectionIdentityResolver()
    const component = new CommandHistorySettingsTabComponent(
        config as any,
        app as any,
        platform as any,
        resolver,
        history as any,
    )
    return { app, component, config, history, initial, platform, resolver }
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

    test('does not save or expose an invalid exclusion expression', async () => {
        const fixture = createSettingsFixture()
        fixture.component.exclusionText = '[sensitive-pattern'

        await fixture.component.save()

        expect(fixture.component.validationError).toBe('Invalid exclusion pattern.')
        expect(fixture.component.validationError).not.toContain('sensitive-pattern')
        expect(fixture.config.store.cmdHistory).toBe(fixture.initial)
        expect(fixture.config.save).not.toHaveBeenCalled()
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
})

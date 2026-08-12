import { Component } from '@angular/core'
import { homedir } from 'node:os'
import { AppService, ConfigService, PlatformService, SplitTabComponent } from 'tabby-core'
import { BaseTerminalProfile, BaseTerminalTabComponent } from 'tabby-terminal'
import {
    CommandHistoryConfig,
    DEFAULT_COMMAND_HISTORY_CONFIG,
    HistoryKeyName,
    validateHistoryConfig,
} from '../config/historyConfig'
import { compileExclusionPatterns } from '../history/commandPolicy'
import {
    ConnectionIdentityResolver,
    normalizeHistoryDataRoot,
    ProfileLike,
} from '../history/connectionIdentity'
import { HistoryService } from '../history/historyService'
import { ConnectionIdentity } from '../history/types'
import { ActiveTerminalTracker } from '../terminal/activeTerminalTracker'

if (process.env.NODE_ENV !== 'test') {
    // Webpack bundles the settings stylesheet; Jest exercises the component contract without loading Sass.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('./settingsTab.component.scss')
}

const template = process.env.NODE_ENV === 'test'
    ? ''
    // pug-loader returns a render function.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    : require('./settingsTab.component.pug')()

interface ActiveConnection {
    identity: ConnectionIdentity
    terminal: BaseTerminalTabComponent<BaseTerminalProfile>
}

@Component({
    selector: 'cmd-history-settings',
    template,
})
export class CommandHistorySettingsTabComponent {
    readonly presentationModes = ['inline', 'list', 'hybrid'] as const
    readonly captureModes = ['strict', 'permissive'] as const
    readonly bindingOptions: readonly HistoryKeyName[] = [
        'ArrowUp',
        'ArrowDown',
        'ArrowRight',
        'Escape',
        'Ctrl+ArrowUp',
        'Ctrl+ArrowDown',
        'Ctrl+ArrowRight',
    ]

    draft: CommandHistoryConfig
    exclusionText: string
    validationError = ''
    actionMessage = ''
    saving = false
    clearing = false

    constructor (
        private readonly config: ConfigService,
        private readonly app: AppService,
        private readonly platform: PlatformService,
        private readonly identityResolver: ConnectionIdentityResolver,
        private readonly history: HistoryService,
        private readonly activeTerminalTracker: ActiveTerminalTracker,
    ) {
        this.draft = cloneConfig(this.currentConfig())
        this.exclusionText = this.draft.exclusionPatterns.join('\n')
    }

    get canClearCurrentConnection (): boolean {
        return !this.clearing && this.resolveActiveConnection() !== null
    }

    async save (): Promise<void> {
        if (this.saving) {
            return
        }
        this.validationError = ''
        this.actionMessage = ''

        let normalized: CommandHistoryConfig
        try {
            const exclusionPatterns = parseExclusionPatterns(this.exclusionText)
            compileExclusionPatterns(exclusionPatterns)
            normalized = validateHistoryConfig({
                ...cloneConfig(this.draft),
                exclusionPatterns,
                dataRoot: normalizeHistoryDataRoot(this.draft.dataRoot, process.platform, homedir()),
            })
        } catch (error) {
            this.validationError = isInvalidExclusionPatternError(error)
                ? 'Invalid exclusion pattern.'
                : safeValidationMessage(error)
            return
        }

        this.saving = true
        const previous = this.config.store.cmdHistory
        const installed = cloneConfig(normalized)
        this.config.store.cmdHistory = installed
        try {
            await this.config.save()
            this.draft = cloneConfig(installed)
            this.exclusionText = installed.exclusionPatterns.join('\n')
            this.actionMessage = 'Command history settings saved. Restart Tabby to apply data directory changes.'
        } catch {
            this.config.store.cmdHistory = previous
            this.validationError = 'Unable to save command history settings.'
        } finally {
            this.saving = false
        }
    }

    async clearActiveConnection (): Promise<void> {
        if (this.clearing) {
            return
        }
        this.actionMessage = ''
        const active = this.resolveActiveConnection()
        if (!active) {
            this.actionMessage = 'No active terminal connection is available.'
            return
        }

        this.clearing = true
        try {
            const result = await this.platform.showMessageBox({
                type: 'warning',
                message: `Clear command history for ${safeIdentityLabel(active.identity)}?`,
                detail: 'This clears only the focused terminal connection.',
                buttons: ['Cancel', 'Clear'],
                defaultId: 0,
                cancelId: 0,
            })
            if (result.response !== 1) {
                this.actionMessage = 'Clear cancelled.'
                return
            }
            if (!this.isOpen(active.terminal)) {
                this.actionMessage = 'No active terminal connection is available.'
                return
            }
            await this.history.clear(active.identity)
            this.actionMessage = 'Command history cleared for the focused connection.'
        } catch {
            this.actionMessage = 'Unable to clear command history.'
        } finally {
            this.clearing = false
        }
    }

    private currentConfig (): CommandHistoryConfig {
        const configured = this.config.store?.cmdHistory as Partial<CommandHistoryConfig> | undefined
        return {
            ...cloneConfig(DEFAULT_COMMAND_HISTORY_CONFIG),
            ...configured,
            weights: { ...DEFAULT_COMMAND_HISTORY_CONFIG.weights, ...configured?.weights },
            bindings: { ...DEFAULT_COMMAND_HISTORY_CONFIG.bindings, ...configured?.bindings },
            exclusionPatterns: [...(configured?.exclusionPatterns ?? DEFAULT_COMMAND_HISTORY_CONFIG.exclusionPatterns)],
        }
    }

    private resolveActiveConnection (): ActiveConnection | null {
        try {
            const active = activeTerminalFrom(this.app.activeTab) ?? this.activeTerminalTracker.lastFocused
            if (!active || !this.isOpen(active) || !isProfileLike(active.profile)) {
                return null
            }
            return {
                identity: this.identityResolver.resolve(active.profile as ProfileLike, active),
                terminal: active as BaseTerminalTabComponent<BaseTerminalProfile>,
            }
        } catch {
            return null
        }
    }

    private isOpen (terminal: BaseTerminalTabComponent<BaseTerminalProfile>): boolean {
        return this.app.tabs.some(tab => tab === terminal ||
            (tab instanceof SplitTabComponent && tab.getAllTabs().includes(terminal)))
    }
}

function cloneConfig (config: Readonly<CommandHistoryConfig>): CommandHistoryConfig {
    return {
        ...config,
        exclusionPatterns: [...config.exclusionPatterns],
        weights: { ...config.weights },
        bindings: { ...config.bindings },
    }
}

function parseExclusionPatterns (text: string): string[] {
    return text.split(/\r?\n/u).map(pattern => pattern.trim()).filter(Boolean)
}

function safeValidationMessage (error: unknown): string {
    if (!(error instanceof Error)) {
        return 'Invalid command history settings.'
    }
    if (/^(?:maxVisible|minQueryLength|capacity) must be/u.test(error.message)) {
        return error.message
    }
    if (/^(?:Weights|Command history binding|Ctrl\+C|Printable character)/u.test(error.message)) {
        return error.message
    }
    if (error.message === 'Data directory must be an absolute path inside the user home directory') {
        return `${error.message}.`
    }
    return 'Invalid command history settings.'
}

function isInvalidExclusionPatternError (error: unknown): boolean {
    return error instanceof Error && error.message === 'Invalid exclusion pattern'
}

function safeIdentityLabel (identity: ConnectionIdentity): string {
    const label = identity.label.replace(/[\u0000-\u001F\u007F]/gu, ' ').trim()
    return label && label.length <= 80 ? label : (identity.persistent ? 'Saved connection' : 'Temporary terminal')
}

function isProfileLike (profile: unknown): profile is ProfileLike {
    return typeof profile === 'object' && profile !== null
}

function activeTerminalFrom (tab: unknown): BaseTerminalTabComponent<BaseTerminalProfile> | null {
    let active = tab
    while (active instanceof SplitTabComponent) {
        active = active.getFocusedTab()
    }
    return active instanceof BaseTerminalTabComponent ? active : null
}

import { ConfigService, LogService } from 'tabby-core'
import { BaseTerminalProfile, BaseTerminalTabComponent, TerminalDecorator } from 'tabby-terminal'
import { CommandHistoryConfig, DEFAULT_COMMAND_HISTORY_CONFIG } from '../config/historyConfig'
import { ConnectionIdentityResolver } from '../history/connectionIdentity'
import { HistoryService } from '../history/historyService'
import {
    CommandHistoryController,
    CommandHistoryControllerDependencies,
} from './commandHistoryController'
import { ActiveTerminalTracker } from './activeTerminalTracker'

export type CommandHistoryControllerFactory = (
    terminal: BaseTerminalTabComponent<BaseTerminalProfile>,
    dependencies: CommandHistoryControllerDependencies,
) => CommandHistoryController

export class CommandHistoryTerminalDecorator extends TerminalDecorator {
    private readonly controllers = new WeakMap<BaseTerminalTabComponent<BaseTerminalProfile>, CommandHistoryController>()

    constructor (
        private readonly configService: ConfigService,
        logService: LogService,
        history: HistoryService,
        identityResolver: ConnectionIdentityResolver,
        private readonly activeTerminalTracker: ActiveTerminalTracker,
        private readonly createController: CommandHistoryControllerFactory = (
            terminal,
            dependencies,
        ) => new CommandHistoryController(terminal, dependencies),
    ) {
        super()
        this.dependencies = {
            history,
            identityResolver,
            getConfig: () => this.currentConfig(),
            configChanged$: configService.changed$,
            logger: logService.create('cmd-history'),
        }
    }

    private readonly dependencies: CommandHistoryControllerDependencies

    override attach (terminal: BaseTerminalTabComponent<BaseTerminalProfile>): void {
        if (this.controllers.has(terminal)) {
            return
        }
        super.attach(terminal)
        try {
            if (!this.activeTerminalTracker.track(terminal)) {
                this.warnTracker('attach')
            }
        } catch {
            this.warnTracker('attach')
        }
        let controller: CommandHistoryController | undefined
        try {
            controller = this.createController(terminal, this.dependencies)
            this.controllers.set(terminal, controller)
            controller.attach()
        } catch (error) {
            this.controllers.delete(terminal)
            controller?.destroy()
            try {
                const detail = error instanceof Error ? ` err=${error.name}` : ''
                this.dependencies.logger.warn(`cmd-history stage=decorator-attach key=unresolved${detail}`)
            } catch {
                // Diagnostics must never interrupt terminal creation.
            }
        }
    }

    override detach (terminal: BaseTerminalTabComponent<BaseTerminalProfile>): void {
        try {
            this.activeTerminalTracker.untrack(terminal)
        } catch {
            this.warnTracker('detach')
        }
        const controller = this.controllers.get(terminal)
        if (controller) {
            this.controllers.delete(terminal)
            controller.destroy()
        }
        super.detach(terminal)
    }

    private warnTracker (stage: 'attach' | 'detach'): void {
        try {
            this.dependencies.logger.warn(`cmd-history stage=tracker-${stage} key=unresolved`)
        } catch {
            // Diagnostics must never interrupt terminal lifecycle.
        }
    }

    private currentConfig (): CommandHistoryConfig {
        return this.configService.store?.cmdHistory ?? {
            ...DEFAULT_COMMAND_HISTORY_CONFIG,
            exclusionPatterns: [...DEFAULT_COMMAND_HISTORY_CONFIG.exclusionPatterns],
            weights: { ...DEFAULT_COMMAND_HISTORY_CONFIG.weights },
            bindings: { ...DEFAULT_COMMAND_HISTORY_CONFIG.bindings },
        }
    }
}

import { CommonModule } from '@angular/common'
import { NgModule } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { homedir } from 'node:os'
import { ConfigProvider, ConfigService, LogService } from 'tabby-core'
import { TerminalDecorator } from 'tabby-terminal'
import { SettingsTabProvider } from 'tabby-settings'
import { CommandHistoryConfigProvider } from './config/configProvider'
import { DEFAULT_COMMAND_HISTORY_CONFIG } from './config/historyConfig'
import { SensitiveCommandFilter } from './history/commandPolicy'
import {
    ConnectionIdentityResolver,
    normalizeHistoryDataRoot,
    resolveDefaultDataRoot,
} from './history/connectionIdentity'
import { HistoryMatcher } from './history/historyMatcher'
import { HistoryService } from './history/historyService'
import { JsonlHistoryRepository } from './history/jsonlHistoryRepository'
import { CommandHistorySettingsTabComponent } from './settings/settingsTab.component'
import { CommandHistorySettingsTabProvider } from './settings/settingsTabProvider'
import { ActiveTerminalTracker } from './terminal/activeTerminalTracker'
import { CommandHistoryTerminalDecorator } from './terminal/commandHistoryDecorator'

@NgModule({
    imports: [CommonModule, FormsModule],
    declarations: [CommandHistorySettingsTabComponent],
    providers: [
        { provide: ConfigProvider, useClass: CommandHistoryConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: CommandHistorySettingsTabProvider, multi: true },
        ConnectionIdentityResolver,
        ActiveTerminalTracker,
        HistoryMatcher,
        {
            provide: JsonlHistoryRepository,
            useFactory: (config: ConfigService, log: LogService) => {
                const logger = log.create('cmd-history-storage')
                const defaultRoot = resolveDefaultDataRoot(
                    process.platform,
                    process.env,
                    homedir(),
                )
                let root = defaultRoot
                try {
                    root = normalizeHistoryDataRoot(
                        config.store?.cmdHistory?.dataRoot,
                        process.platform,
                        homedir(),
                    ) ?? defaultRoot
                } catch {
                    logger.warn('cmd-history data directory is invalid; using the default directory')
                }
                return new JsonlHistoryRepository(root, { warn: message => logger.warn(message) })
            },
            deps: [ConfigService, LogService],
        },
        {
            provide: SensitiveCommandFilter,
            useFactory: (config: ConfigService) => new SensitiveCommandFilter(
                config.store?.cmdHistory?.exclusionPatterns ?? DEFAULT_COMMAND_HISTORY_CONFIG.exclusionPatterns,
            ),
            deps: [ConfigService],
        },
        {
            provide: HistoryService,
            useFactory: (
                repository: JsonlHistoryRepository,
                matcher: HistoryMatcher,
                filter: SensitiveCommandFilter,
            ) => new HistoryService(repository, matcher, filter),
            deps: [JsonlHistoryRepository, HistoryMatcher, SensitiveCommandFilter],
        },
        {
            provide: TerminalDecorator,
            useFactory: (
                config: ConfigService,
                log: LogService,
                history: HistoryService,
                identityResolver: ConnectionIdentityResolver,
                activeTerminalTracker: ActiveTerminalTracker,
            ) => new CommandHistoryTerminalDecorator(config, log, history, identityResolver, activeTerminalTracker),
            deps: [ConfigService, LogService, HistoryService, ConnectionIdentityResolver, ActiveTerminalTracker],
            multi: true,
        },
    ],
})
export default class CommandHistoryModule {}

export * from './api'

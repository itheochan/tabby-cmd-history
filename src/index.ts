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
import { ConnectionIdentityResolver, resolveDefaultDataRoot } from './history/connectionIdentity'
import { HistoryMatcher } from './history/historyMatcher'
import { HistoryService } from './history/historyService'
import { JsonlHistoryRepository } from './history/jsonlHistoryRepository'
import { CommandHistoryTerminalDecorator } from './terminal/commandHistoryDecorator'
import { CommandHistorySettingsTabComponent } from './settings/settingsTab.component'
import { CommandHistorySettingsTabProvider } from './settings/settingsTabProvider'

@NgModule({
    imports: [CommonModule, FormsModule],
    declarations: [CommandHistorySettingsTabComponent],
    providers: [
        { provide: ConfigProvider, useClass: CommandHistoryConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: CommandHistorySettingsTabProvider, multi: true },
        ConnectionIdentityResolver,
        HistoryMatcher,
        {
            provide: JsonlHistoryRepository,
            useFactory: (config: ConfigService, log: LogService) => {
                const logger = log.create('cmd-history-storage')
                const root = config.store?.cmdHistory?.dataRoot ?? resolveDefaultDataRoot(
                    process.platform,
                    process.env,
                    homedir(),
                )
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
            ) => new CommandHistoryTerminalDecorator(config, log, history, identityResolver),
            deps: [ConfigService, LogService, HistoryService, ConnectionIdentityResolver],
            multi: true,
        },
    ],
})
export default class CommandHistoryModule {}

export * from './api'

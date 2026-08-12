import { ConfigProvider } from 'tabby-core'
import { DEFAULT_COMMAND_HISTORY_CONFIG } from './historyConfig'

export class CommandHistoryConfigProvider extends ConfigProvider {
    defaults = {
        cmdHistory: structuredClone(DEFAULT_COMMAND_HISTORY_CONFIG),
    }
}

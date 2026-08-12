import { ProfileLike } from './history/connectionIdentity'
import { ConnectionIdentity } from './history/types'

export interface ConnectionContext {
    identity: ConnectionIdentity
    profile: ProfileLike
}

export type { CommandCaptureAdapter, CommandCaptureHandle } from './terminal/captureAdapter'
export { CommandHistoryController } from './terminal/commandHistoryController'
export { CommandHistoryTerminalDecorator } from './terminal/commandHistoryDecorator'

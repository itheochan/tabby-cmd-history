import { Observable } from 'rxjs'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { ConnectionContext } from '../api'

export interface CommandCaptureAdapter {
    supports (context: ConnectionContext): boolean
    // The public extension contract intentionally accepts every Tabby terminal profile.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attach (terminal: BaseTerminalTabComponent<any>): Promise<CommandCaptureHandle>
}

export interface CommandCaptureHandle {
    finalCommand$: Observable<string>
    detach (): Promise<void>
}

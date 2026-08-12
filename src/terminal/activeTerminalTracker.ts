import { Subscription } from 'rxjs'
import { BaseTerminalProfile, BaseTerminalTabComponent } from 'tabby-terminal'

export class ActiveTerminalTracker {
    private readonly subscriptions = new Map<BaseTerminalTabComponent<BaseTerminalProfile>, Subscription>()
    private current: BaseTerminalTabComponent<BaseTerminalProfile> | null = null

    get lastFocused (): BaseTerminalTabComponent<BaseTerminalProfile> | null {
        return this.current
    }

    track (terminal: BaseTerminalTabComponent<BaseTerminalProfile>): void {
        if (this.subscriptions.has(terminal)) {
            return
        }
        const subscription = new Subscription()
        subscription.add(terminal.focused$.subscribe(() => { this.current = terminal }))
        subscription.add(terminal.destroyed$.subscribe(() => this.untrack(terminal)))
        this.subscriptions.set(terminal, subscription)
        if (terminal.hasFocus) {
            this.current = terminal
        }
    }

    untrack (terminal: BaseTerminalTabComponent<BaseTerminalProfile>): void {
        this.subscriptions.get(terminal)?.unsubscribe()
        this.subscriptions.delete(terminal)
        if (this.current === terminal) {
            this.current = null
        }
    }
}

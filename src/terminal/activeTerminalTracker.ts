import { Subscription } from 'rxjs'
import { BaseTerminalProfile, BaseTerminalTabComponent } from 'tabby-terminal'

export class ActiveTerminalTracker {
    private readonly subscriptions = new Map<BaseTerminalTabComponent<BaseTerminalProfile>, Subscription>()
    private current: BaseTerminalTabComponent<BaseTerminalProfile> | null = null

    get lastFocused (): BaseTerminalTabComponent<BaseTerminalProfile> | null {
        return this.current
    }

    track (terminal: BaseTerminalTabComponent<BaseTerminalProfile>): boolean {
        if (this.subscriptions.has(terminal)) {
            return true
        }
        const subscription = new Subscription()
        let committed = false
        let focusedBeforeCommit = false
        let destroyedBeforeCommit = false
        try {
            subscription.add(terminal.focused$.subscribe(() => {
                if (committed) {
                    this.current = terminal
                } else {
                    focusedBeforeCommit = true
                }
            }))
            subscription.add(terminal.destroyed$.subscribe(() => {
                if (committed) {
                    this.untrack(terminal)
                } else {
                    destroyedBeforeCommit = true
                }
            }))
            const hasFocus = terminal.hasFocus
            if (destroyedBeforeCommit) {
                subscription.unsubscribe()
                return false
            }
            this.subscriptions.set(terminal, subscription)
            committed = true
            if (hasFocus || focusedBeforeCommit) {
                this.current = terminal
            }
            return true
        } catch {
            try {
                subscription.unsubscribe()
            } catch {
                // Tracker cleanup must never interrupt terminal attachment.
            }
            return false
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

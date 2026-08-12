import { Observable, Subject, Subscription } from 'rxjs'

export class SessionMiddleware {
    protected outputToSession = new Subject<Buffer>()
    protected outputToTerminal = new Subject<Buffer>()

    get outputToSession$ (): Observable<Buffer> {
        return this.outputToSession
    }

    get outputToTerminal$ (): Observable<Buffer> {
        return this.outputToTerminal
    }

    feedFromSession (data: Buffer): void {
        this.outputToTerminal.next(data)
    }

    feedFromTerminal (data: Buffer): void {
        this.outputToSession.next(data)
    }

    close (): void {
        this.outputToSession.complete()
        this.outputToTerminal.complete()
    }
}

export class SessionMiddlewareStack extends SessionMiddleware {
    readonly entries: SessionMiddleware[] = []
    private links: Subscription[] = []

    push (middleware: SessionMiddleware): void {
        this.entries.push(middleware)
        this.relink()
    }

    unshift (middleware: SessionMiddleware): void {
        this.entries.unshift(middleware)
        this.relink()
    }

    remove (middleware: SessionMiddleware): void {
        const index = this.entries.indexOf(middleware)
        if (index >= 0) {
            this.entries.splice(index, 1)
            this.relink()
        }
    }

    override feedFromTerminal (data: Buffer): void {
        if (this.entries.length) {
            this.entries[0].feedFromTerminal(data)
        } else {
            super.feedFromTerminal(data)
        }
    }

    override close (): void {
        this.links.forEach(link => link.unsubscribe())
        this.links = []
        this.entries.forEach(entry => entry.close())
        super.close()
    }

    private relink (): void {
        this.links.forEach(link => link.unsubscribe())
        this.links = []
        this.entries.forEach((entry, index) => {
            this.links.push(entry.outputToSession$.subscribe(data => {
                const next = this.entries[index + 1]
                if (next) {
                    next.feedFromTerminal(data)
                } else {
                    this.outputToSession.next(data)
                }
            }))
        })
    }
}

export class BaseSession {
    readonly middleware = new SessionMiddlewareStack()
}

export class BaseTerminalTabComponent<P> {
    profile!: P
}

export class TerminalDecorator {
    private readonly subscriptions = new Map<object, Subscription[]>()

    attach (terminal: BaseTerminalTabComponent<unknown>): void { void terminal }

    detach (terminal: BaseTerminalTabComponent<unknown>): void {
        this.subscriptions.get(terminal)?.forEach(subscription => subscription.unsubscribe())
        this.subscriptions.delete(terminal)
    }

    protected subscribeUntilDetached (
        terminal: BaseTerminalTabComponent<unknown>,
        subscription?: Subscription,
    ): void {
        if (!subscription) {
            return
        }
        const subscriptions = this.subscriptions.get(terminal) ?? []
        subscriptions.push(subscription)
        this.subscriptions.set(terminal, subscriptions)
    }
}

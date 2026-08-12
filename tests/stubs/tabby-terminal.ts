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

    constructor () {
        super()
        this.push(new SessionMiddleware())
    }

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
        this.entries[this.entries.length - 1].feedFromTerminal(data)
    }

    override feedFromSession (data: Buffer): void {
        this.entries[0].feedFromSession(data)
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
        for (let index = 0; index < this.entries.length - 1; index++) {
            this.links.push(this.entries[index].outputToTerminal$.subscribe(data => {
                this.entries[index + 1].feedFromSession(data)
            }))
        }
        this.links.push(this.entries[this.entries.length - 1].outputToTerminal$.subscribe(data => {
            this.outputToTerminal.next(data)
        }))
        for (let index = this.entries.length - 2; index >= 0; index--) {
            this.links.push(this.entries[index + 1].outputToSession$.subscribe(data => {
                this.entries[index].feedFromTerminal(data)
            }))
        }
        this.links.push(this.entries[0].outputToSession$.subscribe(data => {
            this.outputToSession.next(data)
        }))
    }
}

export class BaseSession {
    readonly middleware = new SessionMiddlewareStack()
}

export class BaseTerminalTabComponent<P> {
    profile!: P
    title = ''
    hasFocus = false
    readonly focused$ = new Subject<void>()
    readonly destroyed$ = new Subject<void>()
    frontend?: {
        resize$: Observable<unknown>
        alternateScreenActive$: Observable<boolean>
    }

    get resize$ (): Observable<unknown> {
        if (!this.frontend) {
            throw new Error('Frontend not ready')
        }
        return this.frontend.resize$
    }

    get alternateScreenActive$ (): Observable<boolean> {
        if (!this.frontend) {
            throw new Error('Frontend not ready')
        }
        return this.frontend.alternateScreenActive$
    }
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

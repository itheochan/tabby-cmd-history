import { Observable, Subject } from 'rxjs'

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

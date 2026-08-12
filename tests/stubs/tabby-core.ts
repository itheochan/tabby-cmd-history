import { Observable, Subject } from 'rxjs'

export abstract class ConfigProvider {
    abstract defaults: Record<string, unknown>
}

export class ConfigService {
    store: Record<string, unknown> = {}
    private readonly changed = new Subject<void>()

    get changed$ (): Observable<void> {
        return this.changed
    }

    emitChange (): void {
        this.changed.next()
    }
}

export abstract class Logger {
    debug (...args: unknown[]): void { void args }
    info (...args: unknown[]): void { void args }
    warn (...args: unknown[]): void { void args }
    error (...args: unknown[]): void { void args }
    log (...args: unknown[]): void { void args }
}

export abstract class LogService {
    abstract create (name: string): Logger
}

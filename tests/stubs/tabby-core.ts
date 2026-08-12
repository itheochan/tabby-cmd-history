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

    async save (): Promise<void> {
        this.emitChange()
    }
}

export class AppService {
    activeTab: unknown = null
    tabs: unknown[] = []
}

export class SplitTabComponent {
    constructor (private readonly focusedTab: unknown = null, private readonly tabs: unknown[] = []) {}

    getFocusedTab (): unknown {
        return this.focusedTab
    }

    getAllTabs (): unknown[] {
        return this.tabs.length ? [...this.tabs] : (this.focusedTab ? [this.focusedTab] : [])
    }
}

export abstract class PlatformService {
    abstract showMessageBox (options: {
        type: 'warning' | 'error'
        message: string
        detail?: string
        buttons: string[]
        defaultId?: number
        cancelId?: number
    }): Promise<{ response: number }>
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

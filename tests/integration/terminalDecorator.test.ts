/* eslint-disable @typescript-eslint/no-explicit-any */
import { Subject } from 'rxjs'
import { DEFAULT_COMMAND_HISTORY_CONFIG } from '../../src/config/historyConfig'
import { CommandHistoryTerminalDecorator } from '../../src/terminal/commandHistoryDecorator'
import { SessionMiddleware, SessionMiddlewareStack } from 'tabby-terminal'

function createTerminal () {
    const host = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    host.append(screen)
    const session = { middleware: new SessionMiddlewareStack() as SessionMiddlewareStack & { entries: unknown[] } }
    return {
        profile: { id: 'saved', type: 'local', name: 'Local', options: {} },
        session,
        frontend: {
            contentUpdated$: new Subject<void>(),
            destroyed$: new Subject<void>(),
            resize$: new Subject<unknown>(),
            alternateScreenActive$: new Subject<boolean>(),
            supportsBracketedPaste: () => true,
            xterm: {
                cols: 80,
                rows: 24,
                buffer: { active: { cursorX: 0, cursorY: 0, baseY: 0, getLine: () => undefined } },
                onScroll: () => ({ dispose: jest.fn() }),
                onSelectionChange: () => ({ dispose: jest.fn() }),
            },
        },
        alternateScreenActive: false,
        element: { nativeElement: host },
        sessionChanged$: new Subject<unknown>(),
        frontendReady$: new Subject<void>(),
        get resize$ () {
            if (!this.frontend) {
                throw new Error('Frontend not ready')
            }
            return this.frontend.resize$
        },
        get alternateScreenActive$ () {
            if (!this.frontend) {
                throw new Error('Frontend not ready')
            }
            return this.frontend.alternateScreenActive$
        },
    }
}

function createDecorator () {
    const destroyed: object[] = []
    const history = { query: jest.fn(async () => []), record: jest.fn(async () => undefined) }
    const decorator = new CommandHistoryTerminalDecorator(
        {
            store: { cmdHistory: {
                ...DEFAULT_COMMAND_HISTORY_CONFIG,
                exclusionPatterns: [...DEFAULT_COMMAND_HISTORY_CONFIG.exclusionPatterns],
                weights: { ...DEFAULT_COMMAND_HISTORY_CONFIG.weights },
                bindings: { ...DEFAULT_COMMAND_HISTORY_CONFIG.bindings },
            } },
            changed$: new Subject<void>(),
        } as any,
        { create: () => ({ warn: jest.fn() }) } as any,
        history as any,
        { resolve: () => ({ key: 'b'.repeat(64), persistent: true, label: 'Saved' }) } as any,
        (terminal: any, dependencies: any) => {
            const controller = new (jest.requireActual('../../src/terminal/commandHistoryController').CommandHistoryController)(terminal, dependencies)
            const originalDestroy = controller.destroy.bind(controller)
            controller.destroy = () => {
                destroyed.push(terminal)
                originalDestroy()
            }
            return controller
        },
    )
    return { decorator, destroyed, history }
}

test('double attach creates one controller, middleware, and overlay', () => {
    const terminal = createTerminal()
    const { decorator } = createDecorator()
    decorator.attach(terminal as any)
    decorator.attach(terminal as any)
    expect(terminal.session.middleware.entries).toHaveLength(2)
    expect(terminal.element.nativeElement.querySelectorAll('.cmd-history-overlay')).toHaveLength(1)
})

test('detach is idempotent and destroys controller before calling the base lifecycle', () => {
    const terminal = createTerminal()
    const { decorator, destroyed } = createDecorator()
    decorator.attach(terminal as any)
    decorator.detach(terminal as any)
    decorator.detach(terminal as any)
    expect(destroyed).toEqual([terminal])
    expect(terminal.session.middleware.entries).toHaveLength(1)
    expect(terminal.element.nativeElement.querySelector('.cmd-history-overlay')).toBeNull()
})

test('attaches when session and frontend arrive after decorator attachment', () => {
    const terminal = createTerminal()
    const session = terminal.session
    const frontend = terminal.frontend
    ;(terminal as any).session = null
    ;(terminal as any).frontend = undefined
    const { decorator } = createDecorator()
    decorator.attach(terminal as any)
    expect(session.middleware.entries).toHaveLength(1)
    ;(terminal as any).frontend = frontend
    terminal.frontendReady$.next()
    ;(terminal as any).session = session
    terminal.sessionChanged$.next(session)
    expect(session.middleware.entries).toHaveLength(2)
})

test('controller construction failure leaves the terminal undecorated', () => {
    const terminal = createTerminal()
    const decorator = new CommandHistoryTerminalDecorator(
        { store: { cmdHistory: DEFAULT_COMMAND_HISTORY_CONFIG }, changed$: new Subject<void>() } as any,
        { create: () => ({ warn: jest.fn() }) } as any,
        { query: jest.fn(), record: jest.fn() } as any,
        { resolve: jest.fn() } as any,
        () => { throw new Error('controller unavailable') },
    )
    expect(() => decorator.attach(terminal as any)).not.toThrow()
    expect(terminal.session.middleware.entries).toHaveLength(1)
})

test('unshifted plugin participates in real terminal-input direction beside middleware', async () => {
    const terminal = createTerminal()
    const order: string[] = []
    class NeighborMiddleware extends SessionMiddleware {
        override feedFromTerminal (data: Buffer): void {
            order.push('neighbor')
            super.feedFromTerminal(data)
        }
    }
    terminal.session.middleware.push(new NeighborMiddleware())
    const bytes: Buffer[] = []
    terminal.session.middleware.outputToSession$.subscribe(data => bytes.push(Buffer.from(data)))
    const { decorator, history } = createDecorator()
    decorator.attach(terminal as any)
    expect(terminal.session.middleware.entries).toHaveLength(3)

    terminal.session.middleware.feedFromTerminal(Buffer.from('git'))
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['neighbor'])
    expect(history.query).toHaveBeenCalled()
    expect(Buffer.concat(bytes).toString()).toBe('git')

    decorator.detach(terminal as any)
    expect(terminal.session.middleware.entries).toHaveLength(2)
    terminal.session.middleware.feedFromTerminal(Buffer.from(' raw'))
    expect(Buffer.concat(bytes).toString()).toBe('git raw')
})

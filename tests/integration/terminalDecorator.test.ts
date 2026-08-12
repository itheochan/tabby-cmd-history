/* eslint-disable @typescript-eslint/no-explicit-any */
import { Subject } from 'rxjs'
import { DEFAULT_COMMAND_HISTORY_CONFIG } from '../../src/config/historyConfig'
import { CommandHistoryTerminalDecorator } from '../../src/terminal/commandHistoryDecorator'
import { SessionMiddlewareStack } from 'tabby-terminal'

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
        resize$: new Subject<unknown>(),
        alternateScreenActive$: new Subject<boolean>(),
    }
}

function createDecorator () {
    const destroyed: object[] = []
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
        { query: jest.fn(async () => []), record: jest.fn(async () => undefined) } as any,
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
    return { decorator, destroyed }
}

test('double attach creates one controller, middleware, and overlay', () => {
    const terminal = createTerminal()
    const { decorator } = createDecorator()
    decorator.attach(terminal as any)
    decorator.attach(terminal as any)
    expect(terminal.session.middleware.entries).toHaveLength(1)
    expect(terminal.element.nativeElement.querySelectorAll('.cmd-history-overlay')).toHaveLength(1)
})

test('detach is idempotent and destroys controller before calling the base lifecycle', () => {
    const terminal = createTerminal()
    const { decorator, destroyed } = createDecorator()
    decorator.attach(terminal as any)
    decorator.detach(terminal as any)
    decorator.detach(terminal as any)
    expect(destroyed).toEqual([terminal])
    expect(terminal.session.middleware.entries).toHaveLength(0)
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
    expect(session.middleware.entries).toHaveLength(0)
    ;(terminal as any).frontend = frontend
    terminal.frontendReady$.next()
    ;(terminal as any).session = session
    terminal.sessionChanged$.next(session)
    expect(session.middleware.entries).toHaveLength(1)
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
    expect(terminal.session.middleware.entries).toHaveLength(0)
})

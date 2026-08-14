import { Subject } from 'rxjs'
import { DEFAULT_COMMAND_HISTORY_CONFIG, CommandHistoryConfig } from '../../src/config/historyConfig'
import { SensitiveCommandFilter } from '../../src/history/commandPolicy'
import { HistoryMatcher } from '../../src/history/historyMatcher'
import { HistoryRepository, HistoryService } from '../../src/history/historyService'
import { Prediction } from '../../src/history/types'
import { TerminalGeometryAdapter } from '../../src/terminal/terminalGeometryAdapter'
import { PredictionOverlay } from '../../src/ui/predictionOverlay'
import {
    CommandHistoryController,
    CommandHistoryControllerDependencies,
} from '../../src/terminal/commandHistoryController'
import { SessionMiddlewareStack } from 'tabby-terminal'

const prediction = (command: string): Prediction => ({
    command,
    lastUsedAt: '2026-08-12T12:00:00Z',
    useCount: 1,
    matchKind: 'prefix',
    score: 1,
    matchIndex: 0,
})

function deferred<T> (): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
    return { promise, resolve }
}

class FakeSession {
    readonly middleware = new SessionMiddlewareStack() as SessionMiddlewareStack & { entries: unknown[] }
    readonly bytes: Buffer[] = []

    constructor () {
        this.middleware.outputToSession$.subscribe(data => this.bytes.push(Buffer.from(data)))
    }
}

interface FakeLine {
    isWrapped: boolean
    translateToString: (trimRight?: boolean) => string
}

class FakeFrontend {
    readonly contentUpdated$ = new Subject<void>()
    readonly destroyed$ = new Subject<void>()
    readonly resize$ = new Subject<{ columns: number; rows: number }>()
    readonly alternateScreenActive$ = new Subject<boolean>()
    bracketedPaste = true
    lines: FakeLine[] = [{ isWrapped: false, translateToString: () => '' }]
    xterm = {
        cols: 80,
        rows: 24,
        buffer: { active: {
            cursorX: 0,
            cursorY: 0,
            baseY: 0,
            getLine: (index: number): FakeLine | undefined => this.lines[index],
        } },
        onScroll: (handler: () => void) => { void handler; return { dispose: jest.fn() } },
        onSelectionChange: (handler: () => void) => { void handler; return { dispose: jest.fn() } },
    }

    supportsBracketedPaste (): boolean {
        return this.bracketedPaste
    }
}

class FakeTerminal {
    profile = { id: 'profile-1', type: 'local', name: 'PowerShell', options: {} }
    session: FakeSession | null = new FakeSession()
    frontend: FakeFrontend | undefined = new FakeFrontend()
    alternateScreenActive = false
    readonly sessionChanged$ = new Subject<FakeSession | null>()
    readonly frontendReady$ = new Subject<void>()
    readonly element = { nativeElement: document.createElement('div') }

    get resize$ (): Subject<{ columns: number; rows: number }> {
        if (!this.frontend) {
            throw new Error('Frontend not ready')
        }
        return this.frontend.resize$
    }

    get alternateScreenActive$ (): Subject<boolean> {
        if (!this.frontend) {
            throw new Error('Frontend not ready')
        }
        return this.frontend.alternateScreenActive$
    }

    constructor () {
        const screen = document.createElement('div')
        screen.className = 'xterm-screen'
        this.element.nativeElement.append(screen)
        jest.spyOn(this.element.nativeElement, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 800, 480))
        jest.spyOn(screen, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 800, 480))
    }

    send (data: string | Buffer): void {
        this.session?.middleware.feedFromTerminal(typeof data === 'string' ? Buffer.from(data) : data)
    }

    replaceSession (session: FakeSession | null): void {
        this.session = session
        this.sessionChanged$.next(session)
    }

    replaceFrontend (frontend: FakeFrontend | undefined): void {
        this.frontend = frontend
        if (frontend) {
            this.frontendReady$.next()
        }
    }

    emitAlternate (active: boolean): void {
        this.alternateScreenActive = active
        this.alternateScreenActive$.next(active)
    }
}

function rect (left: number, top: number, width: number, height: number): DOMRect {
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }
}

function config (): CommandHistoryConfig {
    return {
        ...DEFAULT_COMMAND_HISTORY_CONFIG,
        exclusionPatterns: [...DEFAULT_COMMAND_HISTORY_CONFIG.exclusionPatterns],
        weights: { ...DEFAULT_COMMAND_HISTORY_CONFIG.weights },
        bindings: { ...DEFAULT_COMMAND_HISTORY_CONFIG.bindings },
    }
}

function createFixture (
    commands: string[] = [],
    overrides: Partial<CommandHistoryControllerDependencies> = {},
    terminal = new FakeTerminal(),
) {
    let currentConfig = config()
    const changed$ = new Subject<void>()
    const logs: string[] = []
    const history = {
        query: jest.fn(async () => commands.map(prediction)),
        record: jest.fn(async () => undefined),
    }
    const dependencies: CommandHistoryControllerDependencies = {
        history,
        identityResolver: { resolve: jest.fn(() => ({ key: 'a'.repeat(64), persistent: true, label: 'Saved' })) },
        getConfig: () => currentConfig,
        configChanged$: changed$,
        logger: { warn: (...args: unknown[]) => logs.push(args.join(' ')) },
        now: () => new Date('2026-08-12T12:00:00Z'),
        ...overrides,
    }
    // The behavior fake intentionally supplies only the controller's public terminal surface.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const controller = new CommandHistoryController(terminal as any, dependencies)
    controller.attach()
    return {
        terminal,
        history,
        controller,
        logs,
        bytes: () => Buffer.concat(terminal.session?.bytes ?? []),
        changeConfig: (update: Partial<CommandHistoryConfig>) => {
            currentConfig = { ...currentConfig, ...update }
            changed$.next()
        },
    }
}

async function settle (): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
}

describe('CommandHistoryController', () => {
    afterEach(() => jest.useRealTimers())

    test('invalidates and requeries trusted input after a same-key history change', async () => {
        const changes$ = new Subject<string>()
        const history = {
            changes$,
            query: jest.fn()
                .mockResolvedValueOnce([prediction('git status')])
                .mockResolvedValueOnce([]),
            record: jest.fn(async () => undefined),
        }
        const fixture = createFixture([], { history })
        fixture.terminal.send('git')
        await settle()
        expect(fixture.controller.state().predictions).toHaveLength(1)

        changes$.next('a'.repeat(64))
        expect(fixture.controller.state().predictions).toEqual([])
        await settle()

        expect(history.query).toHaveBeenCalledTimes(2)
    })

    test('an initial history cache load does not trigger a feedback query', async () => {
        const repository = {
            updates$: new Subject<string>(),
            load: jest.fn(async () => []),
            record: jest.fn(async () => []),
            clear: jest.fn(async () => undefined),
        }
        const history = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))
        const query = jest.spyOn(history, 'query')
        const fixture = createFixture([], { history })

        fixture.terminal.send('git')
        await settle()

        expect(query).toHaveBeenCalledTimes(1)
    })

    test('ignores another identity change and unsubscribes on destroy', async () => {
        const changes$ = new Subject<string>()
        const history = {
            changes$,
            query: jest.fn(async () => [prediction('git status')]),
            record: jest.fn(async () => undefined),
        }
        const fixture = createFixture([], { history })
        fixture.terminal.send('git')
        await settle()

        changes$.next('b'.repeat(64))
        expect(fixture.controller.state().predictions).toHaveLength(1)
        expect(history.query).toHaveBeenCalledTimes(1)

        fixture.controller.destroy()
        changes$.next('a'.repeat(64))
        await settle()
        expect(history.query).toHaveBeenCalledTimes(1)
    })

    test('a stale same-key requery cannot restore cleared candidates', async () => {
        const changes$ = new Subject<string>()
        const stale = deferred<Prediction[]>()
        const history = {
            changes$,
            query: jest.fn()
                .mockResolvedValueOnce([prediction('git status')])
                .mockReturnValueOnce(stale.promise)
                .mockResolvedValueOnce([]),
            record: jest.fn(async () => undefined),
        }
        const fixture = createFixture([], { history })
        fixture.terminal.send('git')
        await settle()
        changes$.next('a'.repeat(64))
        changes$.next('a'.repeat(64))
        await settle()
        stale.resolve([prediction('stale command')])
        await settle()

        expect(fixture.controller.state().predictions).toEqual([])
        expect(history.query).toHaveBeenCalledTimes(3)
    })

    test('intercepts candidate keys only while predictions are active and accepts without Enter', async () => {
        const fixture = createFixture(['git checkout main', 'git cherry-pick a'])
        fixture.terminal.send('git ch')
        await settle()
        fixture.terminal.send('\x1b[B')
        fixture.terminal.send('\x1b[C')
        expect(fixture.bytes().toString()).toBe('git cherry-pick a')
        expect(fixture.bytes().includes(0x0d)).toBe(false)
        expect(fixture.controller.state().buffer.text).toBe('git cherry-pick a')

        fixture.terminal.send('\x1b[A')
        expect(fixture.bytes().subarray(-3)).toEqual(Buffer.from('\x1b[A'))
    })

    test('does not consume acceptance for an inline prediction with no visible remainder', async () => {
        const fixture = createFixture(['git'])
        fixture.changeConfig({ presentation: 'inline' })
        fixture.terminal.send('git')
        await settle()
        fixture.terminal.send('\x1b[C')
        expect(fixture.bytes()).toEqual(Buffer.from('git\x1b[C'))
    })

    test('Ctrl+C forwards exactly and synchronously resets active and running states', async () => {
        const fixture = createFixture(['danger command'])
        fixture.terminal.send('danger')
        await settle()
        fixture.terminal.send(Buffer.from([0x03]))
        expect(fixture.bytes().subarray(-1)).toEqual(Buffer.from([0x03]))
        expect(fixture.controller.state()).toMatchObject({
            buffer: { text: '', confident: true, dismissed: false },
            predictions: [],
            selectedIndex: 0,
        })

        fixture.terminal.send(Buffer.from([0x03]))
        expect(fixture.bytes().subarray(-2)).toEqual(Buffer.from([0x03, 0x03]))
    })

    test('Ctrl+C ends an in-progress bracketed paste and resets its captured text', () => {
        const fixture = createFixture()
        fixture.terminal.send('\x1b[200~partial')
        expect(fixture.controller.state().buffer.text).toBe('partial')
        fixture.terminal.send(Buffer.from([0x03]))
        expect(fixture.controller.state().buffer.text).toBe('')
        expect(fixture.bytes()).toEqual(Buffer.concat([
            Buffer.from('\x1b[200~partial'),
            Buffer.from([0x03]),
        ]))
        fixture.terminal.send('fresh')
        expect(fixture.controller.state().buffer.text).toBe('fresh')
    })

    test('a lone Escape follows the timeout path, collapses hybrid first, then dismisses', async () => {
        jest.useFakeTimers()
        const fixture = createFixture(['git checkout'])
        fixture.changeConfig({ presentation: 'hybrid' })
        fixture.terminal.send('git')
        await settle()
        fixture.terminal.send('\x1b[B')
        expect(fixture.controller.state().expanded).toBe(true)
        fixture.terminal.send(Buffer.from([0x1b]))
        jest.advanceTimersByTime(25)
        expect(fixture.controller.state().expanded).toBe(false)
        fixture.terminal.send(Buffer.from([0x1b]))
        jest.advanceTimersByTime(25)
        expect(fixture.controller.state().buffer.dismissed).toBe(true)
        expect(fixture.bytes().toString()).toBe('git')

        fixture.terminal.send('x')
        await settle()
        expect(fixture.controller.state().buffer.dismissed).toBe(false)
    })

    test('Tab and unknown sequences forward exactly, lose trust, and hide predictions', async () => {
        const fixture = createFixture(['git checkout'])
        fixture.terminal.send('git')
        await settle()
        fixture.terminal.send(Buffer.from([0x09]))
        const unknown = Buffer.from('\x1b[99~')
        fixture.terminal.send(unknown)
        expect(fixture.bytes()).toEqual(Buffer.concat([Buffer.from('git\t'), unknown]))
        expect(fixture.controller.state().buffer.confident).toBe(false)
        expect(fixture.controller.state().predictions).toEqual([])
    })

    test('Tab clears the cache so it cannot diverge from the rewritten line', async () => {
        const fixture = createFixture(['systemctl status'])
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'user@host:~$ systemctl stat' },
        ]
        fixture.terminal.send('systemctl stat')
        await settle()
        expect(fixture.controller.state().buffer).toMatchObject({ text: 'systemctl stat', confident: true })

        fixture.terminal.send(Buffer.from([0x09]))
        // The shell rewrote the visible line; the cache must not keep stale text.
        expect(fixture.controller.state().buffer).toMatchObject({ text: '', confident: false })
        expect(fixture.controller.state().predictions).toEqual([])
    })

    test('rebuilds the buffer and resumes predictions once the Tab completion arrives', async () => {
        const fixture = createFixture(['systemctl status mysvc.service', 'systemctl restart'])
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'user@host:~$ systemc' },
        ]
        fixture.terminal.send('systemc')
        await settle()
        expect(fixture.controller.state().predictions.map(item => item.command)).toEqual([
            'systemctl status mysvc.service',
            'systemctl restart',
        ])

        fixture.terminal.send(Buffer.from([0x09]))
        expect(fixture.controller.state().buffer.confident).toBe(false)
        expect(fixture.controller.state().predictions).toEqual([])

        // The shell's completion output rewrites the visible line and updates content.
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'user@host:~$ systemctl' },
        ]
        fixture.terminal.frontend!.contentUpdated$.next()
        await settle()
        expect(fixture.controller.state().buffer).toMatchObject({ text: 'systemctl', confident: true })
        expect(fixture.controller.state().predictions.map(item => item.command)).toEqual([
            'systemctl status mysvc.service',
            'systemctl restart',
        ])
    })

    test('re-trusts the buffer and resumes predictions after a no-output Tab via the settle timer', async () => {
        jest.useFakeTimers()
        const fixture = createFixture(['systemctl status'])
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'user@host:~$ systemc' },
        ]
        fixture.terminal.send('systemc')
        await settle()
        fixture.terminal.send(Buffer.from([0x09]))
        expect(fixture.controller.state().buffer.confident).toBe(false)

        jest.advanceTimersByTime(300)
        await settle()
        expect(fixture.controller.state().buffer).toMatchObject({ text: 'systemc', confident: true })
        expect(fixture.controller.state().predictions.map(item => item.command)).toEqual(['systemctl status'])
    })

    test('re-syncs the buffer when the completion arrives after an early rebuild', async () => {
        const fixture = createFixture(['systemctl status'])
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'user@host:~$ systemc' },
        ]
        fixture.terminal.send('systemc')
        await settle()
        fixture.terminal.send(Buffer.from([0x09]))

        // First content update still shows the pre-completion line (slow shell).
        fixture.terminal.frontend!.contentUpdated$.next()
        await settle()
        expect(fixture.controller.state().buffer).toMatchObject({ text: 'systemc', confident: true })

        // The completion output arrives later and rewrites the line.
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'user@host:~$ systemctl' },
        ]
        fixture.terminal.frontend!.contentUpdated$.next()
        await settle()
        expect(fixture.controller.state().buffer).toMatchObject({ text: 'systemctl', confident: true })
    })

    test('recovers and records a Tab-completed command continued by typing', async () => {
        const fixture = createFixture()
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'user@host:~$ systemctl stat' },
        ]
        fixture.terminal.send('systemctl stat')
        await settle()
        fixture.terminal.send(Buffer.from([0x09]))
        // Shell completion rewrites the line before the user continues.
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'user@host:~$ systemctl status ' },
        ]
        fixture.terminal.send('mysvc.service')
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'user@host:~$ systemctl status mysvc.service' },
        ]
        fixture.terminal.send(Buffer.from([0x0d]))
        await settle()
        expect(fixture.history.record).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'a'.repeat(64) }),
            'systemctl status mysvc.service',
            { trustworthy: true, visibleEcho: true },
            expect.anything(),
            expect.anything(),
        )
    })

    test('records a Tab-completed command even when Enter follows immediately', async () => {
        const fixture = createFixture()
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'user@host:~$ systemctl stat' },
        ]
        fixture.terminal.send('systemctl stat')
        await settle()
        fixture.terminal.send(Buffer.from([0x09]))
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'user@host:~$ systemctl status' },
        ]
        fixture.terminal.send(Buffer.from([0x0d]))
        await settle()
        expect(fixture.history.record).toHaveBeenCalledWith(
            expect.anything(),
            'systemctl status',
            { trustworthy: true, visibleEcho: true },
            expect.anything(),
            expect.anything(),
        )
    })

    test('does not record an untrusted submission when the line cannot be rebuilt', async () => {
        const fixture = createFixture()
        fixture.terminal.send('git')
        await settle()
        fixture.terminal.send(Buffer.from([0x09]))
        // No visible line carries the pre-rewrite anchor; recovery must fail closed.
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'user@host:~$ unrelated text' },
        ]
        fixture.terminal.send(Buffer.from([0x0d]))
        await settle()
        expect(fixture.history.record).not.toHaveBeenCalled()
    })

    test('a pager alternate-screen event does not cancel a just-submitted record', async () => {
        const fixture = createFixture()
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'user@host:~$ systemctl status mysvc.service' },
        ]
        fixture.terminal.send('systemctl status mysvc.service')
        fixture.terminal.send(Buffer.from([0x0d]))
        // systemctl status opens less immediately; the alternate event can arrive
        // before the record microtask drains.
        fixture.terminal.emitAlternate(true)
        await settle()
        fixture.terminal.emitAlternate(false)
        await settle()
        expect(fixture.history.record).toHaveBeenCalledWith(
            expect.anything(),
            'systemctl status mysvc.service',
            { trustworthy: true, visibleEcho: true },
            expect.anything(),
            expect.anything(),
        )
    })

    test('captures complete current cursor logical rows before forwarding Enter', async () => {
        const fixture = createFixture()
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'PS> echo vis' },
            { isWrapped: true, translateToString: () => 'ible' },
        ]
        fixture.terminal.frontend!.xterm.buffer.active.cursorY = 1
        fixture.terminal.send('echo visible')
        fixture.terminal.send(Buffer.from([0x0d]))
        await settle()
        expect(fixture.bytes()).toEqual(Buffer.from('echo visible\r'))
        expect(fixture.history.record).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'a'.repeat(64) }),
            'echo visible',
            { trustworthy: true, visibleEcho: true },
            expect.any(Object),
            expect.any(Date),
        )
        expect(fixture.controller.state().buffer.text).toBe('')
    })

    test('captures logical rows when the xterm getLine method requires its receiver', async () => {
        const fixture = createFixture()
        const lines = [
            { isWrapped: false, translateToString: () => 'PS> echo vis' },
            { isWrapped: true, translateToString: () => 'ible' },
        ]
        const active = {
            cursorX: 0,
            cursorY: 1,
            baseY: 0,
            lines,
            getLine (index: number) {
                // xterm's BufferApiView.getLine reads `this._buffer`; the fake enforces the same contract.
                return (this as typeof active).lines[index]
            },
        }
        fixture.terminal.frontend!.xterm.buffer.active = active as never
        fixture.terminal.send('echo visible')
        fixture.terminal.send(Buffer.from([0x0d]))
        await settle()
        expect(fixture.bytes()).toEqual(Buffer.from('echo visible\r'))
        expect(fixture.history.record).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'a'.repeat(64) }),
            'echo visible',
            { trustworthy: true, visibleEcho: true },
            expect.any(Object),
            expect.any(Date),
        )
        expect(fixture.controller.state().buffer.text).toBe('')
    })

    test('readConfig tolerates ConfigProxy internal members in stored values', async () => {
        const stored = {
            ...config(),
            presentation: 'inline',
            maxVisible: 3,
            weights: {
                ...config().weights,
                recency: 0.9,
                frequency: 0.05,
                matchCloseness: 0.05,
                __getValue: () => undefined,
                __setValue: () => undefined,
                __getDefault: () => undefined,
            },
            bindings: {
                ...config().bindings,
                previous: 'Ctrl+ArrowUp',
                __getValue: () => undefined,
                __setValue: () => undefined,
                __getDefault: () => undefined,
            },
        }
        const fixture = createFixture([], { getConfig: () => stored as unknown as CommandHistoryConfig })
        const state = fixture.controller.state()
        expect(state.config.presentation).toBe('inline')
        expect(state.config.maxVisible).toBe(3)
        expect(state.config.weights.recency).toBe(0.9)
        expect(state.config.bindings.previous).toBe('Ctrl+ArrowUp')
        expect(Object.values(state.config.bindings).some(value => typeof value === 'function')).toBe(false)
        expect(Object.values(state.config.weights).some(value => typeof value === 'function')).toBe(false)
    })

    test('Ctrl+C cancels an Enter record that has not started', async () => {
        const fixture = createFixture()
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'PS> echo queued' },
        ]
        fixture.terminal.send('echo queued')
        fixture.terminal.send('\r')
        fixture.terminal.send(Buffer.from([0x03]))
        await settle()
        expect(fixture.history.record).not.toHaveBeenCalled()
        expect(fixture.bytes()).toEqual(Buffer.from('echo queued\r\x03'))
    })

    test('fails strict echo closed instead of passing recent output', async () => {
        const fixture = createFixture()
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'echo hidden' },
            { isWrapped: false, translateToString: () => 'Password:' },
        ]
        fixture.terminal.frontend!.xterm.buffer.active.cursorY = 1
        fixture.terminal.send('hunter2')
        fixture.terminal.send('\r')
        await settle()
        expect(fixture.history.record).toHaveBeenCalledWith(
            expect.anything(),
            'hunter2',
            { trustworthy: true, visibleEcho: false },
            expect.anything(),
            expect.anything(),
        )
    })

    test('strict HistoryService rejects hidden input before repository persistence', async () => {
        const updates$ = new Subject<string>()
        const repository: HistoryRepository = {
            updates$,
            load: jest.fn(async () => []),
            record: jest.fn(async () => []),
            clear: jest.fn(async () => undefined),
        }
        const service = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))
        const fixture = createFixture([], { history: service })
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'Password:' },
        ]
        fixture.terminal.send('hunter2')
        fixture.terminal.send('\r')
        await settle()
        expect(repository.record).not.toHaveBeenCalled()
    })

    test('drops stale async query results after a newer edit', async () => {
        const fixture = createFixture()
        let resolveFirst!: (value: Prediction[]) => void
        fixture.history.query
            .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
            .mockResolvedValueOnce([prediction('git status')])
        fixture.terminal.send('g')
        fixture.terminal.send('i')
        await settle()
        expect(fixture.controller.state().predictions.map(item => item.command)).toEqual(['git status'])
        resolveFirst([prediction('gone stale')])
        await settle()
        expect(fixture.controller.state().predictions.map(item => item.command)).toEqual(['git status'])
    })

    test('clears active predictions synchronously while a newer text query is pending', async () => {
        const fixture = createFixture(['git checkout'])
        fixture.terminal.send('git')
        await settle()
        expect(fixture.controller.state().predictions.map(item => item.command)).toEqual(['git checkout'])

        let resolveCurrent!: (value: Prediction[]) => void
        fixture.history.query.mockImplementationOnce(() => new Promise(resolve => { resolveCurrent = resolve }))
        fixture.terminal.send('x')
        expect(fixture.controller.state().predictions).toEqual([])
        expect((fixture.terminal.element.nativeElement.querySelector('.cmd-history-overlay') as HTMLElement).hidden).toBe(true)

        await Promise.resolve()
        fixture.terminal.send('\x1b[C')
        expect(fixture.bytes()).toEqual(Buffer.from('gitx\x1b[C'))
        resolveCurrent([prediction('gitx result')])
        await settle()
        expect(fixture.controller.state().predictions.map(item => item.command)).toEqual(['gitx result'])
    })

    test('alternate screen and disabled config are raw pass-through and reset capture', async () => {
        const fixture = createFixture(['git status'])
        fixture.terminal.send('git')
        await settle()
        fixture.terminal.emitAlternate(true)
        fixture.terminal.send(':q')
        expect(fixture.controller.state().buffer.text).toBe('')
        expect(fixture.bytes().toString()).toBe('git:q')

        fixture.terminal.emitAlternate(false)
        fixture.changeConfig({ enabled: false })
        fixture.terminal.send('pwd')
        expect(fixture.controller.state().buffer.text).toBe('')
        expect(fixture.bytes().toString()).toBe('git:qpwd')
    })

    test('runtime mode, max results, and bindings update without restart', async () => {
        jest.useFakeTimers()
        const fixture = createFixture(['git one', 'git two'])
        fixture.terminal.send('git')
        await settle()
        fixture.changeConfig({
            presentation: 'inline',
            maxVisible: 1,
            bindings: { previous: 'ArrowDown', next: 'ArrowUp', accept: 'Escape', dismiss: 'ArrowRight' },
        })
        await settle()
        expect(fixture.controller.state().config).toMatchObject({ presentation: 'inline', maxVisible: 1 })
        fixture.terminal.send(Buffer.from([0x1b]))
        jest.advanceTimersByTime(25)
        expect(fixture.bytes().toString()).toBe('git one')
    })

    test('routes configured Ctrl+Arrow bindings while candidates are active', async () => {
        const fixture = createFixture(['git one', 'git two'])
        fixture.changeConfig({
            bindings: {
                previous: 'Ctrl+ArrowUp',
                next: 'Ctrl+ArrowDown',
                accept: 'Ctrl+ArrowRight',
                dismiss: 'Escape',
            },
        })
        fixture.terminal.send('git')
        await settle()
        fixture.terminal.send('\x1b[1;5B')
        fixture.terminal.send('\x1b[1;5C')
        expect(fixture.bytes().toString()).toBe('git two')
    })

    test('accept bound to Enter fills the candidate without executing, then Enter submits', async () => {
        const fixture = createFixture(['git checkout main', 'git cherry-pick a'])
        fixture.changeConfig({ bindings: { ...config().bindings, accept: 'Enter' } })
        fixture.terminal.send('git ch')
        await settle()

        fixture.terminal.send('\r')
        expect(fixture.bytes().toString()).toBe('git checkout main')
        expect(fixture.bytes().includes(0x0d)).toBe(false)
        expect(fixture.controller.state()).toMatchObject({
            buffer: { text: 'git checkout main', confident: true },
            predictions: [],
        })

        fixture.terminal.send('\r')
        expect(fixture.bytes().subarray(-1)).toEqual(Buffer.from([0x0d]))
        await settle()
        expect(fixture.history.record).toHaveBeenCalledWith(
            expect.anything(),
            'git checkout main',
            expect.anything(),
            expect.anything(),
            expect.anything(),
        )
    })

    test('accept bound to Enter submits normally when no candidate exists', async () => {
        const fixture = createFixture()
        fixture.changeConfig({ bindings: { ...config().bindings, accept: 'Enter' } })
        fixture.terminal.send('pwd\r')
        expect(fixture.bytes().toString()).toBe('pwd\r')
        await settle()
        expect(fixture.history.record).toHaveBeenCalledWith(
            expect.anything(),
            'pwd',
            expect.anything(),
            expect.anything(),
            expect.anything(),
        )
    })

    test('filters multiline candidates unless bracketed paste is supported', async () => {
        const fixture = createFixture(['echo one\necho two', 'echo safe'])
        fixture.terminal.frontend!.bracketedPaste = false
        fixture.terminal.send('echo')
        await settle()
        expect(fixture.controller.state().predictions.map(item => item.command)).toEqual(['echo safe'])

        fixture.controller.destroy()
        const supported = createFixture(['echo one\necho two'])
        supported.terminal.send('echo')
        await settle()
        supported.terminal.send('\x1b[C')
        expect(supported.bytes()).toEqual(Buffer.concat([
            Buffer.from('echo'),
            Buffer.from([0x7f, 0x7f, 0x7f, 0x7f]),
            Buffer.from('\x1b[200~echo one\necho two\x1b[201~'),
        ]))
        const pasteEnd = Buffer.from('\x1b[201~')
        expect(supported.bytes().subarray(-pasteEnd.length)).toEqual(pasteEnd)
    })

    test('session replacement closes and removes old middleware before attaching the new session', () => {
        const fixture = createFixture()
        const old = fixture.terminal.session!
        const replacement = new FakeSession()
        fixture.terminal.replaceSession(replacement)
        expect(old.middleware.entries).toHaveLength(1)
        expect(replacement.middleware.entries).toHaveLength(2)
        fixture.terminal.send('new')
        expect(Buffer.concat(replacement.bytes).toString()).toBe('new')
    })

    test('session replacement discards pending decoder state before resetting the new buffer', () => {
        jest.useFakeTimers()
        const fixture = createFixture()
        fixture.terminal.send(Buffer.from([0x1b]))
        fixture.terminal.replaceSession(new FakeSession())
        expect(fixture.controller.state().buffer).toMatchObject({ text: '', confident: true })
        jest.runOnlyPendingTimers()
        expect(fixture.controller.state().buffer).toMatchObject({ text: '', confident: true })
    })

    test('session replacement does not duplicate frontend subscriptions', () => {
        const fixture = createFixture()
        expect(fixture.terminal.frontend!.contentUpdated$.observers).toHaveLength(1)
        fixture.terminal.replaceSession(new FakeSession())
        expect(fixture.terminal.frontend!.contentUpdated$.observers).toHaveLength(1)
        fixture.controller.destroy()
        expect(fixture.terminal.frontend!.contentUpdated$.observers).toHaveLength(0)
    })

    test('stays raw until a delayed frontend arrives, then binds resize and alternate lifecycle', async () => {
        const terminal = new FakeTerminal()
        const frontend = terminal.frontend!
        terminal.frontend = undefined
        const measure = jest.fn(() => ({ left: 0, top: 20, above: false, maxWidth: 80, maxHeight: 40 }))
        const fixture = createFixture(['git status'], {
            geometry: { measure } as unknown as TerminalGeometryAdapter,
        }, terminal)

        terminal.send('raw')
        expect(fixture.bytes().toString()).toBe('raw')
        expect(fixture.controller.state().buffer.text).toBe('')

        terminal.replaceFrontend(frontend)
        terminal.send('git')
        await settle()
        expect(fixture.controller.state().predictions.map(item => item.command)).toEqual(['git status'])
        expect(measure).toHaveBeenCalledTimes(1)
        frontend.resize$.next({ columns: 100, rows: 30 })
        expect(measure).toHaveBeenCalledTimes(2)
        terminal.emitAlternate(true)
        terminal.send(':q')
        expect(fixture.controller.state().predictions).toEqual([])
        expect(fixture.bytes().toString()).toBe('rawgit:q')
        terminal.emitAlternate(false)
    })

    test('rebinds frontend lifecycle subscriptions when the frontend object changes', () => {
        const fixture = createFixture()
        const original = fixture.terminal.frontend!
        const replacement = new FakeFrontend()
        expect(original.resize$.observers).toHaveLength(1)
        expect(original.alternateScreenActive$.observers).toHaveLength(1)

        fixture.terminal.replaceFrontend(replacement)
        expect(original.contentUpdated$.observers).toHaveLength(0)
        expect(original.resize$.observers).toHaveLength(0)
        expect(original.alternateScreenActive$.observers).toHaveLength(0)
        expect(replacement.contentUpdated$.observers).toHaveLength(1)
        expect(replacement.resize$.observers).toHaveLength(1)
        expect(replacement.alternateScreenActive$.observers).toHaveLength(1)
    })

    test('callback failures remain fail-open and logs contain stage and key but no command', async () => {
        const fixture = createFixture()
        fixture.history.query.mockImplementation(() => {
            throw new Error('do-not-log-this')
        })
        fixture.terminal.send('do-not-log-this')
        await settle()
        fixture.terminal.send(Buffer.from([0x03]))
        expect(fixture.bytes()).toEqual(Buffer.concat([Buffer.from('do-not-log-this'), Buffer.from([0x03])]))
        expect(fixture.logs.join('\n')).toContain('query')
        expect(fixture.logs.join('\n')).not.toContain('do-not-log-this')
    })

    test('synchronous record failures are contained and command-free', async () => {
        const fixture = createFixture()
        fixture.history.record.mockImplementation(() => {
            throw new Error('echo do-not-log-this')
        })
        fixture.terminal.frontend!.lines = [
            { isWrapped: false, translateToString: () => 'PS> echo do-not-log-this' },
        ]
        fixture.terminal.send('echo do-not-log-this')
        fixture.terminal.send('\r')
        await settle()
        expect(fixture.bytes()).toEqual(Buffer.from('echo do-not-log-this\r'))
        expect(fixture.logs.join('\n')).toContain('record')
        expect(fixture.logs.join('\n')).not.toContain('echo do-not-log-this')
    })

    test('overlay callback failures hide candidates without blocking terminal input', async () => {
        const fixture = createFixture(['safe command'], {
            createOverlay: host => {
                const overlay = new PredictionOverlay(host)
                jest.spyOn(overlay, 'render').mockImplementation(() => {
                    throw new Error('safe command')
                })
                return overlay
            },
        })
        fixture.terminal.send('safe')
        await settle()
        expect(fixture.bytes().toString()).toBe('safe')
        expect(fixture.controller.state().predictions).toEqual([])
        expect(fixture.logs.join('\n')).toContain('overlay-render')
        expect(fixture.logs.join('\n')).not.toContain('safe command')
    })

    test('overlay factory failure keeps candidate shortcuts raw and command-free', async () => {
        const fixture = createFixture(['safe command'], {
            createOverlay: () => { throw new Error('safe command') },
        })
        fixture.terminal.send('safe')
        await settle()
        fixture.terminal.send('\x1b[A')
        fixture.terminal.send('\x1b[C')
        expect(fixture.controller.state().predictions).toEqual([])
        expect(fixture.bytes()).toEqual(Buffer.from('safe\x1b[A\x1b[C'))
        expect(fixture.terminal.element.nativeElement.querySelector('.cmd-history-overlay')).toBeNull()
        expect(fixture.logs.join('\n')).toContain('overlay-create')
        expect(fixture.logs.join('\n')).not.toContain('safe command')
    })

    test('geometry failure disables presentation and keeps candidate shortcuts raw', async () => {
        const fixture = createFixture(['safe command'], {
            geometry: {
                measure: () => { throw new Error('safe command') },
            } as TerminalGeometryAdapter,
        })
        fixture.terminal.send('safe')
        await settle()
        fixture.terminal.send('\x1b[A')
        fixture.terminal.send('\x1b[C')
        expect(fixture.controller.state().predictions).toEqual([])
        expect(fixture.bytes()).toEqual(Buffer.from('safe\x1b[A\x1b[C'))
        expect(fixture.terminal.element.nativeElement.querySelector('.cmd-history-overlay')).toBeNull()
        expect(fixture.logs.join('\n')).toContain('geometry-measure')
        expect(fixture.logs.join('\n')).not.toContain('safe command')
    })

    test('inline mode navigation skips contains matches', async () => {
        const history = {
            query: jest.fn(async () => [
                { ...prediction('git status'), matchKind: 'prefix' as const, matchIndex: 0 },
                { ...prediction('sudo git checkout'), matchKind: 'contains' as const, matchIndex: 5 },
            ]),
            record: jest.fn(async () => undefined),
        }
        const fixture = createFixture([], { history })
        fixture.changeConfig({ presentation: 'inline' })
        fixture.terminal.send('git')
        await settle()

        expect(fixture.terminal.element.nativeElement.querySelector('.cmd-history-ghost')?.textContent).toBe(' status')

        fixture.terminal.send('\x1b[B')
        expect(fixture.terminal.element.nativeElement.querySelector('.cmd-history-ghost')?.textContent).toBe(' status')
    })

    test('hybrid expanded list includes exact and contains matches', async () => {
        const history = {
            query: jest.fn(async () => [
                { ...prediction('git'), matchKind: 'prefix' as const, matchIndex: 0 },
                { ...prediction('sudo git status'), matchKind: 'contains' as const, matchIndex: 5 },
            ]),
            record: jest.fn(async () => undefined),
        }
        const fixture = createFixture([], { history })
        fixture.changeConfig({ presentation: 'hybrid' })
        fixture.terminal.send('git')
        await settle()

        expect(fixture.terminal.element.nativeElement.querySelector('.cmd-history-ghost')).toBeNull()

        fixture.terminal.send('\x1b[B')
        const options = Array.from(fixture.terminal.element.nativeElement.querySelectorAll('[role="option"]'))
        expect(options.map(option => option.textContent)).toEqual(['git', 'sudo git status'])
    })

    test('inline mode forwards navigation keys when no prefix candidate is visible', async () => {
        const history = {
            query: jest.fn(async () => [
                { ...prediction('sudo git checkout'), matchKind: 'contains' as const, matchIndex: 5 },
            ]),
            record: jest.fn(async () => undefined),
        }
        const fixture = createFixture([], { history })
        fixture.changeConfig({ presentation: 'inline' })
        fixture.terminal.send('git')
        await settle()

        expect(fixture.terminal.element.nativeElement.querySelector('.cmd-history-ghost')).toBeNull()
        fixture.terminal.send('\x1b[B')
        expect(fixture.bytes()).toEqual(Buffer.from('git\x1b[B'))
    })
})

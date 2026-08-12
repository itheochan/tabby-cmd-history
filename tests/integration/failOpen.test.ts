import { Subject } from 'rxjs'
import { SessionMiddlewareStack } from 'tabby-terminal'
import { DEFAULT_COMMAND_HISTORY_CONFIG } from '../../src/config/historyConfig'
import { SensitiveCommandFilter } from '../../src/history/commandPolicy'
import { HistoryMatcher } from '../../src/history/historyMatcher'
import { HistoryRepository, HistoryService } from '../../src/history/historyService'
import { HistoryEntry, Prediction } from '../../src/history/types'
import {
    CommandHistoryController,
    CommandHistoryControllerDependencies,
    ControllerHistoryService,
} from '../../src/terminal/commandHistoryController'
import { PredictionOverlay } from '../../src/ui/predictionOverlay'

const ACTIVE_KEY = 'a'.repeat(64)
const INPUT = Buffer.from('do-not-log-this')
const INTERRUPT = Buffer.from([0x03])
const PRIVATE_PROFILE = 'private-profile'
const PRIVATE_HOST = 'private-host.example'
const PRIVATE_PATH = 'C:\\Users\\private-user\\AppData\\Roaming\\tabby\\cmd-history\\connections\\private.jsonl'
const RAW_EXCEPTION = `fault command=${INPUT.toString()} profile=${PRIVATE_PROFILE} host=${PRIVATE_HOST} path=${PRIVATE_PATH}`

describe('cross-component fail-open behavior', () => {
    test('passes raw input and Ctrl+C when the matcher throws synchronously', async () => {
        const repository = createRepository({ load: async () => [entry('do-not-log-this later')] })
        const matcher = new HistoryMatcher()
        jest.spyOn(matcher, 'query').mockImplementation(() => { throw faultError() })
        const history = new HistoryService(repository, matcher, new SensitiveCommandFilter([]))
        const fixture = createFixture(history)

        await exerciseQueryFault(fixture)

        expect(repository.keys()).toEqual([ACTIVE_KEY])
        fixture.controller.destroy()
    })

    test.each([
        ['asynchronous rejection', (): Promise<HistoryEntry[]> => Promise.reject(faultError())],
        ['synchronous throw', (): Promise<HistoryEntry[]> => { throw faultError() }],
    ] as const)('passes raw input when repository load has an %s', async (_name, loadFault) => {
        const repository = createRepository({ load: loadFault })
        const history = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))
        const fixture = createFixture(history)

        await exerciseQueryFault(fixture)

        expect(repository.keys()).toEqual([ACTIVE_KEY])
        fixture.controller.destroy()
    })

    test('passes raw input when the controller query rejects asynchronously', async () => {
        const queriedKeys: string[] = []
        const history: ControllerHistoryService = {
            query: identity => {
                queriedKeys.push(identity.key)
                return Promise.reject(faultError())
            },
            record: async () => undefined,
        }
        const fixture = createFixture(history)

        await exerciseQueryFault(fixture)

        expect(queriedKeys).toEqual([ACTIVE_KEY])
        fixture.controller.destroy()
    })

    test('passes submitted bytes and Ctrl+C when repository record rejects asynchronously', async () => {
        const repository = createRepository({
            load: async () => [],
            record: async () => { throw faultError() },
        })
        const history = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))
        const fixture = createFixture(history)
        const command = Buffer.from('echo do-not-log-this')

        fixture.terminal.send(command)
        fixture.terminal.send(Buffer.from('\r'))
        await settle()
        fixture.terminal.send(INTERRUPT)
        await settle()

        expect(fixture.bytes()).toEqual(Buffer.concat([command, Buffer.from('\r'), INTERRUPT]))
        expect(fixture.controller.state().buffer).toEqual(expect.objectContaining({ text: '', confident: true }))
        expect(fixture.controller.state().predictions).toEqual([])
        expect(repository.record).toHaveBeenCalledTimes(1)
        expect(repository.keys().every(key => key === ACTIVE_KEY)).toBe(true)
        assertSafeLogs(fixture.logs)
        fixture.controller.destroy()
    })

    test('passes raw input while repository clear throws synchronously', async () => {
        const repository = createRepository({
            load: async () => [entry('do-not-log-this later')],
            clear: () => { throw faultError() },
        })
        const history = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))
        const fixture = createFixture(history)

        fixture.terminal.send(INPUT)
        await settle()
        await expect(history.clear({ key: ACTIVE_KEY, persistent: true, label: PRIVATE_PROFILE }))
            .rejects.toThrow('fault command=')
        fixture.terminal.send(INTERRUPT)
        await settle()

        expect(fixture.bytes()).toEqual(Buffer.concat([INPUT, INTERRUPT]))
        expect(fixture.controller.state().buffer).toEqual(expect.objectContaining({ text: '', confident: true }))
        expect(fixture.overlayVisible()).toBe(false)
        expect(repository.keys().every(key => key === ACTIVE_KEY)).toBe(true)
        assertSafeLogs(fixture.logs)
        fixture.controller.destroy()
    })

    test.each(['create', 'render', 'geometry'] as const)('passes raw input when overlay %s throws', async fault => {
        const queriedKeys: string[] = []
        const history: ControllerHistoryService = {
            query: async identity => {
                queriedKeys.push(identity.key)
                return [prediction('do-not-log-this later')]
            },
            record: async () => undefined,
        }
        const overrides: Partial<CommandHistoryControllerDependencies> = {}
        if (fault === 'create') {
            overrides.createOverlay = () => { throw faultError() }
        } else if (fault === 'render') {
            overrides.createOverlay = host => {
                const overlay = new PredictionOverlay(host)
                jest.spyOn(overlay, 'render').mockImplementation(() => { throw faultError() })
                return overlay
            }
        } else {
            overrides.geometry = {
                measure: () => { throw faultError() },
            } as never
        }
        const fixture = createFixture(history, overrides)

        await exerciseQueryFault(fixture)

        expect(queriedKeys).toEqual([ACTIVE_KEY])
        fixture.controller.destroy()
    })
})

async function exerciseQueryFault (fixture: ReturnType<typeof createFixture>): Promise<void> {
    fixture.terminal.send(INPUT)
    await settle()
    fixture.terminal.send(INTERRUPT)
    await settle()

    expect(fixture.bytes()).toEqual(Buffer.concat([INPUT, INTERRUPT]))
    expect(fixture.controller.state().buffer).toEqual(expect.objectContaining({ text: '', confident: true }))
    expect(fixture.controller.state().predictions).toEqual([])
    expect(fixture.overlayVisible()).toBe(false)
    assertSafeLogs(fixture.logs)
}

function createRepository (overrides: Partial<HistoryRepository> = {}): HistoryRepository & {
    load: jest.MockedFunction<HistoryRepository['load']>
    record: jest.MockedFunction<HistoryRepository['record']>
    clear: jest.MockedFunction<HistoryRepository['clear']>
    keys: () => string[]
} {
    const updates = new Subject<string>()
    const queriedKeys: string[] = []
    const loadImplementation = overrides.load ?? (async () => [])
    const recordImplementation = overrides.record ?? (async () => [])
    const clearImplementation = overrides.clear ?? (async () => undefined)
    const load = jest.fn((key: string, capacity: number) => {
        queriedKeys.push(key)
        return loadImplementation(key, capacity)
    })
    const record = jest.fn((key: string, command: string, at: Date, capacity: number, origin?: object) => {
        queriedKeys.push(key)
        return recordImplementation(key, command, at, capacity, origin)
    })
    const clear = jest.fn((key: string, origin?: object) => {
        queriedKeys.push(key)
        return clearImplementation(key, origin)
    })
    return { updates$: updates.asObservable(), load, record, clear, keys: () => [...queriedKeys] }
}

function createFixture (
    history: ControllerHistoryService,
    overrides: Partial<CommandHistoryControllerDependencies> = {},
) {
    const terminal = new FakeTerminal()
    const logs: string[] = []
    const config = {
        ...DEFAULT_COMMAND_HISTORY_CONFIG,
        captureMode: 'permissive' as const,
        exclusionPatterns: [...DEFAULT_COMMAND_HISTORY_CONFIG.exclusionPatterns],
        weights: { ...DEFAULT_COMMAND_HISTORY_CONFIG.weights },
        bindings: { ...DEFAULT_COMMAND_HISTORY_CONFIG.bindings },
    }
    const dependencies: CommandHistoryControllerDependencies = {
        history,
        identityResolver: {
            resolve: () => ({ key: ACTIVE_KEY, persistent: true, label: PRIVATE_PROFILE }),
        },
        getConfig: () => config,
        logger: { warn: (...args: unknown[]) => logs.push(args.join(' ')) },
        now: () => new Date('2026-08-12T12:00:00.000Z'),
        ...overrides,
    }
    // The integration fake exposes only the public terminal surface consumed by the controller.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const controller = new CommandHistoryController(terminal as any, dependencies)
    controller.attach()
    return {
        terminal,
        controller,
        logs,
        bytes: () => Buffer.concat(terminal.session.bytes),
        overlayVisible: () => {
            const overlay = terminal.element.nativeElement.querySelector('.cmd-history-overlay') as HTMLElement | null
            return overlay !== null && !overlay.hidden
        },
    }
}

class FakeTerminal {
    readonly profile = {
        id: PRIVATE_PROFILE,
        type: 'ssh',
        name: PRIVATE_PROFILE,
        options: { host: PRIVATE_HOST },
    }
    readonly session = new FakeSession()
    readonly sessionChanged$ = new Subject<FakeSession | null>()
    readonly frontendReady$ = new Subject<void>()
    readonly element = { nativeElement: document.createElement('div') }
    readonly frontend = new FakeFrontend()
    alternateScreenActive = false

    get resize$ (): Subject<void> {
        return this.frontend.resize$
    }

    get alternateScreenActive$ (): Subject<boolean> {
        return this.frontend.alternateScreenActive$
    }

    constructor () {
        const screen = document.createElement('div')
        screen.className = 'xterm-screen'
        this.element.nativeElement.append(screen)
        jest.spyOn(this.element.nativeElement, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 800, 480))
        jest.spyOn(screen, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 800, 480))
    }

    send (data: Buffer): void {
        this.session.middleware.feedFromTerminal(data)
    }
}

class FakeSession {
    readonly middleware = new SessionMiddlewareStack()
    readonly bytes: Buffer[] = []

    constructor () {
        this.middleware.outputToSession$.subscribe(data => this.bytes.push(Buffer.from(data)))
    }
}

class FakeFrontend {
    readonly contentUpdated$ = new Subject<void>()
    readonly destroyed$ = new Subject<void>()
    readonly resize$ = new Subject<void>()
    readonly alternateScreenActive$ = new Subject<boolean>()
    readonly xterm = {
        cols: 80,
        rows: 24,
        buffer: { active: {
            cursorX: 0,
            cursorY: 0,
            baseY: 0,
            getLine: () => ({ isWrapped: false, translateToString: () => '' }),
        } },
        onScroll: () => ({ dispose: () => undefined }),
        onSelectionChange: () => ({ dispose: () => undefined }),
    }

    supportsBracketedPaste (): boolean {
        return true
    }
}

function entry (command: string): HistoryEntry {
    return { command, lastUsedAt: '2026-08-12T12:00:00.000Z', useCount: 1 }
}

function prediction (command: string): Prediction {
    return { ...entry(command), matchKind: 'prefix', score: 1, matchIndex: 0 }
}

function rect (left: number, top: number, width: number, height: number): DOMRect {
    return {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({}),
    }
}

function assertSafeLogs (logs: readonly string[]): void {
    const text = logs.join('\n')
    for (const secret of [INPUT.toString(), PRIVATE_PROFILE, PRIVATE_HOST, PRIVATE_PATH, RAW_EXCEPTION]) {
        expect(text).not.toContain(secret)
    }
}

function faultError (): Error {
    return Object.assign(new Error(RAW_EXCEPTION), {
        command: INPUT.toString(),
        profile: PRIVATE_PROFILE,
        host: PRIVATE_HOST,
        path: PRIVATE_PATH,
    })
}

async function settle (): Promise<void> {
    for (let index = 0; index < 8; index++) {
        await Promise.resolve()
    }
}

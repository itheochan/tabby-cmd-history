import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filter, firstValueFrom, Subject, take } from 'rxjs'
import { SessionMiddlewareStack } from 'tabby-terminal'
import { DEFAULT_COMMAND_HISTORY_CONFIG } from '../../src/config/historyConfig'
import { SensitiveCommandFilter } from '../../src/history/commandPolicy'
import { ConnectionIdentityResolver } from '../../src/history/connectionIdentity'
import { HistoryMatcher } from '../../src/history/historyMatcher'
import { HistoryService } from '../../src/history/historyService'
import { JsonlHistoryRepository } from '../../src/history/jsonlHistoryRepository'
import { ConnectionIdentity } from '../../src/history/types'
import { CommandHistoryController } from '../../src/terminal/commandHistoryController'

const config = {
    ...DEFAULT_COMMAND_HISTORY_CONFIG,
    exclusionPatterns: [...DEFAULT_COMMAND_HISTORY_CONFIG.exclusionPatterns],
    weights: { ...DEFAULT_COMMAND_HISTORY_CONFIG.weights },
    bindings: { ...DEFAULT_COMMAND_HISTORY_CONFIG.bindings },
}
const capture = { trustworthy: true, visibleEcho: true }

describe('connection history isolation', () => {
    let root: string

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'tabby-cmd-history-isolation-'))
    })

    afterEach(async () => {
        await rm(root, { recursive: true, force: true })
    })

    test('shares one key while another connection file and cache remain byte-for-byte unchanged', async () => {
        const resolver = new ConnectionIdentityResolver()
        const a1Identity = resolver.resolve(
            { id: 'ssh:profile:a', type: 'ssh', name: 'A label', options: { host: 'host-a.example' } },
            {},
        )
        const a2Identity = resolver.resolve(
            { id: 'ssh:profile:a', type: 'ssh', name: 'A renamed', options: { host: 'changed.example' } },
            {},
        )
        const bIdentity = resolver.resolve(
            { id: 'ssh:profile:b', type: 'ssh', name: 'B label', options: { host: 'host-b.example' } },
            {},
        )
        const repository = new JsonlHistoryRepository(root)
        const service = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))
        const changedKeys: string[] = []
        const subscription = service.changes$.subscribe(key => changedKeys.push(key))

        expect(a1Identity).toEqual(expect.objectContaining({ key: a2Identity.key, persistent: true }))
        expect(a1Identity.key).not.toBe(bIdentity.key)

        await service.record(bIdentity, 'git push', capture, config, new Date('2026-08-12T10:00:00.000Z'))
        await service.record(a1Identity, 'git checkout main', capture, config, new Date('2026-08-12T11:00:00.000Z'))

        expect((await service.query(a2Identity, 'git ch', config)).map(item => item.command))
            .toEqual(['git checkout main'])
        expect((await service.query(bIdentity, 'git', config)).map(item => item.command))
            .toEqual(['git push'])
        expect(changedKeys.filter(key => key === a1Identity.key)).not.toHaveLength(0)
        expect(changedKeys.filter(key => key === bIdentity.key)).not.toHaveLength(0)

        const filesBeforeClear = (await readdir(join(root, 'connections'))).sort()
        expect(filesBeforeClear).toEqual([
            `${a1Identity.key}.jsonl`,
            `${bIdentity.key}.jsonl`,
        ].sort())
        expect(filesBeforeClear.every(file => /^[a-f0-9]{64}\.jsonl$/u.test(file))).toBe(true)
        expect(filesBeforeClear.join('\n')).not.toMatch(/A label|A renamed|B label|host-[ab]|git/u)

        const aBefore = await readFile(connectionFile(root, a1Identity), 'utf8')
        const bBefore = await readFile(connectionFile(root, bIdentity), 'utf8')
        expect(commandsFromJsonl(aBefore)).toEqual(['git checkout main'])
        expect(commandsFromJsonl(bBefore)).toEqual(['git push'])
        expect(aBefore).not.toContain('git push')
        expect(bBefore).not.toContain('git checkout main')

        await service.clear(a1Identity)

        expect(await service.query(a1Identity, 'git', config)).toEqual([])
        expect(await service.query(a2Identity, 'git', config)).toEqual([])
        expect((await service.query(bIdentity, 'git', config)).map(item => item.command))
            .toEqual(['git push'])
        expect(await readFile(connectionFile(root, bIdentity), 'utf8')).toBe(bBefore)

        const files = (await readdir(join(root, 'connections'))).sort()
        expect(files).toEqual([`${bIdentity.key}.jsonl`])
        expect(files.every(file => /^[a-f0-9]{64}\.jsonl$/u.test(file))).toBe(true)
        expect(files.join('\n')).not.toMatch(/A label|A renamed|B label|host-[ab]|git/u)
        subscription.unsubscribe()
    })

    test('keeps anonymous identities in lifetime memory without creating a connection file', async () => {
        const resolver = new ConnectionIdentityResolver()
        const lifetime = {}
        const sameLifetime = resolver.resolve(
            { type: '', name: '', options: { password: 'must-not-identify' } },
            lifetime,
        )
        const sameIdentityAgain = resolver.resolve(
            { type: '', name: '', options: { password: 'changed' } },
            lifetime,
        )
        const otherIdentity = resolver.resolve(
            { type: '', name: '', options: { password: 'must-not-identify' } },
            {},
        )
        const repository = new JsonlHistoryRepository(root)
        const service = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))

        await service.record(sameLifetime, 'echo transient', capture, config, new Date('2026-08-12T12:00:00.000Z'))

        expect(sameLifetime).toEqual(expect.objectContaining({ persistent: false }))
        expect(sameIdentityAgain.key).toBe(sameLifetime.key)
        expect(otherIdentity.key).not.toBe(sameLifetime.key)
        expect((await service.query(sameIdentityAgain, 'echo', config)).map(item => item.command))
            .toEqual(['echo transient'])
        expect(await service.query(otherIdentity, 'echo', config)).toEqual([])
        expect(await connectionFiles(root)).toEqual([])
    })

    test('refreshes only same-key controllers through the real repository and service change chain', async () => {
        const resolver = new ConnectionIdentityResolver()
        const a1Terminal = new ControllerTerminal(profile('ssh:controller:a', 'A1'))
        const a2Terminal = new ControllerTerminal(profile('ssh:controller:a', 'A2'))
        const bTerminal = new ControllerTerminal(profile('ssh:controller:b', 'B'))
        const aIdentity = resolver.resolve(a1Terminal.profile, a1Terminal)
        const a2Identity = resolver.resolve(a2Terminal.profile, a2Terminal)
        const bIdentity = resolver.resolve(bTerminal.profile, bTerminal)
        expect(a2Identity.key).toBe(aIdentity.key)
        expect(bIdentity.key).not.toBe(aIdentity.key)
        const repository = new JsonlHistoryRepository(root)
        const service = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))
        await service.record(aIdentity, 'git checkout initial-a', capture, config, new Date('2026-08-12T10:00:00.000Z'))
        await service.record(bIdentity, 'git checkout stable-b', capture, config, new Date('2026-08-12T10:00:00.000Z'))
        const query = jest.spyOn(service, 'query')
        const a1 = attachController(a1Terminal, service, resolver)
        const a2 = attachController(a2Terminal, service, resolver)
        const b = attachController(bTerminal, service, resolver)
        const fixtures = [a1, a2, b]
        const queryCount = (key: string): number => query.mock.calls.filter(call => call[0].key === key).length

        try {
            for (const fixture of fixtures) {
                fixture.terminal.send(Buffer.from('git ch'))
            }
            await flushUntil(() => fixtures.every(fixture => fixture.controller.state().predictions.length === 1))

            expect(a1.overlayVisible()).toBe(true)
            expect(a2.overlayVisible()).toBe(true)
            expect(b.overlayVisible()).toBe(true)
            const initialAQueryCount = queryCount(aIdentity.key)
            const initialBQueryCount = queryCount(bIdentity.key)
            const bPredictions = b.controller.state().predictions
            const bOverlayText = b.overlayText()
            expect(initialAQueryCount).toBe(2)
            expect(initialBQueryCount).toBe(1)

            await service.record(
                aIdentity,
                'git cherry-pick new-a',
                capture,
                config,
                new Date('2026-08-12T11:00:00.000Z'),
            )
            await flushUntil(() => predictionCommands(a1.controller).includes('git cherry-pick new-a'))

            expect(predictionCommands(a2.controller)).toContain('git cherry-pick new-a')
            expect(a1.overlayText()).toContain('git cherry-pick new-a')
            expect(a2.overlayText()).toContain('git cherry-pick new-a')
            expect(queryCount(aIdentity.key)).toBe(initialAQueryCount + 2)
            expect(queryCount(bIdentity.key)).toBe(initialBQueryCount)
            expect(b.controller.state().predictions).toEqual(bPredictions)
            expect(b.overlayText()).toBe(bOverlayText)

            await service.clear(aIdentity)

            expect(a1.controller.state().predictions).toEqual([])
            expect(a2.controller.state().predictions).toEqual([])
            expect(a1.overlayVisible()).toBe(false)
            expect(a2.overlayVisible()).toBe(false)
            await flushUntil(() => queryCount(aIdentity.key) === initialAQueryCount + 4)
            expect(queryCount(bIdentity.key)).toBe(initialBQueryCount)
            expect(b.controller.state().predictions).toEqual(bPredictions)
            expect(b.overlayText()).toBe(bOverlayText)

            a2.controller.destroy()
            const beforeDestroyedUpdate = queryCount(aIdentity.key)
            await service.record(
                aIdentity,
                'git cherry-pick after-clear',
                capture,
                config,
                new Date('2026-08-12T12:00:00.000Z'),
            )
            await flushUntil(() => predictionCommands(a1.controller).includes('git cherry-pick after-clear'))

            expect(queryCount(aIdentity.key)).toBe(beforeDestroyedUpdate + 1)
            expect(a1.overlayText()).toContain('git cherry-pick after-clear')
            expect(a2.controller.state().predictions).toEqual([])
            expect(a2Terminal.element.nativeElement.querySelector('.cmd-history-overlay')).toBeNull()
            expect(queryCount(bIdentity.key)).toBe(initialBQueryCount)
            expect(b.controller.state().predictions).toEqual(bPredictions)
        } finally {
            fixtures.forEach(fixture => fixture.controller.destroy())
        }
    })

    test('does not reload for its own update and still refreshes an external same-key update', async () => {
        const resolver = new ConnectionIdentityResolver()
        const identity = resolver.resolve({ id: 'local:a', type: 'local', name: 'A' }, {})
        const otherIdentity = resolver.resolve({ id: 'local:b', type: 'local', name: 'B' }, {})
        const repository = new JsonlHistoryRepository(root)
        const load = jest.spyOn(repository, 'load')
        const service = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))

        await service.query(identity, 'git', config)
        await service.query(otherIdentity, 'git', config)
        await service.record(identity, 'git checkout main', capture, config, new Date('2026-08-12T12:00:00.000Z'))

        expect(load.mock.calls).toEqual([
            [identity.key, config.capacity],
            [otherIdentity.key, config.capacity],
        ])

        await service.clear(identity)
        expect(load.mock.calls).toEqual([
            [identity.key, config.capacity],
            [otherIdentity.key, config.capacity],
        ])

        const refreshed = firstValueFrom(service.changes$.pipe(
            filter(key => key === identity.key),
            take(1),
        ))
        await repository.record(
            identity.key,
            'git cherry-pick abc123',
            new Date('2026-08-12T12:01:00.000Z'),
            config.capacity,
        )
        await refreshed

        expect((await service.query(identity, 'git cherry', config)).map(item => item.command))
            .toEqual(['git cherry-pick abc123'])
        expect(await service.query(otherIdentity, 'git cherry', config)).toEqual([])
        expect(load.mock.calls).toEqual([
            [identity.key, config.capacity],
            [otherIdentity.key, config.capacity],
            [identity.key, config.capacity],
        ])
    })

    test('refreshes another service sharing the repository without reloading the writer cache', async () => {
        const resolver = new ConnectionIdentityResolver()
        const identity = resolver.resolve({ id: 'local:shared', type: 'local', name: 'Shared' }, {})
        const repository = new JsonlHistoryRepository(root)
        const load = jest.spyOn(repository, 'load')
        const first = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))
        const second = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))
        await first.query(identity, 'git', config)
        await second.query(identity, 'git', config)

        const secondRefreshed = firstValueFrom(second.changes$.pipe(
            filter(key => key === identity.key),
            take(1),
        ))
        await first.record(identity, 'git switch main', capture, config, new Date('2026-08-12T12:00:00.000Z'))
        await secondRefreshed

        expect((await first.query(identity, 'git', config)).map(item => item.command)).toEqual(['git switch main'])
        expect((await second.query(identity, 'git', config)).map(item => item.command)).toEqual(['git switch main'])
        expect(load.mock.calls).toEqual([
            [identity.key, config.capacity],
            [identity.key, config.capacity],
            [identity.key, config.capacity],
        ])
    })
})

function connectionFile (root: string, identity: ConnectionIdentity): string {
    return join(root, 'connections', `${identity.key}.jsonl`)
}

async function connectionFiles (root: string): Promise<string[]> {
    try {
        return await readdir(join(root, 'connections'))
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
            return []
        }
        throw error
    }
}

function commandsFromJsonl (contents: string): string[] {
    return contents.split(/\r?\n/u)
        .filter(Boolean)
        .map(line => JSON.parse(line) as unknown)
        .filter((event): event is { command: string } => isObject(event) && typeof event.command === 'string')
        .map(event => event.command)
}

function isObject (value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function profile (id: string, name: string): { id: string; type: string; name: string; options: Record<string, unknown> } {
    return { id, type: 'ssh', name, options: { host: `${name.toLowerCase()}.example` } }
}

function attachController (
    terminal: ControllerTerminal,
    history: HistoryService,
    resolver: ConnectionIdentityResolver,
): {
    terminal: ControllerTerminal
    controller: CommandHistoryController
    overlayVisible: () => boolean
    overlayText: () => string
} {
    // The terminal fixture mirrors the public lifecycle surface consumed by the real controller.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const controller = new CommandHistoryController(terminal as any, {
        history,
        identityResolver: resolver,
        getConfig: () => config,
        logger: { warn: jest.fn() },
        now: () => new Date('2026-08-12T12:00:00.000Z'),
    })
    controller.attach()
    const overlay = (): HTMLElement | null => terminal.element.nativeElement.querySelector('.cmd-history-overlay')
    return {
        terminal,
        controller,
        overlayVisible: () => overlay() !== null && overlay()?.hidden === false,
        overlayText: () => overlay()?.textContent ?? '',
    }
}

class ControllerTerminal {
    readonly session = new ControllerSession()
    readonly sessionChanged$ = new Subject<ControllerSession | null>()
    readonly frontendReady$ = new Subject<void>()
    readonly element = { nativeElement: document.createElement('div') }
    readonly frontend = new ControllerFrontend()
    alternateScreenActive = false

    get resize$ (): Subject<void> {
        return this.frontend.resize$
    }

    get alternateScreenActive$ (): Subject<boolean> {
        return this.frontend.alternateScreenActive$
    }

    constructor (readonly profile: { id: string; type: string; name: string; options: Record<string, unknown> }) {
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

class ControllerSession {
    readonly middleware = new SessionMiddlewareStack()
}

class ControllerFrontend {
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

function predictionCommands (controller: CommandHistoryController): string[] {
    return controller.state().predictions.map(item => item.command)
}

async function flushUntil (predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) {
            return
        }
        await Promise.resolve()
    }
    throw new Error('Timed out while flushing deterministic controller promises')
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

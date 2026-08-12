import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filter, firstValueFrom, take } from 'rxjs'
import { DEFAULT_COMMAND_HISTORY_CONFIG } from '../../src/config/historyConfig'
import { SensitiveCommandFilter } from '../../src/history/commandPolicy'
import { ConnectionIdentityResolver } from '../../src/history/connectionIdentity'
import { HistoryMatcher } from '../../src/history/historyMatcher'
import { HistoryService } from '../../src/history/historyService'
import { JsonlHistoryRepository } from '../../src/history/jsonlHistoryRepository'
import { ConnectionIdentity } from '../../src/history/types'

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

        const bBefore = await readFile(connectionFile(root, bIdentity), 'utf8')
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

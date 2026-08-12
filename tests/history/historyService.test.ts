import { Subject } from 'rxjs'
import { DEFAULT_COMMAND_HISTORY_CONFIG as defaults } from '../../src/config/historyConfig'
import { SensitiveCommandFilter } from '../../src/history/commandPolicy'
import { HistoryMatcher } from '../../src/history/historyMatcher'
import { HistoryRepository, HistoryService } from '../../src/history/historyService'
import { ConnectionIdentity, HistoryEntry } from '../../src/history/types'

function identity (key: string, persistent = true): ConnectionIdentity {
    return { key, persistent, label: key }
}

function entry (command: string, useCount = 1): HistoryEntry {
    return { command, lastUsedAt: '2026-08-12T12:00:00.000Z', useCount }
}

function fakeRepository (initial: Record<string, HistoryEntry[]> = {}): HistoryRepository & {
    load: jest.MockedFunction<HistoryRepository['load']>
    record: jest.MockedFunction<HistoryRepository['record']>
    clear: jest.MockedFunction<HistoryRepository['clear']>
    publish: (key: string) => void
    replace: (key: string, entries: HistoryEntry[]) => void
} {
    const values = new Map(Object.entries(initial).map(([key, entries]) => [key, entries.map(item => ({ ...item }))]))
    const updates = new Subject<string>()
    const load = jest.fn(async (key: string, capacity: number) => {
        void capacity
        return (values.get(key) ?? []).map(item => ({ ...item }))
    })
    const record = jest.fn(async (key: string, command: string, at: Date, capacity: number) => {
        const current = values.get(key) ?? []
        const previous = current.find(item => item.command === command)
        const next = [
            { command, lastUsedAt: at.toISOString(), useCount: (previous?.useCount ?? 0) + 1 },
            ...current.filter(item => item.command !== command),
        ].slice(0, capacity)
        values.set(key, next)
        return next.map(item => ({ ...item }))
    })
    const clear = jest.fn(async (key: string) => { values.set(key, []) })

    return {
        updates$: updates.asObservable(),
        load,
        record,
        clear,
        publish: key => updates.next(key),
        replace: (key, entries) => values.set(key, entries.map(item => ({ ...item }))),
    }
}

test('records only commands accepted by trust, visible echo, normalization, and sensitive gates', async () => {
    const repository = fakeRepository()
    const service = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))
    const at = new Date('2026-08-12T12:00:00Z')

    await service.record(identity('a'), ' git status ', { trustworthy: true, visibleEcho: true }, defaults, at)
    await service.record(identity('a'), '--token secret', { trustworthy: true, visibleEcho: true }, defaults, at)
    await service.record(identity('a'), 'hidden', { trustworthy: true, visibleEcho: false }, defaults, at)
    await service.record(identity('a'), 'untrusted', { trustworthy: false, visibleEcho: true }, defaults, at)
    await service.record(identity('a'), '   ', { trustworthy: true, visibleEcho: true }, defaults, at)

    expect(repository.record).toHaveBeenCalledTimes(1)
    expect(repository.record).toHaveBeenCalledWith('a', 'git status', at, 4096)
})

test('permissive capture bypasses only visible echo', async () => {
    const repository = fakeRepository()
    const service = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))
    const permissive = { ...defaults, captureMode: 'permissive' as const }
    const at = new Date('2026-08-12T12:00:00Z')

    await service.record(identity('a'), 'visible not required', { trustworthy: true, visibleEcho: false }, permissive, at)
    await service.record(identity('a'), 'still untrusted', { trustworthy: false, visibleEcho: false }, permissive, at)
    await service.record(identity('a'), '--password nope', { trustworthy: true, visibleEcho: false }, permissive, at)

    expect(repository.record).toHaveBeenCalledTimes(1)
    expect(repository.record).toHaveBeenCalledWith('a', 'visible not required', at, 4096)
})

test('loads each persistent key once and queries only the requested connection cache', async () => {
    const repository = fakeRepository({ a: [entry('git status')], b: [entry('git push')] })
    const service = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))

    expect((await service.query(identity('a'), 'git', defaults)).map(item => item.command)).toEqual(['git status'])
    expect((await service.query(identity('a'), 'git', defaults)).map(item => item.command)).toEqual(['git status'])
    expect((await service.query(identity('b'), 'git', defaults)).map(item => item.command)).toEqual(['git push'])

    expect(repository.load.mock.calls).toEqual([['a', 4096], ['b', 4096]])
})

test('refreshes only an already loaded same-key cache on repository updates', async () => {
    const repository = fakeRepository({ a: [entry('git status')], b: [entry('git push')] })
    const service = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))
    await service.query(identity('a'), 'git', defaults)
    await service.query(identity('b'), 'git', defaults)

    repository.replace('a', [entry('git switch')])
    repository.publish('a')

    expect((await service.query(identity('a'), 'git', defaults)).map(item => item.command)).toEqual(['git switch'])
    expect((await service.query(identity('b'), 'git', defaults)).map(item => item.command)).toEqual(['git push'])
    expect(repository.load.mock.calls).toEqual([['a', 4096], ['b', 4096], ['a', 4096]])
})

test('keeps memory-only identities separate without accessing the repository', async () => {
    const repository = fakeRepository()
    const service = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))
    const capture = { trustworthy: true, visibleEcho: true }

    await service.record(identity('memory:a', false), 'git status', capture, defaults, new Date('2026-08-12T12:00:00Z'))
    await service.record(identity('memory:b', false), 'git push', capture, defaults, new Date('2026-08-12T12:01:00Z'))

    expect((await service.query(identity('memory:a', false), 'git', defaults)).map(item => item.command)).toEqual(['git status'])
    expect((await service.query(identity('memory:b', false), 'git', defaults)).map(item => item.command)).toEqual(['git push'])
    expect(repository.load).not.toHaveBeenCalled()
    expect(repository.record).not.toHaveBeenCalled()
})

test('clears only the requested persistent or memory identity', async () => {
    const repository = fakeRepository({ a: [entry('git status')], b: [entry('git push')] })
    const service = new HistoryService(repository, new HistoryMatcher(), new SensitiveCommandFilter([]))
    const capture = { trustworthy: true, visibleEcho: true }
    await service.query(identity('a'), 'git', defaults)
    await service.query(identity('b'), 'git', defaults)
    await service.record(identity('memory:a', false), 'pwd', capture, defaults, new Date('2026-08-12T12:00:00Z'))

    await service.clear(identity('a'))
    await service.clear(identity('memory:a', false))

    expect(await service.query(identity('a'), 'git', defaults)).toEqual([])
    expect((await service.query(identity('b'), 'git', defaults)).map(item => item.command)).toEqual(['git push'])
    expect(await service.query(identity('memory:a', false), 'pwd', defaults)).toEqual([])
    expect(repository.clear).toHaveBeenCalledTimes(1)
    expect(repository.clear).toHaveBeenCalledWith('a')
})

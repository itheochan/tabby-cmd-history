import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlHistoryRepository } from '../../src/history/jsonlHistoryRepository'

const roots: string[] = []

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeRoot (): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'tabby-history-test-'))
    roots.push(root)
    return root
}

test('aggregates independently by connection key', async () => {
    const root = await makeRoot()
    const repo = new JsonlHistoryRepository(root)
    await repo.record('a'.repeat(64), 'git status', new Date('2026-08-12T10:00:00Z'), 4096)
    await repo.record('a'.repeat(64), 'git status', new Date('2026-08-12T11:00:00Z'), 4096)
    await repo.record('b'.repeat(64), 'pwd', new Date('2026-08-12T12:00:00Z'), 4096)

    expect(await repo.load('a'.repeat(64), 4096)).toEqual([
        { command: 'git status', lastUsedAt: '2026-08-12T11:00:00.000Z', useCount: 2 },
    ])
    expect((await repo.load('b'.repeat(64), 4096))[0].command).toBe('pwd')
})

test('skips corrupt lines and evicts least recently used', async () => {
    const root = await makeRoot()
    const key = 'c'.repeat(64)
    const file = join(root, 'connections', `${key}.jsonl`)
    await mkdir(join(root, 'connections'), { recursive: true })
    await writeFile(file, [
        JSON.stringify({ v: 1, kind: 'entry', command: 'old', lastUsedAt: '2026-01-01T00:00:00Z', useCount: 9 }),
        '{broken',
        JSON.stringify({ v: 1, kind: 'use', command: 'new', at: '2026-08-12T00:00:00Z' }),
    ].join('\n'))

    expect(await new JsonlHistoryRepository(root).load(key, 1)).toEqual([
        { command: 'new', lastUsedAt: '2026-08-12T00:00:00Z', useCount: 1 },
    ])
})

test('replay sums normalized-equivalent entries and uses while retaining the newest timestamp', async () => {
    const root = await makeRoot()
    const key = '6'.repeat(64)
    const file = join(root, 'connections', `${key}.jsonl`)
    await mkdir(join(root, 'connections'), { recursive: true })
    await writeFile(file, [
        JSON.stringify({ v: 1, kind: 'use', command: ' git status\r\n', at: '2026-08-12T10:00:00Z' }),
        JSON.stringify({ v: 1, kind: 'entry', command: 'git status', lastUsedAt: '2026-08-12T09:00:00Z', useCount: 3 }),
        JSON.stringify({ v: 1, kind: 'entry', command: '\tgit status ', lastUsedAt: '2026-08-12T11:00:00Z', useCount: 2 }),
        JSON.stringify({ v: 1, kind: 'use', command: 'git status', at: '2026-08-12T08:00:00Z' }),
    ].join('\n'))

    expect(await new JsonlHistoryRepository(root).load(key, 10)).toEqual([
        { command: 'git status', lastUsedAt: '2026-08-12T11:00:00Z', useCount: 7 },
    ])
})

test('clear removes only one connection', async () => {
    const root = await makeRoot()
    const repo = new JsonlHistoryRepository(root)
    await repo.record('d'.repeat(64), 'one', new Date(), 10)
    await repo.record('e'.repeat(64), 'two', new Date(), 10)

    await repo.clear('d'.repeat(64))

    expect(await repo.load('d'.repeat(64), 10)).toEqual([])
    expect(await repo.load('e'.repeat(64), 10)).toHaveLength(1)
})

test('rejects non-persistent keys before constructing a storage path', async () => {
    const root = await makeRoot()
    const repo = new JsonlHistoryRepository(root)

    await expect(repo.load('../outside', 10)).rejects.toThrow('Invalid connection key')
    await expect(repo.record('A'.repeat(64), 'secret command', new Date(), 10)).rejects.toThrow('Invalid connection key')
    await expect(repo.clear('memory:terminal')).rejects.toThrow('Invalid connection key')
    expect(await readdir(root)).toEqual([])
})

test('publishes the explicit connection key after record and clear', async () => {
    const root = await makeRoot()
    const repo = new JsonlHistoryRepository(root)
    const key = '1'.repeat(64)
    const updates: string[] = []
    const subscription = repo.updates$.subscribe(update => updates.push(update))

    await repo.record(key, 'one', new Date('2026-08-12T10:00:00Z'), 10)
    await repo.clear(key)
    subscription.unsubscribe()

    expect(updates).toEqual([key, key])
})

test('serializes concurrent writes for the same connection key', async () => {
    const root = await makeRoot()
    const repositories = [new JsonlHistoryRepository(root), new JsonlHistoryRepository(root)]
    const key = '2'.repeat(64)

    await Promise.all(Array.from({ length: 20 }, (_, index) => repositories[index % repositories.length].record(
        key,
        'git status',
        new Date(`2026-08-12T10:${String(index).padStart(2, '0')}:00Z`),
        100,
    )))

    expect(await repositories[0].load(key, 100)).toEqual([
        { command: 'git status', lastUsedAt: '2026-08-12T10:19:00.000Z', useCount: 20 },
    ])
    const lines = (await readFile(join(root, 'connections', `${key}.jsonl`), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(20)
    expect(lines.map(line => JSON.parse(line))).toHaveLength(20)
})

test('serializes a same-key clear after an already queued record across repository instances', async () => {
    const root = await makeRoot()
    const key = '9'.repeat(64)
    const file = join(root, 'connections', `${key}.jsonl`)
    const first = new JsonlHistoryRepository(root)
    const second = new JsonlHistoryRepository(root)

    const recording = first.record(key, 'recorded before clear', new Date('2026-08-12T10:00:00Z'), 10)
    const clearing = second.clear(key)
    await Promise.all([recording, clearing])

    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    jest.resetModules()
    const { JsonlHistoryRepository: RestartedRepository } = await import('../../src/history/jsonlHistoryRepository')
    expect(await new RestartedRepository(root).load(key, 10)).toEqual([])
})

test('serializes a same-key record after an already queued clear across repository instances', async () => {
    const root = await makeRoot()
    const key = 'a'.repeat(64)
    const first = new JsonlHistoryRepository(root)
    const second = new JsonlHistoryRepository(root)

    const clearing = first.clear(key)
    const recording = second.record(key, 'recorded after clear', new Date('2026-08-12T10:00:00Z'), 10)
    await Promise.all([clearing, recording])

    jest.resetModules()
    const { JsonlHistoryRepository: RestartedRepository } = await import('../../src/history/jsonlHistoryRepository')
    expect(await new RestartedRepository(root).load(key, 10)).toEqual([
        { command: 'recorded after clear', lastUsedAt: '2026-08-12T10:00:00.000Z', useCount: 1 },
    ])
})

test('normalizes commands before aggregating and retains the most recent unique commands', async () => {
    const root = await makeRoot()
    const repo = new JsonlHistoryRepository(root)
    const key = '3'.repeat(64)

    await repo.record(key, '  git status\r\n', new Date('2026-08-12T10:00:00Z'), 2)
    await repo.record(key, 'git status', new Date('2026-08-12T11:00:00Z'), 2)
    await repo.record(key, 'old', new Date('2026-08-12T09:00:00Z'), 2)
    await repo.record(key, 'new', new Date('2026-08-12T12:00:00Z'), 2)

    expect(await repo.load(key, 2)).toEqual([
        { command: 'new', lastUsedAt: '2026-08-12T12:00:00.000Z', useCount: 1 },
        { command: 'git status', lastUsedAt: '2026-08-12T11:00:00.000Z', useCount: 2 },
    ])
})

test('does not rewrite a corrupt source merely because load skipped lines', async () => {
    const root = await makeRoot()
    const key = '4'.repeat(64)
    const file = join(root, 'connections', `${key}.jsonl`)
    const source = `${JSON.stringify({ v: 1, kind: 'use', command: 'valid', at: '2026-08-12T10:00:00Z' })}\n{broken\n`
    await mkdir(join(root, 'connections'), { recursive: true })
    await writeFile(file, source)

    expect(await new JsonlHistoryRepository(root).load(key, 1)).toHaveLength(1)
    expect(await readFile(file, 'utf8')).toBe(source)
})

test('compacts events into aggregate entries', async () => {
    const root = await makeRoot()
    const key = 'f'.repeat(64)
    const repo = new JsonlHistoryRepository(root, { compactEvents: 3 })
    await repo.record(key, 'git status', new Date('2026-08-12T10:00:00Z'), 10)
    await repo.record(key, 'git status', new Date('2026-08-12T11:00:00Z'), 10)
    await repo.record(key, 'pwd', new Date('2026-08-12T12:00:00Z'), 10)

    const records = (await readFile(join(root, 'connections', `${key}.jsonl`), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line))
    expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'entry', command: 'git status', useCount: 2 }),
        expect.objectContaining({ kind: 'entry', command: 'pwd', useCount: 1 }),
    ]))
    expect(records).toHaveLength(2)
    expect((await readdir(join(root, 'connections'))).filter(name => name.includes('.tmp'))).toEqual([])
})

test('compacts by byte threshold independently of the event threshold', async () => {
    const root = await makeRoot()
    const key = 'b'.repeat(64)
    const repo = new JsonlHistoryRepository(root, { compactBytes: 1, compactEvents: 100 })

    await repo.record(key, 'one', new Date('2026-08-12T10:00:00Z'), 10)

    const records = (await readFile(join(root, 'connections', `${key}.jsonl`), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line))
    expect(records).toEqual([
        expect.objectContaining({ kind: 'entry', command: 'one', useCount: 1 }),
    ])
})

test('keeps memory history and warns once for repeated read failures without command text', async () => {
    const root = await makeRoot()
    const warn = jest.fn()
    const key = '0'.repeat(64)
    const repo = new JsonlHistoryRepository(root, {
        warn,
        fileOperations: {
            readFile: async () => { throw Object.assign(new Error('read unavailable'), { code: 'EACCES' }) },
        },
    })

    await expect(repo.record(key, 'one', new Date('2026-08-12T10:00:00Z'), 10)).resolves.toHaveLength(1)
    await expect(repo.record(key, 'two', new Date('2026-08-12T11:00:00Z'), 10)).resolves.toHaveLength(2)

    expect(await repo.load(key, 10)).toHaveLength(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('stage read')
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/one|two/u)
})

test('warns once per key and failure stage without leaking command text', async () => {
    const root = await makeRoot()
    const secondRoot = await makeRoot()
    const warn = jest.fn()
    const key = '7'.repeat(64)
    const options = {
        warn,
        fileOperations: {
            appendFile: async () => { throw new Error('append unavailable') },
            rm: async () => { throw new Error('clear unavailable') },
        },
    }
    const repo = new JsonlHistoryRepository(root, options)
    const sameKeyAtAnotherRoot = new JsonlHistoryRepository(secondRoot, options)

    await repo.record(key, 'first secret command', new Date('2026-08-12T10:00:00Z'), 10)
    await repo.record(key, 'second secret command', new Date('2026-08-12T11:00:00Z'), 10)
    await sameKeyAtAnotherRoot.record(key, 'third secret command', new Date('2026-08-12T12:00:00Z'), 10)
    await expect(repo.clear(key)).rejects.toThrow('Unable to clear command history')
    await expect(repo.clear(key)).rejects.toThrow('Unable to clear command history')

    expect(warn.mock.calls.map(call => call[0])).toEqual([
        expect.stringContaining('stage append'),
        expect.stringContaining('stage clear'),
    ])
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/first|second|secret|command/u)
})

test('failed clear preserves disk bytes and state, emits no update, and can be retried', async () => {
    const root = await makeRoot()
    const key = '9'.repeat(64)
    const file = join(root, 'connections', `${key}.jsonl`)
    const warn = jest.fn()
    let failDelete = true
    const repo = new JsonlHistoryRepository(root, {
        warn,
        fileOperations: {
            rm: async (path, options) => {
                if (path === file && failDelete) {
                    throw new Error(`private delete failure ${path}`)
                }
                await rm(path, options)
            },
        },
    })
    await repo.record(key, 'existing command', new Date('2026-08-12T10:00:00Z'), 10)
    const before = await readFile(file, 'utf8')
    const updates: string[] = []
    const subscription = repo.updates$.subscribe(update => updates.push(update))

    let failure: unknown
    try {
        await repo.clear(key)
    } catch (error) {
        failure = error
    }
    expect(failure).toEqual(new Error('Unable to clear command history'))
    expect(String(failure)).not.toMatch(new RegExp(`${key}|existing|${root.replace(/\\/gu, '\\\\')}`, 'u'))
    expect(await readFile(file, 'utf8')).toBe(before)
    expect((await repo.load(key, 10)).map(item => item.command)).toEqual(['existing command'])
    expect(updates).toEqual([])

    failDelete = false
    await expect(repo.clear(key)).resolves.toBeUndefined()
    expect(updates).toEqual([key])
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    subscription.unsubscribe()
})

test('temporary-file delete failure leaves the main history bytes untouched', async () => {
    const root = await makeRoot()
    const key = 'a'.repeat(64)
    const file = join(root, 'connections', `${key}.jsonl`)
    const temporary = `${file}.compact.tmp`
    const repo = new JsonlHistoryRepository(root, {
        fileOperations: {
            rm: async (path, options) => {
                if (path === temporary) {
                    throw new Error('temporary delete unavailable')
                }
                await rm(path, options)
            },
        },
    })
    await repo.record(key, 'must remain', new Date('2026-08-12T10:00:00Z'), 10)
    const before = await readFile(file, 'utf8')
    const updates: string[] = []
    repo.updates$.subscribe(update => updates.push(update))

    await expect(repo.clear(key)).rejects.toThrow('Unable to clear command history')

    expect(await readFile(file, 'utf8')).toBe(before)
    expect((await repo.load(key, 10)).map(item => item.command)).toEqual(['must remain'])
    expect(updates).toEqual([])
})

test('preserves source bytes and unrelated temp files when rename fails after compaction sync', async () => {
    const root = await makeRoot()
    const key = '5'.repeat(64)
    const file = join(root, 'connections', `${key}.jsonl`)
    const otherTemp = join(root, 'connections', `${'8'.repeat(64)}.jsonl.compact.tmp`)
    const warn = jest.fn()
    let bytesAtRename = ''
    const repo = new JsonlHistoryRepository(root, {
        compactEvents: 2,
        warn,
        fileOperations: {
            rename: async () => {
                bytesAtRename = await readFile(file, 'utf8')
                throw new Error('rename unavailable')
            },
        },
    })

    await mkdir(join(root, 'connections'), { recursive: true })
    await writeFile(file, `${JSON.stringify({ v: 1, kind: 'use', command: 'existing', at: '2026-08-12T09:00:00Z' })}\n`)
    await writeFile(otherTemp, 'unrelated')
    await repo.record(key, 'new', new Date('2026-08-12T10:00:00Z'), 10)

    expect(bytesAtRename).not.toBe('')
    expect(await readFile(file, 'utf8')).toBe(bytesAtRename)
    expect(await readFile(otherTemp, 'utf8')).toBe('unrelated')
    expect(await readdir(join(root, 'connections'))).not.toContain(`${key}.jsonl.compact.tmp`)
    expect(warn.mock.calls.map(call => call[0])).toEqual([expect.stringContaining('stage compact')])

    jest.resetModules()
    const { JsonlHistoryRepository: RestartedRepository } = await import('../../src/history/jsonlHistoryRepository')
    expect(await new RestartedRepository(root).load(key, 10)).toEqual(expect.arrayContaining([
        expect.objectContaining({ command: 'existing' }),
        expect.objectContaining({ command: 'new' }),
    ]))

    await repo.record(key, 'later', new Date('2026-08-12T11:00:00Z'), 10)
    expect(warn.mock.calls.map(call => call[0])).toEqual([expect.stringContaining('stage compact')])
})

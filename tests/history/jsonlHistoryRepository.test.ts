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

test('keeps memory history and warns once without command text when storage is unavailable', async () => {
    const parent = await makeRoot()
    const blocker = join(parent, 'not-a-directory')
    await writeFile(blocker, 'x')
    const warn = jest.fn()
    const key = '0'.repeat(64)
    const repo = new JsonlHistoryRepository(join(blocker, 'child'), { warn })

    await expect(repo.record(key, 'one', new Date('2026-08-12T10:00:00Z'), 10)).resolves.toHaveLength(1)
    await expect(repo.record(key, 'two', new Date('2026-08-12T11:00:00Z'), 10)).resolves.toHaveLength(2)

    expect(await repo.load(key, 10)).toHaveLength(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/one|two/u)
})

test('keeps the original log when compaction cannot replace it', async () => {
    const root = await makeRoot()
    const key = '5'.repeat(64)
    const file = join(root, 'connections', `${key}.jsonl`)
    const warn = jest.fn()
    const repo = new JsonlHistoryRepository(root, { compactEvents: 1, warn })

    await mkdir(join(root, 'connections'), { recursive: true })
    await writeFile(file, `${JSON.stringify({ v: 1, kind: 'use', command: 'existing', at: '2026-08-12T09:00:00Z' })}\n`)
    await mkdir(`${file}.compact.tmp`)
    await repo.record(key, 'new', new Date('2026-08-12T10:00:00Z'), 10)

    expect(await new JsonlHistoryRepository(root).load(key, 10)).toEqual(expect.arrayContaining([
        expect.objectContaining({ command: 'existing' }),
        expect.objectContaining({ command: 'new' }),
    ]))
    expect(warn).toHaveBeenCalledTimes(1)
})

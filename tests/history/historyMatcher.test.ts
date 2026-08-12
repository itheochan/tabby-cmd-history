import { DEFAULT_COMMAND_HISTORY_CONFIG as defaults } from '../../src/config/historyConfig'
import { HistoryEntry } from '../../src/history/types'
import { HistoryMatcher } from '../../src/history/historyMatcher'

const entries: HistoryEntry[] = [
    { command: 'sudo git checkout main', lastUsedAt: '2026-08-12T11:59:00Z', useCount: 100 },
    { command: 'git checkout feature', lastUsedAt: '2026-08-10T00:00:00Z', useCount: 1 },
    { command: 'git cherry-pick abc', lastUsedAt: '2026-08-12T11:00:00Z', useCount: 4 },
]

test('prefix results always precede contains results', () => {
    const result = new HistoryMatcher().query(entries, 'git ch', defaults, new Date('2026-08-12T12:00:00Z'))

    expect(result.map(x => x.command)).toEqual(['git cherry-pick abc', 'git checkout feature', 'sudo git checkout main'])
    expect(result.map(x => x.matchKind)).toEqual(['prefix', 'prefix', 'contains'])
})

test('honors case and limit', () => {
    expect(new HistoryMatcher().query(entries, 'GIT', { ...defaults, caseSensitive: true }, new Date(), 2)).toEqual([])
    expect(new HistoryMatcher().query(entries, 'git', defaults, new Date(), 2)).toHaveLength(2)
})

test('uses configured weights and deterministic ties without mutating inputs', () => {
    const source: HistoryEntry[] = [
        { command: 'git zebra', lastUsedAt: '2026-08-12T00:00:00Z', useCount: 2 },
        { command: 'git alpha', lastUsedAt: '2026-08-12T00:00:00Z', useCount: 2 },
        { command: 'git recent-command', lastUsedAt: '2026-08-12T01:00:00Z', useCount: 1 },
    ]
    const config = {
        ...defaults,
        weights: { recency: 0, frequency: 0, matchCloseness: 1 },
    }
    const sourceSnapshot = JSON.parse(JSON.stringify(source)) as HistoryEntry[]
    const configSnapshot = JSON.parse(JSON.stringify(config))

    expect(new HistoryMatcher().query(source, 'git ', config, new Date('2026-08-12T12:00:00Z')).map(x => x.command))
        .toEqual(['git alpha', 'git zebra', 'git recent-command'])
    expect(source).toEqual(sourceSnapshot)
    expect(config).toEqual(configSnapshot)
})

test('returns no predictions below minimum length and orders invalid timestamps deterministically', () => {
    const source: HistoryEntry[] = [
        { command: 'git invalid', lastUsedAt: 'invalid', useCount: 1 },
        { command: 'git valid', lastUsedAt: '2026-08-12T00:00:00Z', useCount: 1 },
    ]
    const config = { ...defaults, minQueryLength: 3, weights: { recency: 1, frequency: 0, matchCloseness: 0 } }
    const matcher = new HistoryMatcher()

    expect(matcher.query(source, 'gi', config, new Date('2026-08-12T12:00:00Z'))).toEqual([])
    expect(matcher.query(source, 'git', config, new Date('2026-08-12T12:00:00Z')).map(x => x.command))
        .toEqual(['git valid', 'git invalid'])
})

test('reports the original UTF-16 match index for case-insensitive Unicode matching', () => {
    const result = new HistoryMatcher().query(
        [{ command: 'Xİgit status', lastUsedAt: '2026-08-12T00:00:00Z', useCount: 1 }],
        'git',
        defaults,
        new Date('2026-08-12T12:00:00Z'),
    )

    expect(result).toMatchObject([{ command: 'Xİgit status', matchIndex: 2, matchKind: 'contains' }])
})

test('treats regex metacharacters as literal text', () => {
    const result = new HistoryMatcher().query(
        [
            { command: 'echo [a]', lastUsedAt: '2026-08-12T00:00:00Z', useCount: 1 },
            { command: 'echo a', lastUsedAt: '2026-08-12T00:00:00Z', useCount: 1 },
        ],
        '[a]',
        defaults,
        new Date('2026-08-12T12:00:00Z'),
    )

    expect(result.map(prediction => prediction.command)).toEqual(['echo [a]'])
})

test('uses ECMAScript Unicode case-insensitive semantics', () => {
    const result = new HistoryMatcher().query(
        [{ command: 'Kelvin list', lastUsedAt: '2026-08-12T00:00:00Z', useCount: 1 }],
        'kelvin',
        defaults,
        new Date('2026-08-12T12:00:00Z'),
    )

    expect(result).toMatchObject([{ matchIndex: 0, matchKind: 'prefix' }])
})

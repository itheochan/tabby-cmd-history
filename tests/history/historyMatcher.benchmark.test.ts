import { performance } from 'node:perf_hooks'
import { DEFAULT_COMMAND_HISTORY_CONFIG } from '../../src/config/historyConfig'
import { HistoryMatcher } from '../../src/history/historyMatcher'
import { HistoryEntry } from '../../src/history/types'

const ENTRY_COUNT = 4096
const MATCH_COUNT = 64
const WARMUP_COUNT = 10
const SAMPLE_COUNT = 40
const P95_BUDGET_MS = 10
const FIXED_NOW = new Date('2026-08-12T12:00:00.000Z')

test('ranks 4096 entries under the 10 ms p95 budget', () => {
    const matcher = new HistoryMatcher()
    const entries = createEntries()
    const config = {
        ...DEFAULT_COMMAND_HISTORY_CONFIG,
        exclusionPatterns: [...DEFAULT_COMMAND_HISTORY_CONFIG.exclusionPatterns],
        weights: { ...DEFAULT_COMMAND_HISTORY_CONFIG.weights },
        bindings: { ...DEFAULT_COMMAND_HISTORY_CONFIG.bindings },
    }
    expect(entries).toHaveLength(ENTRY_COUNT)
    expect(entries.filter(entry => entry.command.startsWith('git ch'))).toHaveLength(MATCH_COUNT)

    let expected: string[] = []
    for (let warmup = 0; warmup < WARMUP_COUNT; warmup++) {
        const actual = matcher.query(entries, 'git ch', config, FIXED_NOW).map(item => item.command)
        if (warmup === 0) {
            expected = actual
        } else {
            expect(actual).toEqual(expected)
        }
    }
    expect(expected).toHaveLength(config.maxVisible)
    expect(expected.every(command => command.startsWith('git ch'))).toBe(true)

    const samples: number[] = []
    for (let round = 0; round < SAMPLE_COUNT; round++) {
        const start = performance.now()
        const actual = matcher.query(entries, 'git ch', config, FIXED_NOW).map(item => item.command)
        samples.push(performance.now() - start)
        expect(actual).toEqual(expected)
    }
    samples.sort((left, right) => left - right)
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]
    if (p95 > P95_BUDGET_MS) {
        throw new Error(`HistoryMatcher p95 ${p95.toFixed(3)} ms exceeds ${P95_BUDGET_MS} ms`)
    }
})

function createEntries (): HistoryEntry[] {
    const random = seededRandom(0x5eed1234)
    const entries: HistoryEntry[] = []
    for (let index = 0; index < MATCH_COUNT; index++) {
        entries.push({
            command: `git checkout feature-${String(index).padStart(2, '0')}-${randomToken(random)}`,
            lastUsedAt: new Date(FIXED_NOW.getTime() - index * 60_000).toISOString(),
            useCount: 1 + Math.floor(random() * 100),
        })
    }
    for (let index = MATCH_COUNT; index < ENTRY_COUNT; index++) {
        entries.push({
            command: `noise-${String(index).padStart(4, '0')}-${randomToken(random)}`,
            lastUsedAt: new Date(FIXED_NOW.getTime() - index * 60_000).toISOString(),
            useCount: 1 + Math.floor(random() * 100),
        })
    }
    return entries
}

function seededRandom (seed: number): () => number {
    let state = seed >>> 0
    return () => {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        return (state >>> 0) / 0x1_0000_0000
    }
}

function randomToken (random: () => number): string {
    return Math.floor(random() * 0x1_0000_0000).toString(36).padStart(7, '0')
}

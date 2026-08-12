import { DEFAULT_COMMAND_HISTORY_CONFIG, validateHistoryConfig } from '../../src/config/historyConfig'

describe('command history defaults', () => {
    test('uses list mode and safe limits', () => {
        expect(DEFAULT_COMMAND_HISTORY_CONFIG).toMatchObject({
            enabled: true, presentation: 'list', maxVisible: 5,
            minQueryLength: 1, caseSensitive: false, capacity: 4096,
            captureMode: 'strict', sensitiveFiltering: true,
        })
        expect(DEFAULT_COMMAND_HISTORY_CONFIG.weights).toEqual({ recency: 0.55, frequency: 0.30, matchCloseness: 0.15 })
    })

    test('normalizes weights and rejects Ctrl+C bindings', () => {
        expect(validateHistoryConfig({
            ...DEFAULT_COMMAND_HISTORY_CONFIG,
            weights: { recency: 55, frequency: 30, matchCloseness: 15 },
        }).weights).toEqual({ recency: 0.55, frequency: 0.30, matchCloseness: 0.15 })
        expect(() => validateHistoryConfig({
            ...DEFAULT_COMMAND_HISTORY_CONFIG,
            bindings: { ...DEFAULT_COMMAND_HISTORY_CONFIG.bindings, accept: 'Ctrl+C' as never },
        })).toThrow('Ctrl+C')
    })

    test.each([
        ['maxVisible', { maxVisible: 1 }],
        ['maxVisible', { maxVisible: 20 }],
        ['minQueryLength', { minQueryLength: 1 }],
        ['minQueryLength', { minQueryLength: 20 }],
        ['capacity', { capacity: 1 }],
        ['capacity', { capacity: 100000 }],
    ])('accepts the %s boundary', (_name, override) => {
        expect(() => validateHistoryConfig({ ...DEFAULT_COMMAND_HISTORY_CONFIG, ...override })).not.toThrow()
    })

    test.each([
        ['maxVisible', 0],
        ['maxVisible', 21],
        ['minQueryLength', 0],
        ['minQueryLength', 21],
        ['capacity', 0],
        ['capacity', 100001],
    ])('rejects %s outside its allowed range', (name, value) => {
        expect(() => validateHistoryConfig({ ...DEFAULT_COMMAND_HISTORY_CONFIG, [name]: value })).toThrow(name)
    })

    test('rejects printable bindings', () => {
        expect(() => validateHistoryConfig({
            ...DEFAULT_COMMAND_HISTORY_CONFIG,
            bindings: { ...DEFAULT_COMMAND_HISTORY_CONFIG.bindings, accept: 'a' as never },
        })).toThrow('Printable character')
    })
})

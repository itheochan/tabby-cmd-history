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
})

export type PresentationMode = 'inline' | 'list' | 'hybrid'
export type CaptureMode = 'strict' | 'permissive'
export type HistoryKeyName = 'ArrowUp' | 'ArrowDown' | 'ArrowRight' | 'Escape' | 'Enter' |
    'Ctrl+ArrowUp' | 'Ctrl+ArrowDown' | 'Ctrl+ArrowRight'

export interface CommandHistoryConfig {
    enabled: boolean
    presentation: PresentationMode
    maxVisible: number
    minQueryLength: number
    caseSensitive: boolean
    capacity: number
    captureMode: CaptureMode
    sensitiveFiltering: boolean
    exclusionPatterns: string[]
    weights: { recency: number; frequency: number; matchCloseness: number }
    bindings: { previous: HistoryKeyName; next: HistoryKeyName; accept: HistoryKeyName; dismiss: HistoryKeyName }
    dataRoot: string | null
}

export const DEFAULT_COMMAND_HISTORY_CONFIG: Readonly<CommandHistoryConfig> = Object.freeze<CommandHistoryConfig>({
    enabled: true,
    presentation: 'list',
    maxVisible: 5,
    minQueryLength: 1,
    caseSensitive: false,
    capacity: 4096,
    captureMode: 'strict',
    sensitiveFiltering: true,
    exclusionPatterns: [],
    weights: { recency: 0.55, frequency: 0.30, matchCloseness: 0.15 },
    bindings: { previous: 'ArrowUp', next: 'ArrowDown', accept: 'ArrowRight', dismiss: 'Escape' },
    dataRoot: null,
})

export function validateHistoryConfig (config: CommandHistoryConfig): CommandHistoryConfig {
    if (!(['inline', 'list', 'hybrid'] as const).includes(config.presentation)) {
        throw new Error('Presentation mode is not supported')
    }
    if (!(['strict', 'permissive'] as const).includes(config.captureMode)) {
        throw new Error('Capture mode is not supported')
    }
    validateLimit('maxVisible', config.maxVisible, 1, 20)
    validateLimit('minQueryLength', config.minQueryLength, 1, 20)
    validateLimit('capacity', config.capacity, 1, 100000)
    validateBindings(config.bindings)

    const weights = Object.values(config.weights)
    if (weights.some(weight => !Number.isFinite(weight) || weight < 0)) {
        throw new Error('Weights must be finite non-negative numbers')
    }
    const totalWeight = config.weights.recency + config.weights.frequency + config.weights.matchCloseness
    if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
        throw new Error('Weights must have a positive total')
    }

    return {
        ...config,
        exclusionPatterns: [...config.exclusionPatterns],
        weights: {
            recency: config.weights.recency / totalWeight,
            frequency: config.weights.frequency / totalWeight,
            matchCloseness: config.weights.matchCloseness / totalWeight,
        },
        bindings: { ...config.bindings },
    }
}

function validateLimit (name: string, value: number, minimum: number, maximum: number): void {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
    }
}

function validateBindings (bindings: CommandHistoryConfig['bindings']): void {
    const allowed = new Set<HistoryKeyName>([
        'ArrowUp', 'ArrowDown', 'ArrowRight', 'Escape', 'Enter',
        'Ctrl+ArrowUp', 'Ctrl+ArrowDown', 'Ctrl+ArrowRight',
    ])
    const entries = Object.entries(bindings) as Array<[keyof CommandHistoryConfig['bindings'], HistoryKeyName]>
    for (const [name, binding] of entries) {
        const bindingName: string = binding
        if (bindingName === 'Ctrl+C') {
            throw new Error('Ctrl+C cannot be used as a command history binding')
        }
        if (binding === 'Enter' && name !== 'accept') {
            throw new Error('Command history binding Enter can only be used for accept')
        }
        if (isPrintableCharacter(bindingName)) {
            throw new Error(`Printable character cannot be used as a command history binding: ${bindingName}`)
        }
        if (!allowed.has(binding)) {
            throw new Error('Command history binding is not supported')
        }
    }
}

function isPrintableCharacter (binding: string): boolean {
    return [...binding].length === 1 && !/[\u0000-\u001F\u007F]/u.test(binding)
}

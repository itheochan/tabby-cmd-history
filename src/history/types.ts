export interface HistoryEntry {
    command: string
    lastUsedAt: string
    useCount: number
}

export interface Prediction extends HistoryEntry {
    matchKind: 'prefix' | 'contains'
    score: number
    matchIndex: number
}

export interface ConnectionIdentity {
    key: string
    persistent: boolean
    label: string
}

export interface HistoryRepositoryMutation {
    key: string
    origin?: object
}

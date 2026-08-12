import { CommandHistoryConfig } from '../config/historyConfig'
import { HistoryEntry, Prediction } from './types'

interface ScoredPrediction extends Prediction {
    lastUsedTimestamp: number
    sortableUseCount: number
    sourceIndex: number
}

export class HistoryMatcher {
    query (
        entries: readonly HistoryEntry[],
        query: string,
        config: CommandHistoryConfig,
        now: Date,
        limit = config.maxVisible,
    ): Prediction[] {
        if (query.length < config.minQueryLength || limit <= 0) {
            return []
        }

        const normalizedQuery = this.normalize(query, config.caseSensitive)
        const matches = entries.flatMap((entry, sourceIndex) => {
            const matchIndex = this.normalize(entry.command, config.caseSensitive).indexOf(normalizedQuery)
            if (matchIndex < 0) {
                return []
            }

            return [{ entry, matchIndex, sourceIndex }]
        })
        const maxUseCount = matches.reduce((maximum, match) => Math.max(maximum, safeUseCount(match.entry.useCount)), 0)
        const nowTimestamp = safeTimestamp(now)
        const predictions = matches.map(match => this.score(match.entry, match.matchIndex, match.sourceIndex, normalizedQuery.length, maxUseCount, config, nowTimestamp))
        const prefix = predictions.filter(prediction => prediction.matchKind === 'prefix').sort(comparePredictions)
        const contains = predictions.filter(prediction => prediction.matchKind === 'contains').sort(comparePredictions)

        return [...prefix, ...contains].slice(0, limit).map(toPrediction)
    }

    private normalize (value: string, caseSensitive: boolean): string {
        return caseSensitive ? value : value.toLocaleLowerCase()
    }

    private score (
        entry: HistoryEntry,
        matchIndex: number,
        sourceIndex: number,
        queryLength: number,
        maxUseCount: number,
        config: CommandHistoryConfig,
        nowTimestamp: number,
    ): ScoredPrediction {
        const lastUsedTimestamp = safeTimestamp(entry.lastUsedAt)
        const ageHours = Number.isFinite(lastUsedTimestamp) && Number.isFinite(nowTimestamp)
            ? Math.max(0, (nowTimestamp - lastUsedTimestamp) / 3_600_000)
            : Number.POSITIVE_INFINITY
        const recency = 1 / (1 + ageHours / 24)
        const sortableUseCount = safeUseCount(entry.useCount)
        const frequency = maxUseCount > 0 ? Math.log1p(sortableUseCount) / Math.log1p(maxUseCount) : 0
        const commandLength = entry.command.length
        const matchCloseness = (queryLength / commandLength) * (1 - matchIndex / commandLength)
        const score = config.weights.recency * recency +
            config.weights.frequency * frequency +
            config.weights.matchCloseness * matchCloseness

        return {
            ...entry,
            matchKind: matchIndex === 0 ? 'prefix' : 'contains',
            score: Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY,
            matchIndex,
            lastUsedTimestamp,
            sortableUseCount,
            sourceIndex,
        }
    }
}

function comparePredictions (left: ScoredPrediction, right: ScoredPrediction): number {
    return right.score - left.score ||
        right.lastUsedTimestamp - left.lastUsedTimestamp ||
        right.sortableUseCount - left.sortableUseCount ||
        left.command.localeCompare(right.command) ||
        left.sourceIndex - right.sourceIndex
}

function toPrediction (prediction: ScoredPrediction): Prediction {
    return {
        command: prediction.command,
        lastUsedAt: prediction.lastUsedAt,
        useCount: prediction.useCount,
        matchKind: prediction.matchKind,
        score: prediction.score,
        matchIndex: prediction.matchIndex,
    }
}

function safeTimestamp (value: Date | string): number {
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY
}

function safeUseCount (value: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : 0
}

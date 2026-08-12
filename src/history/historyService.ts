import { Observable } from 'rxjs'
import { CommandHistoryConfig } from '../config/historyConfig'
import { normalizeCommand, SensitiveCommandFilter } from './commandPolicy'
import { HistoryMatcher } from './historyMatcher'
import { ConnectionIdentity, HistoryEntry, Prediction } from './types'

export interface HistoryRepository {
    readonly updates$: Observable<string>
    load: (key: string, capacity: number) => Promise<HistoryEntry[]>
    record: (key: string, command: string, at: Date, capacity: number) => Promise<HistoryEntry[]>
    clear: (key: string) => Promise<void>
}

export interface CaptureEvidence {
    trustworthy: boolean
    visibleEcho: boolean
}

export class HistoryService {
    private readonly persistentEntries = new Map<string, Promise<HistoryEntry[]>>()
    private readonly persistentCapacities = new Map<string, number>()
    private readonly persistentGenerations = new Map<string, number>()
    private readonly memoryEntries = new Map<string, HistoryEntry[]>()

    constructor (
        private readonly repository: HistoryRepository,
        private readonly matcher: HistoryMatcher,
        private readonly sensitiveFilter: SensitiveCommandFilter,
    ) {
        repository.updates$.subscribe(key => this.refreshPersistentKey(key))
    }

    async query (
        identity: ConnectionIdentity,
        query: string,
        config: CommandHistoryConfig,
        now = new Date(),
    ): Promise<Prediction[]> {
        let entries: readonly HistoryEntry[]
        if (identity.persistent) {
            this.persistentCapacities.set(identity.key, config.capacity)
            entries = await this.persistentEntriesFor(identity.key, config.capacity)
        } else {
            entries = this.memoryEntries.get(identity.key) ?? []
        }
        return this.matcher.query(entries, query, config, now)
    }

    async record (
        identity: ConnectionIdentity,
        command: string,
        evidence: CaptureEvidence,
        config: CommandHistoryConfig,
        at: Date,
    ): Promise<void> {
        if (!evidence.trustworthy) {
            return
        }
        if (config.captureMode === 'strict' && !evidence.visibleEcho) {
            return
        }

        const normalized = normalizeCommand(command)
        if (!normalized || !this.sensitiveFilter.allows(normalized, config.sensitiveFiltering)) {
            return
        }

        if (!identity.persistent) {
            this.memoryEntries.set(identity.key, recordInMemory(
                this.memoryEntries.get(identity.key) ?? [],
                normalized,
                at,
                config.capacity,
            ))
            return
        }

        this.persistentCapacities.set(identity.key, config.capacity)
        const generation = this.nextGeneration(identity.key)
        await this.installPersistent(
            identity.key,
            generation,
            this.repository.record(identity.key, normalized, at, config.capacity),
        )
    }

    async clear (identity: ConnectionIdentity): Promise<void> {
        if (!identity.persistent) {
            this.memoryEntries.delete(identity.key)
            return
        }

        const generation = this.nextGeneration(identity.key)
        await this.installPersistent(
            identity.key,
            generation,
            this.repository.clear(identity.key).then(() => []),
        )
    }

    private persistentEntriesFor (key: string, capacity: number): Promise<HistoryEntry[]> {
        const cached = this.persistentEntries.get(key)
        if (cached) {
            return cached
        }

        const generation = this.nextGeneration(key)
        return this.installPersistent(key, generation, this.repository.load(key, capacity))
    }

    private refreshPersistentKey (key: string): void {
        if (!this.persistentEntries.has(key)) {
            return
        }
        const capacity = this.persistentCapacities.get(key)
        if (capacity === undefined) {
            return
        }
        const generation = this.nextGeneration(key)
        const refreshing = this.installPersistent(key, generation, this.repository.load(key, capacity))
        void refreshing.catch(() => undefined)
    }

    private nextGeneration (key: string): number {
        const generation = (this.persistentGenerations.get(key) ?? 0) + 1
        this.persistentGenerations.set(key, generation)
        return generation
    }

    private installPersistent (
        key: string,
        generation: number,
        source: Promise<HistoryEntry[]>,
    ): Promise<HistoryEntry[]> {
        const installed = source.then(copyEntries).catch(error => {
            if (this.persistentGenerations.get(key) === generation && this.persistentEntries.get(key) === installed) {
                this.persistentEntries.delete(key)
            }
            throw error
        })
        if (this.persistentGenerations.get(key) === generation) {
            this.persistentEntries.set(key, installed)
        }
        return installed
    }
}

function recordInMemory (
    entries: readonly HistoryEntry[],
    command: string,
    at: Date,
    capacity: number,
): HistoryEntry[] {
    const timestamp = at.toISOString()
    const previous = entries.find(entry => entry.command === command)
    const updated: HistoryEntry = {
        command,
        lastUsedAt: !previous || Date.parse(timestamp) >= Date.parse(previous.lastUsedAt)
            ? timestamp
            : previous.lastUsedAt,
        useCount: (previous?.useCount ?? 0) + 1,
    }
    const limit = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0
    return [updated, ...entries.filter(entry => entry.command !== command)]
        .sort((left, right) => Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt) || left.command.localeCompare(right.command))
        .slice(0, limit)
        .map(entry => ({ ...entry }))
}

function copyEntries (entries: readonly HistoryEntry[]): HistoryEntry[] {
    return entries.map(entry => ({ ...entry }))
}

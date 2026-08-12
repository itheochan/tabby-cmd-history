import { appendFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Observable, Subject } from 'rxjs'
import { HistoryEntry } from './types'

interface RepositoryOptions {
    compactBytes?: number
    compactEvents?: number
    warn?: (message: string) => void
}

interface KeyState {
    entries: Map<string, HistoryEntry>
    eventCount: number
    fileBytes: number
    storageAvailable: boolean
}

interface UseEvent {
    v: 1
    kind: 'use'
    command: string
    at: string
}

interface EntryEvent {
    v: 1
    kind: 'entry'
    command: string
    lastUsedAt: string
    useCount: number
}

const KEY_PATTERN = /^[a-f0-9]{64}$/u
const DEFAULT_COMPACT_BYTES = 2 * 1024 * 1024
const states = new Map<string, KeyState>()
const queues = new Map<string, Promise<void>>()

export class JsonlHistoryRepository {
    readonly updates$: Observable<string>

    private readonly root: string
    private readonly compactBytes: number
    private readonly compactEvents?: number
    private readonly warn?: (message: string) => void
    private readonly warnedKeys = new Set<string>()
    private readonly updatesSubject = new Subject<string>()

    constructor (root: string, options: RepositoryOptions = {}) {
        this.root = resolve(root)
        this.compactBytes = options.compactBytes ?? DEFAULT_COMPACT_BYTES
        this.compactEvents = options.compactEvents
        this.warn = options.warn
        this.updates$ = this.updatesSubject.asObservable()
    }

    async load (key: string, capacity: number): Promise<HistoryEntry[]> {
        const file = this.fileFor(key)
        return runSerial(file, async () => {
            const state = await this.loadState(key, file)
            trimToCapacity(state.entries, capacity)
            return snapshot(state.entries)
        })
    }

    async record (key: string, command: string, at: Date, capacity: number): Promise<HistoryEntry[]> {
        const file = this.fileFor(key)
        return runSerial(file, async () => {
            const state = await this.loadState(key, file)
            const normalizedCommand = normalizeCommand(command)
            if (!normalizedCommand) {
                return snapshot(state.entries)
            }

            const timestamp = at.toISOString()
            applyUse(state.entries, normalizedCommand, timestamp)
            trimToCapacity(state.entries, capacity)
            this.updatesSubject.next(key)

            if (state.storageAvailable) {
                const event: UseEvent = { v: 1, kind: 'use', command: normalizedCommand, at: timestamp }
                const line = `${JSON.stringify(event)}\n`
                try {
                    await mkdir(join(this.root, 'connections'), { recursive: true })
                    await appendFile(file, line, 'utf8')
                    state.eventCount += 1
                    state.fileBytes += Buffer.byteLength(line)
                } catch {
                    state.storageAvailable = false
                    this.warnStorageFailure(key)
                }

                if (state.storageAvailable && this.shouldCompact(state, capacity)) {
                    try {
                        await compact(file, state.entries)
                        state.eventCount = state.entries.size
                        state.fileBytes = compactedBytes(state.entries)
                    } catch {
                        this.warnStorageFailure(key)
                    }
                }
            }

            return snapshot(state.entries)
        })
    }

    async clear (key: string): Promise<void> {
        const file = this.fileFor(key)
        await runSerial(file, async () => {
            let failed = false
            for (const target of [file, temporaryFileFor(file)]) {
                try {
                    await rm(target, { force: true })
                } catch {
                    failed = true
                }
            }
            if (failed) {
                this.warnStorageFailure(key)
            }
            states.set(file, emptyState(!failed))
            this.updatesSubject.next(key)
        })
    }

    private fileFor (key: string): string {
        if (!KEY_PATTERN.test(key)) {
            throw new Error('Invalid connection key')
        }
        return join(this.root, 'connections', `${key}.jsonl`)
    }

    private async loadState (key: string, file: string): Promise<KeyState> {
        const cached = states.get(file)
        if (cached) {
            return cached
        }

        const state = emptyState(true)
        try {
            const contents = await readFile(file, 'utf8')
            state.fileBytes = Buffer.byteLength(contents)
            for (const line of contents.split(/\r?\n/u)) {
                if (line) {
                    state.eventCount += 1
                    replayLine(state.entries, line)
                }
            }
        } catch (error) {
            if (!hasCode(error, 'ENOENT')) {
                state.storageAvailable = false
                this.warnStorageFailure(key)
            }
        }
        states.set(file, state)
        return state
    }

    private shouldCompact (state: KeyState, capacity: number): boolean {
        const eventLimit = this.compactEvents ?? Math.max(1, normalizedCapacity(capacity) * 2)
        return state.eventCount >= eventLimit || state.fileBytes >= this.compactBytes
    }

    private warnStorageFailure (key: string): void {
        if (this.warnedKeys.has(key)) {
            return
        }
        this.warnedKeys.add(key)
        try {
            this.warn?.(`Command history storage is unavailable for connection ${key}`)
        } catch {
            // Diagnostics must never interrupt terminal history updates.
        }
    }
}

async function runSerial<T> (queueKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(queueKey) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(() => undefined, () => undefined)
    queues.set(queueKey, tail)
    try {
        return await result
    } finally {
        if (queues.get(queueKey) === tail) {
            queues.delete(queueKey)
        }
    }
}

async function compact (file: string, entries: Map<string, HistoryEntry>): Promise<void> {
    const temporaryFile = temporaryFileFor(file)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
        await rm(temporaryFile, { force: true })
        handle = await open(temporaryFile, 'wx')
        await handle.writeFile(compactedContents(entries), 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await rename(temporaryFile, file)
    } catch (error) {
        if (handle) {
            await handle.close().catch(() => undefined)
        }
        await rm(temporaryFile, { force: true }).catch(() => undefined)
        throw error
    }
}

function replayLine (entries: Map<string, HistoryEntry>, line: string): void {
    try {
        const event: unknown = JSON.parse(line)
        if (isUseEvent(event)) {
            applyUse(entries, normalizeCommand(event.command), event.at)
        } else if (isEntryEvent(event)) {
            const command = normalizeCommand(event.command)
            if (command) {
                entries.set(command, { command, lastUsedAt: event.lastUsedAt, useCount: event.useCount })
            }
        }
    } catch {
        // A damaged line is isolated from the rest of the append-only log.
    }
}

function applyUse (entries: Map<string, HistoryEntry>, command: string, at: string): void {
    if (!command) {
        return
    }
    const existing = entries.get(command)
    entries.set(command, {
        command,
        lastUsedAt: !existing || Date.parse(at) >= Date.parse(existing.lastUsedAt) ? at : existing.lastUsedAt,
        useCount: (existing?.useCount ?? 0) + 1,
    })
}

function trimToCapacity (entries: Map<string, HistoryEntry>, capacity: number): void {
    for (const entry of snapshot(entries).slice(normalizedCapacity(capacity))) {
        entries.delete(entry.command)
    }
}

function normalizedCapacity (capacity: number): number {
    return Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0
}

function normalizeCommand (command: string): string {
    return command.replace(/\r\n?/gu, '\n').trim()
}

function snapshot (entries: Map<string, HistoryEntry>): HistoryEntry[] {
    return [...entries.values()]
        .sort((left, right) => Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt) || left.command.localeCompare(right.command))
        .map(entry => ({ ...entry }))
}

function compactedContents (entries: Map<string, HistoryEntry>): string {
    return snapshot(entries)
        .map<EntryEvent>(entry => ({ v: 1, kind: 'entry', ...entry }))
        .map(entry => JSON.stringify(entry))
        .join('\n') + (entries.size ? '\n' : '')
}

function compactedBytes (entries: Map<string, HistoryEntry>): number {
    return Buffer.byteLength(compactedContents(entries))
}

function temporaryFileFor (file: string): string {
    return `${file}.compact.tmp`
}

function emptyState (storageAvailable: boolean): KeyState {
    return { entries: new Map(), eventCount: 0, fileBytes: 0, storageAvailable }
}

function isUseEvent (value: unknown): value is UseEvent {
    if (!isObject(value)) {
        return false
    }
    return value.v === 1 && value.kind === 'use' && isCommand(value.command) && isTimestamp(value.at)
}

function isEntryEvent (value: unknown): value is EntryEvent {
    if (!isObject(value)) {
        return false
    }
    return value.v === 1 && value.kind === 'entry' && isCommand(value.command) && isTimestamp(value.lastUsedAt) &&
        Number.isInteger(value.useCount) && typeof value.useCount === 'number' && value.useCount > 0
}

function isObject (value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function isCommand (value: unknown): value is string {
    return typeof value === 'string' && normalizeCommand(value).length > 0
}

function isTimestamp (value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function hasCode (error: unknown, code: string): boolean {
    return isObject(error) && error.code === code
}

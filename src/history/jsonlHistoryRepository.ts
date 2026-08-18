import {
    appendFile as nodeAppendFile,
    mkdir as nodeMkdir,
    open as nodeOpen,
    readFile as nodeReadFile,
    rename as nodeRename,
    rm as nodeRm,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Observable, Subject } from 'rxjs'
import { version as pluginVersion } from '../../package.json'
import { HistoryEntry, HistoryRepositoryMutation } from './types'

interface RepositoryOptions {
    fileOperations?: Partial<JsonlHistoryFileOperations>
    warn?: (message: string) => void
}

export interface JsonlHistoryFileHandle {
    writeFile: (data: string, encoding: 'utf8') => Promise<void>
    sync: () => Promise<void>
    close: () => Promise<void>
}

export interface JsonlHistoryFileOperations {
    appendFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
    mkdir: (path: string, options: { recursive: true }) => Promise<unknown>
    open: (path: string, flags: 'wx') => Promise<JsonlHistoryFileHandle>
    readFile: (path: string, encoding: 'utf8') => Promise<string>
    rename: (oldPath: string, newPath: string) => Promise<void>
    rm: (path: string, options: { force: true }) => Promise<void>
}

interface KeyState {
    entries: Map<string, HistoryEntry>
    fileBytes: number
    fileLines: number
    storageAvailable: boolean
}

interface LegacyUseEvent {
    v: 1
    kind: 'use'
    command: string
    at: string
}

interface LegacyEntryEvent {
    v: 1
    kind: 'entry'
    command: string
    lastUsedAt: string
    useCount: number
}

interface EntryEvent {
    v: string
    kind: 'entry'
    command: string
    at: string
    count: number
}

const KEY_PATTERN = /^[a-f0-9]{64}$/u
const states = new Map<string, KeyState>()
const queues = new Map<string, Promise<void>>()
const warnedFailures = new Set<string>()
const DEFAULT_FILE_OPERATIONS: JsonlHistoryFileOperations = {
    appendFile: (path, data, encoding) => nodeAppendFile(path, data, encoding),
    mkdir: (path, options) => nodeMkdir(path, options),
    open: (path, flags) => nodeOpen(path, flags),
    readFile: (path, encoding) => nodeReadFile(path, encoding),
    rename: (oldPath, newPath) => nodeRename(oldPath, newPath),
    rm: (path, options) => nodeRm(path, options),
}

type FailureStage = 'read' | 'replay' | 'append' | 'rewrite' | 'migrate' | 'clear'
type ReplayLineKind = 'use' | 'entry' | 'invalid'

interface ReplayResult {
    kind: ReplayLineKind
    legacy: boolean
    duplicate: boolean
}

export class JsonlHistoryRepository {
    readonly updates$: Observable<string>
    readonly mutationUpdates$: Observable<HistoryRepositoryMutation>

    private readonly root: string
    private readonly fileOperations: JsonlHistoryFileOperations
    private readonly warn?: (message: string) => void
    private readonly updatesSubject = new Subject<string>()
    private readonly mutationUpdatesSubject = new Subject<HistoryRepositoryMutation>()

    constructor (root: string, options: RepositoryOptions = {}) {
        this.root = resolve(root)
        this.fileOperations = { ...DEFAULT_FILE_OPERATIONS, ...options.fileOperations }
        this.warn = options.warn
        this.updates$ = this.updatesSubject.asObservable()
        this.mutationUpdates$ = this.mutationUpdatesSubject.asObservable()
    }

    async load (key: string, capacity: number): Promise<HistoryEntry[]> {
        const file = this.fileFor(key)
        return runSerial(file, async () => {
            const state = await this.loadState(key, file)
            trimToCapacity(state.entries, capacity)
            return snapshot(state.entries)
        })
    }

    async record (key: string, command: string, at: Date, capacity: number, origin?: object): Promise<HistoryEntry[]> {
        const file = this.fileFor(key)
        return runSerial(file, async () => {
            const state = await this.loadState(key, file)
            const normalizedCommand = normalizeCommand(command)
            if (!normalizedCommand) {
                return snapshot(state.entries)
            }

            const existed = state.entries.has(normalizedCommand)
            const timestamp = at.toISOString()
            applyUse(state.entries, normalizedCommand, timestamp)
            trimToCapacity(state.entries, capacity)
            this.updatesSubject.next(key)
            this.mutationUpdatesSubject.next({ key, origin })

            if (state.storageAvailable && state.entries.has(normalizedCommand)) {
                try {
                    await this.fileOperations.mkdir(join(this.root, 'connections'), { recursive: true })
                    if (!existed) {
                        const entry = state.entries.get(normalizedCommand)
                        if (!entry) {
                            throw new Error('missing entry')
                        }
                        const event: EntryEvent = {
                            v: pluginVersion,
                            kind: 'entry',
                            command: entry.command,
                            at: entry.lastUsedAt,
                            count: entry.useCount,
                        }
                        const line = `${JSON.stringify(event)}\n`
                        await this.fileOperations.appendFile(file, line, 'utf8')
                        state.fileBytes += Buffer.byteLength(line)
                        state.fileLines += 1
                        if (state.fileLines > Math.max(1, normalizedCapacity(capacity))) {
                            await compact(file, state.entries, this.fileOperations)
                            state.fileBytes = compactedBytes(state.entries)
                            state.fileLines = state.entries.size
                        }
                    } else {
                        await compact(file, state.entries, this.fileOperations)
                        state.fileBytes = compactedBytes(state.entries)
                        state.fileLines = state.entries.size
                    }
                } catch {
                    if (!existed) {
                        state.storageAvailable = false
                        this.warnStorageFailure(key, 'append')
                    } else {
                        this.warnStorageFailure(key, 'rewrite')
                    }
                }
            }

            return snapshot(state.entries)
        })
    }

    async clear (key: string, origin?: object): Promise<void> {
        const file = this.fileFor(key)
        await runSerial(file, async () => {
            try {
                await this.fileOperations.rm(temporaryFileFor(file), { force: true })
                await this.fileOperations.rm(file, { force: true })
            } catch {
                this.warnStorageFailure(key, 'clear')
                throw new Error('Unable to clear command history')
            }
            states.set(file, emptyState(true))
            this.updatesSubject.next(key)
            this.mutationUpdatesSubject.next({ key, origin })
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
        let shouldRewrite = false
        try {
            const contents = await this.fileOperations.readFile(file, 'utf8')
            state.fileBytes = Buffer.byteLength(contents)
            state.fileLines = contents.split(/\r?\n/u).filter(line => line.length > 0).length
            for (const line of contents.split(/\r?\n/u)) {
                if (!line) {
                    continue
                }
                const replayed = replayLine(state.entries, line)
                if (replayed.kind === 'invalid') {
                    this.warnStorageFailure(key, 'replay')
                    continue
                }
                if (replayed.legacy || replayed.duplicate) {
                    shouldRewrite = true
                }
            }
        } catch (error) {
            if (!hasCode(error, 'ENOENT')) {
                state.storageAvailable = false
                this.warnStorageFailure(key, 'read')
            }
        }

        if (state.storageAvailable && shouldRewrite) {
            try {
                await compact(file, state.entries, this.fileOperations)
                state.fileBytes = compactedBytes(state.entries)
                state.fileLines = state.entries.size
            } catch {
                state.storageAvailable = false
                this.warnStorageFailure(key, 'migrate')
            }
        }
        states.set(file, state)
        return state
    }

    private warnStorageFailure (key: string, stage: FailureStage): void {
        if (!this.warn) {
            return
        }
        const warningKey = `${key}\0${stage}`
        if (warnedFailures.has(warningKey)) {
            return
        }
        warnedFailures.add(warningKey)
        try {
            this.warn(`Command history storage issue at stage ${stage} for connection ${key}`)
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

async function compact (
    file: string,
    entries: Map<string, HistoryEntry>,
    fileOperations: JsonlHistoryFileOperations,
): Promise<void> {
    const temporaryFile = temporaryFileFor(file)
    let handle: JsonlHistoryFileHandle | undefined
    try {
        await fileOperations.rm(temporaryFile, { force: true })
        handle = await fileOperations.open(temporaryFile, 'wx')
        await handle.writeFile(compactedContents(entries), 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await fileOperations.rename(temporaryFile, file)
    } catch (error) {
        if (handle) {
            await handle.close().catch(() => undefined)
        }
        await fileOperations.rm(temporaryFile, { force: true }).catch(() => undefined)
        throw error
    }
}

function replayLine (entries: Map<string, HistoryEntry>, line: string): ReplayResult {
    try {
        const event: unknown = JSON.parse(line)
        if (isLegacyUseEvent(event)) {
            const command = normalizeCommand(event.command)
            if (!command) {
                return { kind: 'invalid', legacy: false, duplicate: false }
            }
            const duplicate = entries.has(command)
            applyUse(entries, command, event.at)
            return { kind: 'use', legacy: true, duplicate }
        }
        if (isLegacyEntryEvent(event)) {
            const command = normalizeCommand(event.command)
            if (!command) {
                return { kind: 'invalid', legacy: false, duplicate: false }
            }
            const duplicate = entries.has(command)
            mergeContribution(entries, command, event.lastUsedAt, event.useCount)
            return { kind: 'entry', legacy: true, duplicate }
        }
        if (isEntryEvent(event)) {
            const command = normalizeCommand(event.command)
            if (!command) {
                return { kind: 'invalid', legacy: false, duplicate: false }
            }
            const duplicate = entries.has(command)
            mergeContribution(entries, command, event.at, event.count)
            return { kind: 'entry', legacy: false, duplicate }
        }
    } catch {
        // A damaged line is isolated from the rest of the JSONL file.
    }
    return { kind: 'invalid', legacy: false, duplicate: false }
}

function applyUse (entries: Map<string, HistoryEntry>, command: string, at: string): void {
    if (!command) {
        return
    }
    mergeContribution(entries, command, at, 1)
}

function mergeContribution (entries: Map<string, HistoryEntry>, command: string, at: string, useCount: number): void {
    const existing = entries.get(command)
    entries.set(command, {
        command,
        lastUsedAt: !existing || Date.parse(at) >= Date.parse(existing.lastUsedAt) ? at : existing.lastUsedAt,
        useCount: (existing?.useCount ?? 0) + useCount,
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
        .map<EntryEvent>(entry => ({
            v: pluginVersion,
            kind: 'entry',
            command: entry.command,
            at: entry.lastUsedAt,
            count: entry.useCount,
        }))
        .map(event => JSON.stringify(event))
        .join('\n') + (entries.size ? '\n' : '')
}

function compactedBytes (entries: Map<string, HistoryEntry>): number {
    return Buffer.byteLength(compactedContents(entries))
}

function temporaryFileFor (file: string): string {
    return `${file}.compact.tmp`
}

function emptyState (storageAvailable: boolean): KeyState {
    return { entries: new Map(), fileBytes: 0, fileLines: 0, storageAvailable }
}

function isLegacyUseEvent (value: unknown): value is LegacyUseEvent {
    if (!isObject(value)) {
        return false
    }
    return value.v === 1 && value.kind === 'use' && isCommand(value.command) && isTimestamp(value.at)
}

function isLegacyEntryEvent (value: unknown): value is LegacyEntryEvent {
    if (!isObject(value)) {
        return false
    }
    return value.v === 1 && value.kind === 'entry' && isCommand(value.command) && isTimestamp(value.lastUsedAt) &&
        isPositiveInteger(value.useCount)
}

function isEntryEvent (value: unknown): value is EntryEvent {
    if (!isObject(value)) {
        return false
    }
    return typeof value.v === 'string' && value.kind === 'entry' && isCommand(value.command) &&
        isTimestamp(value.at) && isPositiveInteger(value.count)
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

function isPositiveInteger (value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function hasCode (error: unknown, code: string): boolean {
    return isObject(error) && error.code === code
}

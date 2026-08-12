import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { ConnectionIdentity } from './types'

export interface ProfileLike {
    id?: string
    type?: string
    name?: string
    options?: Record<string, unknown>
}

type SafeValue = null | boolean | number | string | SafeValue[] | { [key: string]: SafeValue }

const SENSITIVE_OR_VOLATILE_KEY = /(?:pass(?:word|phrase|wd)?|token|secret|credential|authorization|api[_-]?key|private[_-]?key|environment|env|cwd|working[_-]?directory|window|columns|rows|process[_-]?id|pid|pty|restore|session)/iu

export class ConnectionIdentityResolver {
    resolve (profile: ProfileLike, tabLifetimeKey: string): ConnectionIdentity {
        const canonical = this.resolveCanonical(profile)
        if (!canonical) {
            return { key: `memory:${tabLifetimeKey}`, persistent: false, label: 'Temporary terminal' }
        }

        return {
            key: createHash('sha256').update(canonical).digest('hex'),
            persistent: true,
            label: profile.id ? 'Saved connection' : 'Temporary connection',
        }
    }

    private resolveCanonical (profile: ProfileLike): string | undefined {
        const type = normalizeText(profile.type).toLowerCase()
        const id = normalizeText(profile.id)
        if (type && id) {
            return `profile:${type}\0${id}`
        }

        const options = profile.options ?? {}
        switch (type) {
            case 'ssh':
                return resolveSshCanonical(options)
            case 'serial':
                return resolveSerialCanonical(options)
            case 'local':
                return resolveLocalCanonical(options)
            default:
                return resolveProviderCanonical(type, normalizeText(profile.name), options)
        }
    }
}

export function resolveDefaultDataRoot (
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    home: string,
): string {
    if (platform === 'win32') {
        return win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), 'tabby', 'cmd-history')
    }
    if (platform === 'darwin') {
        return posix.join(home, 'Library', 'Application Support', 'tabby', 'cmd-history')
    }
    return posix.join(env.XDG_DATA_HOME || posix.join(home, '.local', 'share'), 'tabby', 'cmd-history')
}

function resolveSshCanonical (options: Record<string, unknown>): string | undefined {
    const host = normalizeText(options.host).toLowerCase()
    const user = normalizeText(options.user).toLowerCase()
    const port = normalizePort(options.port)
    if (!host || !user || !port) {
        return undefined
    }
    return `ssh\0${user}\0${host}\0${port}`
}

function resolveSerialCanonical (options: Record<string, unknown>): string | undefined {
    const device = normalizeText(options.device).toLowerCase()
    const baud = normalizeBaud(options.baud)
    if (!device || !baud) {
        return undefined
    }
    return ['serial', device, baud].join('\0')
}

function resolveLocalCanonical (options: Record<string, unknown>): string | undefined {
    const shell = normalizeText(options.shell).toLowerCase()
    if (!shell) {
        return undefined
    }
    return JSON.stringify({
        path: normalizeText(options.path),
        provider: normalizeText(options.provider).toLowerCase(),
        shell,
        type: 'local',
    })
}

function resolveProviderCanonical (type: string, name: string, options: Record<string, unknown>): string | undefined {
    if (!type || !name) {
        return undefined
    }
    const safeOptions = sanitizeOptions(options)
    if (!safeOptions) {
        return undefined
    }
    return JSON.stringify({ name, options: safeOptions, type })
}

function normalizeText (value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function normalizePort (value: unknown): string | undefined {
    const port = value === undefined || value === null || value === '' ? 22 : Number(value)
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? String(port) : undefined
}

function normalizeBaud (value: unknown): string | undefined {
    const baud = Number(value)
    return Number.isInteger(baud) && baud > 0 ? String(baud) : undefined
}

function sanitizeOptions (value: unknown, ancestors = new WeakSet<object>()): SafeValue | undefined {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined
    }
    if (typeof value !== 'object' || value === null || ancestors.has(value)) {
        return undefined
    }
    ancestors.add(value)

    if (Array.isArray(value)) {
        const values: SafeValue[] = []
        for (const item of value) {
            const safeItem = sanitizeOptions(item, ancestors)
            if (safeItem === undefined) {
                ancestors.delete(value)
                return undefined
            }
            values.push(safeItem)
        }
        ancestors.delete(value)
        return values
    }
    if (!isPlainObject(value)) {
        ancestors.delete(value)
        return undefined
    }

    const result: { [key: string]: SafeValue } = {}
    for (const key of Object.keys(value).sort()) {
        if (SENSITIVE_OR_VOLATILE_KEY.test(key)) {
            continue
        }
        const safeValue = sanitizeOptions(value[key], ancestors)
        if (safeValue === undefined) {
            ancestors.delete(value)
            return undefined
        }
        result[key] = safeValue
    }
    ancestors.delete(value)
    return result
}

function isPlainObject (value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null) {
        return false
    }
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

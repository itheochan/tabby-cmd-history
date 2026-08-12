import { ConnectionIdentityResolver, resolveDefaultDataRoot } from '../../src/history/connectionIdentity'

const resolver = new ConnectionIdentityResolver()

test('saved profiles use type and stable id, not display name', () => {
    const a = resolver.resolve({ id: 'ssh:custom:abc', type: 'ssh', name: 'Old', options: { host: 'a' } }, 'tab-a')
    const b = resolver.resolve({ id: 'ssh:custom:abc', type: 'ssh', name: 'New', options: { host: 'b' } }, 'tab-b')
    expect(a.key).toBe(b.key)
    expect(a.persistent).toBe(true)
    expect(a.key).toMatch(/^[a-f0-9]{64}$/)
})

test('quick connect excludes passwords and separates endpoints', () => {
    const a = resolver.resolve({ type: 'ssh', name: 'temp', options: { user: 'root', host: 'Example.COM', port: 22, password: 'one' } }, 'a')
    const b = resolver.resolve({ type: 'ssh', name: 'temp', options: { user: 'root', host: 'example.com', port: 22, password: 'two' } }, 'b')
    const c = resolver.resolve({ type: 'ssh', name: 'temp', options: { user: 'root', host: 'other', port: 22 } }, 'c')
    expect(a.key).toBe(b.key)
    expect(a.key).not.toBe(c.key)
})

test('unsafe anonymous profiles use tab-lifetime memory', () => {
    expect(resolver.resolve({ type: '', name: '', options: { password: 'x' } }, 'tab-7')).toEqual({
        key: 'memory:tab-7', persistent: false, label: 'Temporary terminal',
    })
})

test('serial quick connect persists normalized device and baud identities', () => {
    const serialA = resolver.resolve({ type: 'serial', options: { device: 'COM3', baud: 9600 } }, 'a')
    const serialB = resolver.resolve({ type: 'SERIAL', options: { device: 'com3', baud: 115200 } }, 'b')
    expect(serialA.persistent).toBe(true)
    expect(serialA.key).not.toBe(serialB.key)
    expect(resolver.resolve({ type: 'serial', options: { device: 'COM3' } }, 'missing-baud').persistent).toBe(false)
    expect(resolver.resolve({ type: 'serial', options: { device: 'COM3', baud: 'fast' } }, 'invalid-baud').persistent).toBe(false)
    expect(resolver.resolve({ type: 'serial', options: { baud: 9600 } }, 'missing-device').persistent).toBe(false)
})

test('local quick connect persists shell, path, and provider identities', () => {
    const localA = resolver.resolve({ type: 'local', options: { shell: 'bash', path: '/bin/bash', provider: 'builtin' } }, 'a')
    const localB = resolver.resolve({ type: 'LOCAL', options: { shell: 'bash', path: '/bin/bash', provider: 'custom' } }, 'b')
    expect(localA.persistent).toBe(true)
    expect(localA.key).not.toBe(localB.key)
    expect(resolver.resolve({ type: 'local', options: { path: '/bin/bash', provider: 'builtin' } }, 'missing-shell').persistent).toBe(false)
})

test('ssh quick connect separates explicit ports for the same user and host', () => {
    const a = resolver.resolve({ type: 'ssh', options: { user: 'root', host: 'example.com', port: 22 } }, 'a')
    const b = resolver.resolve({ type: 'ssh', options: { user: 'root', host: 'example.com', port: 2222 } }, 'b')
    expect(a.persistent).toBe(true)
    expect(a.key).not.toBe(b.key)
})

test('other providers discard sensitive and session-only options before sorting', () => {
    const a = resolver.resolve({
        type: 'docker', name: 'engine', options: { host: 'daemon', nested: { keep: true, token: 'one' }, pid: 10 },
    }, 'a')
    const b = resolver.resolve({
        type: 'docker', name: 'engine', options: { nested: { token: 'two', keep: true }, host: 'daemon', pid: 20 },
    }, 'b')
    expect(a).toEqual(b)
    expect(a.persistent).toBe(true)
})

test('unsafe option graphs fall back to tab-lifetime memory', () => {
    const options: Record<string, unknown> = { host: 'daemon' }
    options.self = options
    expect(resolver.resolve({ type: 'docker', name: 'engine', options }, 'tab-loop')).toEqual({
        key: 'memory:tab-loop', persistent: false, label: 'Temporary terminal',
    })
})

test('resolves documented roots', () => {
    expect(resolveDefaultDataRoot('win32', { APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }, 'C:\\Users\\t'))
        .toBe('C:\\Users\\t\\AppData\\Roaming\\tabby\\cmd-history')
    expect(resolveDefaultDataRoot('linux', {}, '/home/t')).toBe('/home/t/.local/share/tabby/cmd-history')
    expect(resolveDefaultDataRoot('linux', { XDG_DATA_HOME: '/var/data' }, '/home/t')).toBe('/var/data/tabby/cmd-history')
    expect(resolveDefaultDataRoot('darwin', {}, '/Users/t')).toBe('/Users/t/Library/Application Support/tabby/cmd-history')
})

import { CommandInputMiddleware } from '../../src/terminal/inputMiddleware'

const BRACKETED_PASTE_START = Buffer.from('\x1b[200~')
const BRACKETED_PASTE_END = Buffer.from('\x1b[201~')

describe('CommandInputMiddleware', () => {
    test('forwards ordinary input and Ctrl+C byte-for-byte', () => {
        const routes: Buffer[] = []
        const middleware = new CommandInputMiddleware(action => ({ consume: false, action }))
        middleware.outputToSession$.subscribe(data => routes.push(data))
        middleware.feedFromTerminal(Buffer.from('x'))
        middleware.feedFromTerminal(Buffer.from([0x03]))
        expect(Buffer.concat(routes)).toEqual(Buffer.from([0x78, 0x03]))
    })

    test('consumes only tokens explicitly selected by the router', () => {
        const routes: Buffer[] = []
        const middleware = new CommandInputMiddleware(action => ({ consume: action.type === 'left' }))
        middleware.outputToSession$.subscribe(data => routes.push(data))
        middleware.feedFromTerminal(Buffer.concat([
            Buffer.from('a'),
            Buffer.from([0x1b, 0x5b, 0x44]),
            Buffer.from([0x03]),
        ]))
        expect(Buffer.concat(routes)).toEqual(Buffer.from([0x61, 0x03]))
    })

    test('fails open with exact raw bytes when the router throws', () => {
        const routes: Buffer[] = []
        const input = Buffer.from([0x1b, 0x5b, 0x39, 0x39, 0x7e, 0x03])
        const middleware = new CommandInputMiddleware(() => {
            throw new Error('router failed')
        })
        middleware.outputToSession$.subscribe(data => routes.push(data))
        middleware.feedFromTerminal(input)
        expect(Buffer.concat(routes)).toEqual(input)
    })

    test('forwards UTF-8 and escape sequences split across buffers without partial output', () => {
        const routes: Buffer[] = []
        const middleware = new CommandInputMiddleware(() => ({ consume: false }))
        middleware.outputToSession$.subscribe(data => routes.push(data))
        const chunks = [Buffer.from([0xf0, 0x9f]), Buffer.from([0x91, 0x8d, 0x1b]), Buffer.from('[D')]
        for (const chunk of chunks) {
            middleware.feedFromTerminal(chunk)
        }
        expect(Buffer.concat(routes)).toEqual(Buffer.concat(chunks))
    })

    test('injects only a safe suffix for an end-of-buffer prefix match', () => {
        const routes: Buffer[] = []
        const middleware = new CommandInputMiddleware(() => ({ consume: false }))
        middleware.outputToSession$.subscribe(data => routes.push(data))
        middleware.injectReplacement({ current: 'git ch', cursor: 6, candidate: 'git checkout' })
        expect(Buffer.concat(routes)).toEqual(Buffer.from('eckout'))
    })

    test('replaces a line using grapheme counts and the known grapheme cursor', () => {
        const routes: Buffer[] = []
        const middleware = new CommandInputMiddleware(() => ({ consume: false }))
        middleware.outputToSession$.subscribe(data => routes.push(data))
        middleware.injectReplacement({ current: 'a👨‍👩‍👧‍👦b', cursor: 1, candidate: 'done' })
        expect(Buffer.concat(routes)).toEqual(Buffer.concat([
            Buffer.from('\x1b[C\x1b[C'),
            Buffer.from([0x7f, 0x7f, 0x7f]),
            Buffer.from('done'),
        ]))
    })

    test.each(['bad\ncommand', 'bad\rcommand', 'bad\r\ncommand', 'bad\x03command', 'bad\x1b[A'])(
        'rejects unsafe replacement %p atomically',
        candidate => {
            const routes: Buffer[] = []
            const middleware = new CommandInputMiddleware(() => ({ consume: false }))
            middleware.outputToSession$.subscribe(data => routes.push(data))
            expect(() => middleware.injectReplacement({ current: 'safe', cursor: 4, candidate })).toThrow()
            expect(routes).toEqual([])
        },
    )

    test('replacement injection never contains a command terminator', () => {
        const routes: Buffer[] = []
        const middleware = new CommandInputMiddleware(() => ({ consume: false }))
        middleware.outputToSession$.subscribe(data => routes.push(data))
        middleware.injectReplacement({ current: 'git ch', cursor: 6, candidate: 'sudo git checkout' })
        const bytes = Buffer.concat(routes)
        expect(bytes.includes(0x0d)).toBe(false)
        expect(bytes.includes(0x0a)).toBe(false)
    })

    test('injects an intentional multiline candidate as bracketed paste without final Enter', () => {
        const routes: Buffer[] = []
        const middleware = new CommandInputMiddleware(() => ({ consume: false }))
        middleware.outputToSession$.subscribe(data => routes.push(data))
        middleware.injectBracketedPaste('echo one\necho two')
        const bytes = Buffer.concat(routes)
        expect(bytes).toEqual(Buffer.concat([
            BRACKETED_PASTE_START,
            Buffer.from('echo one\necho two'),
            BRACKETED_PASTE_END,
        ]))
        expect(bytes.subarray(bytes.length - BRACKETED_PASTE_END.length)).toEqual(BRACKETED_PASTE_END)
    })

    test('rejects non-multiline and marker-breaking bracketed paste candidates atomically', () => {
        const routes: Buffer[] = []
        const middleware = new CommandInputMiddleware(() => ({ consume: false }))
        middleware.outputToSession$.subscribe(data => routes.push(data))
        expect(() => middleware.injectBracketedPaste('single line')).toThrow()
        expect(() => middleware.injectBracketedPaste('one\ntwo\n')).toThrow()
        expect(() => middleware.injectBracketedPaste('safe\n\x1b[201~unsafe')).toThrow()
        expect(() => middleware.injectBracketedPaste('safe\n\x03unsafe')).toThrow()
        expect(routes).toEqual([])
    })
})

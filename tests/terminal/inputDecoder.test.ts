import { TerminalInputDecoder } from '../../src/terminal/inputDecoder'

describe('TerminalInputDecoder', () => {
    test('decodes text, editing keys, bracketed paste and Ctrl+C', () => {
        const decoder = new TerminalInputDecoder()
        expect(decoder.decode(Buffer.from('git'))[0].action).toEqual({ type: 'insert', text: 'git' })
        expect(decoder.decode(Buffer.from([0x1b, 0x5b, 0x44]))[0].action).toEqual({ type: 'left' })
        expect(decoder.decode(Buffer.from([0x03]))[0].action).toEqual({ type: 'interrupt' })
        decoder.decode(Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]))
        expect(decoder.decode(Buffer.from('a\nb'))[0].action).toEqual({ type: 'paste', text: 'a\nb' })
    })

    test('recognizes supported control keys and editing escape sequences', () => {
        const decoder = new TerminalInputDecoder()
        const controls = decoder.decode(Buffer.from([
            0x0d, 0x0a, 0x7f, 0x08, 0x01, 0x05, 0x15, 0x0b, 0x17,
        ]))
        expect(controls.map(token => token.action)).toEqual([
            { type: 'enter' },
            { type: 'enter' },
            { type: 'backspace' },
            { type: 'backspace' },
            { type: 'home' },
            { type: 'end' },
            { type: 'deleteStart' },
            { type: 'deleteEnd' },
            { type: 'deleteWord' },
        ])

        const sequences = [
            ['1b5b41', 'up'],
            ['1b5b42', 'down'],
            ['1b5b43', 'right'],
            ['1b5b44', 'left'],
            ['1b5b48', 'home'],
            ['1b5b46', 'end'],
            ['1b5b337e', 'delete'],
        ] as const
        expect(sequences.map(([hex]) => decoder.decode(Buffer.from(hex, 'hex'))[0].action)).toEqual(
            sequences.map(([, type]) => ({ type })),
        )
    })

    test('waits for a complete UTF-8 code point split across chunks', () => {
        const decoder = new TerminalInputDecoder()
        const bytes = Buffer.from('👍🏽')
        const tokens = []
        for (const byte of bytes) {
            tokens.push(...decoder.decode(Buffer.from([byte])))
        }
        expect(tokens.map(token => token.action)).toEqual([
            { type: 'insert', text: '👍' },
            { type: 'insert', text: '🏽' },
        ])
        expect(Buffer.concat(tokens.map(token => token.raw))).toEqual(bytes)
    })

    test('rejects an invalid UTF-8 prefix immediately without holding following text', () => {
        const decoder = new TerminalInputDecoder()
        const tokens = decoder.decode(Buffer.from([0xf0, 0x61]))
        expect(tokens).toEqual([
            { action: { type: 'unknown' }, raw: Buffer.from([0xf0]) },
            { action: { type: 'insert', text: 'a' }, raw: Buffer.from('a') },
        ])
        expect(decoder.hasPending).toBe(false)
    })

    test('flushes a truly truncated UTF-8 prefix as unknown raw bytes', () => {
        const decoder = new TerminalInputDecoder()
        const raw = Buffer.from([0xf0, 0x9f])
        expect(decoder.decode(raw)).toEqual([])
        expect(decoder.hasPending).toBe(true)
        expect(decoder.flush()).toEqual([{ action: { type: 'unknown' }, raw }])
        expect(decoder.hasPending).toBe(false)
    })

    test('waits for complete known and unknown escape sequences split across chunks', () => {
        const decoder = new TerminalInputDecoder()
        expect(decoder.decode(Buffer.from([0x1b]))).toEqual([])
        expect(decoder.decode(Buffer.from([0x5b]))).toEqual([])
        const left = decoder.decode(Buffer.from([0x44]))
        expect(left).toEqual([{ action: { type: 'left' }, raw: Buffer.from([0x1b, 0x5b, 0x44]) }])

        expect(decoder.decode(Buffer.from([0x1b, 0x5b, 0x39]))).toEqual([])
        expect(decoder.decode(Buffer.from([0x39]))).toEqual([])
        const unknown = decoder.decode(Buffer.from([0x7e]))
        expect(unknown).toEqual([{
            action: { type: 'unknown' },
            raw: Buffer.from([0x1b, 0x5b, 0x39, 0x39, 0x7e]),
        }])
    })

    test('flushes a lone Escape explicitly and incomplete escape sequences as unknown', () => {
        const decoder = new TerminalInputDecoder()
        expect(decoder.decode(Buffer.from([0x1b]))).toEqual([])
        expect(decoder.hasPending).toBe(true)
        expect(decoder.flush()).toEqual([{
            action: { type: 'escape' },
            raw: Buffer.from([0x1b]),
        }])
        expect(decoder.hasPending).toBe(false)

        const incomplete = Buffer.from('\x1b[2')
        expect(decoder.decode(incomplete)).toEqual([])
        expect(decoder.flush()).toEqual([{
            action: { type: 'unknown' },
            raw: incomplete,
        }])
    })

    test('keeps bracketed paste markers and content ordered across arbitrary chunks', () => {
        const decoder = new TerminalInputDecoder()
        const chunks = [
            Buffer.from([0x1b]),
            Buffer.from('[20'),
            Buffer.from('0~echo 👍\nnext\x1b[2'),
            Buffer.from('01'),
            Buffer.from('~z'),
        ]
        const tokens = chunks.flatMap(chunk => decoder.decode(chunk))
        expect(tokens.map(token => token.action)).toEqual([
            { type: 'paste', text: '' },
            { type: 'paste', text: 'echo 👍\nnext' },
            { type: 'paste', text: '' },
            { type: 'insert', text: 'z' },
        ])
        expect(Buffer.concat(tokens.map(token => token.raw))).toEqual(Buffer.concat(chunks))
    })

    test('decodes every byte boundary in bracketed paste without replacement text', () => {
        const decoder = new TerminalInputDecoder()
        const bytes = Buffer.from('\x1b[200~one\n👍\x1b[201~')
        const tokens = []
        for (const byte of bytes) {
            tokens.push(...decoder.decode(Buffer.from([byte])))
        }
        expect(tokens.map(token => token.action)).toEqual([
            { type: 'paste', text: '' },
            { type: 'paste', text: 'o' },
            { type: 'paste', text: 'n' },
            { type: 'paste', text: 'e' },
            { type: 'paste', text: '\n' },
            { type: 'paste', text: '👍' },
            { type: 'paste', text: '' },
        ])
        expect(Buffer.concat(tokens.map(token => token.raw))).toEqual(bytes)
    })

    test('flush resets unfinished bracketed paste while preserving its pending marker bytes', () => {
        const decoder = new TerminalInputDecoder()
        const start = Buffer.from('\x1b[200~')
        const partialEnd = Buffer.from('\x1b[20')
        const tokens = [
            ...decoder.decode(start),
            ...decoder.decode(Buffer.from('data')),
            ...decoder.decode(partialEnd),
        ]
        expect(decoder.hasPending).toBe(true)
        tokens.push(...decoder.flush())
        expect(tokens.map(token => token.action)).toEqual([
            { type: 'paste', text: '' },
            { type: 'paste', text: 'data' },
            { type: 'unknown' },
        ])
        expect(Buffer.concat(tokens.map(token => token.raw))).toEqual(Buffer.concat([start, Buffer.from('data'), partialEnd]))
        expect(decoder.hasPending).toBe(false)
        expect(decoder.decode(Buffer.from('x'))[0].action).toEqual({ type: 'insert', text: 'x' })
    })

    test('turns unknown control bytes into unknown actions without losing surrounding text', () => {
        const decoder = new TerminalInputDecoder()
        const bytes = Buffer.from([0x61, 0x09, 0x62])
        const tokens = decoder.decode(bytes)
        expect(tokens.map(token => token.action)).toEqual([
            { type: 'insert', text: 'a' },
            { type: 'unknown' },
            { type: 'insert', text: 'b' },
        ])
        expect(Buffer.concat(tokens.map(token => token.raw))).toEqual(bytes)
    })
})

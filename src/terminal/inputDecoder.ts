import { EditAction } from './commandBuffer'

export interface DecodedInputToken {
    action: TerminalInputAction
    raw: Buffer
}

export type TerminalInputAction = EditAction |
    { type: 'up' } |
    { type: 'down' } |
    { type: 'escape' } |
    { type: 'ctrlUp' } |
    { type: 'ctrlDown' } |
    { type: 'ctrlRight' }

const ESC = 0x1b
const BRACKETED_PASTE_START = Buffer.from('\x1b[200~')
const BRACKETED_PASTE_END = Buffer.from('\x1b[201~')

const controls = new Map<number, EditAction>([
    [0x01, { type: 'home' }],
    [0x03, { type: 'interrupt' }],
    [0x05, { type: 'end' }],
    [0x08, { type: 'backspace' }],
    [0x0b, { type: 'deleteEnd' }],
    [0x0d, { type: 'enter' }],
    [0x0a, { type: 'enter' }],
    [0x15, { type: 'deleteStart' }],
    [0x17, { type: 'deleteWord' }],
    [0x7f, { type: 'backspace' }],
])

const escapeActions = new Map<string, TerminalInputAction>([
    ['\x1b[A', { type: 'up' }],
    ['\x1b[B', { type: 'down' }],
    ['\x1b[C', { type: 'right' }],
    ['\x1b[D', { type: 'left' }],
    ['\x1b[H', { type: 'home' }],
    ['\x1b[F', { type: 'end' }],
    ['\x1b[1~', { type: 'home' }],
    ['\x1b[4~', { type: 'end' }],
    ['\x1b[7~', { type: 'home' }],
    ['\x1b[8~', { type: 'end' }],
    ['\x1b[3~', { type: 'delete' }],
    ['\x1bOA', { type: 'up' }],
    ['\x1bOB', { type: 'down' }],
    ['\x1bOC', { type: 'right' }],
    ['\x1bOD', { type: 'left' }],
    ['\x1bOH', { type: 'home' }],
    ['\x1bOF', { type: 'end' }],
    ['\x1b[1;5A', { type: 'ctrlUp' }],
    ['\x1b[1;5B', { type: 'ctrlDown' }],
    ['\x1b[1;5C', { type: 'ctrlRight' }],
])

interface EscapeSequence {
    length: number
    action: TerminalInputAction
    pasteStart?: true
}

export class TerminalInputDecoder {
    private pending = Buffer.alloc(0)
    private bracketedPaste = false

    get hasPending (): boolean {
        return this.pending.length > 0 || this.bracketedPaste
    }

    decode (data: Buffer): DecodedInputToken[] {
        if (data.length === 0) {
            return []
        }

        const input = this.pending.length === 0 ? data : Buffer.concat([this.pending, data])
        this.pending = Buffer.alloc(0)
        const tokens: DecodedInputToken[] = []
        let offset = 0

        while (offset < input.length) {
            if (this.bracketedPaste) {
                const end = input.indexOf(BRACKETED_PASTE_END, offset)
                const interrupt = input.indexOf(0x03, offset)
                if (interrupt !== -1 && (end === -1 || interrupt < end)) {
                    emitUtf8(input.subarray(offset, interrupt), 'paste', false, tokens)
                    tokens.push({
                        action: { type: 'interrupt' },
                        raw: copy(input.subarray(interrupt, interrupt + 1)),
                    })
                    offset = interrupt + 1
                    this.bracketedPaste = false
                    continue
                }
                if (end !== -1) {
                    emitUtf8(input.subarray(offset, end), 'paste', false, tokens)
                    tokens.push({ action: { type: 'paste', text: '' }, raw: copy(BRACKETED_PASTE_END) })
                    offset = end + BRACKETED_PASTE_END.length
                    this.bracketedPaste = false
                    continue
                }

                const markerPrefixLength = longestSuffixPrefix(input.subarray(offset), BRACKETED_PASTE_END)
                const contentEnd = input.length - markerPrefixLength
                const content = input.subarray(offset, contentEnd)
                const consumed = emitUtf8(content, 'paste', true, tokens)
                this.pending = copy(input.subarray(offset + consumed))
                break
            }

            const byte = input[offset]
            if (byte === ESC) {
                const sequence = parseEscape(input, offset)
                if (!sequence) {
                    this.pending = copy(input.subarray(offset))
                    break
                }
                const raw = copy(input.subarray(offset, offset + sequence.length))
                tokens.push({ action: sequence.action, raw })
                offset += sequence.length
                if (sequence.pasteStart) {
                    this.bracketedPaste = true
                }
                continue
            }

            if (byte < 0x20 || byte === 0x7f) {
                tokens.push({ action: controls.get(byte) ?? { type: 'unknown' }, raw: copy(input.subarray(offset, offset + 1)) })
                offset++
                continue
            }

            let end = offset + 1
            while (end < input.length && input[end] >= 0x20 && input[end] !== 0x7f && input[end] !== ESC) {
                end++
            }
            const text = input.subarray(offset, end)
            const consumed = emitUtf8(text, 'insert', end === input.length, tokens)
            offset += consumed
            if (consumed < text.length) {
                this.pending = copy(input.subarray(offset))
                break
            }
        }

        return tokens
    }

    flush (): DecodedInputToken[] {
        const raw = this.pending
        const wasBracketedPaste = this.bracketedPaste
        this.pending = Buffer.alloc(0)
        this.bracketedPaste = false

        if (raw.length === 0) {
            return wasBracketedPaste
                ? [{ action: { type: 'unknown' }, raw }]
                : []
        }
        if (!wasBracketedPaste && raw.length === 1 && raw[0] === ESC) {
            return [{ action: { type: 'escape' }, raw }]
        }
        return [{ action: { type: 'unknown' }, raw }]
    }
}

function parseEscape (input: Buffer, offset: number): EscapeSequence | null {
    if (offset + 1 >= input.length) {
        return null
    }

    const introducer = input[offset + 1]
    if (introducer === 0x5b) {
        return parseCsi(input, offset)
    }
    if (introducer === 0x4f) {
        if (offset + 2 >= input.length) {
            return null
        }
        const final = input[offset + 2]
        if (final < 0x30 || final > 0x7e) {
            return { length: 2, action: { type: 'unknown' } }
        }
        return knownEscape(input.subarray(offset, offset + 3))
    }
    if (introducer >= 0x20 && introducer <= 0x2f) {
        let end = offset + 2
        while (end < input.length && input[end] >= 0x20 && input[end] <= 0x2f) {
            end++
        }
        if (end >= input.length) {
            return null
        }
        if (input[end] < 0x30 || input[end] > 0x7e) {
            return { length: end - offset, action: { type: 'unknown' } }
        }
        return { length: end - offset + 1, action: { type: 'unknown' } }
    }
    if (introducer >= 0x30 && introducer <= 0x7e) {
        return { length: 2, action: { type: 'unknown' } }
    }
    return { length: 1, action: { type: 'unknown' } }
}

function parseCsi (input: Buffer, offset: number): EscapeSequence | null {
    let end = offset + 2
    while (end < input.length) {
        const byte = input[end]
        if (byte >= 0x40 && byte <= 0x7e) {
            const raw = input.subarray(offset, end + 1)
            if (raw.equals(BRACKETED_PASTE_START)) {
                return { length: raw.length, action: { type: 'paste', text: '' }, pasteStart: true }
            }
            return knownEscape(raw)
        }
        if ((byte >= 0x30 && byte <= 0x3f) || (byte >= 0x20 && byte <= 0x2f)) {
            end++
            continue
        }
        return { length: end - offset, action: { type: 'unknown' } }
    }
    return null
}

function knownEscape (raw: Buffer): EscapeSequence {
    return {
        length: raw.length,
        action: escapeActions.get(raw.toString('latin1')) ?? { type: 'unknown' },
    }
}

function emitUtf8 (
    raw: Buffer,
    type: 'insert' | 'paste',
    allowIncomplete: boolean,
    tokens: DecodedInputToken[],
): number {
    let offset = 0
    let textStart = 0

    const flushText = (end: number): void => {
        if (textStart < end) {
            const bytes = copy(raw.subarray(textStart, end))
            tokens.push({ action: { type, text: bytes.toString('utf8') }, raw: bytes })
        }
    }

    while (offset < raw.length) {
        const length = utf8Length(raw[offset])
        if (length === 0) {
            flushText(offset)
            tokens.push({ action: { type: 'unknown' }, raw: copy(raw.subarray(offset, offset + 1)) })
            offset++
            textStart = offset
            continue
        }
        if (offset + length > raw.length) {
            if (!validUtf8Prefix(raw, offset, length)) {
                flushText(offset)
                tokens.push({ action: { type: 'unknown' }, raw: copy(raw.subarray(offset, offset + 1)) })
                offset++
                textStart = offset
                continue
            }
            if (allowIncomplete) {
                flushText(offset)
                return offset
            }
            flushText(offset)
            tokens.push({ action: { type: 'unknown' }, raw: copy(raw.subarray(offset, offset + 1)) })
            offset++
            textStart = offset
            continue
        }
        if (!validUtf8(raw, offset, length)) {
            flushText(offset)
            tokens.push({ action: { type: 'unknown' }, raw: copy(raw.subarray(offset, offset + 1)) })
            offset++
            textStart = offset
            continue
        }
        offset += length
    }

    flushText(offset)
    return offset
}

function utf8Length (lead: number): number {
    if (lead <= 0x7f) {
        return 1
    }
    if (lead >= 0xc2 && lead <= 0xdf) {
        return 2
    }
    if (lead >= 0xe0 && lead <= 0xef) {
        return 3
    }
    if (lead >= 0xf0 && lead <= 0xf4) {
        return 4
    }
    return 0
}

function validUtf8 (raw: Buffer, offset: number, length: number): boolean {
    return validUtf8Prefix(raw, offset, length)
}

function validUtf8Prefix (raw: Buffer, offset: number, length: number): boolean {
    const available = Math.min(length, raw.length - offset)
    for (let index = 1; index < available; index++) {
        if (raw[offset + index] < 0x80 || raw[offset + index] > 0xbf) {
            return false
        }
    }
    const lead = raw[offset]
    const second = raw[offset + 1]
    if (available < 2) {
        return true
    }
    if (lead === 0xe0 && second < 0xa0) {
        return false
    }
    if (lead === 0xed && second > 0x9f) {
        return false
    }
    if (lead === 0xf0 && second < 0x90) {
        return false
    }
    return lead !== 0xf4 || second <= 0x8f
}

function longestSuffixPrefix (raw: Buffer, marker: Buffer): number {
    const maximum = Math.min(raw.length, marker.length - 1)
    for (let length = maximum; length > 0; length--) {
        if (raw.subarray(raw.length - length).equals(marker.subarray(0, length))) {
            return length
        }
    }
    return 0
}

function copy (raw: Buffer): Buffer {
    return Buffer.from(raw)
}

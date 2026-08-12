import { SessionMiddleware } from 'tabby-terminal'
import { TerminalInputAction, TerminalInputDecoder } from './inputDecoder'

export interface InputRouteDecision {
    consume: boolean
    action?: TerminalInputAction
}

export interface ReplacementInput {
    current: string
    cursor: number
    candidate: string
}

export type InputRouter = (action: TerminalInputAction) => InputRouteDecision

const RIGHT = Buffer.from('\x1b[C')
const BACKSPACE = Buffer.from([0x7f])
const BRACKETED_PASTE_START = Buffer.from('\x1b[200~')
const BRACKETED_PASTE_END = Buffer.from('\x1b[201~')
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export class CommandInputMiddleware extends SessionMiddleware {
    private readonly decoder = new TerminalInputDecoder()

    constructor (private readonly router: InputRouter) {
        super()
    }

    override feedFromTerminal (data: Buffer): void {
        for (const token of this.decoder.decode(data)) {
            let consume = false
            try {
                consume = this.router(token.action)?.consume === true
            } catch {
                consume = false
            }
            if (!consume) {
                this.outputToSession.next(token.raw)
            }
        }
    }

    injectReplacement ({ current, cursor, candidate }: ReplacementInput): void {
        assertSingleLine(current, 'current command')
        assertSingleLine(candidate, 'replacement candidate')
        const currentLength = graphemes(current).length
        if (!Number.isInteger(cursor) || cursor < 0 || cursor > currentLength) {
            throw new RangeError('cursor must be a valid grapheme index')
        }

        if (cursor === currentLength && candidate.startsWith(current)) {
            this.emit(Buffer.from(candidate.slice(current.length)))
            return
        }

        this.emitRepeated(RIGHT, currentLength - cursor)
        this.emitRepeated(BACKSPACE, currentLength)
        this.emit(Buffer.from(candidate))
    }

    injectBracketedPaste (candidate: string): void {
        if (!candidate.includes('\n') || candidate.endsWith('\n')) {
            throw new Error('bracketed paste requires an intentional multiline candidate')
        }
        if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(candidate)) {
            throw new Error('bracketed paste candidate contains unsafe control bytes')
        }
        this.emit(Buffer.concat([
            BRACKETED_PASTE_START,
            Buffer.from(candidate),
            BRACKETED_PASTE_END,
        ]))
    }

    private emitRepeated (bytes: Buffer, count: number): void {
        if (count > 0) {
            this.outputToSession.next(Buffer.concat(Array.from({ length: count }, () => bytes)))
        }
    }

    private emit (bytes: Buffer): void {
        if (bytes.length > 0) {
            this.outputToSession.next(bytes)
        }
    }
}

function assertSingleLine (text: string, label: string): void {
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
        throw new Error(`${label} must not contain terminal control bytes`)
    }
}

function graphemes (text: string): string[] {
    return Array.from(graphemeSegmenter.segment(text), part => part.segment)
}

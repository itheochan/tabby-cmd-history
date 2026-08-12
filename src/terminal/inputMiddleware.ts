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

export interface BracketedReplacementInput extends ReplacementInput {}

export type InputRouter = (action: TerminalInputAction) => InputRouteDecision

export interface CommandInputMiddlewareOptions {
    pendingTimeoutMs?: number
}

const RIGHT = Buffer.from('\x1b[C')
const BACKSPACE = Buffer.from([0x7f])
const BRACKETED_PASTE_START = Buffer.from('\x1b[200~')
const BRACKETED_PASTE_END = Buffer.from('\x1b[201~')
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export class CommandInputMiddleware extends SessionMiddleware {
    private readonly decoder = new TerminalInputDecoder()
    private readonly pendingTimeoutMs: number
    private pendingTimer: ReturnType<typeof setTimeout> | null = null

    constructor (
        private readonly router: InputRouter,
        options: CommandInputMiddlewareOptions = {},
    ) {
        super()
        this.pendingTimeoutMs = options.pendingTimeoutMs ?? 25
    }

    override feedFromTerminal (data: Buffer): void {
        this.clearPendingTimer()
        this.route(this.decoder.decode(data))
        if (this.decoder.hasPending) {
            this.pendingTimer = setTimeout(() => {
                this.pendingTimer = null
                this.route(this.decoder.flush())
            }, this.pendingTimeoutMs)
        }
    }

    override close (): void {
        this.clearPendingTimer()
        this.route(this.decoder.flush())
        super.close()
    }

    injectReplacement ({ current, cursor, candidate }: ReplacementInput): void {
        assertSingleLine(current, 'current command')
        assertSingleLine(candidate, 'replacement candidate')
        const currentLength = graphemes(current).length
        if (!Number.isInteger(cursor) || cursor < 0 || cursor > currentLength) {
            throw new RangeError('cursor must be a valid grapheme index')
        }

        if (cursor === currentLength && candidate.startsWith(current) && isGraphemeBoundary(candidate, current.length)) {
            this.emit(Buffer.from(candidate.slice(current.length)))
            return
        }

        this.emitRepeated(RIGHT, currentLength - cursor)
        this.emitRepeated(BACKSPACE, currentLength)
        this.emit(Buffer.from(candidate))
    }

    injectBracketedPaste (candidate: string): void {
        validateBracketedPaste(candidate)
        this.emit(bracketedPaste(candidate))
    }

    injectBracketedReplacement ({ current, cursor, candidate }: BracketedReplacementInput): void {
        assertSafeBuffer(current, 'current command')
        validateBracketedPaste(candidate)
        const currentLength = graphemes(current).length
        if (!Number.isInteger(cursor) || cursor < 0 || cursor > currentLength) {
            throw new RangeError('cursor must be a valid grapheme index')
        }

        this.emitRepeated(RIGHT, currentLength - cursor)
        this.emitRepeated(BACKSPACE, currentLength)
        this.emit(bracketedPaste(candidate))
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

    private route (tokens: ReturnType<TerminalInputDecoder['decode']>): void {
        for (const token of tokens) {
            let consume = false
            try {
                consume = this.router(token.action)?.consume === true
            } catch {
                consume = false
            }
            if (token.action.type === 'unknown' || !consume) {
                if (token.raw.length > 0) {
                    this.outputToSession.next(token.raw)
                }
            }
        }
    }

    private clearPendingTimer (): void {
        if (this.pendingTimer !== null) {
            clearTimeout(this.pendingTimer)
            this.pendingTimer = null
        }
    }
}

function assertSingleLine (text: string, label: string): void {
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
        throw new Error(`${label} must not contain terminal control bytes`)
    }
}

function assertSafeBuffer (text: string, label: string): void {
    if (/[^\r\n\t\u0020-\u007e\u00a0-\u{10ffff}]/u.test(text)) {
        throw new Error(`${label} contains unsafe terminal control bytes`)
    }
}

function validateBracketedPaste (candidate: string): void {
    if (!candidate.includes('\n') && !candidate.includes('\r')) {
        throw new Error('bracketed paste requires an intentional multiline candidate')
    }
    if (/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f]/u.test(candidate)) {
        throw new Error('bracketed paste candidate contains unsafe control bytes')
    }
}

function bracketedPaste (candidate: string): Buffer {
    return Buffer.concat([BRACKETED_PASTE_START, Buffer.from(candidate), BRACKETED_PASTE_END])
}

function graphemes (text: string): string[] {
    return Array.from(graphemeSegmenter.segment(text), part => part.segment)
}

function isGraphemeBoundary (text: string, offset: number): boolean {
    return offset === text.length || Array.from(graphemeSegmenter.segment(text), part => part.index).includes(offset)
}

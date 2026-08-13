export type EditAction =
    | { type: 'insert' | 'paste'; text: string }
    | { type: 'left' | 'right' | 'home' | 'end' | 'backspace' | 'delete' }
    | { type: 'deleteStart' | 'deleteEnd' | 'deleteWord' }
    | { type: 'unknown' | 'enter' | 'interrupt' }
    | { type: 'alternate'; active: boolean }

export interface BufferState {
    text: string
    cursor: number
    confident: boolean
    dismissed: boolean
}

export type BufferEffect = { submitted?: string | null; interrupted?: true }

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export class CommandBuffer {
    private graphemes: string[] = []
    private cursor = 0
    private confident = true
    private dismissed = false
    private alternateActive = false

    apply (action: EditAction): BufferEffect {
        if (action.type === 'alternate') {
            this.alternateActive = action.active
            this.reset()
            return {}
        }

        if (this.alternateActive) {
            return {}
        }

        switch (action.type) {
            case 'insert':
            case 'paste':
                this.replace(this.cursor, this.cursor, action.text)
                return {}
            case 'left':
                this.cursor = Math.max(0, this.cursor - 1)
                return {}
            case 'right':
                this.cursor = Math.min(this.graphemes.length, this.cursor + 1)
                return {}
            case 'home':
                this.cursor = 0
                return {}
            case 'end':
                this.cursor = this.graphemes.length
                return {}
            case 'backspace':
                if (this.cursor > 0) {
                    this.replace(this.cursor - 1, this.cursor, '')
                }
                return {}
            case 'delete':
                if (this.cursor < this.graphemes.length) {
                    this.replace(this.cursor, this.cursor + 1, '')
                }
                return {}
            case 'deleteStart':
                this.replace(0, this.cursor, '')
                return {}
            case 'deleteEnd':
                this.replace(this.cursor, this.graphemes.length, '')
                return {}
            case 'deleteWord':
                this.deleteWord()
                return {}
            case 'unknown':
                // The shell may have rewritten the visible line (Tab completion, shell
                // history, unobservable control sequences). Retaining the old text would
                // diverge from the actual line, so clear it and stay untrusted until a
                // trusted rebuild or a reset (Enter / Ctrl+C / alternate screen).
                this.reset()
                this.confident = false
                return {}
            case 'enter': {
                const submitted = this.confident && this.graphemes.length > 0
                    ? this.graphemes.join('')
                    : null
                this.reset()
                return { submitted }
            }
            case 'interrupt':
                this.reset()
                return { interrupted: true }
        }
    }

    snapshot (): BufferState {
        return {
            text: this.graphemes.join(''),
            cursor: this.cursor,
            confident: this.confident,
            dismissed: this.dismissed,
        }
    }

    reset (): void {
        this.graphemes = []
        this.cursor = 0
        this.confident = true
        this.dismissed = false
    }

    dismiss (): void {
        this.dismissed = true
    }

    adopt (text: string): void {
        this.graphemes = segment(text)
        this.cursor = this.graphemes.length
        this.confident = true
        this.dismissed = false
    }

    private deleteWord (): void {
        let start = this.cursor
        while (start > 0 && /^\s$/u.test(this.graphemes[start - 1])) {
            start--
        }
        while (start > 0 && !/^\s$/u.test(this.graphemes[start - 1])) {
            start--
        }
        this.replace(start, this.cursor, '')
    }

    private replace (start: number, end: number, inserted: string): void {
        const text = this.graphemes.join('')
        const startOffset = offsetAt(this.graphemes, start)
        const endOffset = offsetAt(this.graphemes, end)
        const cursorOffset = startOffset + inserted.length
        const updated = text.slice(0, startOffset) + inserted + text.slice(endOffset)
        this.graphemes = segment(updated)
        this.cursor = cursorAtOrAfterOffset(this.graphemes, cursorOffset)
        this.dismissed = false
    }
}

function segment (text: string): string[] {
    return Array.from(graphemeSegmenter.segment(text), part => part.segment)
}

function offsetAt (graphemes: readonly string[], cursor: number): number {
    return graphemes.slice(0, cursor).reduce((offset, grapheme) => offset + grapheme.length, 0)
}

function cursorAtOrAfterOffset (graphemes: readonly string[], offset: number): number {
    if (offset === 0) {
        return 0
    }

    let endOffset = 0
    for (let cursor = 0; cursor < graphemes.length; cursor++) {
        endOffset += graphemes[cursor].length
        if (endOffset >= offset) {
            return cursor + 1
        }
    }
    return graphemes.length
}

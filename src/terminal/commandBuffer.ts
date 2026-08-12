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
            case 'paste': {
                const inserted = segment(action.text)
                this.graphemes.splice(this.cursor, 0, ...inserted)
                this.cursor += inserted.length
                return {}
            }
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
                    this.graphemes.splice(--this.cursor, 1)
                }
                return {}
            case 'delete':
                if (this.cursor < this.graphemes.length) {
                    this.graphemes.splice(this.cursor, 1)
                }
                return {}
            case 'deleteStart':
                this.graphemes.splice(0, this.cursor)
                this.cursor = 0
                return {}
            case 'deleteEnd':
                this.graphemes.splice(this.cursor)
                return {}
            case 'deleteWord':
                this.deleteWord()
                return {}
            case 'unknown':
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

    private deleteWord (): void {
        let start = this.cursor
        while (start > 0 && /^\s$/u.test(this.graphemes[start - 1])) {
            start--
        }
        while (start > 0 && !/^\s$/u.test(this.graphemes[start - 1])) {
            start--
        }
        this.graphemes.splice(start, this.cursor - start)
        this.cursor = start
    }
}

function segment (text: string): string[] {
    return Array.from(graphemeSegmenter.segment(text), part => part.segment)
}

import { CommandBuffer } from '../../src/terminal/commandBuffer'

describe('CommandBuffer', () => {
    test('edits Unicode graphemes', () => {
        const buffer = new CommandBuffer()
        buffer.apply({ type: 'insert', text: 'git 👨‍👩‍👧‍👦x' })
        buffer.apply({ type: 'left' })
        buffer.apply({ type: 'backspace' })
        expect(buffer.snapshot()).toMatchObject({ text: 'git x', cursor: 4, confident: true })
    })

    test('re-segments a combining mark inserted after its base character', () => {
        const buffer = new CommandBuffer()
        buffer.apply({ type: 'insert', text: 'e' })
        buffer.apply({ type: 'insert', text: '\u0301' })
        expect(buffer.snapshot()).toMatchObject({ text: 'é', cursor: 1 })
        buffer.apply({ type: 'backspace' })
        expect(buffer.snapshot()).toMatchObject({ text: '', cursor: 0 })
    })

    test('re-segments a ZWJ family assembled across insert actions', () => {
        const buffer = new CommandBuffer()
        for (const text of ['👨', '\u200d', '👩', '\u200d', '👧', '\u200d', '👦']) {
            buffer.apply({ type: 'insert', text })
        }
        expect(buffer.snapshot()).toMatchObject({ text: '👨‍👩‍👧‍👦', cursor: 1 })
        buffer.apply({ type: 'backspace' })
        expect(buffer.snapshot()).toMatchObject({ text: '', cursor: 0 })
    })

    test('keeps the cursor on a boundary when insertion merges both adjacent graphemes', () => {
        const buffer = new CommandBuffer()
        buffer.apply({ type: 'insert', text: '👨👩' })
        buffer.apply({ type: 'left' })
        buffer.apply({ type: 'insert', text: '\u200d' })
        expect(buffer.snapshot()).toMatchObject({ text: '👨‍👩', cursor: 1 })
        buffer.apply({ type: 'insert', text: 'x' })
        expect(buffer.snapshot()).toMatchObject({ text: '👨‍👩x', cursor: 2 })
    })

    test('inserts and pastes at the grapheme cursor', () => {
        const buffer = new CommandBuffer()
        buffer.apply({ type: 'insert', text: 'ac' })
        buffer.apply({ type: 'left' })
        buffer.apply({ type: 'paste', text: '🇺🇳b' })
        expect(buffer.snapshot()).toEqual({ text: 'a🇺🇳bc', cursor: 3, confident: true, dismissed: false })
    })

    test('backspace and delete remove whole graphemes', () => {
        const buffer = new CommandBuffer()
        buffer.apply({ type: 'insert', text: 'é👍🏽!' })
        buffer.apply({ type: 'left' })
        buffer.apply({ type: 'backspace' })
        buffer.apply({ type: 'home' })
        buffer.apply({ type: 'delete' })
        expect(buffer.snapshot()).toEqual({ text: '!', cursor: 0, confident: true, dismissed: false })
    })

    test('left, right, home, and end move within grapheme bounds', () => {
        const buffer = new CommandBuffer()
        buffer.apply({ type: 'insert', text: 'a👨‍👩‍👧‍👦b' })
        buffer.apply({ type: 'home' })
        buffer.apply({ type: 'left' })
        expect(buffer.snapshot().cursor).toBe(0)
        buffer.apply({ type: 'right' })
        expect(buffer.snapshot().cursor).toBe(1)
        buffer.apply({ type: 'end' })
        buffer.apply({ type: 'right' })
        expect(buffer.snapshot().cursor).toBe(3)
    })

    test('Ctrl+A and Ctrl+E actions move to the start and end', () => {
        const buffer = new CommandBuffer()
        buffer.apply({ type: 'insert', text: 'echo' })
        buffer.apply({ type: 'home' })
        expect(buffer.snapshot().cursor).toBe(0)
        buffer.apply({ type: 'end' })
        expect(buffer.snapshot().cursor).toBe(4)
    })

    test('Ctrl+U and Ctrl+K actions delete to the start and end', () => {
        const buffer = new CommandBuffer()
        buffer.apply({ type: 'insert', text: 'abcdef' })
        buffer.apply({ type: 'left' })
        buffer.apply({ type: 'left' })
        buffer.apply({ type: 'deleteStart' })
        expect(buffer.snapshot()).toMatchObject({ text: 'ef', cursor: 0 })
        buffer.apply({ type: 'right' })
        buffer.apply({ type: 'deleteEnd' })
        expect(buffer.snapshot()).toMatchObject({ text: 'e', cursor: 1 })
    })

    test('Ctrl+W action deletes the preceding whitespace-delimited word', () => {
        const buffer = new CommandBuffer()
        buffer.apply({ type: 'insert', text: 'git status  ' })
        buffer.apply({ type: 'deleteWord' })
        expect(buffer.snapshot()).toMatchObject({ text: 'git ', cursor: 4 })
    })

    test('unknown input loses confidence until Enter', () => {
        const buffer = new CommandBuffer()
        buffer.apply({ type: 'insert', text: 'git' })
        buffer.apply({ type: 'unknown' })
        buffer.apply({ type: 'insert', text: ' status' })
        expect(buffer.snapshot().confident).toBe(false)
        expect(buffer.apply({ type: 'enter' })).toEqual({ submitted: null })
        expect(buffer.snapshot()).toEqual({ text: '', cursor: 0, confident: true, dismissed: false })
    })

    test('Enter submits trustworthy non-empty text and resets all state', () => {
        const buffer = new CommandBuffer()
        buffer.apply({ type: 'insert', text: 'echo 👍🏽' })
        buffer.dismiss()
        expect(buffer.apply({ type: 'enter' })).toEqual({ submitted: 'echo 👍🏽' })
        expect(buffer.snapshot()).toEqual({ text: '', cursor: 0, confident: true, dismissed: false })
        expect(buffer.apply({ type: 'enter' })).toEqual({ submitted: null })
    })

    test('Ctrl+C clears all state', () => {
        const buffer = new CommandBuffer()
        buffer.apply({ type: 'insert', text: 'danger' })
        buffer.dismiss()
        expect(buffer.apply({ type: 'interrupt' })).toEqual({ interrupted: true })
        expect(buffer.snapshot()).toEqual({ text: '', cursor: 0, confident: true, dismissed: false })
    })

    test('alternate screen ignores edits until it becomes inactive', () => {
        const buffer = new CommandBuffer()
        buffer.apply({ type: 'insert', text: 'partial' })
        buffer.apply({ type: 'alternate', active: true })
        buffer.apply({ type: 'insert', text: ':q' })
        buffer.apply({ type: 'backspace' })
        expect(buffer.snapshot()).toEqual({ text: '', cursor: 0, confident: true, dismissed: false })
        buffer.apply({ type: 'alternate', active: false })
        buffer.apply({ type: 'insert', text: 'pwd' })
        expect(buffer.snapshot().text).toBe('pwd')
    })

    test('reset and dismiss expose explicit lifecycle state', () => {
        const buffer = new CommandBuffer()
        buffer.apply({ type: 'insert', text: 'ls' })
        buffer.dismiss()
        expect(buffer.snapshot().dismissed).toBe(true)
        buffer.reset()
        expect(buffer.snapshot()).toEqual({ text: '', cursor: 0, confident: true, dismissed: false })
    })

    test('editing actions at buffer boundaries are no-ops', () => {
        const buffer = new CommandBuffer()
        buffer.apply({ type: 'backspace' })
        buffer.apply({ type: 'delete' })
        buffer.apply({ type: 'deleteStart' })
        buffer.apply({ type: 'deleteEnd' })
        buffer.apply({ type: 'deleteWord' })
        buffer.apply({ type: 'left' })
        buffer.apply({ type: 'right' })
        expect(buffer.snapshot()).toEqual({ text: '', cursor: 0, confident: true, dismissed: false })
    })
})

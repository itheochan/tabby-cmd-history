import { TerminalGeometryAdapter } from '../../src/terminal/terminalGeometryAdapter'
import { VisibleEchoVerifier } from '../../src/terminal/visibleEchoVerifier'

function rect (left: number, top: number, width: number, height: number): DOMRect {
    return {
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        toJSON: () => ({}),
    }
}

test('visible echo accepts a command suffix and rejects hidden input', () => {
    const verifier = new VisibleEchoVerifier()

    expect(verifier.matches(['PS C:\\> git status'], 'git status')).toBe(true)
    expect(verifier.matches(['Password:'], 'hunter2')).toBe(false)
})

test('normalizes line endings and trailing line whitespace', () => {
    const verifier = new VisibleEchoVerifier()

    expect(verifier.matches(['PS> echo one   ', '>> two\t'], 'echo one\r\ntwo')).toBe(true)
})

test('fails closed when visible evidence is unavailable, incomplete, or mismatched', () => {
    const verifier = new VisibleEchoVerifier()

    expect(verifier.matches(undefined, 'git status')).toBe(false)
    expect(verifier.matches([], 'git status')).toBe(false)
    expect(verifier.matches(['PS> echo one'], 'echo one\ntwo')).toBe(false)
    expect(verifier.matches(['PS> echo one', 'Password:'], 'echo one\ntwo')).toBe(false)
    expect(verifier.matches(['PS>'], '   ')).toBe(false)
})

test('compares multiline commands line-by-line without interpreting continuation prompts', () => {
    const verifier = new VisibleEchoVerifier()

    expect(verifier.matches(['arbitrary> printf one', 'anything> second'], 'printf one\nsecond')).toBe(true)
    expect(verifier.matches(['arbitrary> printf one', 'anything> secon'], 'printf one\nsecond')).toBe(false)
})

test('measures cursor-relative geometry and keeps an overlay below when it fits', () => {
    const host = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    host.append(screen)
    host.getBoundingClientRect = () => rect(100, 50, 300, 200)
    screen.getBoundingClientRect = () => rect(110, 60, 200, 100)

    const position = new TerminalGeometryAdapter().measure(
        host,
        { cursorX: 2, cursorY: 2, cols: 20, rows: 10 },
        { width: 80, height: 40 },
    )

    expect(position).toEqual({ left: 30, top: 40, above: false, maxWidth: 80, maxHeight: 40 })
})

test('flips above when below lacks room and clamps within the xterm screen', () => {
    const host = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    host.append(screen)
    host.getBoundingClientRect = () => rect(100, 50, 300, 200)
    screen.getBoundingClientRect = () => rect(110, 60, 200, 100)

    const position = new TerminalGeometryAdapter().measure(
        host,
        { cursorX: 19, cursorY: 8, cols: 20, rows: 10 },
        { width: 80, height: 40 },
    )

    expect(position).toEqual({ left: 130, top: 50, above: true, maxWidth: 80, maxHeight: 40 })
    expect((position?.top ?? 0) + (position?.maxHeight ?? 0)).toBe(90)
})

test('constrains oversized overlays without mutating terminal layout', () => {
    const host = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    host.append(screen)
    host.getBoundingClientRect = () => rect(100, 50, 300, 200)
    screen.getBoundingClientRect = () => rect(110, 60, 200, 100)
    const originalStyle = screen.getAttribute('style')

    const position = new TerminalGeometryAdapter().measure(
        host,
        { cursorX: 19, cursorY: 8, cols: 20, rows: 10 },
        { width: 400, height: 300 },
    )

    expect(position).toEqual({ left: 10, top: 10, above: true, maxWidth: 200, maxHeight: 80 })
    expect(screen.getAttribute('style')).toBe(originalStyle)
})

test('fails closed when screen bounds or terminal metrics are unavailable', () => {
    const host = document.createElement('div')
    const adapter = new TerminalGeometryAdapter()

    expect(adapter.measure(host, { cursorX: 0, cursorY: 0, cols: 80, rows: 24 }, { width: 10, height: 10 })).toBeNull()
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    host.append(screen)
    screen.getBoundingClientRect = () => rect(0, 0, 0, 0)
    expect(adapter.measure(host, { cursorX: 0, cursorY: 0, cols: 0, rows: 24 }, { width: 10, height: 10 })).toBeNull()
})

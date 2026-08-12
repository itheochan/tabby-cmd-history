import { Prediction } from '../../src/history/types'
import { PredictionOverlay } from '../../src/ui/predictionOverlay'

const predictions: Prediction[] = [
    { command: 'git checkout main', lastUsedAt: '2026-08-12T12:00:00Z', useCount: 2, matchKind: 'prefix', score: 1, matchIndex: 0 },
    { command: 'git cherry-pick abc', lastUsedAt: '2026-08-12T11:00:00Z', useCount: 1, matchKind: 'prefix', score: 0.8, matchIndex: 0 },
]

test.each(['inline', 'list', 'hybrid'] as const)('renders %s mode with real DOM nodes', mode => {
    const host = document.createElement('div')
    const overlay = new PredictionOverlay(host)

    overlay.render({
        mode,
        query: 'git ch',
        predictions,
        selectedIndex: 0,
        expanded: mode === 'list',
        position: { left: 20, top: 30, above: false },
    })

    expect(host.querySelector('[data-command="git checkout main"]')).not.toBeNull()
    expect(host.querySelector('.cmd-history-overlay')?.getAttribute('data-mode')).toBe(mode)
    expect(host.querySelector('.cmd-history-overlay')).toBeInstanceOf(HTMLElement)
})

test('inline and collapsed hybrid render only the selected command remainder', () => {
    for (const mode of ['inline', 'hybrid'] as const) {
        const host = document.createElement('div')
        const overlay = new PredictionOverlay(host)
        overlay.render({
            mode,
            query: 'git ch',
            predictions,
            selectedIndex: 1,
            expanded: false,
            position: { left: 0, top: 0, above: false },
        })

        expect(host.querySelector('.cmd-history-ghost')?.textContent).toBe('erry-pick abc')
        expect(host.querySelectorAll('[role="option"]')).toHaveLength(0)
    }
})

test('expanded hybrid renders a bounded accessible list with one selected row', () => {
    const host = document.createElement('div')
    const overlay = new PredictionOverlay(host)
    overlay.render({
        mode: 'hybrid',
        query: 'git',
        predictions: [
            ...predictions,
            { ...predictions[0], command: 'git clean' },
        ],
        selectedIndex: 1,
        expanded: true,
        maxResults: 2,
        position: { left: 0, top: 0, above: false },
    })

    const root = host.querySelector('.cmd-history-overlay')
    const options = root?.querySelectorAll('[role="option"]') ?? []
    expect(root?.getAttribute('role')).toBe('listbox')
    expect(root?.getAttribute('aria-label')).toBe('Command history predictions')
    expect(options).toHaveLength(2)
    expect(options[0].getAttribute('aria-selected')).toBe('false')
    expect(options[1].getAttribute('aria-selected')).toBe('true')
    expect(options[1].classList.contains('is-selected')).toBe(true)
})

test('writes hostile commands as text and never creates command-derived elements', () => {
    const host = document.createElement('div')
    const overlay = new PredictionOverlay(host)
    const command = '<img src=x onerror="globalThis.pwned=true">'
    overlay.render({
        mode: 'list',
        query: '<',
        predictions: [{ ...predictions[0], command }],
        selectedIndex: 0,
        expanded: true,
        position: { left: 0, top: 0, above: false },
    })

    expect(host.querySelector('[role="option"]')?.textContent).toBe(command)
    expect(host.querySelector('img')).toBeNull()
})

test('reuses one root and hide and destroy are idempotent', () => {
    const host = document.createElement('div')
    const overlay = new PredictionOverlay(host)
    const state = {
        mode: 'list' as const,
        query: 'git',
        predictions,
        selectedIndex: 0,
        expanded: true,
        position: { left: 0, top: 0, above: false },
    }

    overlay.render(state)
    const root = host.querySelector('.cmd-history-overlay')
    overlay.render({ ...state, selectedIndex: 1 })
    expect(host.querySelectorAll('.cmd-history-overlay')).toHaveLength(1)
    expect(host.querySelector('.cmd-history-overlay')).toBe(root)

    overlay.hide()
    overlay.hide()
    expect((root as HTMLElement).hidden).toBe(true)
    overlay.render(state)
    expect((root as HTMLElement).hidden).toBe(false)

    overlay.destroy()
    overlay.destroy()
    overlay.render(state)
    expect(host.querySelector('.cmd-history-overlay')).toBeNull()
})

test('applies clamped geometry and above placement without covering the cursor boundary', () => {
    const host = document.createElement('div')
    const overlay = new PredictionOverlay(host)
    overlay.render({
        mode: 'list',
        query: 'git',
        predictions,
        selectedIndex: 0,
        expanded: true,
        position: { left: 12.4, top: 20, above: true, maxWidth: 80, maxHeight: 40 },
    })

    const root = host.querySelector('.cmd-history-overlay') as HTMLElement
    expect(root.style.left).toBe('12.4px')
    expect(root.style.top).toBe('20px')
    expect(root.style.maxWidth).toBe('80px')
    expect(root.style.maxHeight).toBe('40px')
    expect(root.getAttribute('data-position')).toBe('above')
    expect(root.classList.contains('is-above')).toBe(true)
})

test('hides the root when there are no predictions', () => {
    const host = document.createElement('div')
    const overlay = new PredictionOverlay(host)
    overlay.render({
        mode: 'inline',
        query: 'git',
        predictions: [],
        selectedIndex: 0,
        expanded: false,
        position: { left: 0, top: 0, above: false },
    })

    expect((host.querySelector('.cmd-history-overlay') as HTMLElement).hidden).toBe(true)
})

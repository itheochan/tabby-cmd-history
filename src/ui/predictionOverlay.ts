import { PresentationMode } from '../config/historyConfig'
import { Prediction } from '../history/types'

if (process.env.NODE_ENV !== 'test') {
    // Webpack bundles the stylesheet; Jest exercises the DOM contract without loading Sass.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('./predictionOverlay.scss')
}

export interface PredictionOverlayPosition {
    left: number
    top: number
    above: boolean
    maxWidth?: number
    maxHeight?: number
}

export interface PredictionOverlayState {
    mode: PresentationMode
    query: string
    predictions: readonly Prediction[]
    selectedIndex: number
    expanded: boolean
    maxResults?: number
    position: PredictionOverlayPosition
}

let overlaySequence = 0

export class PredictionOverlay {
    private readonly root: HTMLDivElement
    private readonly optionIdPrefix = `cmd-history-option-${overlaySequence++}`
    private destroyed = false

    constructor (host: HTMLElement) {
        this.root = document.createElement('div')
        this.root.className = 'cmd-history-overlay'
        this.root.hidden = true
        host.append(this.root)
    }

    render (state: PredictionOverlayState): void {
        if (this.destroyed) {
            return
        }

        this.root.replaceChildren()
        this.root.dataset.mode = state.mode
        this.applyPosition(state.position)
        if (!state.predictions.length) {
            this.hide()
            return
        }

        const listVisible = state.mode === 'list' || (state.mode === 'hybrid' && state.expanded)
        const rendered = listVisible ? this.renderList(state) : this.renderInline(state)
        this.root.hidden = !rendered
    }

    hide (): void {
        if (!this.destroyed) {
            this.root.hidden = true
        }
    }

    destroy (): void {
        if (this.destroyed) {
            return
        }
        this.destroyed = true
        this.root.remove()
    }

    private renderInline (state: PredictionOverlayState): boolean {
        const selectedIndex = clampIndex(state.selectedIndex, state.predictions.length)
        const selected = state.predictions[selectedIndex]
        const matchIndex = clamp(
            Number.isFinite(selected.matchIndex) ? Math.floor(selected.matchIndex) : 0,
            0,
            selected.command.length,
        )
        const suffixStart = clamp(matchIndex + state.query.length, 0, selected.command.length)
        const remainder = selected.command.slice(suffixStart)
        if (!remainder) {
            return false
        }
        const ghost = document.createElement('span')
        ghost.className = 'cmd-history-ghost'
        ghost.textContent = remainder
        this.root.setAttribute('role', 'status')
        this.root.setAttribute('aria-live', 'polite')
        this.root.setAttribute('aria-label', 'Command history prediction')
        this.root.removeAttribute('aria-activedescendant')
        this.root.append(ghost)
        return true
    }

    private renderList (state: PredictionOverlayState): boolean {
        const limit = normalizedLimit(state.maxResults, state.predictions.length)
        if (limit <= 0) {
            return false
        }
        const selectedIndex = clampIndex(state.selectedIndex, state.predictions.length)
        const windowSize = Math.min(limit, state.predictions.length)
        const windowStart = clamp(
            selectedIndex - Math.floor(windowSize / 2),
            0,
            state.predictions.length - windowSize,
        )
        const visible = state.predictions.slice(windowStart, windowStart + windowSize)
        const localSelectedIndex = selectedIndex - windowStart
        this.root.setAttribute('role', 'listbox')
        this.root.setAttribute('aria-label', 'Command history predictions')
        this.root.removeAttribute('aria-live')

        visible.forEach((prediction, index) => {
            const row = document.createElement('div')
            const selected = index === localSelectedIndex
            row.id = `${this.optionIdPrefix}-${index}`
            row.className = `cmd-history-option${selected ? ' is-selected' : ''}`
            row.setAttribute('role', 'option')
            row.setAttribute('aria-selected', String(selected))
            row.textContent = prediction.command
            this.root.append(row)
            if (selected) {
                this.root.setAttribute('aria-activedescendant', row.id)
            }
        })
        return true
    }

    private applyPosition (position: PredictionOverlayPosition): void {
        this.root.style.left = `${position.left}px`
        this.root.style.top = `${position.top}px`
        setOptionalPixelStyle(this.root, 'maxWidth', position.maxWidth)
        setOptionalPixelStyle(this.root, 'maxHeight', position.maxHeight)
        this.root.dataset.position = position.above ? 'above' : 'below'
        this.root.classList.toggle('is-above', position.above)
    }
}

function normalizedLimit (limit: number | undefined, fallback: number): number {
    return limit === undefined || !Number.isFinite(limit) ? fallback : Math.max(0, Math.floor(limit))
}

function clampIndex (index: number, length: number): number {
    return Math.min(Math.max(Number.isFinite(index) ? Math.floor(index) : 0, 0), length - 1)
}

function clamp (value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum)
}

function setOptionalPixelStyle (
    element: HTMLElement,
    property: 'maxWidth' | 'maxHeight',
    value: number | undefined,
): void {
    element.style[property] = value === undefined ? '' : `${value}px`
}

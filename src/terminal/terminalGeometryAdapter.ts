export interface TerminalViewportMetrics {
    cursorX: number
    cursorY: number
    cols: number
    rows: number
}

export interface OverlaySize {
    width: number
    height: number
}

export interface OverlayPosition {
    left: number
    top: number
    above: boolean
    maxWidth: number
    maxHeight: number
}

export class TerminalGeometryAdapter {
    measure (
        host: HTMLElement,
        metrics: TerminalViewportMetrics,
        overlay: OverlaySize,
    ): OverlayPosition | null {
        const screen = host.querySelector<HTMLElement>('.xterm-screen')
        if (!screen || !validMetrics(metrics) || !validSize(overlay)) {
            return null
        }

        const hostBounds = host.getBoundingClientRect()
        const screenBounds = screen.getBoundingClientRect()
        if (!validRect(hostBounds) || !validRect(screenBounds)) {
            return null
        }
        const cellWidth = screenBounds.width / metrics.cols
        const cellHeight = screenBounds.height / metrics.rows
        const column = clamp(Math.floor(metrics.cursorX), 0, metrics.cols - 1)
        const row = clamp(Math.floor(metrics.cursorY), 0, metrics.rows - 1)
        const cursorLeft = screenBounds.left + column * cellWidth
        const cursorTop = screenBounds.top + row * cellHeight
        const cursorBottom = cursorTop + cellHeight
        const spaceAbove = Math.max(0, cursorTop - screenBounds.top)
        const spaceBelow = Math.max(0, screenBounds.bottom - cursorBottom)
        if (![cellWidth, cellHeight, cursorLeft, cursorTop, cursorBottom, spaceAbove, spaceBelow].every(Number.isFinite)) {
            return null
        }
        const above = spaceBelow < overlay.height && spaceAbove > 0
        const availableHeight = above ? spaceAbove : spaceBelow
        const maxHeight = Math.min(overlay.height, availableHeight)
        if (maxHeight <= 0) {
            return null
        }

        const maxWidth = Math.min(overlay.width, screenBounds.width)
        const absoluteLeft = clamp(cursorLeft, screenBounds.left, screenBounds.right - maxWidth)
        const absoluteTop = above ? cursorTop - maxHeight : cursorBottom
        const left = absoluteLeft - hostBounds.left
        const top = clamp(absoluteTop, screenBounds.top, screenBounds.bottom - maxHeight) - hostBounds.top
        if (![maxWidth, maxHeight, absoluteLeft, absoluteTop, left, top].every(Number.isFinite)) {
            return null
        }

        return {
            left,
            top,
            above,
            maxWidth,
            maxHeight,
        }
    }
}

function validMetrics (metrics: TerminalViewportMetrics): boolean {
    return Number.isFinite(metrics.cursorX) && Number.isFinite(metrics.cursorY) &&
        Number.isInteger(metrics.cols) && metrics.cols > 0 &&
        Number.isInteger(metrics.rows) && metrics.rows > 0
}

function validSize (size: OverlaySize): boolean {
    return Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0
}

function validRect (bounds: DOMRect): boolean {
    return [bounds.left, bounds.top, bounds.right, bounds.bottom, bounds.width, bounds.height].every(Number.isFinite) &&
        bounds.width > 0 && bounds.height > 0 && bounds.right > bounds.left && bounds.bottom > bounds.top
}

function clamp (value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum)
}

import { Observable, Subscription } from 'rxjs'
import { Logger } from 'tabby-core'
import { BaseSession, BaseTerminalProfile, BaseTerminalTabComponent } from 'tabby-terminal'
import {
    CommandHistoryConfig,
    DEFAULT_COMMAND_HISTORY_CONFIG,
    HistoryKeyName,
    validateHistoryConfig,
} from '../config/historyConfig'
import { ConnectionIdentityResolver, ProfileLike } from '../history/connectionIdentity'
import { CaptureEvidence } from '../history/historyService'
import { ConnectionIdentity, Prediction } from '../history/types'
import { PredictionOverlay } from '../ui/predictionOverlay'
import { BufferState, CommandBuffer, EditAction } from './commandBuffer'
import { TerminalInputAction } from './inputDecoder'
import { CommandInputMiddleware, InputRouteDecision } from './inputMiddleware'
import { TerminalGeometryAdapter } from './terminalGeometryAdapter'
import { VisibleEchoVerifier } from './visibleEchoVerifier'

export interface ControllerHistoryService {
    changes$?: Observable<string>
    query: (
        identity: ConnectionIdentity,
        query: string,
        config: CommandHistoryConfig,
        now?: Date,
    ) => Promise<Prediction[]>
    record: (
        identity: ConnectionIdentity,
        command: string,
        evidence: CaptureEvidence,
        config: CommandHistoryConfig,
        at: Date,
    ) => Promise<void>
}

export interface CommandHistoryControllerDependencies {
    history: ControllerHistoryService
    identityResolver: Pick<ConnectionIdentityResolver, 'resolve'>
    getConfig: () => CommandHistoryConfig
    configChanged$?: Observable<void>
    logger: Pick<Logger, 'warn'>
    now?: () => Date
    createOverlay?: (host: HTMLElement) => PredictionOverlay
    echoVerifier?: VisibleEchoVerifier
    geometry?: TerminalGeometryAdapter
}

export interface CommandHistoryControllerState {
    buffer: BufferState
    predictions: readonly Prediction[]
    selectedIndex: number
    expanded: boolean
    config: CommandHistoryConfig
    identity: ConnectionIdentity
}

interface XtermLine {
    isWrapped: boolean
    translateToString: (trimRight?: boolean) => string
}

interface Disposable {
    dispose (): void
}

interface XtermFacade {
    cols: number
    rows: number
    buffer: { active: {
        cursorX: number
        cursorY: number
        baseY: number
        getLine: (index: number) => XtermLine | undefined
    } }
    onScroll?: (handler: () => void) => Disposable
    onSelectionChange?: (handler: () => void) => Disposable
}

interface FrontendFacade {
    xterm: XtermFacade
    contentUpdated$?: Observable<void>
    destroyed$?: Observable<void>
    supportsBracketedPaste: () => boolean
}

export class CommandHistoryController {
    private readonly buffer = new CommandBuffer()
    private readonly subscriptions: Subscription[] = []
    private readonly frontendSubscriptions: Subscription[] = []
    private readonly frontendDisposables: Disposable[] = []
    private readonly echoVerifier: VisibleEchoVerifier
    private readonly geometry: TerminalGeometryAdapter
    private middleware?: CommandInputMiddleware
    private attachedSession: BaseSession | null = null
    private overlay?: PredictionOverlay
    private identity: ConnectionIdentity
    private config: CommandHistoryConfig
    private predictions: Prediction[] = []
    private selectedIndex = 0
    private expanded = false
    private alternateActive = false
    private frontendAvailable = false
    private queryGeneration = 0
    private recordEpoch = 0
    private attached = false
    private destroyed = false

    constructor (
        private readonly terminal: BaseTerminalTabComponent<BaseTerminalProfile>,
        private readonly dependencies: CommandHistoryControllerDependencies,
    ) {
        this.config = this.readConfig(DEFAULT_COMMAND_HISTORY_CONFIG)
        this.identity = dependencies.identityResolver.resolve(
            terminal.profile as ProfileLike,
            terminal,
        )
        this.echoVerifier = dependencies.echoVerifier ?? new VisibleEchoVerifier()
        this.geometry = dependencies.geometry ?? new TerminalGeometryAdapter()
    }

    attach (): void {
        if (this.attached || this.destroyed) {
            return
        }
        this.attached = true
        this.createOverlay()
        this.attachTerminalSubscriptions()
        this.attachFrontend()
        this.attachSession(this.terminal.session)
    }

    destroy (): void {
        if (this.destroyed) {
            return
        }
        this.destroyed = true
        this.attached = false
        this.recordEpoch++
        this.invalidatePredictions()
        this.detachSession()
        this.detachFrontend()
        this.subscriptions.splice(0).forEach(subscription => subscription.unsubscribe())
        try {
            this.overlay?.destroy()
        } catch {
            this.warn('overlay-destroy')
        }
        this.overlay = undefined
        this.buffer.reset()
    }

    state (): CommandHistoryControllerState {
        return {
            buffer: this.buffer.snapshot(),
            predictions: [...this.predictions],
            selectedIndex: this.selectedIndex,
            expanded: this.expanded,
            config: cloneConfig(this.config),
            identity: { ...this.identity },
        }
    }

    private route = (action: TerminalInputAction): InputRouteDecision => {
        if (action.type === 'interrupt') {
            this.recordEpoch++
            this.invalidatePredictions()
            this.buffer.apply(action)
            return { consume: false, action }
        }

        if (!this.config.enabled || this.alternateActive || !this.frontendAvailable || this.destroyed) {
            return { consume: false, action }
        }

        const key = keyFor(action)
        if (this.predictions.length && key) {
            if (key === this.config.bindings.previous) {
                this.previous()
                return { consume: true, action }
            }
            if (key === this.config.bindings.next) {
                this.next()
                return { consume: true, action }
            }
            if (key === this.config.bindings.accept) {
                return { consume: this.accept(), action }
            }
            if (key === this.config.bindings.dismiss) {
                this.dismiss()
                return { consume: true, action }
            }
        }

        if (action.type === 'enter') {
            this.submit()
            return { consume: false, action }
        }

        if (action.type === 'unknown' || isShellManagedKey(action)) {
            this.buffer.apply({ type: 'unknown' })
            this.invalidatePredictions()
            return { consume: false, action }
        }

        const before = this.buffer.snapshot()
        this.buffer.apply(action as EditAction)
        const after = this.buffer.snapshot()
        if (after.text !== before.text || after.confident !== before.confident || after.dismissed !== before.dismissed) {
            this.queryFromBuffer()
        } else {
            this.refreshPosition()
        }
        return { consume: false, action }
    }

    private attachTerminalSubscriptions (): void {
        this.subscribe(this.terminal.sessionChanged$, session => this.handleSessionChanged(session))
        this.subscribe(this.terminal.frontendReady$, () => this.handleFrontendReady())
        if (this.dependencies.configChanged$) {
            this.subscribe(this.dependencies.configChanged$, () => this.handleConfigChanged())
        }
        if (this.dependencies.history.changes$) {
            this.subscribe(this.dependencies.history.changes$, key => this.handleHistoryChanged(key))
        }
    }

    private subscribe<T> (observable: Observable<T>, handler: (value: T) => void): void {
        this.subscriptions.push(observable.subscribe(value => {
            try {
                handler(value)
            } catch {
                this.warn('subscription')
            }
        }))
    }

    private handleSessionChanged (session: BaseSession | null): void {
        this.recordEpoch++
        this.detachSession()
        this.invalidatePredictions()
        this.buffer.reset()
        this.identity = this.dependencies.identityResolver.resolve(
            this.terminal.profile as ProfileLike,
            this.terminal,
        )
        this.attachSession(session)
        this.attachFrontend()
    }

    private attachSession (session: BaseSession | null): void {
        if (this.attachedSession === session && this.middleware) {
            return
        }
        this.detachSession()
        if (!session || this.destroyed) {
            return
        }
        const middleware = new CommandInputMiddleware(this.route)
        try {
            session.middleware.unshift(middleware)
            this.middleware = middleware
            this.attachedSession = session
        } catch {
            middleware.close()
            this.warn('middleware-attach')
        }
    }

    private detachSession (): void {
        const middleware = this.middleware
        const session = this.attachedSession
        this.middleware = undefined
        this.attachedSession = null
        if (!middleware) {
            return
        }
        try {
            session?.middleware.remove(middleware)
        } catch {
            this.warn('middleware-remove')
        }
        try {
            middleware.close()
        } catch {
            this.warn('middleware-close')
        }
    }

    private handleFrontendReady (): void {
        this.invalidatePredictions()
        this.buffer.reset()
        this.attachFrontend()
    }

    private attachFrontend (): void {
        this.detachFrontend()
        const frontend = this.frontend()
        this.frontendAvailable = frontend !== null
        if (!frontend) {
            this.invalidatePredictions()
            return
        }
        try {
            this.subscribeFrontend(this.terminal.resize$, () => this.refreshPosition())
            this.subscribeFrontend(this.terminal.alternateScreenActive$, active => this.setAlternate(active))
            if (frontend.contentUpdated$) {
                this.subscribeFrontend(frontend.contentUpdated$, () => this.refreshPosition())
            }
            if (frontend.destroyed$) {
                this.subscribeFrontend(frontend.destroyed$, () => {
                    this.frontendAvailable = false
                    this.invalidatePredictions()
                    this.buffer.reset()
                    this.detachFrontend()
                })
            }
            this.addFrontendDisposable(frontend.xterm.onScroll?.(() => this.refreshPosition()))
            this.addFrontendDisposable(frontend.xterm.onSelectionChange?.(() => this.refreshPosition()))
            this.setAlternate(this.terminal.alternateScreenActive === true)
        } catch {
            this.warn('frontend-bind')
            this.detachFrontend()
            this.invalidatePredictions()
        }
    }

    private subscribeFrontend<T> (observable: Observable<T>, handler: (value: T) => void): void {
        this.frontendSubscriptions.push(observable.subscribe(value => {
            try {
                handler(value)
            } catch {
                this.warn('frontend-event')
                this.frontendAvailable = false
                this.invalidatePredictions()
                this.detachFrontend()
            }
        }))
    }

    private detachFrontend (): void {
        this.frontendAvailable = false
        this.frontendSubscriptions.splice(0).forEach(subscription => subscription.unsubscribe())
        this.frontendDisposables.splice(0).forEach(disposable => {
            try {
                disposable.dispose()
            } catch {
                this.warn('frontend-dispose')
            }
        })
    }

    private addFrontendDisposable (disposable: Disposable | undefined): void {
        if (disposable) {
            this.frontendDisposables.push(disposable)
        }
    }

    private handleConfigChanged (): void {
        const previous = this.config
        this.config = this.readConfig(previous)
        this.invalidatePredictions()
        if (!this.config.enabled) {
            this.buffer.reset()
            return
        }
        this.queryFromBuffer()
    }

    private handleHistoryChanged (key: string): void {
        if (key !== this.identity.key) {
            return
        }
        this.invalidatePredictions()
        this.queryFromBuffer()
    }

    private readConfig (fallback: CommandHistoryConfig): CommandHistoryConfig {
        try {
            const configured = this.dependencies.getConfig()
            return validateHistoryConfig({
                ...cloneConfig(DEFAULT_COMMAND_HISTORY_CONFIG),
                ...configured,
                weights: { ...DEFAULT_COMMAND_HISTORY_CONFIG.weights, ...configured.weights },
                bindings: { ...DEFAULT_COMMAND_HISTORY_CONFIG.bindings, ...configured.bindings },
                exclusionPatterns: [...configured.exclusionPatterns],
            })
        } catch {
            this.warn('config')
            return cloneConfig(fallback)
        }
    }

    private setAlternate (active: boolean): void {
        this.alternateActive = active
        this.recordEpoch++
        this.invalidatePredictions()
        this.buffer.apply({ type: 'alternate', active })
    }

    private queryFromBuffer (): void {
        const state = this.buffer.snapshot()
        this.invalidatePredictions()
        if (!this.config.enabled || this.alternateActive || !this.frontendAvailable ||
            !state.confident || state.dismissed || state.text.trim().length < this.config.minQueryLength) {
            return
        }

        const generation = this.queryGeneration
        const identity = this.identity
        const config = cloneConfig(this.config)
        Promise.resolve()
            .then(() => this.dependencies.history.query(identity, state.text, config, this.now()))
            .then(predictions => {
                if (generation !== this.queryGeneration || this.destroyed) {
                    return
                }
                if (!this.overlay) {
                    this.invalidatePredictions()
                    return
                }
                const supportsMultiline = this.supportsBracketedPaste()
                this.predictions = predictions
                    .filter(item => supportsMultiline || !/[\r\n]/u.test(item.command))
                    .filter(item => config.presentation === 'list' || hasInlineRemainder(item, state.text))
                this.selectedIndex = 0
                this.expanded = config.presentation === 'list'
                this.renderPredictions()
            })
            .catch(() => {
                if (generation === this.queryGeneration) {
                    this.invalidatePredictions()
                    this.warn('query')
                }
            })
    }

    private previous (): void {
        this.selectedIndex = (this.selectedIndex - 1 + this.predictions.length) % this.predictions.length
        this.renderPredictions()
    }

    private next (): void {
        if (this.config.presentation === 'hybrid' && !this.expanded) {
            this.expanded = true
        } else {
            this.selectedIndex = (this.selectedIndex + 1) % this.predictions.length
        }
        this.renderPredictions()
    }

    private dismiss (): void {
        if (this.config.presentation === 'hybrid' && this.expanded) {
            this.expanded = false
            this.renderPredictions()
            return
        }
        this.buffer.dismiss()
        this.invalidatePredictions()
    }

    private accept (): boolean {
        const candidate = this.predictions[this.selectedIndex]?.command
        const middleware = this.middleware
        if (!candidate || !middleware) {
            return false
        }
        const state = this.buffer.snapshot()
        try {
            if (/[\r\n]/u.test(candidate)) {
                if (!this.supportsBracketedPaste()) {
                    this.invalidatePredictions()
                    return false
                }
                middleware.injectBracketedReplacement({
                    current: state.text,
                    cursor: state.cursor,
                    candidate,
                })
            } else {
                middleware.injectReplacement({ current: state.text, cursor: state.cursor, candidate })
            }
            this.buffer.adopt(candidate.replace(/\r\n?/gu, '\n'))
            this.invalidatePredictions()
            return true
        } catch {
            this.invalidatePredictions()
            this.warn('accept')
            return false
        }
    }

    private submit (): void {
        const before = this.buffer.snapshot()
        let visibleEcho = false
        if (before.confident && before.text) {
            try {
                visibleEcho = this.echoVerifier.matches(
                    this.captureCurrentLogicalLines(before.text),
                    before.text,
                )
            } catch {
                this.warn('echo')
            }
        }
        const result = this.buffer.apply({ type: 'enter' })
        this.invalidatePredictions()
        if (!result.submitted) {
            return
        }

        const epoch = this.recordEpoch
        const identity = this.identity
        const config = cloneConfig(this.config)
        const command = result.submitted
        const at = this.now()
        queueMicrotask(() => {
            if (this.destroyed || epoch !== this.recordEpoch) {
                return
            }
            void Promise.resolve()
                .then(() => this.dependencies.history.record(
                    identity,
                    command,
                    { trustworthy: before.confident, visibleEcho },
                    config,
                    at,
                ))
                .catch(() => this.warn('record'))
        })
    }

    private captureCurrentLogicalLines (command: string): string[] | null {
        const frontend = this.frontend()
        if (!frontend) {
            return null
        }
        const active = frontend.xterm.buffer.active
        const count = command.replace(/\r\n?/gu, '\n').split('\n').length
        let end = active.baseY + active.cursorY
        const result: string[] = []
        for (let index = 0; index < count; index++) {
            const logical = readLogicalLine(active.getLine, end)
            if (!logical) {
                return null
            }
            result.unshift(logical.text)
            end = logical.start - 1
        }
        return result
    }

    private renderPredictions (): void {
        if (!this.predictions.length || !this.overlay) {
            this.predictions = []
            this.selectedIndex = 0
            this.expanded = false
            this.hideOverlay()
            return
        }
        let stage = 'frontend-measure'
        try {
            const frontend = this.frontend()
            if (!frontend) {
                this.disablePresentation('frontend-measure')
                return
            }
            const active = frontend.xterm.buffer.active
            stage = 'geometry-measure'
            const position = this.geometry.measure(
                this.host(),
                {
                    cursorX: active.cursorX,
                    cursorY: active.cursorY,
                    cols: frontend.xterm.cols,
                    rows: frontend.xterm.rows,
                },
                { width: 480, height: Math.max(24, this.config.maxVisible * 28) },
            )
            if (!position) {
                this.invalidatePredictions()
                return
            }
            stage = 'overlay-render'
            this.overlay.render({
                mode: this.config.presentation,
                query: this.buffer.snapshot().text,
                predictions: this.predictions,
                selectedIndex: this.selectedIndex,
                expanded: this.expanded,
                maxResults: this.config.maxVisible,
                position,
            })
        } catch {
            this.disablePresentation(stage)
        }
    }

    private refreshPosition (): void {
        if (this.predictions.length) {
            this.renderPredictions()
        }
    }

    private invalidatePredictions (): void {
        this.queryGeneration++
        this.predictions = []
        this.selectedIndex = 0
        this.expanded = false
        this.hideOverlay()
    }

    private createOverlay (): void {
        try {
            this.overlay = (this.dependencies.createOverlay ?? (host => new PredictionOverlay(host)))(this.host())
        } catch {
            this.overlay = undefined
            this.warn('overlay-create')
        }
    }

    private hideOverlay (): void {
        try {
            this.overlay?.hide()
        } catch {
            this.destroyOverlay('overlay-hide')
        }
    }

    private destroyOverlay (stage: string): void {
        try {
            this.overlay?.destroy()
        } catch {
            // The diagnostic below is intentionally command-free.
        }
        this.overlay = undefined
        this.warn(stage)
    }

    private disablePresentation (stage: string): void {
        this.queryGeneration++
        this.predictions = []
        this.selectedIndex = 0
        this.expanded = false
        this.destroyOverlay(stage)
    }

    private frontend (): FrontendFacade | null {
        const frontend: unknown = this.terminal.frontend
        if (!isObject(frontend) || !isObject(frontend.xterm) ||
            typeof frontend.supportsBracketedPaste !== 'function') {
            return null
        }
        const xterm = frontend.xterm
        if (!isObject(xterm.buffer) || !isObject(xterm.buffer.active) ||
            typeof xterm.buffer.active.getLine !== 'function') {
            return null
        }
        return frontend as unknown as FrontendFacade
    }

    private supportsBracketedPaste (): boolean {
        try {
            return this.frontend()?.supportsBracketedPaste() === true
        } catch {
            this.warn('capability')
            return false
        }
    }

    private host (): HTMLElement {
        return this.terminal.element.nativeElement
    }

    private now (): Date {
        return this.dependencies.now?.() ?? new Date()
    }

    private warn (stage: string): void {
        try {
            this.dependencies.logger.warn(`cmd-history stage=${stage} key=${this.identity?.key ?? 'unresolved'}`)
        } catch {
            // Diagnostics must never interrupt terminal input.
        }
    }
}

function readLogicalLine (
    getLine: (index: number) => XtermLine | undefined,
    end: number,
): { start: number; text: string } | null {
    if (!Number.isInteger(end) || end < 0 || !getLine(end)) {
        return null
    }
    let start = end
    while (start > 0 && getLine(start)?.isWrapped) {
        start--
    }
    const parts: string[] = []
    for (let index = start; index <= end; index++) {
        const line = getLine(index)
        if (!line) {
            return null
        }
        parts.push(line.translateToString(true))
    }
    return { start, text: parts.join('') }
}

function keyFor (action: TerminalInputAction): HistoryKeyName | null {
    switch (action.type) {
        case 'up': return 'ArrowUp'
        case 'down': return 'ArrowDown'
        case 'right': return 'ArrowRight'
        case 'escape': return 'Escape'
        case 'ctrlUp': return 'Ctrl+ArrowUp'
        case 'ctrlDown': return 'Ctrl+ArrowDown'
        case 'ctrlRight': return 'Ctrl+ArrowRight'
        default: return null
    }
}

function isShellManagedKey (action: TerminalInputAction): boolean {
    return action.type === 'up' || action.type === 'down' || action.type === 'escape' ||
        action.type === 'ctrlUp' || action.type === 'ctrlDown' || action.type === 'ctrlRight'
}

function isObject (value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function cloneConfig (config: Readonly<CommandHistoryConfig>): CommandHistoryConfig {
    return {
        ...config,
        exclusionPatterns: [...config.exclusionPatterns],
        weights: { ...config.weights },
        bindings: { ...config.bindings },
    }
}

function hasInlineRemainder (prediction: Prediction, query: string): boolean {
    const matchIndex = Math.min(
        Math.max(Number.isFinite(prediction.matchIndex) ? Math.floor(prediction.matchIndex) : 0, 0),
        prediction.command.length,
    )
    return matchIndex + query.length < prediction.command.length
}

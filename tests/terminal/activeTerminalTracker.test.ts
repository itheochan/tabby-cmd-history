/* eslint-disable @typescript-eslint/no-explicit-any */
import { Subject } from 'rxjs'
import { ActiveTerminalTracker } from '../../src/terminal/activeTerminalTracker'

function terminalWith (properties: PropertyDescriptorMap): any {
    return Object.create({}, properties)
}

test.each(['getter', 'subscribe'] as const)('focused$ %s failure leaves no registration', stage => {
    const tracker = new ActiveTerminalTracker()
    const terminal = stage === 'getter'
        ? terminalWith({ focused$: { get: () => { throw new Error('private focused getter') } } })
        : { focused$: { subscribe: () => { throw new Error('private focused subscribe') } } }

    let tracked: boolean | undefined
    expect(() => { tracked = tracker.track(terminal) }).not.toThrow()
    expect(tracked).toBe(false)
    expect(tracker.lastFocused).toBeNull()
})

test.each(['getter', 'subscribe'] as const)(
    'destroyed$ %s failure unsubscribes the focused subscription',
    stage => {
        const tracker = new ActiveTerminalTracker()
        const focusedUnsubscribe = jest.fn()
        const terminal = stage === 'getter'
            ? terminalWith({
                focused$: { value: { subscribe: () => ({ unsubscribe: focusedUnsubscribe }) } },
                destroyed$: { get: () => { throw new Error('private destroyed getter') } },
            })
            : {
                focused$: { subscribe: () => ({ unsubscribe: focusedUnsubscribe }) },
                destroyed$: { subscribe: () => { throw new Error('private destroyed subscribe') } },
            }

        expect(tracker.track(terminal)).toBe(false)

        expect(focusedUnsubscribe).toHaveBeenCalledTimes(1)
        expect(tracker.lastFocused).toBeNull()
    },
)

test('synchronous focus emission is not committed when later registration fails', () => {
    const tracker = new ActiveTerminalTracker()
    const terminal = terminalWith({
        focused$: { value: { subscribe: (next: () => void) => {
            next()
            return { unsubscribe: jest.fn() }
        } } },
        destroyed$: { get: () => { throw new Error('registration failed') } },
    })

    expect(tracker.track(terminal)).toBe(false)
    expect(tracker.lastFocused).toBeNull()
})

test('hasFocus failure unsubscribes both local subscriptions', () => {
    const tracker = new ActiveTerminalTracker()
    const focusedUnsubscribe = jest.fn()
    const destroyedUnsubscribe = jest.fn()
    const terminal = terminalWith({
        focused$: { value: { subscribe: () => ({ unsubscribe: focusedUnsubscribe }) } },
        destroyed$: { value: { subscribe: () => ({ unsubscribe: destroyedUnsubscribe }) } },
        hasFocus: { get: () => { throw new Error('private focus state') } },
    })

    expect(tracker.track(terminal)).toBe(false)

    expect(focusedUnsubscribe).toHaveBeenCalledTimes(1)
    expect(destroyedUnsubscribe).toHaveBeenCalledTimes(1)
    expect(tracker.lastFocused).toBeNull()
})

test('a failed registration can be retried without an orphan', () => {
    const tracker = new ActiveTerminalTracker()
    const focused = new Subject<void>()
    const destroyed = new Subject<void>()
    let fail = true
    const terminal = terminalWith({
        focused$: { value: focused },
        destroyed$: { get: () => {
            if (fail) {
                throw new Error('first registration fails')
            }
            return destroyed
        } },
        hasFocus: { value: false },
    })

    expect(tracker.track(terminal)).toBe(false)
    fail = false
    expect(tracker.track(terminal)).toBe(true)
    focused.next()
    expect(tracker.lastFocused).toBe(terminal)
    tracker.untrack(terminal)
    expect(tracker.lastFocused).toBeNull()
})

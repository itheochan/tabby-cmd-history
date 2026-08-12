const BUILT_IN = /password|asplaintext|token|apikey|secret/i

export function normalizeCommand (command: string): string {
    return command.replace(/\r\n?/g, '\n').trim()
}

export class SensitiveCommandFilter {
    private patterns: RegExp[] = []

    constructor (patterns: string[]) {
        this.replacePatterns(patterns)
    }

    replacePatterns (patterns: string[]): void {
        const next = patterns.map(source => {
            try {
                return new RegExp(source, 'i')
            } catch {
                throw new Error(`Invalid exclusion pattern: ${source}`)
            }
        })
        this.patterns = next
    }

    allows (command: string, enabled: boolean): boolean {
        return !enabled || (!BUILT_IN.test(command) && !this.patterns.some(pattern => pattern.test(command)))
    }
}

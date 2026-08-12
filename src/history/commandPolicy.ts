const BUILT_IN = /password|asplaintext|token|apikey|secret/i

export function normalizeCommand (command: string): string {
    return command.replace(/\r\n?/g, '\n').trim()
}

export class SensitiveCommandFilter {
    private patterns: RegExp[] = []
    private patternSources: string[] = []

    constructor (patterns: string[]) {
        this.replacePatterns(patterns)
    }

    replacePatterns (patterns: string[]): void {
        if (patterns.length === this.patternSources.length &&
            patterns.every((pattern, index) => pattern === this.patternSources[index])) {
            return
        }
        const next = patterns.map(source => {
            try {
                return new RegExp(source, 'i')
            } catch {
                throw new Error(`Invalid exclusion pattern: ${source}`)
            }
        })
        this.patterns = next
        this.patternSources = [...patterns]
    }

    allows (command: string, enabled: boolean): boolean {
        return !enabled || (!BUILT_IN.test(command) && !this.patterns.some(pattern => pattern.test(command)))
    }
}

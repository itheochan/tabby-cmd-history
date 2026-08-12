export class VisibleEchoVerifier {
    /**
     * Compares only the complete current cursor logical rows captured before Enter is forwarded.
     * The caller must fail closed rather than pass output history, wrapped fragments, or partial rows.
     */
    matches (currentLogicalLines: readonly string[] | null | undefined, command: string): boolean {
        if (!currentLogicalLines?.length || currentLogicalLines.some(line => /[\r\n]/u.test(line))) {
            return false
        }

        const commandLines = normalizeNewlines(command).split('\n').map(trimLineEnd)
        if (commandLines.every(line => !line)) {
            return false
        }

        const visibleLines = currentLogicalLines.map(trimLineEnd)
        if (visibleLines.length < commandLines.length) {
            return false
        }

        const recent = visibleLines.slice(-commandLines.length)
        return commandLines.every((line, index) => line
            ? recent[index].endsWith(line)
            : recent[index] === '')
    }
}

function normalizeNewlines (value: string): string {
    return value.replace(/\r\n?/gu, '\n')
}

function trimLineEnd (value: string): string {
    return value.replace(/[\t ]+$/gu, '')
}

import { normalizeCommand } from '../history/commandPolicy'

export class VisibleEchoVerifier {
    matches (recentLogicalLines: readonly string[] | null | undefined, command: string): boolean {
        if (!recentLogicalLines?.length) {
            return false
        }

        const normalizedCommand = normalizeCommand(command)
        if (!normalizedCommand) {
            return false
        }

        const commandLines = normalizedCommand.split('\n').map(trimLineEnd)
        const visibleLines = recentLogicalLines.flatMap(line => normalizeNewlines(line).split('\n')).map(trimLineEnd)
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

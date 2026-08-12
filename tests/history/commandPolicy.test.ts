import { normalizeCommand, SensitiveCommandFilter } from '../../src/history/commandPolicy'

test('normalizes outer whitespace and line endings only', () => {
    expect(normalizeCommand('  git  commit\r\n-m x  ')).toBe('git  commit\n-m x')
})

test('preserves quoted content and line continuations', () => {
    expect(normalizeCommand('  echo "a\r\nb" \\\r\n  --flag  ')).toBe('echo "a\nb" \\\n  --flag')
})

test.each(['--password x', '-AsPlainText', '--token=x', '--apiKey x', 'set-secret x'])(
    'blocks %s',
    command => expect(new SensitiveCommandFilter([]).allows(command, true)).toBe(false),
)

test('custom rules can be disabled explicitly', () => {
    const filter = new SensitiveCommandFilter(['^mysql .*--password'])
    expect(filter.allows('mysql db --password x', true)).toBe(false)
    expect(filter.allows('mysql db --password x', false)).toBe(true)
})

test('custom rules block commands without built-in sensitive terms', () => {
    const filter = new SensitiveCommandFilter(['private-host'])
    expect(filter.allows('ssh private-host', true)).toBe(false)
    expect(filter.allows('ssh private-host', false)).toBe(true)
})

test('invalid replacement preserves prior rules', () => {
    const filter = new SensitiveCommandFilter(['private-host'])
    expect(() => filter.replacePatterns(['['])).toThrow('Invalid exclusion pattern')
    expect(filter.allows('ssh private-host', true)).toBe(false)
})

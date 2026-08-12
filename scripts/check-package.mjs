import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCli = process.env.npm_execpath

if (!npmCli) {
    throw new Error('pack:check must be run through npm')
}

const npmCache = mkdtempSync(join(tmpdir(), 'tabby-cmd-history-pack-'))
let packed
try {
    packed = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            npm_config_cache: npmCache,
            npm_config_update_notifier: 'false',
        },
    })
} finally {
    rmSync(npmCache, { force: true, recursive: true })
}

if (packed.status !== 0) {
    process.stderr.write(packed.stderr)
    process.exit(packed.status ?? 1)
}

let result
try {
    const parsed = JSON.parse(packed.stdout)
    if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0]?.files)) {
        throw new Error('unexpected npm pack result')
    }
    result = parsed[0]
} catch (error) {
    process.stderr.write(`Unable to parse npm pack JSON: ${error instanceof Error ? error.message : 'unknown error'}\n`)
    process.exit(1)
}

const fileNames = result.files.map(file => String(file.path).replaceAll('\\', '/'))
const requiredFiles = ['LICENSE', 'README.md', 'package.json', 'dist/index.d.ts', 'dist/index.js']
const unexpectedFiles = fileNames.filter(file =>
    file !== 'LICENSE' &&
    file !== 'README.md' &&
    file !== 'package.json' &&
    !file.startsWith('dist/'),
)
const missingFiles = requiredFiles.filter(file => !fileNames.includes(file))
const topLevelEntries = [...new Set(fileNames.map(file => file.split('/')[0]))].sort()
const expectedTopLevelEntries = ['LICENSE', 'README.md', 'dist', 'package.json']

if (
    unexpectedFiles.length > 0 ||
    missingFiles.length > 0 ||
    JSON.stringify(topLevelEntries) !== JSON.stringify(expectedTopLevelEntries)
) {
    process.stderr.write('npm package contents are not release-safe\n')
    if (missingFiles.length > 0) {
        process.stderr.write(`Missing: ${missingFiles.join(', ')}\n`)
    }
    if (unexpectedFiles.length > 0) {
        process.stderr.write(`Unexpected: ${unexpectedFiles.join(', ')}\n`)
    }
    process.stderr.write(`Top-level entries: ${topLevelEntries.join(', ')}\n`)
    process.exit(1)
}

process.stdout.write(`Package allowlist passed: ${fileNames.length} files, ${result.size} bytes\n`)

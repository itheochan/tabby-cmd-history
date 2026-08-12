module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'jsdom',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/*.test.ts'],
    setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
    globals: { 'ts-jest': { tsconfig: 'tsconfig.test.json' } },
    moduleNameMapper: {
        '^tabby-core$': '<rootDir>/tests/stubs/tabby-core.ts',
        '^tabby-terminal$': '<rootDir>/tests/stubs/tabby-terminal.ts',
        '^tabby-settings$': '<rootDir>/tests/stubs/tabby-settings.ts',
    },
}

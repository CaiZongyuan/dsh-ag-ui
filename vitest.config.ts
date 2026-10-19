import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const sourceEntry = fileURLToPath(new URL('./src/index.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      'dsh-ag-ui': sourceEntry,
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})

import { defineConfig } from 'vitest/config'

// Unit/integration tests of packages/core, the web API (route handlers, called directly) and the runner.
// No network, no real hosts: Prometheus, Discord, SMTP and ansible-playbook are faked (packages/core/test/helpers.ts).
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/web/test/**/*.test.ts', 'apps/runner/test/**/*.test.ts'],
    setupFiles: ['packages/core/test/setup.ts'],
    env: { TZ: 'Asia/Taipei' },
    testTimeout: 30_000,
    fileParallelism: true,
  },
})

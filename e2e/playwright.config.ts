import { defineConfig, devices } from '@playwright/test';

// Run through e2e/run.sh, which brings up the stack on http://localhost:8080 first.
export default defineConfig({
  testDir: './tests',
  // The API flow runs several ansible jobs against the fake host (the agents job alone can take ~6 min).
  timeout: 20 * 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:8080',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

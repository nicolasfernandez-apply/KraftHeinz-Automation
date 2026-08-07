import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

export default defineConfig({
  globalSetup: './utils/global-setup',
  testDir: '.',
  testMatch: ['tests/**/*.spec.ts', 'sites/**/*.spec.ts'],
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 4,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['allure-playwright', { detail: true, outputFolder: 'allure-results', suiteTitle: false }],
  ],
  use: {
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    // Bound every individual action (click/fill/selectOption). Without this,
    // actions default to NO timeout and a click on an element obscured by an
    // open dropdown overlay will hang until the whole test times out, tearing
    // down the page before any diagnostic screenshot can be taken.
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

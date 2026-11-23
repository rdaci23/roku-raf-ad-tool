import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const SYSTEM_CHROMIUM_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROMIUM_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter((p): p is string => Boolean(p && existsSync(p)));

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4321',
    headless: true,
    launchOptions: SYSTEM_CHROMIUM_CANDIDATES[0]
      ? { executablePath: SYSTEM_CHROMIUM_CANDIDATES[0] }
      : undefined,
  },
});

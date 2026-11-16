import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4311',
    viewport: { width: 1440, height: 1050 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx tsx tests/browser-server.ts',
    url: 'http://127.0.0.1:4311/api/status',
    reuseExistingServer: false,
    timeout: 30000,
  },
});

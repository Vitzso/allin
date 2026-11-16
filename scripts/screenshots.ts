// Takes the screenshots on the front page: npm run screenshots.
// It starts the server the browser tests use, on port 4311, with a temporary profile and no
// vault, so the pictures show the built-in synthetic preview and can never show real data.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const images = join(repo, 'docs', 'images');
const base = 'http://127.0.0.1:4311';

const server = spawn('npx', ['tsx', 'tests/browser-server.ts'], { cwd: repo, stdio: 'ignore' });
try {
  for (let tries = 0; ; tries++) {
    const up = await fetch(`${base}/api/status`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) break;
    if (tries > 100) throw new Error('The preview server did not start.');
    await new Promise((done) => setTimeout(done, 200));
  }
  mkdirSync(images, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 820 },
    reducedMotion: 'reduce',
  });
  await page.goto(base);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await nav.waitFor();
  for (const view of ['Today', 'Markets', 'Tasks', 'Health']) {
    await nav.getByRole('button', { name: new RegExp(`^${view}`) }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(images, `${view.toLowerCase()}.png`) });
    console.log(`docs/images/${view.toLowerCase()}.png`);
  }
  // The banner at the top of the README, in the two colour schemes GitHub can show.
  const banner = await browser.newPage({
    viewport: { width: 1280, height: 440 },
    deviceScaleFactor: 2,
  });
  for (const theme of ['light', 'dark']) {
    await banner.goto(`${pathToFileURL(join(repo, 'scripts', 'banner.html')).href}?${theme}`);
    await banner.waitForLoadState('networkidle');
    await banner.screenshot({ path: join(images, `banner-${theme}.png`) });
    console.log(`docs/images/banner-${theme}.png`);
  }
  await browser.close();
} finally {
  server.kill('SIGTERM');
}

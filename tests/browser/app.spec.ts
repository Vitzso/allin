import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe.serial('AllIn local workflows', () => {
  test('desktop preview, independent modules, replay evidence, and responsive layout', async ({
    page,
  }) => {
    const external: string[] = [],
      errors: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith('http://127.0.0.1:4311/')) external.push(request.url());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your day, in perspective.' })).toBeVisible();
    await page.screenshot({
      path: 'test-results/today-desktop.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page
      .getByRole('textbox', { name: 'Quick capture task' })
      .fill('Synthetic browser capture');
    await page.getByRole('button', { name: 'Capture task', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: /Tasks/ })
      .click();
    await expect(page.getByText('Synthetic browser capture', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Complete Synthetic browser capture' }).click();
    await page.getByRole('button', { name: 'Completed', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Reopen Synthetic browser capture' }),
    ).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Markets', exact: true })
      .click();
    await page
      .getByRole('button', { name: /Buy setup.*EMA/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Behind the decision' })).toBeVisible();
    await expect(page.getByText('Evidence SHA-256', { exact: false })).toBeVisible();
    await expect(page.getByText('SIMULATED · AllIn fixture v1')).toBeVisible();
    await expect(page.getByText('What happened afterward')).toBeVisible();
    await expect(page.getByRole('dialog').getByText(/not financial advice/)).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: '4H', exact: true }).click();
    await page.screenshot({
      path: 'test-results/markets-desktop.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Health', exact: true })
      .click();
    await expect(page.getByText('Health sharing off')).toBeVisible();
    await page.getByRole('button', { name: 'Workouts', exact: true }).click();
    await page.screenshot({
      path: 'test-results/health-desktop.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Import OpenFit export', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your local vault' })).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog' }).click();
    // In preview, turning a feed on leads to vault creation, and nothing is sent.
    await page.getByRole('button', { name: 'Connections & privacy', exact: true }).first().click();
    for (const name of ['Coinbase market data', 'Alpaca market data']) {
      const row = page.locator('.integration-row').filter({ hasText: name });
      await row.getByRole('button', { name: 'Turn on', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Your local vault' })).toBeVisible();
      await page.getByRole('button', { name: 'Close dialog' }).click();
    }
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Today', exact: true })
      .click();
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      audit.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      path: 'test-results/today-mobile.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: /Tasks/ })
      .click();
    await expect(page.getByRole('heading', { name: 'Make room for what matters.' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  });
  test('the About OpenFit import dialog describes what the import does', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Health', exact: true })
      .click();
    await page.getByRole('button', { name: 'About OpenFit import', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'OpenFit stays the source of truth' });
    await expect(dialog).toContainText(/OpenFit 0\.1\.11/);
    await expect(dialog).toContainText(/number of workouts/);
    await expect(dialog).toContainText(/weight in kilograms/);
    await expect(dialog).not.toContainText(/disabled in this foundation|next milestone/i);
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Around AllIn' }).click();
    const help = page.getByRole('dialog', { name: 'A little more intention, every day' });
    await expect(help).not.toContainText(
      /example health trends|M0 foundation|personal health imports/,
    );
  });
  test('a failed health module leaves task capture and markets usable', async ({ page }) => {
    await page.route('**/api/demo/health', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic health failure' }),
      }),
    );
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Health summary unavailable' })).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Quick capture task' })
      .fill('Task while health is unavailable');
    await page.getByRole('button', { name: 'Capture task', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Added to the preview inbox');
    await expect(page.getByRole('button', { name: /AAPL Apple Inc/ })).toBeVisible();
  });
  test('real vault workflow: create, persist, edit, complete, recoverable export, and lock', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Make it yours', exact: true }).click();
    await expect(page.locator('.vault-caveat')).toHaveText(
      'Foundation release · market feeds stay off until you turn them on, and AI connections are disabled. OpenFit import is by hand, from a file you choose. Keep your passphrase safe; there is no cloud recovery.',
    );
    await page.getByLabel('Choose a passphrase').fill('browser synthetic passphrase 1234');
    await page.getByLabel('Confirm passphrase').fill('browser synthetic passphrase 1234');
    await page.getByRole('button', { name: 'Create my vault', exact: true }).click();
    await expect(page.getByText('YOUR LOCAL VAULT', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Add a task', exact: true }).click();
    await page.getByLabel('Task', { exact: true }).fill('Persisted browser task');
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('Work');
    await page.getByLabel('Estimated minutes').fill('45');
    await page.getByRole('button', { name: 'Add to inbox', exact: true }).click();
    await expect(page.getByText('Persisted browser task', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Persisted browser task', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Complete Persisted browser task' }).click();
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: /Tasks/ })
      .click();
    await page.getByRole('button', { name: 'Completed', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Persisted browser task' }).click();
    await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('Work');
    await expect(page.getByLabel('Estimated minutes')).toHaveValue('45');
    await page.getByLabel('Task', { exact: true }).fill('Completed and edited');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('button', { name: 'Reopen Completed and edited' })).toBeVisible();
    await page.getByRole('button', { name: 'Connections & privacy', exact: true }).click();
    await page.getByRole('button', { name: 'Export encrypted backup' }).click();
    const backupDialog = page.getByRole('dialog', { name: 'A safe copy of your space' });
    await expect(backupDialog).toContainText(
      'Your tasks, Health summaries, and preferences are encrypted before download. Choose a separate recovery phrase; it will never be saved by AllIn.',
    );
    await expect(backupDialog).toContainText(
      'Store this phrase somewhere safe. A lost phrase cannot be reset. Deleting a task or purging Health data later does not remove it from older backups.',
    );
    await page
      .getByLabel('Recovery phrase', { exact: true })
      .fill('browser synthetic recovery phrase 5678');
    await page.getByLabel('Confirm recovery phrase').fill('browser synthetic recovery phrase 5678');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download encrypted backup' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.allin-backup$/);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Lock vault', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: 'Welcome back to your space.' })).toBeVisible();
    await expect(page.getByText('Completed and edited', { exact: true })).toHaveCount(0);
    await page.getByLabel('Your passphrase').fill('browser synthetic passphrase 1234');
    await page.getByRole('button', { name: 'Unlock vault', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your day, in perspective.' })).toBeVisible();
  });
  test('another tab must enter the passphrase, then takes over from the first', async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4311' });
    try {
      const first = await context.newPage();
      await unlock(first);
      await first.reload();
      await expect(first.getByRole('heading', { name: 'Your day, in perspective.' })).toBeVisible();
      const second = await context.newPage();
      await unlock(second);
      await first.reload();
      await expect(
        first.getByRole('heading', { name: 'Welcome back to your space.' }),
      ).toBeVisible();
      await expect(
        second.getByRole('heading', { name: 'Your day, in perspective.' }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
  test('market screens show the rule overview and the disclaimer', async ({ page }) => {
    await unlock(page);
    await expect(page.locator('.watchlist-card').getByText(/not financial advice/)).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Markets', exact: true })
      .click();
    const overview = page.locator('.rule-overview');
    await expect(overview).toContainText('Where the rule stands on AAPL');
    await expect(overview).toContainText('EMA position');
    await expect(overview).toContainText(/not financial advice/);
  });
  test('a failed task read is shown on the Tasks page, not an empty list', async ({ page }) => {
    await page.route('**/api/tasks', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic read failure' }),
      }),
    );
    await unlock(page);
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: /Tasks/ })
      .click();
    await expect(page.getByRole('alert')).toContainText('Synthetic read failure');
  });
  test('schedule times, overdue tasks, project filter, and weekly adjustment', async ({
    browser,
  }) => {
    // The browser is in New York while the app's display timezone stays Asia/Jerusalem.
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:4311',
      timezoneId: 'America/New_York',
      viewport: { width: 1440, height: 1050 },
    });
    try {
      const page = await context.newPage();
      await unlock(page);
      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      await nav.getByRole('button', { name: /Tasks/ }).click();

      const newTask = async (title: string, fill: () => Promise<void>) => {
        await page.getByRole('button', { name: 'New task', exact: true }).click();
        await page.getByLabel('Task', { exact: true }).fill(title);
        await fill();
        await page.getByRole('button', { name: 'Add to inbox', exact: true }).click();
        await expect(page.getByText(title, { exact: true })).toBeVisible();
      };

      await newTask('Zoned browser task', () =>
        page.getByLabel('Reserve a time').fill('2026-11-20T09:00'),
      );
      await expect(
        page.locator('.task-row', { hasText: 'Zoned browser task' }).locator('.task-meta'),
      ).toContainText('Nov 20, 9:00 AM');
      await page.getByRole('button', { name: 'Edit Zoned browser task' }).click();
      await expect(page.getByLabel('Reserve a time')).toHaveValue('2026-11-20T09:00');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();

      await newTask('Overdue browser task', () => page.getByLabel('Due date').fill('2026-01-05'));
      await page.locator('.tabs').getByRole('button', { name: 'Today', exact: true }).click();
      await expect(page.getByText('Overdue browser task', { exact: true })).toBeVisible();
      await page.locator('.tabs').getByRole('button', { name: /Inbox/ }).click();

      await newTask('Workout plan', async () => {});
      await page.locator('.project-row', { hasText: 'Work' }).click();
      await expect(page.getByText('Completed and edited', { exact: true })).toBeVisible();
      await expect(page.getByText('Workout plan', { exact: true })).toHaveCount(0);
      await page.locator('.project-row', { hasText: 'Work' }).click();
      await expect(page.getByText('Workout plan', { exact: true })).toBeVisible();

      await nav.getByRole('button', { name: 'Weekly review', exact: true }).click();
      await page.getByRole('radio', { name: 'Protect one daily focus block' }).check();
      await page.getByRole('button', { name: 'Keep this intention' }).click();
      await expect(page.getByRole('button', { name: 'Adjustment saved' })).toBeVisible();
      await nav.getByRole('button', { name: 'Today', exact: true }).click();
      await expect(page.locator('.intention-card')).toContainText(
        'Next week: Protect one daily focus block',
      );
    } finally {
      await context.close();
    }
  });
});
async function unlock(page: Page) {
  await page.goto('/');
  await page.getByLabel('Your passphrase').fill('browser synthetic passphrase 1234');
  await page.getByRole('button', { name: 'Unlock vault', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your day, in perspective.' })).toBeVisible();
}

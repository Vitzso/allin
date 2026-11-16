import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { closeSync, openSync, readFileSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_EXPORT_BYTES } from '../../shared/openfit';
import { calendarDay } from '../../shared/schema';
import { addDays, daysBetween } from '../../shared/time';

import { openVault, passphrase } from './support';

/** The fixture with its dates moved to the present, so the tests don't depend on the real clock. */
function exportFile(daysAgo = 0, edit?: (d: any) => void) {
  const data = JSON.parse(readFileSync('tests/fixtures/openfit-0.1.11.json', 'utf8'));
  const exportedAt = new Date(Date.now() - daysAgo * 86400000).toISOString();
  const shift = daysBetween('2026-11-06', calendarDay(exportedAt, 'Asia/Jerusalem'));
  for (const entry of [...data.workouts, ...data.bodyWeights])
    entry.day = addDays(entry.day, shift);
  data.exportedAt = exportedAt;
  edit?.(data);
  return {
    name: 'PRIVATE-MARKER-file-name.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data)),
  };
}
const NUDGING_WORDING =
  /you should|we recommend|too (high|low)|diagnos|A little more movement|Consistency over intensity/i;
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
async function openHealth(page: Page) {
  await openVault(page);
  await nav(page).getByRole('button', { name: 'Health', exact: true }).click();
}
async function openImport(page: Page, file: ReturnType<typeof exportFile> | string) {
  await page.getByRole('button', { name: 'Import OpenFit export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import from OpenFit' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('OpenFit export file').setInputFiles(file);
  return dialog;
}
const importBodies = (page: Page) => {
  const bodies: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/health/import')) bodies.push(r.postData() ?? '');
  });
  return bodies;
};

test.describe.serial('Health', () => {
  test('the week start setting reorders the weekly review', async ({ page }) => {
    await openVault(page);
    await page.getByRole('button', { name: 'Connections & privacy', exact: true }).click();
    await page.getByLabel('Week starts on').selectOption('Sunday');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await nav.getByRole('button', { name: 'Weekly review', exact: true }).click();
    await expect(page.locator('.weekly-chart small').first()).toHaveText('Sun');
    await page.getByRole('button', { name: 'Connections & privacy', exact: true }).click();
    await page.getByLabel('Week starts on').selectOption('Monday');
  });

  test('first run asks for an import and shows no sample numbers', async ({ page }) => {
    await openHealth(page);
    await expect(page.getByRole('heading', { name: 'Import your OpenFit export' })).toBeVisible();
    await expect(page.getByText('Sample data')).toHaveCount(0);
    await expect(page.getByText('76.0')).toHaveCount(0);
  });
  test('a bad file shows a message and sends nothing', async ({ page }) => {
    const bodies = importBodies(page);
    await openHealth(page);
    const dialog = await openImport(page, {
      name: 'PRIVATE-MARKER-file-name.json',
      mimeType: 'application/json',
      buffer: Buffer.from('this is not json'),
    });
    await expect(dialog.getByRole('alert')).toContainText(/isn’t an OpenFit export/);
    const big = join(tmpdir(), `allin-big-${process.pid}.json`);
    closeSync(openSync(big, 'w'));
    try {
      truncateSync(big, MAX_EXPORT_BYTES + 1);
      await dialog.getByLabel('OpenFit export file').setInputFiles(big);
      await expect(dialog.getByRole('alert')).toContainText(/over 100 MB/);
    } finally {
      rmSync(big, { force: true });
    }
    expect(bodies).toEqual([]);
  });
  test('the preview explains the import, and only derived rows are sent', async ({ page }) => {
    const bodies = importBodies(page);
    await openHealth(page);
    const dialog = await openImport(page, exportFile());
    await expect(dialog.getByText('4 days')).toBeVisible();
    await expect(dialog.getByText('3 days')).toBeVisible();
    await expect(dialog.getByText('Coach messages', { exact: true })).toBeVisible();
    await expect(dialog.getByText(/2 empty or warm-up-only/)).toBeVisible();
    await expect(dialog.getByText(/stays wherever you saved it/)).toBeVisible();
    await expect(dialog.getByText(/starts its week on Sunday/)).toBeVisible();
    await expect(dialog.getByText('4 added')).toBeVisible();
    const exportDate = new Date().toLocaleDateString('en-US', {
      timeZone: 'Asia/Jerusalem',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    await expect(dialog.getByText(`Exported ${exportDate}`)).toBeVisible();
    const audit = await new AxeBuilder({ page })
      .include('dialog')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(
      audit.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
    await dialog.getByRole('button', { name: 'Save to my vault', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('OpenFit export imported');
    await expect(dialog).toHaveCount(0);
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(body).not.toMatch(/PRIVATE-MARKER|weekStart/);
      expect(Object.keys(JSON.parse(body)).sort()).toEqual([
        'confirmOlder',
        'dryRun',
        'source',
        'weight',
        'workouts',
      ]);
    }
    expect(JSON.parse(bodies[0]).dryRun).toBe(true);
    expect(JSON.parse(bodies.at(-1)!).dryRun).toBe(false);
  });
  test('choosing a date range and categories changes what is sent', async ({ page }) => {
    const bodies = importBodies(page);
    await openHealth(page);
    const dialog = await openImport(page, exportFile());
    await expect.poll(() => bodies.length).toBeGreaterThan(0);
    const kept = dialog
      .getByRole('region', { name: 'What this import does' })
      .locator('ul')
      .first();
    await expect(kept).toContainText('Weight');
    await dialog.getByLabel('Weight', { exact: true }).uncheck();
    await expect
      .poll(() => Object.keys(JSON.parse(bodies.at(-1)!)).sort())
      .toEqual(['confirmOlder', 'dryRun', 'source', 'workouts']);
    await expect(kept).toContainText('Workouts');
    await expect(kept).not.toContainText('Weight');
    await dialog.getByLabel('Weight', { exact: true }).check();
    await expect(kept).toContainText('Weight');
    await expect(kept.locator('li', { hasText: 'Workouts' })).toContainText('4 days');
    const today = calendarDay(new Date().toISOString(), 'Asia/Jerusalem');
    await dialog.getByLabel('A date range').check();
    await dialog.getByLabel('From').fill(today);
    await dialog.getByLabel('To').fill(addDays(today, -3));
    await expect(dialog.getByText(/From must be on or before To/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save to my vault' })).toBeDisabled();
    const before = bodies.length;
    await page.waitForTimeout(500);
    expect(bodies.length).toBe(before);
    await dialog.getByLabel('From').fill(addDays(today, -3));
    await dialog.getByLabel('To').fill(today);
    await expect
      .poll(() => JSON.parse(bodies.at(-1)!).workouts?.replaceFrom)
      .toBe(addDays(today, -3));
    expect(JSON.parse(bodies.at(-1)!).workouts.replaceTo).toBe(today);
    // The kept list follows the range: two workout days and one weight in the last four days.
    await expect(kept.locator('li', { hasText: 'Workouts' })).toContainText('2 days');
    await expect(kept.locator('li', { hasText: 'Workouts' })).not.toContainText('4 days');
    await expect(kept.locator('li', { hasText: 'Weight' })).toContainText('1 day');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
  test('a selection with nothing to save says so, unless it records days with no workout', async ({
    page,
  }) => {
    await openHealth(page);
    const dialog = await openImport(page, exportFile());
    const save = dialog.getByRole('button', { name: 'Save to my vault', exact: true });
    await expect(save).toBeEnabled();
    const today = calendarDay(new Date().toISOString(), 'Asia/Jerusalem');
    await dialog.getByLabel('A date range').check();
    await dialog.getByLabel('From').fill(addDays(today, -400));
    await dialog.getByLabel('To').fill(addDays(today, -300));
    await expect(dialog.getByText('Nothing to save in this selection.')).toBeVisible();
    await expect(save).toBeDisabled();
    // Dates inside the export with no entries still record days with no workout.
    await dialog.getByLabel('From').fill(addDays(today, -10));
    await dialog.getByLabel('To').fill(addDays(today, -6));
    await expect(dialog.locator('.import-counts').first()).toBeVisible();
    await expect(dialog.getByText('Nothing to save in this selection.')).toHaveCount(0);
    await expect(save).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
  test('an older file needs confirmation', async ({ page }) => {
    await openHealth(page);
    const dialog = await openImport(page, exportFile(2));
    const save = dialog.getByRole('button', { name: 'Save to my vault', exact: true });
    const confirm = dialog.getByLabel('Use this older file anyway');
    await expect(confirm).toBeVisible();
    await expect(save).toBeDisabled();
    await confirm.check();
    await expect(save).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
  test('changing the selection or the file clears the older-file confirmation', async ({
    page,
  }) => {
    await openHealth(page);
    const dialog = await openImport(page, exportFile(2));
    const save = dialog.getByRole('button', { name: 'Save to my vault', exact: true });
    const confirm = dialog.getByLabel('Use this older file anyway');
    await confirm.check();
    await expect(save).toBeEnabled();
    await dialog.getByLabel('Weight', { exact: true }).uncheck();
    await expect(confirm).not.toBeChecked();
    await expect(save).toBeDisabled();
    await confirm.check();
    await expect(save).toBeEnabled();
    await dialog.getByLabel('OpenFit export file').setInputFiles(exportFile(2));
    await expect(confirm).not.toBeChecked();
    await expect(save).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  });
  test('a slow file cannot replace the preview of a later one', async ({ page }) => {
    await openHealth(page);
    const dialog = await openImport(page, exportFile());
    await expect(dialog.getByText('Coach messages', { exact: true })).toBeVisible();
    // The next file read answers late.
    await page.evaluate(() => {
      const read = Blob.prototype.text;
      let calls = 0;
      Blob.prototype.text = function (this: Blob) {
        const answer = read.call(this);
        return calls++ === 0
          ? new Promise<string>((resolve) => setTimeout(() => void answer.then(resolve), 1500))
          : answer;
      };
    });
    const kept = dialog
      .getByRole('region', { name: 'What this import does' })
      .locator('ul')
      .first();
    const input = dialog.getByLabel('OpenFit export file');
    await input.setInputFiles(exportFile());
    await input.setInputFiles(
      exportFile(0, (d) => {
        d.bodyWeights = d.bodyWeights.slice(0, 1);
      }),
    );
    await expect(kept.locator('li', { hasText: 'Weight' })).toContainText('1 day');
    await page.waitForTimeout(2200);
    await expect(kept.locator('li', { hasText: 'Weight' })).toContainText('1 day');
    await expect(kept.locator('li', { hasText: 'Weight' })).not.toContainText('3 days');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
  test('a dry run answered after the selection changed is dropped', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = false;
    let first = true;
    await page.route('**/api/health/import', async (route) => {
      if (first && route.request().postDataJSON().dryRun) {
        first = false;
        holding = true;
        await held;
      }
      return route.continue();
    });
    await openHealth(page);
    const dialog = await openImport(page, exportFile());
    await expect.poll(() => holding).toBe(true);
    await dialog.getByLabel('Weight', { exact: true }).uncheck();
    const counts = dialog.locator('.import-counts');
    await expect(counts).toHaveCount(1);
    await expect(counts.first()).toContainText('Workouts');
    release();
    await page.waitForTimeout(800);
    await expect(counts).toHaveCount(1);
    await expect(counts.first()).toContainText('Workouts');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
  test('the dialog stays open while a save is running', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = false;
    await page.route('**/api/health/import', async (route) => {
      if (route.request().postDataJSON().dryRun === false) {
        holding = true;
        await held;
      }
      return route.continue();
    });
    await openHealth(page);
    const dialog = await openImport(page, exportFile());
    const save = dialog.getByRole('button', { name: 'Save to my vault', exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(() => holding).toBe(true);
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancel).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.mouse.click(4, 4);
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await expect(dialog).toBeVisible();
    release();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('OpenFit export imported');
  });
  test('a refused save shows the server message and keeps the choices', async ({ page }) => {
    const message =
      'AllIn is tracking too many separate date ranges. Import All dates to combine them.';
    let dryRuns = 0;
    await page.route('**/api/health/import', (route) => {
      if (route.request().postDataJSON().dryRun === false)
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: message }),
        });
      dryRuns++;
      return route.continue();
    });
    await openHealth(page);
    const dialog = await openImport(page, exportFile());
    const save = dialog.getByRole('button', { name: 'Save to my vault', exact: true });
    await expect(save).toBeEnabled();
    const before = dryRuns;
    await save.click();
    await expect(dialog.getByRole('alert')).toHaveText(message);
    // The preview is checked again, so its counts are current, and the message stays.
    await expect.poll(() => dryRuns).toBeGreaterThan(before);
    await expect(dialog.getByRole('alert')).toHaveText(message);
    await expect(save).toBeEnabled();
    await expect(dialog.getByLabel('Use this older file anyway')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('All dates')).toBeChecked();
  });
  test('an empty export states what it will remove before saving', async ({ page }) => {
    await openHealth(page);
    const dialog = await openImport(
      page,
      exportFile(0, (d) => {
        d.workouts = [];
        d.bodyWeights = [];
      }),
    );
    await expect(dialog.getByText(/saved days will be removed/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Import your OpenFit export' })).toHaveCount(0);
  });
  test('locking during an import clears the file and preview', async ({ page }) => {
    await openHealth(page);
    const dialog = await openImport(page, exportFile());
    await expect(dialog.getByText('Coach messages', { exact: true })).toBeVisible();
    await page.evaluate(async () => {
      await fetch('/api/vault/lock', {
        method: 'POST',
        headers: {
          'X-AllIn-CSRF': sessionStorage.getItem('allin.session-token') ?? '',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      window.dispatchEvent(new Event('allin-locked'));
    });
    await expect(page.getByLabel('Your passphrase')).toBeVisible();
    await page.getByLabel('Your passphrase').fill(passphrase);
    await page.getByRole('button', { name: 'Unlock vault', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your day, in perspective.' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await nav(page).getByRole('button', { name: 'Health', exact: true }).click();
    await page.getByRole('button', { name: 'Import OpenFit export', exact: true }).click();
    await expect(page.getByText('Coach messages')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save to my vault' })).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  });
  test('a failed summary shows its error and other modules keep working', async ({ page }) => {
    await page.route('**/api/health/summary', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic health failure' }),
      }),
    );
    await openHealth(page);
    await expect(page.getByRole('heading', { name: 'Health summary unavailable' })).toBeVisible();
    await expect(page.getByText('Synthetic health failure')).toBeVisible();
    await nav(page).getByRole('button', { name: 'Today', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Quick capture task' })
      .fill('Task during health failure');
    await page.getByRole('button', { name: 'Capture task', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved to your inbox');
  });
  test('Connections & privacy does not claim Not imported when the summary cannot be read', async ({
    page,
  }) => {
    await page.route('**/api/health/summary', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic health failure' }),
      }),
    );
    await openVault(page);
    await page.getByRole('button', { name: 'Connections & privacy', exact: true }).click();
    const row = page.locator('.integration-row').filter({ hasText: 'OpenFit' });
    await expect(row.getByText('Status unavailable', { exact: true })).toBeVisible();
    await expect(row).toContainText('Kept: Unknown');
    await expect(row).toContainText('Last import: Unknown');
    await expect(row).not.toContainText('Not imported');
    await expect(row).not.toContainText('Never');
  });
  /** Imports a file through the dialog and waits for it to close. */
  async function importFile(page: Page, file: ReturnType<typeof exportFile>, older = false) {
    const dialog = await openImport(page, file);
    if (older) await dialog.getByLabel('Use this older file anyway').check();
    await dialog.getByRole('button', { name: 'Save to my vault', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  const today = (page: Page) => nav(page).getByRole('button', { name: 'Today', exact: true });
  const healthCards = (page: Page) => page.locator('.summary-card, .movement-card');

  test('imported data replaces every sample on Today and Health', async ({ page }) => {
    await openVault(page);
    for (const card of ['.summary-card:has-text("OpenFit")', '.movement-card']) {
      await expect(page.locator(card)).toContainText(/\d+ (of \d+ )?workouts?/);
    }
    await expect(healthCards(page).getByText('Example')).toHaveCount(0);
    expect(await page.locator('main').innerText()).not.toMatch(NUDGING_WORDING);
    await expect(healthCards(page).getByText('Synthetic example')).toHaveCount(0);
    const exportDate = new Date().toLocaleDateString('en-US', {
      timeZone: 'Asia/Jerusalem',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    for (const card of ['.summary-card:has-text("OpenFit")', '.movement-card']) {
      await expect(page.locator(card)).toContainText(`exported ${exportDate}`);
      await expect(page.locator(card)).toContainText(/\d of 7 days covered/);
    }
    await nav(page).getByRole('button', { name: 'Health', exact: true }).click();
    await expect(page.getByText(/OpenFit export · exported .* · imported/)).toBeVisible();
    await expect(page.locator('.workout-days [role="img"]')).toHaveCount(7);
    await expect(page.getByRole('heading', { name: 'Recent workout days' })).toBeVisible();
    await expect(page.locator('.weight-latest')).toContainText('76.2');
    await expect(page.getByText('Sample data')).toHaveCount(0);
    const text = await page.locator('main').innerText();
    expect(text).not.toMatch(NUDGING_WORDING);
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      audit.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('a goal changes the count and survives a reload', async ({ page }) => {
    await openHealth(page);
    await page.getByLabel('Weekly workout goal').selectOption('3');
    await expect(page.getByText(/ of 3 workouts/).first()).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your day, in perspective.' })).toBeVisible();
    await nav(page).getByRole('button', { name: 'Health', exact: true }).click();
    await expect(page.getByLabel('Weekly workout goal')).toHaveValue('3');
    await expect(page.getByText(/ of 3 workouts/).first()).toBeVisible();
    await page.getByLabel('Weekly workout goal').selectOption({ label: 'No goal' });
    await expect(page.getByText(/ of 3/)).toHaveCount(0);
  });

  test('the weight chart switches range and handles sparse data', async ({ page }) => {
    await openHealth(page);
    for (const label of ['90 days', '1 year', '28 days']) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    await expect(page.getByRole('button', { name: '90 days', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // One measurement today.
    await importFile(
      page,
      exportFile(0, (d) => {
        d.bodyWeights = [{ id: 1, day: d.workouts.at(-1).day, weightKg: 75.5 }];
      }),
    );
    await expect(page.getByText('One measurement in this range')).toBeVisible();
    await expect(page.locator('.weight-latest')).toContainText('75.5');
    expect(await page.content()).not.toMatch(/NaN|Infinity/);
    // The only measurement is 100 days back.
    await importFile(
      page,
      exportFile(0, (d) => {
        d.bodyWeights = [{ id: 1, day: addDays(d.workouts.at(-1).day, -100), weightKg: 74.5 }];
      }),
    );
    await expect(page.getByText('No measurements in this range')).toBeVisible();
    expect(await page.content()).not.toMatch(/NaN|Infinity/);
    await page.getByRole('button', { name: '1 year', exact: true }).click();
    await expect(page.getByText('One measurement in this range')).toBeVisible();
    expect(await page.content()).not.toMatch(/NaN|Infinity/);
    await importFile(page, exportFile(0));
    await expect(page.locator('.weight-latest')).toContainText('76.2');
  });

  test('a week with no workout data says so instead of showing zero', async ({ page }) => {
    await openHealth(page);
    await page.getByRole('button', { name: 'Purge Health data', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Purge imported Health data?' })
      .getByRole('button', { name: 'Purge from AllIn', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Import your OpenFit export' })).toBeVisible();
    const dialog = await openImport(page, exportFile());
    await dialog.getByLabel('Workouts', { exact: true }).uncheck();
    await dialog.getByRole('button', { name: 'Save to my vault', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const none = /(^|\D)0 (of \d+ )?workouts?/;
    await expect(page.locator('.health-value').first()).toContainText('No workout data this week');
    expect(await page.locator('main').innerText()).not.toMatch(none);
    await today(page).click();
    for (const card of ['.summary-card:has-text("OpenFit")', '.movement-card']) {
      await expect(page.locator(card)).toContainText('No workout data this week');
      await expect(page.locator(card)).toContainText('exported');
      await expect(page.locator(card)).toContainText('0 of 7 days covered');
    }
    expect(await page.locator('main').innerText()).not.toMatch(none);
    await nav(page).getByRole('button', { name: 'Health', exact: true }).click();
    await importFile(page, exportFile(0));
    await expect(page.locator('.health-value').first()).toContainText(/\d+ workouts?/);
  });

  test('an old export is labelled with its age', async ({ page }) => {
    await openHealth(page);
    // The label follows the newest saved coverage, so the vault starts empty of newer data.
    await page.evaluate(async () => {
      await fetch('/api/health/purge', {
        method: 'POST',
        headers: {
          'X-AllIn-CSRF': sessionStorage.getItem('allin.session-token') ?? '',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
    });
    await nav(page).getByRole('button', { name: 'Today', exact: true }).click();
    await nav(page).getByRole('button', { name: 'Health', exact: true }).click();
    await importFile(page, exportFile(10));
    await expect(page.getByText(/Exported \d+ days ago/)).toBeVisible();
    await today(page).click();
    await expect(page.getByText(/Exported \d+ days ago/).first()).toBeVisible();
    await nav(page).getByRole('button', { name: 'Health', exact: true }).click();
    await importFile(page, exportFile(0));
    await expect(page.getByText(/Exported \d+ days ago/)).toHaveCount(0);
  });

  test('changing the week start updates Health without a reload', async ({ page }) => {
    await openVault(page);
    const settings = page.getByRole('button', { name: 'Connections & privacy', exact: true });
    const first = page.locator('.workout-days [role="img"]').first();
    await settings.click();
    await page.getByLabel('Week starts on').selectOption('Sunday');
    await nav(page).getByRole('button', { name: 'Health', exact: true }).click();
    await expect(page.locator('.workout-days > div > span').first()).toHaveText('S');
    await expect(first).toHaveAttribute('aria-label', /^Sun/);
    await settings.click();
    await page.getByLabel('Week starts on').selectOption('Monday');
    await nav(page).getByRole('button', { name: 'Health', exact: true }).click();
    await expect(first).toHaveAttribute('aria-label', /^Mon/);
  });

  test('purge explains itself, then returns to the first-run state', async ({ page }) => {
    await openHealth(page);
    const open = () => page.getByRole('button', { name: 'Purge Health data', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Purge imported Health data?' });
    await open();
    await expect(dialog).toContainText(/older backups/i);
    await expect(dialog).toContainText(/OpenFit/);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.workout-days')).toBeVisible();
    await open();
    await dialog.getByRole('button', { name: 'Purge from AllIn', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Import your OpenFit export' })).toBeVisible();
    await today(page).click();
    await expect(page.getByRole('heading', { name: 'Import your OpenFit export' })).toBeVisible();
    await expect(page.locator('.summary-card').getByText(/workouts?$/)).toHaveCount(0);
    await nav(page).getByRole('button', { name: 'Health', exact: true }).click();
    await importFile(page, exportFile(0));
    await expect(page.locator('.workout-days')).toBeVisible();
  });

  test('an empty export leaves a goal that Purge can remove', async ({ page }) => {
    await openHealth(page);
    await page.getByLabel('Weekly workout goal').selectOption('3');
    await expect(page.getByText(/ of 3 workouts/).first()).toBeVisible();
    await importFile(
      page,
      exportFile(0, (d) => {
        d.workouts = [];
        d.bodyWeights = [];
      }),
    );
    await expect(page.getByRole('heading', { name: 'Import your OpenFit export' })).toBeVisible();
    const purge = page.getByRole('button', { name: 'Purge Health data', exact: true });
    await expect(purge).toBeVisible();
    await purge.click();
    await page
      .getByRole('dialog', { name: 'Purge imported Health data?' })
      .getByRole('button', { name: 'Purge from AllIn', exact: true })
      .click();
    await expect(purge).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Import your OpenFit export' })).toBeVisible();
    await importFile(page, exportFile(0));
    await expect(page.locator('.workout-days')).toBeVisible();
  });

  test('a failed purge shows its error in the dialog and leaves none behind after Cancel', async ({
    page,
  }) => {
    await openHealth(page);
    let failed = 0;
    await page.route('**/api/health/purge', (route) => {
      if (failed++) return route.continue();
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic purge failure' }),
      });
    });
    await page.getByRole('button', { name: 'Purge Health data', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Purge imported Health data?' });
    await dialog.getByRole('button', { name: 'Purge from AllIn', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Synthetic purge failure');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    // Closing with the dialog's own control clears it too.
    await page.getByRole('button', { name: 'Purge Health data', exact: true }).click();
    await page.unroute('**/api/health/purge');
    await page.route('**/api/health/purge', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic purge failure' }),
      }),
    );
    await dialog.getByRole('button', { name: 'Purge from AllIn', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('Connections & privacy reports the real OpenFit status', async ({ page }) => {
    await openVault(page);
    const privacy = page.getByRole('button', { name: 'Connections & privacy', exact: true });
    const row = page.locator('.integration-row').filter({ hasText: 'OpenFit' });
    await privacy.click();
    await expect(row).toContainText('Manual file import · no database access');
    await expect(row.getByText('Imported', { exact: true })).toBeVisible();
    await expect(row).toContainText('Kept: Workouts, Weight');
    await expect(row).toContainText('Destination: Local file only');
    await expect(row).toContainText(/Last import: [A-Z][a-z]{2} \d{1,2}, \d{4}/);
    await expect(row).not.toContainText('Never');
    // The other connections keep their own, untouched status.
    for (const name of ['Coinbase market data', 'Alpaca market data']) {
      const feed = page.locator('.integration-row').filter({ hasText: name });
      await expect(feed).toContainText('Last access: Never');
      await expect(feed).toContainText('Shared: None');
    }
    await expect(row).not.toContainText('Shared:');
    await expect(row).not.toContainText('Last access:');
    await expect(page.getByText('Export tasks, Health summaries, and preferences')).toBeVisible();
    await row.getByRole('button', { name: 'Manage in Health', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Health', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import OpenFit export' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Purge Health data' })).toBeVisible();
    await page.getByRole('button', { name: 'Purge Health data', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Purge imported Health data?' })
      .getByRole('button', { name: 'Purge from AllIn', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Import your OpenFit export' })).toBeVisible();
    await privacy.click();
    await expect(row.getByText('Not imported', { exact: true })).toBeVisible();
    await expect(row).toContainText('Kept: None');
    await expect(row).toContainText('Last import: Never');
  });
});

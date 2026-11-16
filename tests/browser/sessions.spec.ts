import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openVault } from './support';

test('Connections & privacy lists this device, and signing out returns to the locked screen', async ({
  page,
}) => {
  await openVault(page);
  await page.getByRole('button', { name: 'Connections & privacy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Signed-in devices' })).toBeVisible();
  const card = page.locator('.card', {
    has: page.getByRole('heading', { name: 'Signed-in devices' }),
  });
  const rows = card.locator('.event-list > div');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('This device');
  await expect(rows.first()).toContainText(/signed in .* last active /);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    results.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
  ).toEqual([]);
  await rows.first().getByRole('button', { name: 'Sign out this device', exact: true }).click();
  await expect(page.getByLabel('Your passphrase')).toBeVisible();
});

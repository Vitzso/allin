import { expect, type Page } from '@playwright/test';

export const passphrase = 'browser synthetic passphrase 1234';

/** Creates the vault if none exists, else unlocks the one an earlier spec left behind. */
export async function openVault(page: Page) {
  await page.goto('/');
  const create = page.getByRole('button', { name: 'Make it yours', exact: true });
  const unlock = page.getByLabel('Your passphrase');
  await create.or(unlock).waitFor();
  if (await create.isVisible()) {
    await create.click();
    await page.getByLabel('Choose a passphrase').fill(passphrase);
    await page.getByLabel('Confirm passphrase').fill(passphrase);
    await page.getByRole('button', { name: 'Create my vault', exact: true }).click();
  } else {
    await unlock.fill(passphrase);
    await page.getByRole('button', { name: 'Unlock vault', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: 'Your day, in perspective.' })).toBeVisible();
}

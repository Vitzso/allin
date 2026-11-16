import { expect, test, type Page } from '@playwright/test';
import { openVault } from './support.ts';

// The Apple polish pass: dark mode, readable text, touch targets, the phone tab bar, and the
// home-screen manifest. These run signed in, because the other specs leave a vault behind and the preview is then gone.
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

// WCAG contrast between two CSS colours, read from the page so the real values are tested.
async function contrast(page: Page, front: string, back: string) {
  return page.evaluate(
    ([front, back]) => {
      const rgb = (value: string) => {
        const probe = document.createElement('i');
        probe.style.color = value;
        document.body.append(probe);
        const parts = getComputedStyle(probe)
          .color.match(/[\d.]+/g)!
          .map(Number);
        probe.remove();
        return parts.slice(0, 3).map((channel) => {
          const part = channel / 255;
          return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
        });
      };
      const light = (value: string) => {
        const [r, g, b] = rgb(value);
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const [a, b] = [light(front!), light(back!)];
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    },
    [front, back],
  );
}

for (const scheme of ['light', 'dark'] as const)
  test(`body and secondary text are readable on the page and on cards in ${scheme} mode`, async ({
    browser,
  }) => {
    const page = await browser.newPage({ colorScheme: scheme });
    await openVault(page);
    const text = await page.evaluate(() => getComputedStyle(document.body).color);
    for (const back of ['var(--surface)', 'var(--page)']) {
      expect(await contrast(page, text, back)).toBeGreaterThanOrEqual(7);
      expect(await contrast(page, 'var(--muted)', back)).toBeGreaterThanOrEqual(4.5);
      expect(await contrast(page, 'var(--green)', back)).toBeGreaterThanOrEqual(4.5);
    }
    await page.close();
  });

test('dark mode follows the device and the page turns dark', async ({ browser }) => {
  const page = await browser.newPage({ colorScheme: 'dark' });
  await openVault(page);
  expect(await contrast(page, 'var(--page)', '#000')).toBeLessThan(1.6);
  expect(await contrast(page, 'var(--surface)', 'var(--page)')).toBeGreaterThan(1.05);
  await page.close();
});

test('a phone gets a tab bar for the five sections, and a desktop does not', async ({
  browser,
  page,
}) => {
  await openVault(page);
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeHidden();
  const small = await browser.newPage(phone);
  await openVault(small);
  const bar = small.getByRole('navigation', { name: 'Sections' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button')).toHaveCount(5);
  await bar.getByRole('button', { name: 'Tasks' }).click();
  await expect(bar.getByRole('button', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page');
  await expect(small.getByRole('heading', { name: 'Make room for what matters.' })).toBeVisible();
  // The bar stays at the bottom of the screen and the last content can scroll clear of it.
  const box = (await bar.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(844);
  await small.close();
});

test('on a touch screen every control can be hit in a 44-point square', async ({ browser }) => {
  const small = await browser.newPage(phone);
  await openVault(small);
  const bar = small.getByRole('navigation', { name: 'Sections' });
  for (const view of ['Today', 'Markets', 'Health', 'Tasks', 'Weekly review']) {
    await bar.getByRole('button', { name: view }).click();
    const tooSmall = await small.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('button, a, select, input, textarea')]
        .filter((control) => control.getClientRects().length > 0)
        .filter(
          (control) => !['checkbox', 'radio', 'file'].includes(control.getAttribute('type') ?? ''),
        )
        .map((control) => {
          const own = control.getBoundingClientRect();
          const area = getComputedStyle(control, '::after');
          const hit = (side: 'width' | 'height') =>
            Math.max(own[side], area.content === 'none' ? 0 : parseFloat(area[side]) || 0);
          return {
            label: control.getAttribute('aria-label') ?? control.textContent?.trim().slice(0, 30),
            width: hit('width'),
            height: hit('height'),
          };
        })
        .filter((control) => control.width < 43.5 || control.height < 43.5),
    );
    expect(tooSmall, view).toEqual([]);
  }
  await small.close();
});

test('fields on a phone use 16px text, so iOS does not zoom when one is tapped', async ({
  browser,
}) => {
  const small = await browser.newPage(phone);
  await openVault(small);
  const sizes = await small.evaluate(() =>
    [...document.querySelectorAll('input, select, textarea')].map((field) =>
      parseFloat(getComputedStyle(field).fontSize),
    ),
  );
  expect(sizes.length).toBeGreaterThan(0);
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16);
  await small.close();
});

test('keyboard focus is visible on a button and on a field', async ({ page }) => {
  await openVault(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe('none');
});

test('the home-screen manifest and its icons are served, with no service worker', async ({
  page,
  request,
}) => {
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.headers()['content-type']).toBe('application/manifest+json');
  const body = (await manifest.json()) as { display: string; icons: { src: string }[] };
  expect(body.display).toBe('standalone');
  for (const icon of [...body.icons.map((entry) => entry.src), '/icon-180.png']) {
    const image = await request.get(icon);
    expect(image.headers()['content-type'], icon).toBe('image/png');
    expect((await image.body()).subarray(1, 4).toString(), icon).toBe('PNG');
  }
  await openVault(page);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  expect(
    await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((all) => all.length)),
  ).toBe(0);
});

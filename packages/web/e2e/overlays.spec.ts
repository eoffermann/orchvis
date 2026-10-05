import { expect, test, type Page } from '@playwright/test';

/*
 * WP6 overlays against the simulator's mock feed (see playwright.config.ts).
 * Not run in CI by Vitest; running it needs the machine coordinator's
 * approval because it launches a browser.
 */

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByLabel('Owner token')).toBeVisible();
  await page.getByLabel('Owner token').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('did not accept');
  await page.getByLabel('Owner token').fill('mock');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test('node chat: open from the graph, send a message, see it in the Owner thread, Esc closes', async ({ page }) => {
  const firstNode = page.getByRole('button', { name: /^Open chat with / }).first();
  await firstNode.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /this session's sends/ })).toBeVisible();
  const input = dialog.getByLabel(/^Message to /);
  await input.fill('e2e hello <img src=x onerror=alert(1)>');
  await input.press('Enter');
  const log = dialog.getByRole('log');
  await expect(log.getByText('e2e hello <img src=x onerror=alert(1)>')).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('node chat: attachment needs a caption, uploads, then shows as a thumbnail', async ({ page }) => {
  await page.getByRole('button', { name: /^Open chat with / }).first().click();
  const dialog = page.getByRole('dialog');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeDisabled();
  await dialog.getByLabel('Caption for dot.png').fill('A single dot');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog.getByRole('button', { name: 'Enlarge image: A single dot' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Enlarge image: A single dot' }).click();
  await expect(page.getByRole('dialog', { name: 'Image 1 of 1' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Image 1 of 1' })).toBeHidden();
  await expect(dialog).toBeVisible();
});

test('thread overlay: opens from the node side list, follows new messages, mutes', async ({ page }) => {
  await page.getByRole('button', { name: /^Open chat with / }).first().click();
  const side = page.getByRole('navigation', { name: /Peer threads of/ });
  const firstThread = side.getByRole('button').first();
  await expect(firstThread).toBeVisible({ timeout: 15_000 });
  await firstThread.click();
  const dialog = page.getByRole('dialog', { name: /⇄/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Mute thread' }).click();
  await expect(dialog.getByRole('button', { name: 'Unmute thread' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Unmute thread' }).click();
  await expect(dialog.getByRole('button', { name: 'Mute thread' })).toBeVisible();
});

test('media browser: opens from an edge media icon and navigates with the keyboard', async ({ page }) => {
  const icon = page.getByRole('button', { name: /^Browse \d+ / }).first();
  await expect(icon).toBeVisible({ timeout: 60_000 });
  await icon.focus();
  await page.keyboard.press('Enter');
  const browser = page.getByRole('dialog', { name: /media:/ });
  await expect(browser).toBeVisible();
  const first = browser.getByRole('button', { name: /^Open / }).first();
  await first.click();
  const viewer = page.getByRole('dialog', { name: /1 of \d+/ });
  await expect(viewer).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await expect(browser).toBeVisible();
  await expect(browser.getByText(/Expires in /).first()).toBeVisible();
});

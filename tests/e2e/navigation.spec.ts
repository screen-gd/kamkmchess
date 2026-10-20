import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.use({ reducedMotion: 'reduce' });
async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('editing the current position reopens setup while the drawer is still closing', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/play');
  await page.addStyleTag({ content: '.right-game-sidebar { transition: none !important; } .right-game-sidebar[data-ending-style] { animation: hold-drawer-close 30s linear; } @keyframes hold-drawer-close { from { opacity: 1; } to { opacity: 1; } }' });
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.locator('.right-game-sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.right-game-sidebar')).toHaveAttribute('data-ending-style', '');
  await page.locator('.focus-page').getByRole('button', { name: 'Position', exact: true }).click();
  await page.getByRole('button', { name: 'New game from here', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Visual starting position board' })).toBeVisible();
  await expect(page.getByLabel('Custom starting position (six-field FEN)')).toHaveValue('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
});

test('AI opponent opens the functional right-hand drawer and the redundant preview group is gone', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.locator('.game-sidebar .sidebar-setup')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Opponent label', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'AI opponent', exact: true }).click();
  const drawer = page.locator('.right-game-sidebar');
  await expect(drawer).toBeVisible();
  const bounds = (await drawer.boundingBox())!;
  expect(bounds.x).toBeGreaterThan(700);
  expect(bounds.x + bounds.width).toBeCloseTo(1280, 0);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Chess against a');
  await expect(page.locator('.setup-panel')).toHaveCount(0);
  await page.getByLabel('Game mode').selectOption('local');
  await page.getByLabel('Starting minutes', { exact: true }).fill('7');
  await page.getByLabel('Increment seconds', { exact: true }).fill('3');
  await page.screenshot({ path: testInfo.outputPath('home-right-game-options.png') });
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await expect(page).toHaveURL(/\/play$/);
  await page.getByRole('button', { name: 'Type a move', exact: true }).click();
  await page.getByLabel('Enter a move by coordinates', { exact: true }).fill('e2e4');
  await page.getByRole('button', { name: 'Play move', exact: true }).click();
  const moves = page.getByRole('table', { name: 'Committed moves' }).getByRole('button');
  await expect(moves).toHaveText(['e4']);
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await expect(drawer).toBeVisible();
  await expect(page.getByRole('region', { name: 'Chess match board' })).toBeVisible();
  await expect.poll(() => page.locator('cg-board piece.black.pawn').evaluateAll(pieces => new Set(pieces.map(piece => piece.getBoundingClientRect().x)).size)).toBe(8);
  await page.screenshot({ path: testInfo.outputPath('play-right-game-options.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(moves).toHaveText(['e4']);
  await page.reload();
  await expect(moves).toHaveText(['e4']);
});

test('the right drawer collapses, resizes, remembers its width and preserves drafts across breakpoints', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'AI opponent', exact: true }).click();
  const control = page.getByRole('separator', { name: 'Game settings width' });
  const handle = (await control.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, 180);
  await page.mouse.down();
  await page.mouse.move(720, 180, { steps: 8 });
  await page.mouse.up();
  await expect(control).toHaveAttribute('aria-valuenow', '560');
  await control.press('ArrowLeft');
  await expect(control).toHaveAttribute('aria-valuenow', '568');
  await control.press('End');
  await control.press('ArrowLeft');
  await expect(control).toHaveAttribute('aria-valuenow', '720');
  await control.press('Home');
  await control.press('ArrowRight');
  await expect(control).toHaveAttribute('aria-valuenow', '320');
  await control.press('Enter');
  await expect(control).toHaveAttribute('aria-valuenow', '420');
  await page.getByLabel('Game mode').selectOption('local');
  await page.getByLabel('Starting minutes', { exact: true }).fill('9');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Starting minutes', { exact: true })).toHaveValue('9');
  await expectNoOverflow(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByLabel('Starting minutes', { exact: true })).toHaveValue('9');
  await control.press('Shift+ArrowLeft');
  await page.reload();
  await expect(control).toHaveAttribute('aria-valuenow', '452');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.right-game-sidebar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand game settings' }).click();
  await expect(control).toHaveAttribute('aria-valuenow', '452');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.goto('/play');
  await expect(page.locator('.right-game-sidebar')).toHaveCount(0);
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await expect(control).toHaveAttribute('aria-valuenow', '452');
});

test('mobile AI opponent opens the right drawer and creates a local match', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'AI opponent', exact: true }).click();
  await expect(page.locator('.right-game-sidebar')).toBeVisible();
  await page.getByLabel('Game mode').selectOption('local');
  await expectNoOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('mobile-right-game-options.png') });
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await expect(page).toHaveURL(/\/play$/);
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await expect(page.getByLabel('Game mode')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.right-game-sidebar')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await expectNoOverflow(page);
});

test('right drawer controls work when preference storage is unavailable', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage disabled', 'SecurityError'); } }); });
  await page.goto('/');
  await page.getByRole('button', { name: 'AI opponent', exact: true }).click();
  await page.getByLabel('Game mode').selectOption('local');
  await page.getByRole('separator', { name: 'Game settings width' }).press('End');
  await expect(page.getByRole('separator', { name: 'Game settings width' })).toHaveAttribute('aria-valuenow', '720');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Expand game settings' }).click();
  await expect(page.getByLabel('Game mode')).toBeVisible();
});

test('an AI opponent configured on the homepage plays the saved match', async ({ page }) => {
  await page.route('http://127.0.0.1:8317/v1/**', async route => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      return;
    }
    if (route.request().url().endsWith('/models')) {
      await route.fulfill({ json: { data: [{ id: 'sidebar-fixture' }] } });
      return;
    }
    const body = route.request().postDataJSON() as { model: string };
    const text = JSON.stringify(body);
    const marker = /KAMKM-COMPAT-[a-zA-Z0-9-]+/.exec(text)?.[0];
    const answer = marker ? { move: 'e2e4', marker, plan: /Unique plan marker: ([^\s.]+)/.exec(text)?.[1] } : { move: 'e7e5', plan: 'Develop the kingside.' };
    await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: JSON.stringify(answer) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'AI opponent', exact: true }).click();
  await page.getByLabel('Game mode').selectOption('ai');
  await page.getByLabel('API key', { exact: true }).fill('offline-key');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Available models').selectOption('sidebar-fixture');
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await expect(page).toHaveURL(/\/play$/);
  await page.getByRole('button', { name: 'Type a move', exact: true }).click();
  await page.getByLabel('Enter a move by coordinates', { exact: true }).fill('e2e4');
  await page.getByRole('button', { name: 'Play move', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Committed moves' }).getByRole('button')).toHaveText(['e4', 'e5']);
});

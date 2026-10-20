import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function startLocal(page: Page) {
  await page.goto('/play');
  await page.bringToFront();
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.getByLabel('Game mode').selectOption('local');
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
  // The setup drawer restores focus after it closes. Let that finish before opening a dialog.
  await expect(page.getByRole('button', { name: 'New game', exact: true })).toBeFocused();
}

test('cancelling the draw confirmation keeps the game running', async ({ page }) => {
  await startLocal(page);
  const draw = page.getByRole('button', { name: 'Agree a draw', exact: true });
  await expect(draw).toBeEnabled();

  await draw.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Agree a draw?' })).toBeVisible();
  await expect(dialog.getByText('The game will end as a draw. This cannot be undone.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep playing' })).toBeFocused();

  await dialog.getByRole('button', { name: 'Keep playing' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(draw).toBeFocused();
  await expect(page.locator('.status-heading')).toHaveText('White to move');
  await expect(draw).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Resign game', exact: true })).toBeEnabled();
});

test('a draw needs confirmation, survives reload, and cannot be undone', async ({ page }) => {
  await startLocal(page);
  const draw = page.getByRole('button', { name: 'Agree a draw', exact: true });
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(draw).toBeEnabled();
  await expect(undo).toBeDisabled();

  await draw.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Draw', exact: true }).click();
  await expect(page.locator('.status-heading')).toHaveText('Draw');
  await expect(page.getByRole('heading', { name: 'Draw', exact: true })).toBeFocused();
  await expect(draw).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Resign game', exact: true })).toBeDisabled();
  await expect(undo).toBeDisabled();

  await page.reload();
  await expect(page.locator('.status-heading')).toHaveText('Draw');
  await expect(page.getByRole('button', { name: 'Agree a draw', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Resign game', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('a resignation names the side and records the opposing win after reload', async ({ page }) => {
  await startLocal(page);
  await page.getByRole('button', { name: 'Resign game', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: 'Resign this game?' })).toBeVisible();
  await expect(dialog.getByText('White resigns and Black wins. This cannot be undone.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep playing' })).toBeFocused();

  await dialog.getByRole('button', { name: 'Resign', exact: true }).click();
  await expect(page.locator('.status-heading')).toHaveText('Black won');
  await expect(page.getByRole('heading', { name: 'Black won', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  await page.reload();
  await expect(page.locator('.status-heading')).toHaveText('Black won');
  await expect(page.getByRole('button', { name: 'Agree a draw', exact: true })).toBeDisabled();
});

test.describe('touch result controls', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('all eight board tools fit the phone toolbar and the dialog stays usable', async ({ page }, testInfo) => {
    await startLocal(page);
    const tools = page.locator('.board-tools .icon-button');
    await expect(tools).toHaveCount(8);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const toolbar = await tools.evaluateAll((buttons) => buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { left: box.left, right: box.right, height: box.height };
    }));
    expect(toolbar.every((box) => box.height >= 44)).toBe(true);
    expect(toolbar.every((box) => box.left >= 0 && box.right <= 390)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('result-controls-mobile.png'), fullPage: true });

    await page.getByRole('button', { name: 'Agree a draw', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    const actions = await dialog.locator('.result-dialog-actions .button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
    expect(actions.every((height) => height >= 44)).toBe(true);
    await page.getByRole('button', { name: 'Keep playing' }).click();

    await page.setViewportSize({ width: 320, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const narrow = await tools.evaluateAll((buttons) => buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { left: box.left, right: box.right, height: box.height };
    }));
    expect(narrow.every((box) => box.height >= 44)).toBe(true);
    expect(narrow.every((box) => box.left >= 0 && box.right <= 320)).toBe(true);
  });
});

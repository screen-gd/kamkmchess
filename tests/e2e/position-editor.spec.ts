import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function openEditor(page: Page) {
  await page.goto('/play');
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.getByLabel('Game mode').selectOption('local');
  await page.getByRole('button', { name: 'Custom starting position', exact: true }).click();
}

async function dragTo(page: Page, source: string, target: string) {
  await page.locator('.editor-interaction').scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: source, exact: true })).toBeInViewport();
  const from = await page.getByRole('button', { name: source, exact: true }).boundingBox();
  const to = await page.getByRole('button', { name: target, exact: true }).boundingBox();
  if (!from || !to) throw new Error('Drag source or destination is missing');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
}

test('dragging an editor piece lifts only the piece and keeps the squares fixed', async ({ page }) => {
  await openEditor(page);
  const source = page.getByRole('button', { name: /^e2, white (pawn|p)$/ });
  const target = page.getByRole('button', { name: 'e4, empty', exact: true });
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('Editor squares are missing');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await expect(page.locator('.editor-drag-piece')).toBeVisible();
  await expect(source).toHaveAttribute('draggable', 'false');
  expect(await source.boundingBox()).toEqual(from);
  await expect(source.locator('img')).toHaveCSS('opacity', '0');
  await expect(page.locator('.editor-drag-piece')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'e2, empty', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'e4, white pawn', exact: true })).toBeVisible();
  await expect(page.getByLabel('Custom starting position (six-field FEN)')).toHaveValue('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1');
});

test('palette dragging, click placement, replacement, and removal update the FEN', async ({ page }) => {
  await openEditor(page);
  await dragTo(page, 'Place black queen', 'd4, empty');
  await expect(page.getByRole('button', { name: 'd4, black queen', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Place white knight', exact: true }).click();
  await page.getByRole('button', { name: 'd4, black queen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'd4, white knight', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove pieces', exact: true }).click();
  await page.getByRole('button', { name: 'd4, white knight', exact: true }).click();
  await expect(page.getByRole('button', { name: 'd4, empty', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'e2, white pawn', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('button', { name: 'e2, empty', exact: true })).toBeVisible();
});

test('Escape cancels a drag and dropping off the board removes only its piece', async ({ page }) => {
  await openEditor(page);
  const fen = page.getByLabel('Custom starting position (six-field FEN)');
  const original = await fen.inputValue();
  const source = page.getByRole('button', { name: 'e2, white pawn', exact: true });
  const box = await source.boundingBox();
  if (!box) throw new Error('Source square is missing');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - box.height, { steps: 6 });
  await expect(page.locator('.editor-drag-piece')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.editor-drag-piece')).toHaveCount(0);
  await expect(fen).toHaveValue(original);
  await source.click(); // Clear any click selection left by the canceled pointer.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(4, box.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'e2, empty', exact: true })).toBeVisible();
  await expect(page.locator('.editor-square img')).toHaveCount(31);
});

test('keyboard editing and flipped-board dragging preserve chess coordinates', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'e2, white pawn', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'e4, empty', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'e4, white pawn', exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: 'New game', exact: true }).getByRole('button', { name: 'Flip board', exact: true }).click();
  await expect(page.locator('.editor-square').first()).toHaveAttribute('data-editor-square', 'h1');
  await dragTo(page, 'e4, white pawn', 'e5, empty');
  await expect(page.getByRole('button', { name: 'e5, white pawn', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'e4, empty', exact: true })).toBeVisible();
});

test('FEN import, metadata, empty boards, and starting a custom game work together', async ({ page }) => {
  await openEditor(page);
  const fen = page.getByLabel('Custom starting position (six-field FEN)');
  await fen.fill('invalid');
  await expect(page.locator('.editor-board-error')).toContainText('Enter a valid six-field FEN');
  await expect(page.getByRole('button', { name: 'Place black queen', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Clear board', exact: true }).click();
  await expect(page.locator('.editor-square')).toHaveCount(64);
  await expect(page.locator('.editor-square img')).toHaveCount(0);
  await fen.fill('4k3/8/8/8/8/8/8/4K2R w - - 0 1');
  await page.getByLabel('White king-side castling', { exact: true }).check();
  await expect(fen).toHaveValue('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
  await page.getByLabel('Side to move', { exact: true }).selectOption('b');
  await expect(fen).toHaveValue('4k3/8/8/8/8/8/8/4K2R b K - 0 1');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await expect(page.locator('cg-board piece')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
});

for (const appearance of ['light', 'dark'] as const) {
  test(`${appearance} editor has readable contrast and fits its viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize(appearance === 'light' ? { width: 1280, height: 900 } : { width: 390, height: 844 });
    await page.goto('/play');
    await page.getByRole('button', { name: 'New game', exact: true }).click();
    await page.locator('.right-game-sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('combobox', { name: /Appearance/ }).selectOption(appearance);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'New game', exact: true }).click();
    await page.getByLabel('Game mode').selectOption('local');
    await page.getByRole('button', { name: 'Custom starting position', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const board = await page.locator('.editor-grid').boundingBox();
    const panel = await page.locator('.editor-palette-panel').boundingBox();
    if (!board || !panel) throw new Error('Editor layout is missing');
    expect(board.width).toBeGreaterThan(180);
    expect(board.height).toBeCloseTo(board.width, 0);
    expect(panel.y).toBeGreaterThan(board.y + board.height);
    const contrasts = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      const luminance = (color: string) => {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const channels = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(value => {
          const channel = value / 255;
          return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
        });
        const [red = 0, green = 0, blue = 0] = channels;
        return red * .2126 + green * .7152 + blue * .0722;
      };
      return ['.editor-control-panel > label', '.editor-control-panel select', '.editor-board-toolbar > span', '.editor-palette-heading span', '.position-editor-footer .primary', '.editor-coordinate'].flatMap(selector =>
        Array.from(document.querySelectorAll(selector)).map(element => {
          const foreground = luminance(getComputedStyle(element).color);
          let ancestor: Element | null = element;
          while (ancestor && getComputedStyle(ancestor).backgroundColor === 'rgba(0, 0, 0, 0)') ancestor = ancestor.parentElement;
          const background = luminance(ancestor ? getComputedStyle(ancestor).backgroundColor : '#ffffff');
          return { selector, ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) };
        }));
    });
    for (const { selector, ratio } of contrasts) expect(ratio, `${selector} contrast`).toBeGreaterThanOrEqual(4.5);
    await expect(page.getByRole('button', { name: 'Place black queen', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`editor-${appearance}.png`), fullPage: true });
  });
}

test('touch dragging moves a piece and pointer cancellation leaves the position unchanged', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openEditor(page);
  const source = await page.getByRole('button', { name: 'e2, white pawn', exact: true }).boundingBox();
  const target = await page.getByRole('button', { name: 'e4, empty', exact: true }).boundingBox();
  if (!source || !target) throw new Error('Editor squares are missing');
  const client = await context.newCDPSession(page);
  const from = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const to = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [to] });
  await expect(page.locator('.editor-drag-piece')).toBeVisible();
  await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(page.locator('.editor-drag-piece')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'e2, white pawn', exact: true })).toBeVisible();
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [to] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByRole('button', { name: 'e4, white pawn', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

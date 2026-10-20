import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Count rendered copy, selected options, and input text. Board coordinates,
// chess notation, clocks, the model conversation transcript, and screen-reader descriptions are game data.
// The shared navigation is outside each focused screen's copy budget.
async function visibleWords(page: Page) {
  return page.evaluate(() => {
    const words: string[] = [];
    function walk(node: Node) {
      if (node instanceof Element) {
        if (node.matches('script, style, svg, .sr-only, .game-options-sr-only, cg-board, coords, .clock, .game-rail, .archive-page, .move-list, [hidden]')) return;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        if (node instanceof HTMLSelectElement) { words.push(node.selectedOptions[0]?.text ?? ''); return; }
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
          if (node.type !== 'password') words.push(node.value || node.getAttribute('placeholder') || '');
          return;
        }
        // A zero-size label supplies an accessible name without visible copy.
        if (style.fontSize === '0px') { for (const child of node.children) walk(child); return; }
      }
      if (node.nodeType === Node.TEXT_NODE) words.push(node.textContent ?? '');
      else for (const child of node.childNodes) walk(child);
    }
    walk(document.querySelector('.sidebar-game-setup') ?? document.body);
    return words.join(' ').split(/\s+/).filter(word => /\p{L}/u.test(word));
  });
}
async function budget(page: Page, limit = 20) {
  if (await page.locator('.sidebar-game-setup').count()) limit = Math.max(limit, 48);
  const words = await visibleWords(page);
  expect(words.length, words.join(' ')).toBeLessThanOrEqual(limit);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function newMode(page: Page, mode: string) {
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.getByLabel('Game mode').selectOption(mode);
  await budget(page, mode.includes('engine') ? 10 : 20);
}
async function move(page: Page, coordinate: string) {
  await page.getByRole('button', { name: 'Type a move', exact: true }).click();
  await page.getByLabel('Enter a move by coordinates', { exact: true }).fill(coordinate);
  await page.getByRole('button', { name: 'Play move', exact: true }).click();
}
async function fixture(page: Page, models = ['alpha', 'beta']) {
  const calls: { model: string; check: boolean }[] = [];
  let reject = false;
  await page.route('http://127.0.0.1:8317/v1/**', async route => {
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } }); return; }
    if (route.request().url().endsWith('/models')) { await route.fulfill({ json: { data: models.map(id => ({ id })) } }); return; }
    const body = route.request().postDataJSON() as { model: string; messages: { content: string }[] };
    const text = JSON.stringify(body);
    const marker = /KAMKM-COMPAT-[a-zA-Z0-9-]+/.exec(text)?.[0];
    calls.push({ model: body.model, check: Boolean(marker) });
    if (reject) { await route.fulfill({ status: 401, json: { error: { message: 'Invalid API key' } } }); return; }
    const answer = marker ? { move: 'e2e4', marker, plan: /Unique plan marker: ([^\s.]+)/.exec(text)?.[1] } : { move: calls.filter(call => !call.check).length === 1 ? 'e7e5' : 'b8c6', plan: 'Develop pieces.' };
    await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: JSON.stringify(answer) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
  });
  return { calls, reject: () => { reject = true; } };
}

test('focused screens stay compact and fit desktop and mobile', async ({ page }, testInfo) => {
  await page.goto('/play');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await budget(page);
    await page.screenshot({ path: testInfo.outputPath(`board-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'New game', exact: true }).click();
    await page.locator('.right-game-sidebar').getByRole('button', { name: 'Settings', exact: true }).click(); await budget(page, 10);
    await page.locator('.focus-page').getByRole('button', { name: 'Position', exact: true }).click(); await budget(page, 10);
    await page.getByRole('button', { name: 'New game from here', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Visual starting position board' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Position settings' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Done', exact: true }).click(); await budget(page, 10);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Moves' })).toBeVisible(); await budget(page, 10);
    await page.getByRole('button', { name: 'New game', exact: true }).click();
    await page.locator('.right-game-sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Conversation and archive', exact: true }).click(); await budget(page, 10);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  }
  await newMode(page, 'local'); await budget(page, 10);
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await page.getByRole('button', { name: 'Type a move', exact: true }).click();
  await page.getByLabel('Enter a move by coordinates', { exact: true }).fill('e2e5');
  await page.getByRole('button', { name: 'Play move', exact: true }).click();
  await expect(page.getByText('Illegal move.', { exact: true })).toBeVisible(); await budget(page, 10);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await move(page, 'e2e4'); await budget(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.match-layout [aria-label="Committed moves"] button')).toHaveCount(0);
});

test('discovers models, validates selection once, and revalidates automatically after reload', async ({ page }, testInfo) => {
  const provider = await fixture(page);
  await page.goto('/play'); await newMode(page, 'ai');
  await expect(page.getByRole('textbox', { name: /model.*id/i })).toHaveCount(0);
  await page.getByLabel('API key', { exact: true }).fill('offline-key'); await budget(page);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByLabel('Available models')).toBeEnabled();
  expect(provider.calls).toHaveLength(0);
  await budget(page);
  await page.getByLabel('Available models').selectOption('beta');
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
  expect(provider.calls).toHaveLength(0); await budget(page);
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Ready' })).toBeVisible();
  expect(provider.calls).toEqual([{ model: 'beta', check: true }]);
  await budget(page); await page.screenshot({ path: testInfo.outputPath('model-ready.png') });
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await move(page, 'e2e4');
  await expect.poll(() => provider.calls.filter(call => !call.check).length).toBe(1);
  await expect(page.locator('.match-layout [aria-label="Committed moves"] button')).toHaveCount(2);
  await page.reload(); await move(page, 'g1f3');
  await expect(page.locator('.match-layout [aria-label="Committed moves"] button')).toHaveCount(4);
  expect(provider.calls.filter(call => call.check)).toHaveLength(2);
  expect(provider.calls.every(call => call.model === 'beta')).toBe(true);
  await budget(page);
});

test('blocks failed models and does not enable starting a game or make a game request', async ({ page }) => {
  const provider = await fixture(page); provider.reject();
  await page.goto('/play'); await newMode(page, 'ai');
  await page.getByLabel('API key', { exact: true }).fill('bad-key');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Available models').selectOption('alpha');
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('Check API key.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start game', exact: true })).toBeDisabled();
  expect(provider.calls).toEqual([{ model: 'alpha', check: true }]); await budget(page);
});

test('prepares a real engine automatically and keeps engine configuration compact', async ({ page }, testInfo) => {
  await page.goto('/play'); await newMode(page, 'human-engine');
  await page.getByLabel('Chess engine', { exact: true }).selectOption('stockfish-lite');
  await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await budget(page, 10);
  await page.getByRole('button', { name: 'Engine memory', exact: true }).click(); await budget(page, 10);
  await page.getByLabel('Hash memory').selectOption('16');
  await expect(page.getByText('Ready', { exact: true })).toBeVisible(); await budget(page, 10);
  await page.getByRole('button', { name: 'Start game', exact: true }).click(); await budget(page, 10);
  await move(page, 'e2e4');
  await expect(page.locator('.match-layout [aria-label="Committed moves"] button')).toHaveCount(2);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 }); await budget(page, 10);
    await page.screenshot({ path: testInfo.outputPath(`engine-${width}.png`), fullPage: true });
  }
});

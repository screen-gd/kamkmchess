import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { Chess } from 'chess.js';
import { readFileSync } from 'node:fs';

const endpoint = 'https://offline-chess.example/v1';

interface FixtureProvider {
  readonly calls: unknown[];
  readonly modelCalls: unknown[];
  readonly respond: (route: Route, answer: string, reasoning?: string) => Promise<void>;
}

async function provider(page: Page, moves: readonly string[], intercept?: (route: Route, index: number, fixture: FixtureProvider) => Promise<void>, apiEndpoint = endpoint): Promise<FixtureProvider> {
  const calls: unknown[] = [];
  const modelCalls: unknown[] = [];
  const respond = async (route: Route, answer: string, reasoning?: string) => {
    const frames = [
      { model: 'offline-fixture', choices: [{ index: 0, delta: { content: answer, ...(reasoning === undefined ? {} : { reasoning_content: reasoning }) }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 25, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 0 } } },
    ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: frames, headers: { 'access-control-allow-origin': '*' } }).catch(() => undefined);
  };
  const fixture = { calls, modelCalls, respond };
  const handle = async (route: Route) => {
    const relayed = new URL(route.request().url()).pathname === '/api/provider-relay';
    const envelope = relayed ? route.request().postDataJSON() as { url: string; method: string; body?: string } : null;
    const url = envelope?.url ?? route.request().url();
    if (!url.startsWith(`${apiEndpoint}/`)) { await route.fallback(); return; }
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      return;
    }
    if (url.endsWith('/models')) {
      await route.fulfill({ json: { data: [{ id: 'offline-fixture' }, { id: 'offline-candidate' }, { id: 'another-model' }] } });
      return;
    }
    const body: unknown = envelope ? JSON.parse(envelope.body!) : route.request().postDataJSON();
    calls.push(body);
    const text = JSON.stringify(body);
    const marker = /KAMKM-COMPAT-[a-zA-Z0-9-]+/.exec(text)?.[0];
    if (marker) {
      const plan = /Unique plan marker: ([^\s.]+)/.exec(text)?.[1];
      await respond(route, JSON.stringify({ move: 'e2e4', plan, marker }));
      return;
    }
    modelCalls.push(body);
    const index = modelCalls.length - 1;
    if (intercept) { await intercept(route, index, fixture); return; }
    const move = moves[index];
    await respond(route, move === 'resign' ? '{"resign":true}' : JSON.stringify({ move, plan: `retained plan ${index + 1}` }));
  };
  await page.route(`${apiEndpoint}/**`, handle);
  await page.route('**/api/provider-relay', handle);
  return fixture;
}

async function configure(page: Page, side = 'white') {
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.getByLabel('Game mode').selectOption('ai');
  await page.getByLabel('Your side').selectOption(side);
  await page.getByLabel('Provider').selectOption('custom');
  await page.getByLabel('Base URL', { exact: true }).fill(endpoint);
  await page.getByRole('button', { name: 'Advanced connection settings', exact: true }).click();
  await page.getByLabel('Connection name').fill('Offline fixture');
  await page.getByLabel('Authentication').selectOption('none');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Available models').selectOption('offline-fixture');
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
}
async function move(page: Page, coordinate: string) {
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Type a move', exact: true }).click();
  await page.getByLabel('Enter a move by coordinates').fill(coordinate);
  await page.getByRole('button', { name: 'Play move', exact: true }).click();
}
async function selectModel(page: Page, model = 'offline-candidate') {
  const panel = page.getByRole('region', { name: 'AI model', exact: true });
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await panel.getByLabel('Available models').selectOption(model);
  await expect.poll(async () => await page.getByText('Ready', { exact: true }).isVisible() || await page.locator('.match-layout').isVisible()).toBe(true);
}
async function archivedText(page: Page) {
  await page.locator('.game-rail, .topbar').getByRole('button', { name: 'New game', exact: true }).click();
  await page.locator('.right-game-sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.locator('.focus-page').getByRole('button', { name: 'Download game (JSON)', exact: true }).click();
  const stream = await (await download).createReadStream();
  let text = ''; for await (const chunk of stream) text += chunk.toString();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  return text;
}

const movesOnBoard = (page: Page) => page.getByRole('table', { name: 'Committed moves' }).getByRole('button');

test('a custom provider without browser CORS loads models, passes its check and plays through the site relay', async ({ page }) => {
  await provider(page, ['e7e5']);
  await page.route(`${endpoint}/**`, route => route.abort('blockedbyclient'));
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/provider-relay') requests.push(request.postDataJSON());
  });
  await page.goto('/play');
  await configure(page);
  await move(page, 'e2e4');
  await expect(movesOnBoard(page)).toHaveCount(2);
  expect(requests.map(request => [request.method, request.url])).toEqual([
    ['GET', `${endpoint}/models`],
    ['POST', `${endpoint}/chat/completions`],
    ['POST', `${endpoint}/chat/completions`],
  ]);
});

test('a final AI result closes an open declaration and focuses the result', async ({ page }) => {
  let release: (() => void) | undefined;
  await provider(page, [], async (route, _index, fixture) => {
    await new Promise<void>(resolve => { release = resolve; });
    await fixture.respond(route, '{"resign":true}');
  });
  await page.goto('/play');
  await configure(page);
  await move(page, 'e2e4');
  await expect.poll(() => release !== undefined).toBe(true);
  await page.getByRole('button', { name: 'Agree a draw', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  release?.();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'White won', exact: true })).toBeFocused();
  await expect(movesOnBoard(page)).toHaveCount(1);
});

for (const action of ['draw', 'resignation'] as const) {
  test(`a confirmed ${action} fences a delayed AI reply and its recovery controls`, async ({ page }) => {
    let release: (() => void) | undefined;
    let delivered: (() => void) | undefined;
    const delivery = new Promise<void>(resolve => { delivered = resolve; });
    await provider(page, [], async (route, _index, fixture) => {
      await new Promise<void>(resolve => { release = resolve; });
      await fixture.respond(route, '{"move":"e7e5"}');
      delivered?.();
    });
    await page.goto('/play');
    await configure(page);
    await move(page, 'e2e4');
    await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible();
    await expect.poll(() => release !== undefined).toBe(true);
    await page.getByRole('button', { name: action === 'draw' ? 'Agree a draw' : 'Resign game', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: action === 'draw' ? 'Draw' : 'Resign', exact: true }).click();
    release?.();
    await delivery;
    const finalStatus = action === 'draw' ? 'Draw' : 'Black won';
    await expect(page.locator('.status-heading')).toHaveText(finalStatus);
    await expect(page.getByRole('heading', { name: finalStatus, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Stop generation|Retry model request|Resume model turn/ })).toHaveCount(0);
    await expect(movesOnBoard(page)).toHaveCount(1);
    await page.reload();
    await expect(page.locator('.status-heading')).toHaveText(finalStatus);
    await expect(movesOnBoard(page)).toHaveCount(1);
  });
}

async function dragBoardMove(page: Page, from: string, to: string) {
  await page.locator('cg-board').scrollIntoViewIfNeeded();
  const box = await page.locator('cg-board').boundingBox();
  if (!box) throw new Error('Missing board');
  const flipped = await page.locator('.board-host').evaluate((element) => element.classList.contains('orientation-black'));
  const point = (square: string) => {
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]) - 1;
    return {
      x: box.x + ((flipped ? 7 - file : file) + .5) * box.width / 8,
      y: box.y + ((flipped ? rank : 7 - rank) + .5) * box.height / 8,
    };
  };
  const origin = point(from), destination = point(to);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(destination.x, destination.y, { steps: 6 });
  await page.mouse.up();
}

test('executes one legal premove after the AI reply', async ({ page }) => {
  let release: (() => void) | undefined;
  await provider(page, [], async (route, index, fixture) => {
    if (index === 0) {
      await new Promise<void>((resolve) => { release = resolve; });
      await fixture.respond(route, '{"move":"e7e5"}');
    } else await fixture.respond(route, '{"resign":true}');
  });
  await page.goto('/play');
  await configure(page);
  await move(page, 'e2e4');
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible();
  await dragBoardMove(page, 'g1', 'f3');
  await expect(page.getByRole('status', { name: 'Premove g1 to f3 queued.', exact: true })).toBeVisible();
  await expect(page.locator('square.current-premove:visible')).toHaveCount(2);
  await expect(movesOnBoard(page)).toHaveCount(1);
  release?.();
  await expect(movesOnBoard(page)).toHaveCount(3);
  await expect(movesOnBoard(page).last()).toContainText('Nf3');
  await expect(page.locator('square.current-premove:visible')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel premove' })).toHaveCount(0);
});

test('drops an illegal premove after the AI reply without submitting a move', async ({ page }) => {
  let release: (() => void) | undefined;
  const fixture = await provider(page, [], async (route, _index, mock) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await mock.respond(route, '{"move":"e7e5"}');
  });
  await page.goto('/play');
  await configure(page);
  await move(page, 'e2e4');
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible();
  await dragBoardMove(page, 'e4', 'd5');
  await expect(page.getByRole('status', { name: 'Premove e4 to d5 queued.', exact: true })).toBeVisible();
  release?.();
  await expect(movesOnBoard(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Cancel premove' })).toHaveCount(0);
  expect(fixture.modelCalls).toHaveLength(1);
});

test('cancels premoves and keeps a reviewed position while the AI finishes', async ({ page }) => {
  let release: (() => void) | undefined;
  await provider(page, [], async (route, _index, fixture) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await fixture.respond(route, '{"move":"e7e5"}');
  });
  await page.goto('/play');
  await configure(page);
  await move(page, 'e2e4');
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible();
  await dragBoardMove(page, 'g1', 'f3');
  await expect(page.getByRole('button', { name: 'Cancel premove' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Cancel premove' })).toHaveCount(0);
  await dragBoardMove(page, 'g1', 'f3');
  await page.getByRole('button', { name: 'Cancel premove' }).click();
  await expect(page.locator('square.current-premove:visible')).toHaveCount(0);
  await dragBoardMove(page, 'g1', 'f3');
  await page.getByRole('button', { name: 'Flip board', exact: true }).focus();
  await page.keyboard.press('Home');
  await expect(page.getByRole('button', { name: 'Cancel premove' })).toHaveCount(0);
  release?.();
  await expect(movesOnBoard(page)).toHaveCount(2);
  await expect(page.locator('.match-status')).toContainText('0/2');
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
});

test('plays against the AI without a position-check worker', async ({ page }) => {
  const fixture = await provider(page, ['e7e5']);
  const workers: string[] = [];
  page.on('worker', worker => workers.push(worker.url()));
  await page.route('**/assets/proof-search.worker-*.js', route => route.abort('connectionrefused'));
  await page.goto('/play');
  await configure(page);
  await move(page, 'e2e4');
  await expect(movesOnBoard(page)).toHaveCount(2);
  expect(fixture.modelCalls).toHaveLength(1);
  expect(workers.filter(url => url.includes('proof-search'))).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Continue position check' })).toHaveCount(0);
});

test('finishes a legal AI match, preserves plans, restores its result and fits mobile', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = await provider(page, [], async (route, index, mock) => {
    await mock.respond(route, JSON.stringify({ move: ['e7e5', 'b8c6', 'g8f6'][index], plan: `retained plan ${index + 1}` }), `retained reasoning ${index + 1}`);
  });
  await page.goto('/play');
  await configure(page);
  for (const [coordinate, count] of [['e2e4', 2], ['d1h5', 4], ['f1c4', 6]] as const) {
    await move(page, coordinate);
    await expect(movesOnBoard(page)).toHaveCount(count);
  }
  await move(page, 'h5f7');
  await expect(page.getByRole('heading', { name: 'White won', exact: true })).toBeVisible();
  expect(fixture.calls).toHaveLength(4);
  expect(JSON.stringify(fixture.modelCalls[1])).toContain('retained plan 1');
  expect(JSON.stringify(fixture.modelCalls[1])).toContain('retained reasoning 1');
  expect(JSON.stringify(fixture.modelCalls[1])).toContain('e4 e5 Qh5');
  expect(JSON.stringify(fixture.modelCalls[2])).toContain('retained plan 2');
  expect(JSON.stringify(fixture.modelCalls[2])).not.toContain('retained plan 1');
  expect(JSON.stringify(fixture.modelCalls[2])).toContain('retained reasoning 2');
  expect(JSON.stringify(fixture.modelCalls[2])).not.toContain('retained reasoning 1');
  for (const call of fixture.modelCalls) {
    expect(new TextEncoder().encode(JSON.stringify(call)).byteLength).toBeLessThan(2_000);
    expect(JSON.stringify(call)).not.toContain('opaque-provider-record');
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: 'White won', exact: true })).toBeVisible();
  await expect(movesOnBoard(page)).toHaveCount(7);
  expect(fixture.calls).toHaveLength(4);
  expect(await archivedText(page)).toContain('retained plan 1');
  await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('starts with a model playing White and offers practice after that model resigns', async ({ page }) => {
  const fixture = await provider(page, ['e2e4', 'resign']);
  await page.goto('/play');
  await configure(page, 'black');
  await expect(movesOnBoard(page)).toHaveCount(1);
  await move(page, 'e7e5');
  await expect(page.getByRole('heading', { name: 'Black won', exact: true })).toBeVisible();
  expect(fixture.modelCalls).toHaveLength(2);
  await page.reload();
  await page.getByRole('button', { name: 'Start practice from this position' }).click();
  await expect(page.locator('.match-layout')).toHaveAttribute('data-practice', 'practice');
  expect(fixture.calls.filter(call => JSON.stringify(call).includes('KAMKM-COMPAT-'))).toHaveLength(2);
});

test('Stop fences a delayed reply and Retry remains an explicit new request', async ({ page }) => {
  let release: (() => void) | undefined;
  const fixture = await provider(page, [], async (route, index, mock) => {
    if (index === 0) await new Promise<void>((resolve) => { release = resolve; });
    await mock.respond(route, '{"move":"e7e5","plan":"after explicit retry"}');
  });
  await page.goto('/play');
  await configure(page);
  await move(page, 'e2e4');
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible();
  await expect.poll(() => fixture.modelCalls.length).toBe(1);
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
  release?.();
  await expect(page.getByRole('button', { name: 'Retry model request' })).toBeVisible();
  await expect(movesOnBoard(page)).toHaveCount(1);
  expect(fixture.modelCalls).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry model request' }).click();
  await expect(movesOnBoard(page)).toHaveCount(2);
  expect(fixture.modelCalls).toHaveLength(2);
});

test('Undo keeps the discarded conversation and the same model can start another game', async ({ page }) => {
  const fixture = await provider(page, ['e7e5', 'd7d5']);
  await page.goto('/play');
  await configure(page);
  await move(page, 'e2e4');
  await expect(movesOnBoard(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(movesOnBoard(page)).toHaveCount(0);
  expect(await archivedText(page)).toContain('retained plan 1');
  await move(page, 'd2d4');
  await expect(movesOnBoard(page)).toHaveCount(2);
  expect(JSON.stringify(fixture.modelCalls[1])).toContain('d4');
  expect(JSON.stringify(fixture.modelCalls[1])).not.toContain('e4 e5');
  expect(JSON.stringify(fixture.modelCalls[1])).not.toContain('retained plan 1');
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await selectModel(page, 'offline-fixture');
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'White to move', exact: true })).toBeVisible();
});

test('queues a different model and commits it only with its first legal reply', async ({ page }) => {
  let release: (() => void) | undefined;
  const fixture = await provider(page, [], async (route, _index, mock) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await mock.respond(route, '{"move":"e7e5","plan":"new model continuation"}');
  });
  await page.goto('/play');
  await configure(page);
  await page.getByRole('button', { name: 'Choose another model', exact: true }).click();
  await selectModel(page);
  await expect(page.locator('.match-layout')).toHaveAttribute('data-queued-model', 'offline-candidate');
  await expect(page.locator('.match-layout')).toHaveAttribute('data-committed-model', 'offline-fixture');
  expect(fixture.modelCalls).toHaveLength(0);
  await move(page, 'e2e4');
  await expect.poll(() => fixture.modelCalls.length).toBe(1);
  await expect(page.locator('.match-layout')).toHaveAttribute('data-committed-model', 'offline-fixture');
  expect(fixture.modelCalls[0]).toMatchObject({ model: 'offline-candidate' });
  release?.();
  await expect(movesOnBoard(page)).toHaveCount(2);
  await expect(page.locator('.match-layout')).toHaveAttribute('data-committed-model', 'offline-candidate');
  await page.reload();
  await expect(page.locator('.match-layout')).toHaveAttribute('data-committed-model', 'offline-candidate');
});

test('reload rechecks compatibility automatically before the next model request', async ({ page }) => {
  const fixture = await provider(page, ['e7e5', 'b8c6']);
  await page.goto('/play');
  await configure(page);
  await move(page, 'e2e4');
  await expect(movesOnBoard(page)).toHaveCount(2);
  await page.reload();
  await expect(movesOnBoard(page)).toHaveCount(2);
  await move(page, 'd1h5');
  await expect(movesOnBoard(page)).toHaveCount(4);
  expect(fixture.modelCalls).toHaveLength(2);
  expect(JSON.stringify(fixture.modelCalls[1])).toContain('retained plan 1');
  expect(JSON.stringify(fixture.modelCalls[1])).toContain('e4 e5 Qh5');
});

test('corrects malformed and illegal replies with current-turn feedback only', async ({ page }) => {
  const fixture = await provider(page, [], async (route, index, mock) => {
    await mock.respond(route, ['I prefer the center.', '{"move":"e7e4"}', '{"move":"e7e5"}', '{"move":"g8f6"}'][index] ?? '{"resign":true}');
  });
  await page.goto('/play');
  await configure(page);
  await move(page, 'e2e4');
  await expect(movesOnBoard(page)).toHaveCount(2);
  expect(fixture.modelCalls).toHaveLength(3);
  expect(JSON.stringify(fixture.modelCalls[1])).toContain('invalid move format');
  expect(JSON.stringify(fixture.modelCalls[1])).not.toContain('I prefer the center.');
  expect(JSON.stringify(fixture.modelCalls[2])).toContain('e7e4');
  await expect(page.getByRole('heading', { name: 'White to move', exact: true })).toBeVisible();
  await move(page, 'g1f3');
  await expect(movesOnBoard(page)).toHaveCount(4);
  expect(JSON.stringify(fixture.modelCalls[3])).toContain('e4 e5 Nf3');
  expect(JSON.stringify(fixture.modelCalls[3])).not.toContain('e7e4');
  expect(JSON.stringify(fixture.modelCalls[3])).not.toContain('formatCorrection');
});

test('pauses after the formatting budget and sends another request only on Retry', async ({ page }) => {
  const fixture = await provider(page, [], async (route, index, mock) => {
    await mock.respond(route, index < 4 ? 'I prefer the center.' : '{"move":"e7e5"}');
  });
  await page.goto('/play');
  await configure(page);
  await move(page, 'e2e4');
  await expect(page.getByRole('button', { name: 'Retry model request' })).toBeVisible();
  expect(fixture.modelCalls).toHaveLength(4);
  await expect(movesOnBoard(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Retry model request' }).click();
  await expect(movesOnBoard(page)).toHaveCount(2);
  expect(fixture.modelCalls).toHaveLength(5);
});

test('a failed candidate keeps the prior model and can be retried explicitly', async ({ page }) => {
  const fixture = await provider(page, [], async (route, index, mock) => {
    await mock.respond(route, index === 0 ? 'I prefer the center.' : '{"move":"e7e5"}');
  });
  await page.goto('/play');
  await configure(page);
  await page.getByRole('button', { name: 'Choose another model', exact: true }).click();
  await selectModel(page);
  await move(page, 'e2e4');
  await expect(page.getByRole('button', { name: 'Retry queued model' })).toBeVisible();
  await expect(page.locator('.match-layout')).toHaveAttribute('data-committed-model', 'offline-fixture');
  expect(fixture.modelCalls).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry queued model' }).click();
  await expect(movesOnBoard(page)).toHaveCount(2);
  await expect(page.locator('.match-layout')).toHaveAttribute('data-committed-model', 'offline-candidate');
  expect(fixture.modelCalls).toHaveLength(2);
});

test('CLIProxyAPI discovers models, preserves consent cancellation, and plays', async ({ page }) => {
  const fixture = await provider(page, ['e7e5', 'b8c6'], undefined, 'http://127.0.0.1:8317/v1');
  await page.goto('/play');
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.getByLabel('Game mode').selectOption('ai');
  await page.getByLabel('API key', { exact: true }).fill('offline-key');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Available models').selectOption('offline-fixture');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(fixture.calls).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Start game', exact: true })).toBeDisabled();
  await page.getByLabel('Available models').selectOption('offline-fixture');
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  expect(fixture.calls).toHaveLength(1);
  await selectModel(page, 'another-model');
  expect(fixture.calls).toHaveLength(2);
  await page.getByRole('button', { name: 'Start game', exact: true }).click();
  await move(page, 'e2e4'); await expect(movesOnBoard(page)).toHaveCount(2);
  await move(page, 'g1f3'); await expect(movesOnBoard(page)).toHaveCount(4);
  expect(fixture.modelCalls).toHaveLength(2);
});

test('a model playing White continues through knight and bishop development', async ({ page }) => {
  const searchWorkers: string[] = [];
  page.on('worker', (worker) => searchWorkers.push(worker.url()));
  const fixture = await provider(page, ['e2e4', 'g1f3', 'f1c4']);
  await page.goto('/play');
  await configure(page, 'black');
  await expect(movesOnBoard(page)).toHaveCount(1);
  await move(page, 'e7e5');
  await expect(movesOnBoard(page)).toHaveCount(3);
  await move(page, 'b8c6');
  await expect(movesOnBoard(page)).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
  expect(fixture.modelCalls).toHaveLength(3);
  expect(searchWorkers.filter((url) => url.includes('proof-search.worker'))).toHaveLength(0);
});

test('plays through move 15 without proof workers', async ({ page }) => {
  const chess = new Chess();
  const coordinates = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7 Nbd2 Bb7 Bc2 Re8 Nf1 Bf8 Ng3 g6 a4 c5'
    .split(' ').map((san) => chess.move(san).lan);
  const fixture = await provider(page, coordinates.filter((_, index) => index % 2 === 1));
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.goto('/play');
  await configure(page);
  for (let ply = 0; ply < coordinates.length; ply += 2) {
    await move(page, coordinates[ply]!);
    await expect(movesOnBoard(page)).toHaveCount(ply + 2);
  }
  await expect(page.getByRole('button', { name: 'Type a move', exact: true })).toBeEnabled();
  expect(fixture.modelCalls).toHaveLength(15);
  expect(workers.filter((url) => url.includes('proof-search.worker'))).toHaveLength(0);
});

test('a prefixed endpoint discovers models but blocks rejected credentials from play', async ({ page }) => {
  const apiEndpoint = 'https://offline-chess.example/proxy/v1';
  let attempts = 0;
  await page.route('**/api/provider-relay', async route => {
    const request = route.request().postDataJSON() as { url: string; headers: Record<string, string>; body?: string };
    if (request.url === `${apiEndpoint}/models`) {
      await route.fulfill({ json: { data: [{ id: 'exact-routing-alias' }] } }); return;
    }
    expect(request.url).toBe(`${apiEndpoint}/chat/completions`);
    attempts += 1;
    expect(request.headers.authorization).toBe('Bearer offline-key');
    expect(JSON.parse(request.body!)).toMatchObject({ model: 'exact-routing-alias' });
    await route.fulfill({ status: 401, json: { error: { message: 'Invalid API key.' } } });
  });
  await page.goto('/play');
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.getByLabel('Game mode').selectOption('ai');
  await page.getByLabel('Base URL', { exact: true }).fill(`${apiEndpoint}/chat/completions`);
  await page.getByLabel('API key', { exact: true }).fill('offline-key');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Available models').selectOption('exact-routing-alias');
  await expect(page.locator('.disclosure-panel')).toContainText(`${apiEndpoint}/chat/completions`);
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('Check API key.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start game', exact: true })).toBeDisabled();
  expect(attempts).toBe(1);
});

test('changing a saved destination requires its own key and consent', async ({ page }) => {
  await provider(page, []);
  const changed = 'http://127.0.0.1:8318/v1';
  const proxy = await provider(page, [], undefined, changed);
  await page.goto('/play'); await configure(page);
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await expect(page.getByLabel('Available models')).toBeVisible();
  await page.getByRole('button', { name: 'Connection', exact: true }).click();
  await page.getByLabel('Provider').selectOption('cliproxy');
  await page.getByLabel('Base URL', { exact: true }).fill(changed);
  await expect(page.getByLabel('API key', { exact: true })).toHaveAttribute('required', '');
  await page.getByLabel('API key', { exact: true }).fill('destination-key');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Available models').selectOption('offline-fixture');
  await expect(page.locator('.disclosure-panel')).toContainText(changed);
  expect(proxy.calls).toHaveLength(0);
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  expect(proxy.calls).toHaveLength(1);
});

test('reports an upstream failure without calling it a connection failure', async ({ page }) => {
  const fixture = await provider(page, [], async route => {
    await route.fulfill({ status: 502, json: { error: { type: 'server_error', message: 'Upstream service failed.' } } });
  });
  await page.goto('/play'); await configure(page); await move(page, 'e2e4');
  await expect(page.getByRole('heading', { name: 'Provider unavailable. Retry.', exact: true })).toBeVisible();
  expect(fixture.modelCalls).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Retry model request' })).toBeVisible();
  await expect(movesOnBoard(page)).toHaveCount(1);
  const downloading = page.waitForEvent('download');
  await page.evaluate(readFileSync('scripts/extract-browser-game.js', 'utf8'));
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('kamkmchess-debug.json');
  const stream = await download.createReadStream();
  let text = ''; for await (const chunk of stream) text += chunk.toString();
  const exported: { games: { checkpoint: { rules: { moves: unknown[] } }; chunks: { bytes: { encoding: string } }[] }[] } = JSON.parse(text);
  expect(exported.games[0]?.checkpoint.rules.moves).toHaveLength(1);
  expect(exported.games[0]?.chunks.some(chunk => chunk.bytes.encoding === 'base64')).toBe(true);
  expect(JSON.stringify(exported)).toContain('"httpStatus":502');
});

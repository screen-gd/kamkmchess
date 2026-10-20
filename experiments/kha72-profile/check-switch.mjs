/**
 * Browser check for the KHA-72 account-switch fence.
 *
 * Start the dev server first:
 *
 *   pnpm dev --port 5186 --strictPort
 *
 * then run this check:
 *
 *   node experiments/kha72-profile/check-switch.mjs http://127.0.0.1:5186
 *
 * The check drives the real panel, the real state machine and the real
 * client against a local stand-in for the profile service. It never reaches
 * a network service, a hosted account, or a provider, and it is not product
 * acceptance.
 */
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://127.0.0.1:5186';
const page = `${origin}/experiments/kha72-profile/switch.html`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const tab = await context.newPage();
const pageErrors = [];
tab.on('pageerror', (error) => pageErrors.push(String(error)));
tab.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });

try {
  await tab.goto(page, { waitUntil: 'domcontentloaded' });
  await tab.waitForSelector('.profile-name');
  await tab.waitForFunction(() => document.querySelector('.profile-name')?.textContent === 'Alice');

  // A save that is interrupted by an account change is never sent, and the
  // new account sees its own profile instead of the previous drafts.
  const nameField = tab.locator('.profile-field input');
  await nameField.fill('Bobby');
  await tab.getByLabel('Save profile').click();
  await tab.waitForTimeout(60);
  await tab.locator('#switch-account').click();
  await tab.waitForTimeout(1200);

  const interrupted = await tab.locator('#requests').innerText();
  assert(!interrupted.includes('PUT'), `An interrupted save was sent:\n${interrupted}`);
  assert((await tab.locator('#active-account').innerText()).includes('bravo'), 'The account did not change.');
  assert((await tab.locator('.profile-name').innerText()) === 'Bob', 'The new account does not show its own profile.');
  assert((await nameField.inputValue()) === 'Bob', 'The previous account drafts are still shown.');

  // A save that is not interrupted reaches the service under the account it
  // started under.
  await nameField.fill('Carol');
  await tab.getByLabel('Save profile').click();
  await tab.waitForTimeout(1200);

  const completed = await tab.locator('#requests').innerText();
  const saves = completed.split('\n').filter(line => line.startsWith('PUT'));
  assert(saves.length === 1, `The healthy save was not sent:\n${completed}`);
  assert(saves[0].includes('Bearer token-bravo'), `The healthy save used the wrong account:\n${completed}`);
  assert(pageErrors.length === 0, `The page reported errors: ${pageErrors.join(' | ')}`);

  console.log('KHA-72 account switch check passed.');
  console.log(completed);
} finally {
  await browser.close();
}

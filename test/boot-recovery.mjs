import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.WORKSTATION_TEST_ENGINE || 'chromium';
const origin = process.env.WORKSTATION_TEST_ORIGIN || 'https://linux.pointblankllc.com';
const profile = await mkdtemp(join(tmpdir(), 'pointblank-boot-'));
const options = process.env.WORKSTATION_TEST_MOBILE === '1'
  ? playwright.devices['iPhone 15']
  : { viewport: { width: 1400, height: 850 } };
const timeout = 120_000;
const marker = 'pointblank-linux-boot-in-progress';
let context;

try {
  context = await playwright[engine].launchPersistentContext(profile, {
    ...options,
    executablePath: process.env.WORKSTATION_BROWSER_PATH,
    args: engine === 'chromium' ? ['--no-sandbox'] : [],
  });
  const page = context.pages()[0];
  const boot = page.locator('#boot');
  const rows = page.locator('.xterm-rows');
  const addSession = page.locator('#add-session');
  const save = page.locator('#save-state');
  const saveStatus = page.locator('#save-status');
  const workspaceMenu = page.locator('#workspace-settings');
  const crashes = [];
  page.on('crash', () => crashes.push('renderer crash'));

  async function ready() {
    await page.locator('#add-session:enabled').waitFor({ timeout });
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), marker), null);
  }

  async function command(input, output) {
    await page.locator('.xterm-helper-textarea').first().focus();
    await page.keyboard.insertText(input);
    await page.keyboard.press('Enter');
    await rows.getByText(output, { exact: true }).waitFor({ timeout });
  }

  async function interruptedBoot() {
    await page.evaluate((key) => sessionStorage.setItem(key, '1'), marker);
    await page.reload({ waitUntil: 'commit', timeout });
    await boot.getByText(/^Linux startup was interrupted/).waitFor({ timeout });
    assert(await addSession.isDisabled());
  }

  const start = performance.now();
  await page.goto(origin, { waitUntil: 'commit', timeout });
  await ready();
  const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize);
  console.log(`PASS ${engine} reached a shell in ${((performance.now() - start) / 1000).toFixed(2)}s${heap ? ' (JS heap ' + heap + ' bytes)' : ''}`);

  await command('echo SAVED_WORKSPACE_PROBE >/workspace/boot-probe && echo PROBE_WRITTEN', 'PROBE_WRITTEN');
  await workspaceMenu.click();
  await save.click();
  await page.waitForFunction(() => document.getElementById('save-status').textContent.startsWith('Saved '), null, { timeout });
  await interruptedBoot();
  await boot.getByRole('button', { name: 'Open temporary shell' }).click();
  await ready();
  await command('test ! -e /workspace/boot-probe && echo TEMPORARY_WORKSPACE_OK', 'TEMPORARY_WORKSPACE_OK');
  assert(await save.isDisabled());
  assert.match(await saveStatus.textContent(), /^Temporary session/);
  console.log('PASS an interrupted boot pauses and a temporary shell keeps the checkpoint intact');

  await interruptedBoot();
  await boot.getByRole('button', { name: 'Retry saved workspace' }).click();
  await ready();
  await command('cat /workspace/boot-probe', 'SAVED_WORKSPACE_PROBE');
  await page.reload({ waitUntil: 'commit', timeout });
  await ready();
  await command('cat /workspace/boot-probe', 'SAVED_WORKSPACE_PROBE');
  assert.deepEqual(crashes, []);
  console.log('PASS retry and ordinary reload both restore the saved Alpine filesystem');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}

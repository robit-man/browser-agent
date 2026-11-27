import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = 'https://linux.pointblankllc.com';
const artifact = process.env.WORKSTATION_RELEASE_HTML;
const smoke = process.env.WORKSTATION_STARTUP_SMOKE === '1';
const browser = await chromium.launch({
  args: ['--no-sandbox'], executablePath: process.env.CHROMIUM_PATH,
});

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 850 }, acceptDownloads: true });
  const page = await context.newPage();
  if (artifact) await page.route(origin + '/', (route) => route.fulfill({ path: artifact, contentType: 'text/html' }));
  return page;
}

async function ready(page, state) {
  await page.locator('#add-session:enabled').waitFor({ timeout: 90000 });
  assert.equal(await page.locator('#network-label').textContent(), 'NETWORK: ' + state);
}

let commandNumber = 0;
async function guest(page, command, expected) {
  const number = ++commandNumber;
  await page.locator('.xterm-screen').click();
  await page.keyboard.insertText(command + "; printf '\\nPBL_NETWORK_%s=%s\\n' " + number + ' "$?"');
  await page.keyboard.press('Enter');
  const rows = page.locator('.xterm-rows');
  await rows.getByText('PBL_NETWORK_' + number + '=0', { exact: true }).waitFor({ timeout: 30000 });
  assert.match(await rows.innerText(), expected);
}

async function workspaceAction(page, id) {
  await page.locator('#workspace-settings').click();
  await page.locator('#' + id).click();
}

try {
  const page = await newPage();
  await page.addInitScript(() => {
    // Old releases left this value behind on the next visit after a disconnect.
    const key = 'pointblank-linux-public-network';
    if (localStorage.getItem(key) === null) localStorage.setItem(key, 'off');
  });
  await page.goto(origin);
  await ready(page, 'ONLINE');
  await guest(page, 'network test', /Diagnostics HTTP 200/);
  await guest(page, 'git ls-remote https://github.com/robit-man/POINTBLANK.git HEAD', /^[a-f0-9]{40}\s+HEAD\s*$/m);
  await guest(page, 'npm view is-number@7.0.0 version', /^7\.0\.0\s*$/m);
  assert.equal(await page.locator('#network-dialog').evaluate((dialog) => dialog.open), false);
  console.log('PASS the first shell reaches Alpine mirrors, GitHub, and npm without clicking through networking');

  if (!smoke) {
    await guest(page, 'network off', /NETWORK: OFFLINE/);
    await workspaceAction(page, 'save-state');
    await page.waitForFunction(() => document.getElementById('save-status').textContent.startsWith('Saved '), null, { timeout: 120000 });
    await page.reload();
    await ready(page, 'ONLINE');
    console.log('PASS an ordinary workspace saved while offline reconnects on reload');

    const download = page.waitForEvent('download', { timeout: 120000 });
    await workspaceAction(page, 'export-state');
    const path = await (await download).path();
    page.once('dialog', (dialog) => dialog.accept());
    const reload = page.waitForEvent('load', { timeout: 120000 });
    await page.locator('#snapshot-file').setInputFiles(path);
    await reload;
    await ready(page, 'OFFLINE');
    await page.reload();
    await ready(page, 'OFFLINE');
    await guest(page, 'network on', /NETWORK: ONLINE/);
    await page.reload();
    await ready(page, 'ONLINE');
    console.log('PASS imported snapshots stay offline until explicitly approved, then reconnect on later visits');
  }
  await page.context().close();

  if (!smoke) {
    const failure = await newPage();
    const services = origin + '/api/workstation/public/v1/services';
    await failure.route(services, (route) => route.fulfill({ status: 503 }), { times: 1 });
    await failure.goto(origin);
    await ready(failure, 'ERROR');
    await failure.evaluate(() => window.dispatchEvent(new Event('online')));
    await failure.getByRole('button', { name: 'NETWORK: ONLINE', exact: true }).waitFor({ timeout: 20000 });
    await guest(failure, 'network test', /Diagnostics HTTP 200/);
    console.log('PASS a failed gateway check leaves the shell usable and networking reconnects when the browser comes online');
  }
} finally {
  await browser.close();
}

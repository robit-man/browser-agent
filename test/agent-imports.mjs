import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.WORKSTATION_TEST_ORIGIN || 'http://127.0.0.1:18733';
const browser = await chromium.launch({
  args: ['--no-sandbox'],
  executablePath: process.env.CHROMIUM_PATH,
});

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  // Reach the engine loader on headless Chromium without allocating a GPU.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      value: { requestAdapter: async () => ({ info: { vendor: 'test' }, features: new Set() }) },
    });
  });
  // Strands imports the engine before requesting this first checkpoint file.
  // Stop here so the regression test can run without downloading the model.
  let checkpointRequests = 0;
  await page.route('https://huggingface.co/alxnahas/strands-decider-v21-webgpu/resolve/**', (route) => {
    assert.ok(new URL(route.request().url()).pathname.endsWith('/model/hobson_config.json'));
    checkpointRequests++;
    return route.fulfill({ status: 503, body: 'Stopped by test after engine import' });
  });

  const response = await page.goto(origin);
  assert.equal(response.status(), 200);
  await page.locator('#add-session:enabled').waitFor({ timeout: 90000 });
  await page.locator('.xterm-screen').click();
  await page.keyboard.insertText("agent model verify strands; printf '\\nAGENT_IMPORT_STATUS=%s\\n' \"$?\"");
  await page.keyboard.press('Enter');
  const rows = page.locator('.xterm-rows');
  await rows.getByText(/^AGENT_IMPORT_STATUS=\d+$/).waitFor({ timeout: 30000 });
  const output = await rows.innerText();
  assert.doesNotMatch(output, /Failed to resolve module specifier/);
  assert.match(output, /model\/hobson_config\.json: HTTP 503/);
  assert.equal(checkpointRequests, 1);
  console.log('PASS standalone Strands engine loaded and reached the checkpoint request from the Alpine terminal');
} finally {
  await browser.close();
}

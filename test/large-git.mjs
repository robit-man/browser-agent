import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.WORKSTATION_TEST_ORIGIN || 'http://127.0.0.1:18735';
const keepLimit = process.env.WORKSTATION_TEST_GROWTH === 'cancel';
const growth = keepLimit || process.env.WORKSTATION_TEST_GROWTH === '1';
const browser = await chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.CHROMIUM_PATH });

try {
  const entries = await (await fetch(origin + '/test/payloads')).json();
  assert.equal(entries.length, 4, 'Start test/fixture.mjs with LARGE_GIT_FIXTURE=1');
  const page = await browser.newPage({ viewport: { width: 1480, height: 900 } });
  page.on('pageerror', (error) => console.error(error));
  if (process.env.WORKSTATION_RELEASE_HTML) {
    await page.route(origin + '/', (route) => route.fulfill({ path: process.env.WORKSTATION_RELEASE_HTML, contentType: 'text/html' }));
  }
  await page.goto(origin);
  await page.locator('#add-session:enabled').waitFor({ timeout: 120000 });

  let sequence = 0;
  async function guest(command, expected = 0) {
    const marker = 'LARGE_GIT_' + ++sequence;
    await page.locator('.xterm-screen').click();
    await page.keyboard.insertText('( ' + command + " ); rc=$?; printf '\\n%s=%s\\n' " + marker + ' "$rc"');
    await page.keyboard.press('Enter');
    const rows = page.locator('.xterm-rows');
    try {
      const result = rows.getByText(new RegExp('^' + marker + '=\\d+$'));
      await result.waitFor({ timeout: 240000 });
      assert.equal(await result.innerText(), marker + '=' + expected);
    } catch (error) {
      console.error(await rows.innerText());
      throw error;
    }
  }

  await page.locator('#network-settings').click();
  await page.locator('#configure-network').click();
  await page.locator('[name=key]').fill('workstation-fixture-key-with-32-characters');
  await page.locator('[name=repository]').fill('pointblank-fixture/upstream');
  await page.locator('[name=username]').fill('fixture');
  await page.locator('[name=git-token]').fill('github_pat_fixtureOnly000000000000000000000000000000');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: 'NETWORK: ONLINE', exact: true }).waitFor({ timeout: 20000 });
  if (growth) await guest('dd if=/dev/zero of=/workspace/filler bs=1M count=200');
  const clone = guest('git clone --quiet https://github.com/pointblank-fixture/upstream.git /workspace/large', keepLimit ? 128 : 0);
  if (growth) {
    await page.locator('#growth-dialog[open]').getByText(/This Git download/).waitFor({ timeout: 120000 });
    await page.locator('#growth-dialog').getByRole('button', { name: keepLimit ? 'Keep limit' : 'Allow growth' }).click();
  }
  await clone;
  if (keepLimit) {
    assert.equal(await page.evaluate(() => localStorage.getItem('pointblank-linux-workspace-growth')), null);
    await guest('test -s /workspace/filler && git --version');
    console.log('PASS keeping the default limit canceled the clone and preserved the existing workspace');
  } else {
    const checks = entries.map(({ name, sha256 }) => {
      assert.match(name, /^payload-[0-3]\.bin$/);
      assert.match(sha256, /^[a-f0-9]{64}$/);
      return "'" + sha256 + '  ' + name + "'";
    }).join(' ');
    const verify = "cd /workspace/large && test -s .git/HEAD && test \"$(wc -c < payload-0.bin)\" -eq 27262976 && " +
      "printf '%s\\n' " + checks + ' | sha256sum -c -';
    await guest(verify + ' && set -- .git/objects/pack/*.pack && test "$(wc -c < "$1")" -gt 109051904');
    console.log('PASS native Alpine Git cloned and checked out a pack over 104 MiB, with all four files verified');
    if (growth) {
      await guest('df -Pk /workspace | awk \'NR==2 {exit !($4 > 512 * 1024)}\' && ' +
        'dd if=/dev/zero of=/workspace/filler bs=1M count=400 && test "$(du -sm /workspace | cut -f1)" -gt 512');
      console.log('PASS live approval resumed the Git transfer and the workspace grew past the guest RAM size');
    }

    await page.locator('#workspace-settings').click();
    await page.locator('#save-state').click();
    await page.waitForFunction(() => {
      const status = document.getElementById('save-status').textContent;
      return status.startsWith('Saved ') || (!status.includes('Saving') && !document.getElementById('save-state').disabled);
    }, null, { timeout: 180000 });
    assert.match(await page.locator('#save-status').textContent(), /^Saved /);
    await page.reload({ timeout: 120000 });
    await page.locator('#add-session:enabled').waitFor({ timeout: 150000 });
    await guest(verify);
    if (growth) await guest('test "$(wc -c < /workspace/filler)" -eq 419430400');
    console.log('PASS the large checkout was saved and restored with matching hashes');
  }
} finally {
  await browser.close();
}

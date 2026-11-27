import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.WORKSTATION_TEST_ORIGIN || 'http://127.0.0.1:18733';
const browser = await chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.CHROMIUM_PATH });

try {
  const page = await browser.newPage({ viewport: { width: 1480, height: 960 } });
  await page.addInitScript(() => localStorage.setItem('pointblank-linux-autosave', '0'));
  const panel = id => page.locator('#terminal-session-' + id);
  const rows = id => panel(id).locator('.xterm-rows');
  const lastLineMatches = (id, pattern) => page.waitForFunction(([id, pattern]) => {
    const lines = document.querySelector('#terminal-session-' + id + ' .xterm-rows')?.innerText
      .split('\n').map(line => line.trim()).filter(Boolean);
    return new RegExp(pattern).test(lines?.at(-1) || '');
  }, [id, pattern], { timeout: 15000 });
  const prompt = id => lastLineMatches(id, '^/workspace #$');
  async function command(id, text, result) {
    await panel(id).locator('.xterm-helper-textarea').focus();
    await page.keyboard.insertText(text);
    await page.keyboard.press('Enter');
    await rows(id).getByText(result, { exact: true }).last().waitFor();
    await prompt(id);
  }
  async function ready() {
    await page.locator('#add-session:enabled').waitFor({ timeout: 120000 });
    await prompt(1);
  }

  assert.equal((await page.goto(origin, { waitUntil: 'commit', timeout: 120000 })).status(), 200);
  await ready();
  await command(1, 'command -v git', '/usr/bin/git');
  await page.locator('#workspace-settings').click();
  await page.locator('#split-right').click();
  await prompt(2);
  const first = "printf '%s\\n' HISTORY_FIRST";
  const second = "printf '%s\\n' HISTORY_SECOND";
  await command(1, first, 'HISTORY_FIRST');
  await command(1, first, 'HISTORY_FIRST');
  await panel(1).locator('.xterm-helper-textarea').focus();
  await page.keyboard.insertText("printf '%s\\n' 'HISTORY_MULTI_HEAD");
  await page.keyboard.press('Enter');
  await page.keyboard.insertText("HISTORY_MULTI_TAIL'");
  await page.keyboard.press('Enter');
  await rows(1).getByText('HISTORY_MULTI_TAIL', { exact: true }).waitFor();
  await prompt(1);
  await command(2, second, 'HISTORY_SECOND');
  await command(2, " echo HISTORY_PRIVATE", 'HISTORY_PRIVATE');
  await command(2, "echo 'https://fake-user:fake-password@github.com/example/repo' >/dev/null && echo HISTORY_FILTERED",
    'HISTORY_FILTERED');
  assert.equal(await page.locator('#save-status').textContent(), 'Ready to save');
  const saved = await page.evaluate(async () => {
    const store = await (await navigator.storage.getDirectory()).getDirectoryHandle('pointblank-linux-filesystem');
    return (await (await store.getFileHandle('shell-history-v1')).getFile()).text();
  });
  assert.equal(saved.split('\n').filter(line => line === first).length, 1);
  assert.equal(saved.split('\n').filter(line => line === second).length, 1);
  assert.match(saved, /HISTORY_MULTI_HEAD\nHISTORY_MULTI_TAIL/);
  assert.doesNotMatch(saved, /HISTORY_PRIVATE|fake-password|HISTORY_FILTERED|__pointblank_prompt/);

  await page.reload({ waitUntil: 'commit', timeout: 120000 });
  await ready();
  await panel(1).locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('ArrowUp');
  await rows(1).getByText('/workspace # ' + second, { exact: true }).waitFor();
  await page.keyboard.press('Enter');
  await rows(1).getByText('HISTORY_SECOND', { exact: true }).waitFor();
  await prompt(1);
  await page.keyboard.press('Control+r');
  await page.keyboard.insertText('HISTORY_FIRST');
  await rows(1).getByText(/reverse-i-search.*HISTORY_FIRST/).waitFor();
  await page.keyboard.press('Enter');
  await rows(1).getByText('HISTORY_FIRST', { exact: true }).waitFor();
  await prompt(1);

  console.log('PASS Bash Up Arrow and Ctrl+R after reload with autosave off, merged pane history, multiline history, and credential filtering');

  await command(1, 'history-clear && echo HISTORY_CLEARED', 'HISTORY_CLEARED');
  await page.reload({ waitUntil: 'commit', timeout: 120000 });
  await ready();
  await panel(1).locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('ArrowUp');
  await prompt(1);
  assert.doesNotMatch(await rows(1).innerText(), /HISTORY_FIRST|HISTORY_SECOND|history-clear/);
  console.log('PASS history-clear removes saved history across reloads');
} finally {
  await browser.close();
}

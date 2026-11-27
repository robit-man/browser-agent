import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.WORKSTATION_TEST_ORIGIN || 'http://127.0.0.1:18733';
const ttyURL = process.env.TTY_URL || 'https://tty.pointblankllc.com/';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
const terminal = (id) => '#terminal-session-' + id;
const timeout = 25000;

async function boot(context) {
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(error));
  const response = await page.goto(url);
  assert.equal(response.status(), 200);
  await page.locator('#add-session:enabled').waitFor({ timeout: 90000 });
  return page;
}

async function run(page, command, target) {
  await page.bringToFront();
  await page.locator((target || '.terminal-panel') + ' .xterm-screen').first().click({ position: { x: 24, y: 24 } });
  await page.keyboard.insertText(command);
  await page.keyboard.press('Enter');
}

async function output(page, text, target = '.terminal-panel') {
  await page.locator(target + ' .xterm-rows').getByText(text, { exact: true }).waitFor({ timeout });
}

async function workspaceAction(page, id) {
  await page.locator('#workspace-settings').click();
  await page.locator('#' + id).click();
}

async function drag(page, from, to, x, y) {
  const origin = await page.locator(from).boundingBox();
  const bounds = await page.locator(to).boundingBox();
  await page.mouse.move(origin.x + origin.width / 2, origin.y + origin.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * x, bounds.y + bounds.height * y, { steps: 10 });
  await page.locator('#dock-targets [data-highlight=true]').waitFor();
  await page.mouse.up();
}

async function readInvite(page) {
  await page.locator('#share-generate').click();
  await page.locator('#share-qr').waitFor({ timeout });
  return { link: await page.locator('#share-invite-url').inputValue(), pin: await page.locator('#share-pin').textContent() };
}

try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 850 } });
  const page = await boot(desktop);
  await run(page, "echo same-alpine > /workspace/terminal-test && echo shared-fs-written", terminal(1));
  await output(page, 'shared-fs-written', terminal(1));
  await workspaceAction(page, 'split-right');
  await page.locator(terminal(2) + '[data-state=online]').waitFor();
  await run(page, 'cat /workspace/terminal-test', terminal(2));
  await output(page, 'same-alpine', terminal(2));
  await page.locator(terminal(1) + ' .pane-label').click();
  await page.locator('#pane-font-larger').click();
  assert.equal(await page.locator('#pane-font-value').textContent(), '14 px');
  await page.keyboard.press('Escape');
  await page.locator(terminal(2) + ' .pane-label').click();
  assert.equal(await page.locator('#pane-font-value').textContent(), '13 px');
  await page.keyboard.press('Escape');
  const divider = page.getByRole('separator').first();
  const initialRatio = await divider.getAttribute('aria-valuenow');
  await divider.press('ArrowRight');
  assert.notEqual(await divider.getAttribute('aria-valuenow'), initialRatio);
  await page.locator(terminal(2) + ' .pane-minimize').click();
  assert.equal(await page.locator(terminal(2)).count(), 0);
  await drag(page, '#tabs .tab-select:has-text("Alpine 2")', terminal(1), .5, .88);
  assert.equal(await page.locator('.pane-split').getAttribute('data-axis'), 'column');
  await output(page, 'same-alpine', terminal(2));
  await drag(page, '#add-session', terminal(2), .9, .5);
  await page.locator(terminal(3) + '[data-state=online]').waitFor();
  await page.locator(terminal(3) + ' .pane-close').click();
  await page.locator('#close-terminal-dialog button[value=cancel]').click();
  assert.equal(await page.locator(terminal(3)).count(), 1);
  await page.locator(terminal(3) + ' .pane-close').click();
  await page.locator('#close-terminal-dialog button[value=close]').click();
  await page.locator(terminal(3)).waitFor({ state: 'detached' });
  await output(page, 'same-alpine', terminal(2));
  await page.locator('#files').setInputFiles({ name: 'pane-test.txt', mimeType: 'text/plain', buffer: Buffer.from('shared-upload\n') });
  await page.locator('#transfer').getByText(/Imported/).waitFor({ timeout });
  await run(page, 'cat /workspace/inbox/pane-test.txt', terminal(2));
  await output(page, 'shared-upload', terminal(2));
  await run(page, 'mkdir -p /workspace/working && cd /workspace/working && echo working-cwd', terminal(2));
  await output(page, 'working-cwd', terminal(2));
  await page.locator(terminal(2) + ' .pane-fork').click();
  await page.locator(terminal(4) + '[data-state=online]').waitFor();
  await run(page, 'pwd', terminal(4));
  await output(page, '/workspace/working', terminal(4));
  await page.locator(terminal(4) + ' .pane-close').click();
  await page.locator('#close-terminal-dialog button[value=close]').click();
  await page.locator(terminal(4)).waitFor({ state: 'detached' });
  console.log('PASS same Alpine filesystem, independent text sizes, resize, drag docking, minimize, confirmed close, file upload and fork in the same directory');

  if (!process.env.SKIP_TTY_SHARING) {
    const tty = await desktop.newPage();
    await run(page, "printf '\\nREADY_TO_SHARE\\n'", terminal(1));
    await output(page, 'READY_TO_SHARE', terminal(1));
    await page.locator(terminal(1) + ' .pane-share').click();
    let invite = await readInvite(page);
    const locateTTY = (link) => new URL(new URL(link).hash, ttyURL).href;
    await tty.goto(locateTTY(invite.link));
    await tty.locator('#share-dialog[open]').waitFor({ timeout });
    for (const [index, char] of [...invite.pin].entries()) await tty.locator('.share-pin-cell').nth(index).fill(char);
    await tty.locator('#share-verify').click();
    await page.locator('#share-approve').waitFor({ timeout });
    await page.locator('#share-approve').click();
    await output(tty, 'READY_TO_SHARE');
    const viewer = tty.locator('.terminal-panel[data-guest=true]');
    assert.equal(await viewer.locator('.xterm-helper-textarea').evaluate((field) => field.readOnly), true);
    await page.locator('#share-peers button').click();
    await viewer.getByText(/sharing ended/i).waitFor({ timeout });
    await page.locator('#share-close').click();
    console.log('PASS live TTY receives browser Alpine screen and view-only permissions, host can revoke access');

    await page.locator(terminal(1) + ' .pane-share').click();
    invite = await readInvite(page);
    await tty.goto(locateTTY(invite.link));
    for (const [index, char] of [...invite.pin].entries()) await tty.locator('.share-pin-cell').nth(index).fill(char);
    await tty.locator('#share-verify').click();
    await page.locator('#share-approve').waitFor({ timeout });
    await page.locator('#share-write').check();
    await page.locator('#share-approve').click();
    await output(tty, 'READY_TO_SHARE');
    await run(tty, "printf '\\nTTY_CONTROL_OK\\n'");
    await output(tty, 'TTY_CONTROL_OK');
    await page.locator('#share-close').click();
    await output(page, 'TTY_CONTROL_OK', terminal(1));
    console.log('PASS TTY control input executes in the shared browser Alpine PTY and renders output on both sites');
    const receiver = await desktop.newPage();
    await receiver.goto(ttyURL);
    await receiver.keyboard.press('Escape');
    await receiver.locator('#connect-dialog').waitFor({ state: 'hidden', timeout });
    await receiver.locator('#session-status').click();
    await receiver.locator('#stats-scan').click();
    await receiver.locator('#share-tab').click();
    await receiver.locator('#share-generate').click();
    const code = receiver.locator('#share-qr');
    await code.waitFor({ timeout });
    const receiveURL = await code.evaluate(async (img) => {
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(img, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      return window.TTYShareVendor.jsQR(pixels.data, canvas.width, canvas.height).data;
    });
    const receivePIN = await receiver.locator('#share-pin').textContent();
    await page.locator(terminal(2) + ' .pane-share').click();
    await page.locator('#share-connect-tab').click();
    await page.locator('#share-link').fill(receiveURL);
    await page.locator('#share-mode').selectOption('give');
    for (const [index, char] of [...receivePIN].entries()) await page.locator('.share-pin-cell').nth(index).fill(char);
    await page.locator('#share-verify').click();
    await receiver.locator('#share-approve').click({ timeout });
    await output(receiver, 'shared-upload');
    await page.locator('#share-close').click();
    console.log('PASS Linux can offer a terminal using a QR/PIN invite issued by the live TTY site');
    await receiver.close();
    await tty.close();

    const guestContext = await browser.newContext({ viewport: { width: 1050, height: 768 } });
    const linuxGuest = await guestContext.newPage();
    await page.locator(terminal(1) + ' .pane-share').click();
    invite = await readInvite(page);
    await linuxGuest.goto(new URL(new URL(invite.link).hash, url).href);
    await linuxGuest.locator('#share-dialog[open]').waitFor({ timeout: 90000 });
    for (const [index, char] of [...invite.pin].entries()) await linuxGuest.locator('.share-pin-cell').nth(index).fill(char);
    await linuxGuest.locator('#share-verify').click();
    await page.locator('#share-approve').waitFor({ timeout });
    await page.locator('#share-write').check();
    await page.locator('#share-approve').click();
    const sharedPane = '.terminal-panel[data-guest=true]';
    await output(linuxGuest, 'READY_TO_SHARE', sharedPane);
    await linuxGuest.bringToFront();
    const input = linuxGuest.locator(sharedPane + ' .xterm-helper-textarea');
    assert.equal(await input.evaluate((field) => field.readOnly), false);
    await input.focus();
    await linuxGuest.keyboard.insertText("printf '\\nSHARED_LINUX_GUEST_OK\\n'");
    await linuxGuest.keyboard.press('Enter');
    try { await output(linuxGuest, 'SHARED_LINUX_GUEST_OK', sharedPane); }
    catch (error) {
      console.error('Source and viewer terminal rows', await page.locator(terminal(1) + ' .xterm-rows').allTextContents(),
        await linuxGuest.locator(sharedPane + ' .xterm-rows').allTextContents());
      throw error;
    }
    await page.locator('#share-close').click();
    await output(page, 'SHARED_LINUX_GUEST_OK', terminal(1));
    await guestContext.close();
    console.log('PASS Linux opens a shared guest pane from a v2 invite URL and sends approved input to the remote Alpine shell');
  }
  await desktop.close();

  const mobile = await browser.newContext({ ...devices['Pixel 7'] });
  await mobile.addInitScript(() => {
    const viewport = visualViewport;
    const original = Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'height').get;
    Object.defineProperty(viewport, 'height', { get() { return globalThis.keyboardHeight ?? original.call(viewport); } });
  });
  const phone = await boot(mobile);
  assert.equal(await phone.locator('#session-sidebar').evaluate((el) => getComputedStyle(el).getPropertyValue('--rail-width').trim()), '79px');
  await phone.locator('#toggle-sessions').tap();
  await phone.locator('#add-sidebar-session').tap();
  await phone.locator(terminal(2) + '[data-state=online]').waitFor();
  await phone.locator(terminal(2) + ' .xterm-screen').tap({ position: { x: 20, y: 20 } });
  await phone.locator(terminal(2) + ' .xterm-helper-textarea').focus();
  await phone.evaluate(() => {
    globalThis.keyboardHeight = 500;
    visualViewport.dispatchEvent(new Event('resize'));
  });
  const keys = phone.locator('#soft-keys');
  await keys.waitFor();
  const keyBounds = await keys.boundingBox();
  assert.ok(Math.abs(keyBounds.y + keyBounds.height - 500) < 2);
  await phone.keyboard.insertText('discard this draft');
  await keys.getByRole('button', { name: 'Ctrl', exact: true }).tap();
  await phone.keyboard.insertText('u');
  assert.equal(await keys.getByRole('button', { name: 'Ctrl', exact: true }).getAttribute('aria-pressed'), 'false');
  await phone.keyboard.insertText("printf '\\nSOFT_KEY_OK\\n'");
  await keys.getByRole('button', { name: 'Enter', exact: true }).tap();
  await output(phone, 'SOFT_KEY_OK', terminal(2));
  await phone.keyboard.insertText("printf '<%s>\\n' 'a");
  const mobileInput = phone.locator(terminal(2) + ' .xterm-helper-textarea');
  await mobileInput.evaluate((field) => {
    function spaceKey(type) {
      field.dispatchEvent(new KeyboardEvent(type, { key: ' ', code: 'Space', keyCode: 32, charCode: 32,
        bubbles: true, cancelable: true, composed: true }));
    }
    function insertSpace() {
      field.dispatchEvent(new InputEvent('beforeinput', { data: ' ', inputType: 'insertText', bubbles: true }));
      field.value += ' ';
      field.dispatchEvent(new InputEvent('input', { data: ' ', inputType: 'insertText', bubbles: true }));
    }
    spaceKey('keydown');
    spaceKey('keypress');
    insertSpace();
    spaceKey('keyup');
    spaceKey('keydown');
    spaceKey('keypress');
    spaceKey('keyup');
    insertSpace();
    insertSpace();
  });
  await phone.keyboard.insertText("b'");
  await keys.getByRole('button', { name: 'Enter', exact: true }).tap();
  await output(phone, '<a   b>', terminal(2));
  const touch = await mobile.newCDPSession(phone);
  const word = phone.locator(terminal(2) + ' .xterm-rows').getByText('SOFT_KEY_OK', { exact: true });
  const row = await word.boundingBox();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: row.x + 14, y: row.y + row.height / 2 }] });
  await phone.waitForTimeout(520);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await phone.locator('#term-copy:enabled').waitFor({ timeout: 5000 });
  await phone.keyboard.press('Escape');
  await phone.locator(terminal(2) + ' .pane-label').tap();
  await phone.locator('#pane-font-larger').tap();
  assert.equal(await phone.locator('#pane-font-value').textContent(), '14 px');
  await phone.evaluate(() => {
    delete globalThis.keyboardHeight;
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await keys.waitFor({ state: 'hidden' });
  console.log('PASS touch sidebar and text sizing, keyboard viewport, sticky Ctrl, soft Enter, single spaces and long-press text selection');
} finally {
  await browser.close();
}

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.WORKSTATION_TEST_ENGINE === 'webkit' ? webkit : chromium;
const browser = await engine.launch({
  executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH,
  ...(engine === chromium ? { args: ['--no-sandbox'] } : {}),
});

try {
  const page = await browser.newPage({ ...devices['iPhone 15 Pro'] });
  await page.goto(process.env.WORKSTATION_TEST_ORIGIN || 'http://127.0.0.1:18733');
  await page.locator('#add-session:enabled').waitFor({ timeout: 90000 });
  const field = page.locator('.xterm-helper-textarea');
  await field.focus();

  async function dispatch(events) {
    await field.evaluate((textarea, events) => {
      for (const [type, value, code] of events) {
        const options = { bubbles: true, cancelable: true, composed: true };
        if (type.startsWith('key')) {
          const event = new KeyboardEvent(type, { ...options, key: value, code: value === ' ' ? 'Space' : '' });
          Object.defineProperty(event, 'keyCode', { value: code });
          Object.defineProperty(event, 'charCode', { value: type === 'keypress' ? code : 0 });
          textarea.dispatchEvent(event);
        } else if (type.startsWith('composition')) {
          textarea.dispatchEvent(new CompositionEvent(type, { ...options, data: value }));
        } else {
          const edit = { ...options, data: value, inputType: type, isComposing: type === 'insertCompositionText' };
          if (!textarea.dispatchEvent(new InputEvent('beforeinput', edit))) continue;
          const end = textarea.value.length;
          const replaced = type === 'deleteContentBackward' ? 1 : code || 0;
          textarea.setRangeText(value ?? '', Math.max(0, end - replaced), end, 'end');
          textarea.dispatchEvent(new InputEvent('input', edit));
        }
      }
    }, events);
  }

  async function check(name, events, expected) {
    await page.keyboard.insertText(`printf '\\n${name}<%s>\\n' 'a`);
    if (typeof events === 'function') {
      await events();
      await page.keyboard.insertText("b'");
    } else {
      await dispatch(events);
      await page.waitForTimeout(50);
      // Follow the simulated edit with another simulated edit. Playwright's
      // native WebKit insertion can otherwise replace a trailing scripted space.
      await dispatch([['insertText', "b'"]]);
    }
    await page.keyboard.press('Enter');
    const line = page.locator('.xterm-rows').getByText(new RegExp('^' + name + '<.*>$'));
    await line.waitFor();
    const actual = await line.textContent();
    return { name, actual, expected: name + '<' + expected + '>' };
  }

  const space = ['insertText', ' '];
  const results = [
    await check('IOS_IME_SPACE', [['keydown', ' ', 229], ['keyup', ' ', 229], space], 'a b'),
    await check('IOS_COMMIT_SPACE', [
      ['compositionstart', ''], ['compositionupdate', 'あ'], ['insertCompositionText', 'あ'],
      ['compositionend', 'あ'], space,
    ], 'aあ b'),
    await check('IOS_PHYSICAL_EVENTS', [
      ['keydown', ' ', 32], ['keypress', ' ', 32], ['keyup', ' ', 32], space,
    ], 'a b'),
    await check('IOS_REPEATED_SPACE', [space, space, space], 'a   b'),
    await check('IOS_DELETE_SPACE', [space, space, ['deleteContentBackward', null]], 'a b'),
    await check('IOS_REPLACEMENT', [['insertText', ' the'], ['insertReplacementText', ' new', 4]], 'a newb'),
    await check('IOS_TRUSTED_KEYBOARD', async () => {
      await page.keyboard.press('Space');
      await page.keyboard.press('Shift+KeyA');
      await page.keyboard.press('Space');
      await page.keyboard.press('Space');
    }, 'a A  b'),
  ];
  for (const { name, actual, expected } of results) {
    console.log(`${engine.name()} ${name} ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
  }
  assert.deepEqual(results.map(({ actual }) => actual), results.map(({ expected }) => expected));
} finally {
  await browser.close();
}

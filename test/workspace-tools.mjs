import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.CHROMIUM_PATH });
const origin = process.env.WORKSTATION_TEST_ORIGIN || 'http://127.0.0.1:18733';
const mobile = process.env.WORKSTATION_TEST_MOBILE === '1';
const packs = process.env.WORKSTATION_TEST_PACKS;
const run = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), 'pointblank-tools-'));

try {
  const page = await browser.newPage({ acceptDownloads: true,
    ...(mobile ? devices['Pixel 7'] : { viewport: { width: 1440, height: 900 } }) });
  await page.goto(origin, { waitUntil: 'commit', timeout: 120000 });
  const ready = () => page.locator('#add-session:enabled').waitFor({ timeout: 120000 });
  await ready();
  let seq = 0;
  async function guest(command, timeout = 100000) {
    const id = 'WORKSPACE_TOOL_' + ++seq;
    await page.locator('.xterm-helper-textarea').first().focus();
    await page.keyboard.insertText('( ' + command + " ); rc=$?; printf '\\n%s=%s\\n' " + id + ' "$rc"');
    await page.keyboard.press('Enter');
    const rows = page.locator('.xterm-rows').first();
    try {
      const line = rows.getByText(new RegExp('^' + id + '=\\d+$'));
      await line.waitFor({ timeout });
      assert.equal((await line.textContent()).trim(), id + '=0');
    } catch (error) { console.error(await rows.innerText()); throw error; }
  }
  async function workspace(action) {
    await page.locator('#workspace-settings').click();
    await page.locator('#' + action).click();
  }
  async function getDownload(selector, name) {
    const download = page.waitForEvent('download');
    await page.locator(selector).click();
    const result = await download;
    assert.equal(result.suggestedFilename(), name);
    const file = join(temp, name);
    await result.saveAs(file);
    return file;
  }
  function writeGuestFile(name, contents) {
    const bytes = Buffer.from(contents).toString('base64');
    return 'printf %s ' + bytes + ' | base64 -d > ' + name;
  }

  await guest('network off && mkdir -p "/workspace/dev space/web/empty" && ' +
    "printf '%s\\n' verified > '/workspace/dev space/data [1].txt' && " +
    "printf '%s\\n' hidden > '/workspace/dev space/.hidden' && ln -s /etc/passwd '/workspace/dev space/escape' && " +
    "mkfifo '/workspace/dev space/special'");
  await workspace('open-workspace-files');
  const files = page.locator('#workspace-files-dialog');
  await files.getByRole('button', { name: 'Open dev space', exact: true }).click();
  await files.getByText('/workspace/dev space', { exact: true }).waitFor();
  await files.getByText('escape', { exact: true }).waitFor();
  assert.equal(await files.getByRole('button', { name: 'Download escape', exact: true }).count(), 0);
  assert.equal(await files.getByRole('button', { name: 'Download special', exact: true }).count(), 0);
  const direct = await getDownload('button[aria-label="Download data [1].txt"]', 'data [1].txt');
  assert.equal(await readFile(direct, 'utf8'), 'verified\n');
  const zip = await getDownload('#workspace-files-zip', 'dev space.zip');
  const listed = (await run('unzip', ['-Z1', zip])).stdout.trim().split('\n').sort();
  assert.deepEqual(listed, ['.hidden', 'data [1].txt', 'web/', 'web/empty/']);
  assert.equal((await run('unzip', ['-p', zip, '.hidden'])).stdout, 'hidden\n');
  await files.getByRole('button', { name: 'Up', exact: true }).click();
  await files.getByText('/workspace', { exact: true }).waitFor();
  await files.getByRole('button', { name: 'Close', exact: true }).click();
  console.log('PASS file navigation, direct download, ZIP contents, links and special files');

  const root = '/workspace/dev\\ space/web/';
  const pixel = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="green"/></svg>';
  const server = `from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/redirect", "/escape"):
            self.send_response(302)
            self.send_header("Location", "/second.html" if self.path == "/redirect" else "https://example.test/escape")
            self.end_headers()
        else:
            super().do_GET()
ThreadingHTTPServer(("127.0.0.1", 8123), Handler).serve_forever()
`;
  const requests = [];
  page.on('request', request => {
    if (request.url().startsWith('https://example.test')) requests.push(request.url());
  });
  await guest([
    writeGuestFile(root + 'index.html', '<link rel="stylesheet" href="style.css"><h1>Preview first</h1>' +
      '<img src="pixel.svg" alt="pixel"><a href="/second.html">Next</a><a href="https://example.test/link">External</a>' +
      '<img src="https://example.test/image"><script>document.body.textContent="unsafe executed"</script>' +
      '<meta http-equiv="refresh" content="0;url=https://example.test/refresh">' +
      '<iframe src="https://example.test/frame"></iframe><form action="https://example.test/form"></form>'),
    writeGuestFile(root + 'style.css', 'h1 { color: rgb(1, 2, 3); background-image: url(pixel.svg); }'),
    writeGuestFile(root + 'second.html', '<h1>Preview second</h1>'),
    writeGuestFile(root + 'status.json', '{"result":"guest only"}'),
    writeGuestFile(root + 'pixel.svg', pixel),
    writeGuestFile('/tmp/pointblank-preview-test.py', server),
    '(cd ' + root + ' && nohup python3 /tmp/pointblank-preview-test.py >/tmp/pointblank-preview-test.log 2>&1 </dev/null &)',
  ].join(' && '));

  await workspace('open-workspace-preview');
  const dialog = page.locator('#workspace-preview-dialog');
  const preview = page.frameLocator('#workspace-preview-frame');
  const result = page.locator('#workspace-preview-status');
  async function open(path, port = '8123') {
    await dialog.getByLabel('Port', { exact: true }).fill(port);
    await dialog.getByLabel('Path', { exact: true }).fill(path);
    await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  }
  await open('/');
  await preview.getByRole('heading', { name: 'Preview first' }).waitFor({ timeout: 30000 });
  assert.equal(await preview.getByRole('heading', { name: 'Preview first' }).evaluate(node => getComputedStyle(node).color), 'rgb(1, 2, 3)');
  await preview.locator('img[alt=pixel]').evaluate(image => image.decode());
  assert.equal(await preview.locator('img[alt=pixel]').evaluate(image => image.naturalWidth), 8);
  assert.equal(await preview.locator('script, form, iframe, meta[http-equiv=refresh]').count(), 0);
  assert.equal(await preview.getByText('External', { exact: true }).getAttribute('href'), null);
  await preview.getByRole('link', { name: 'Next' }).click();
  await preview.getByRole('heading', { name: 'Preview second' }).waitFor();
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  await preview.getByRole('heading', { name: 'Preview first' }).waitFor();
  await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
  await result.getByText(/HTTP 200/).waitFor();
  await open('/redirect');
  await preview.getByRole('heading', { name: 'Preview second' }).waitFor();
  await open('/status.json');
  await preview.getByText('{"result":"guest only"}', { exact: true }).waitFor();
  await open('/missing');
  await result.getByText(/HTTP 404/).waitFor();
  await open('/escape');
  await result.getByText(/leaves the selected guest origin/).waitFor();
  await open('/', '18791');
  await result.getByText(/other than the workspace gateway/).waitFor();
  assert.deepEqual(requests, []);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  console.log('PASS offline guest preview, styles, images, links, redirects, and active-content isolation');

  if (packs) {
    await guest("rm '/workspace/dev space/special'");
    if (packs === 'fixture') {
      await page.locator('#network-settings').click();
      await page.locator('#configure-network').click();
      await page.locator('[name=key]').fill('workstation-fixture-key-with-32-characters');
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
    } else await guest('network on');
    await page.getByRole('button', { name: 'NETWORK: ONLINE', exact: true }).waitFor();
    await workspace('open-workspace-packs');
    const packDialog = page.locator('#workspace-packs-dialog');
    async function install(id, name) {
      const control = packDialog.locator('#workspace-pack-' + id);
      await control.click();
      if (id === 'native') {
        const growth = page.locator('#growth-dialog');
        await Promise.race([growth.waitFor({ timeout: 120000 }), packDialog.getByText(/Native build installed/).waitFor({ timeout: 120000 })]);
        if (await growth.isVisible()) await growth.getByRole('button', { name: 'Allow growth' }).click();
      }
      try { await control.getByText('Installed', { exact: true }).waitFor({ timeout: 420000 }); }
      catch (error) { console.error(await page.locator('#workspace-packs-log').textContent()); throw error; }
      console.log('PASS installed ' + name);
    }
    await install('shell', 'Shell tools');
    await install('native', 'Native build');
    await packDialog.getByRole('button', { name: 'Close', exact: true }).click();
    const verify = 'fzf --version && shellcheck --version && gcc --version && g++ --version && pkgconf --version && ' +
      "printf '%s\\n' '#include <stdio.h>' 'int main(void) { puts(\"compiled\"); }' > /workspace/tool.c && " +
      'gcc /workspace/tool.c -o /workspace/tool && test "$(/workspace/tool)" = compiled';
    await guest(verify);
    console.log('PASS pack binaries work and GCC compiled and ran a program');
    await workspace('save-state');
    await page.waitForFunction(() => {
      const status = document.getElementById('save-status').textContent;
      return status.startsWith('Saved ') || (!status.includes('Saving') && !document.getElementById('save-state').disabled);
    }, null, { timeout: 240000 });
    assert.match(await page.locator('#save-status').textContent(), /^Saved /);
    console.log('PASS workspace saved with both packs');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    await ready();
    await guest(verify);
    await workspace('open-workspace-packs');
    for (const id of ['shell', 'native']) {
      await page.locator('#workspace-pack-' + id).getByText('Installed', { exact: true }).waitFor();
    }
    console.log('PASS both packs and their installed-state labels survive save and reload');
  }
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.WORKSTATION_TEST_ORIGIN || 'http://127.0.0.1:18733';
const launch = { executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'],
  viewport: { width: 1500, height: 950 }, acceptDownloads: true };
const temp = await mkdtemp(join(tmpdir(), 'pointblank-browser-'));
const out = join(temp, 'workspace.pblinux');
const profile = join(temp, 'profile');
const cleanProfile = join(temp, 'clean');
const fallbackProfile = join(temp, 'fallback');
let context;

async function boot(context) {
  const page = context.pages()[0] || await context.newPage();
  page.on('pageerror', (error) => console.error(error));
  await page.goto(origin);
  await ready(page);
  return page;
}

async function ready(page) {
  try { await page.locator('#add-session:enabled').waitFor({ timeout: 120000 }); }
  catch (error) {
    console.error('Boot', await page.locator('#boot, #save-status').allTextContents());
    throw error;
  }
}

let commandNumber = 0;
async function guest(page, command, timeout = 90000) {
  commandNumber += 1;
  const id = commandNumber;
  await page.locator('.xterm-screen').click();
  await page.keyboard.insertText('( ' + command + " ); rc=$?; printf '\\nPOINTBLANK_%s=%s\\n' " + id + ' "$rc"');
  await page.keyboard.press('Enter');
  const rows = page.locator('.xterm-rows');
  try {
    const result = rows.getByText(new RegExp('^POINTBLANK_' + id + '=[0-9]+\\s*$'));
    await result.waitFor({ timeout });
    assert.equal((await result.textContent()).trim(), 'POINTBLANK_' + id + '=0');
  } catch (error) { console.error(await rows.innerText()); throw error; }
}

async function connect(page, withGit = true) {
  if ((await page.locator('#network-label').textContent()) === 'NETWORK: ONLINE') {
    await page.locator('#network-settings').click();
    await page.locator('#configure-network').click();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  }
  await page.locator('#network-settings').click();
  await page.locator('#configure-network').click();
  await page.locator('[name=key]').fill('workstation-fixture-key-with-32-characters');
  if (withGit) {
    await page.locator('[name=repository]').fill('pointblank-fixture/upstream');
    await page.locator('[name=username]').fill('fixture');
    await page.locator('[name=git-token]').fill('github_pat_fixtureOnly000000000000000000000000000000');
  }
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: 'NETWORK: ONLINE', exact: true }).waitFor({ timeout: 20000 });
}

async function setAutosave(page, value) {
  await page.locator('#workspace-settings').click();
  await page.locator('#workspace-storage').click();
  await page.locator('#autosave').selectOption(value);
  await page.locator('#storage-dialog').getByRole('button', { name: 'Close', exact: true }).click();
}

async function status(page, pattern) {
  try {
    await page.waitForFunction(({ source, flags }) => new RegExp(source, flags).test(document.getElementById('save-status').textContent),
      { source: pattern.source, flags: pattern.flags }, { timeout: 60000 });
  } catch (error) {
    console.error('Save status:', await page.locator('#save-status').innerText());
    throw error;
  }
}

async function save(page) {
  await page.locator('#workspace-settings').click();
  await page.locator('#save-state').click();
  await status(page, /^Saved /);
}

async function replaceWorkspace(page, button) {
  page.once('dialog', (dialog) => dialog.accept());
  const loaded = page.waitForEvent('load', { timeout: 120000 });
  await button.click();
  await loaded;
  await ready(page);
}

async function upload(page, path) {
  await page.locator('#snapshot-file').setInputFiles(path);
}

async function fixture(path, method = 'GET') {
  const response = await fetch(origin + '/test/' + path, { method });
  assert(response.ok, 'fixture ' + path + ' returned ' + response.status);
  return response;
}

async function verifyWorkspace(page) {
  assert.equal(await page.locator('#network-label').textContent(), 'NETWORK: OFFLINE');
  await guest(page, 'test "$(stat -c %a /tmp)" = 1777 && file=$(mktemp) && test -f "$file" && rm "$file"');
  await guest(page, "apk info -e curl git wget && test \"$(cat /root/kept.txt)\" = home && test \"$(cat /etc/pointblank-test)\" = config && test \"$(cat /workspace/repo/readme.txt)\" = 'updated outside the browser' && cd /workspace/repo && test \"$(git rev-list --count HEAD)\" = 3 && test \"$(git remote get-url origin)\" = https://github.com/pointblank-fixture/upstream.git");
}

try {
  context = await chromium.launchPersistentContext(profile, launch);
  let page = await boot(context);
  await setAutosave(page, '0');
  await connect(page);
  await guest(page, 'apk add --no-cache curl git wget', 150000);
  const hash = await (await fixture('script-hash')).text();
  await guest(page, "curl --fail --silent --show-error https://fixture.example/smoke.sh -o /workspace/test.sh && echo '" +
    hash + "  /workspace/test.sh' | sha256sum -c && test \"$(sh /workspace/test.sh)\" = POINTBLANK_SCRIPT_OK && " +
    "wget -q -O /workspace/wget.sh https://fixture.example/smoke.sh && cmp /workspace/test.sh /workspace/wget.sh && " +
    "curl -fsS http://fixture.example/smoke.sh -o /workspace/http.sh && cmp /workspace/http.sh /workspace/test.sh && " +
    "test \"$(curl -sS -o /dev/null -w '%{http_code}' https://fixture.example/denied)\" = 403 && " +
    "! curl --noproxy '*' --connect-timeout 4 -fsS https://fixture.example/smoke.sh");
  console.log('PASS native apk, curl, wget, HTTP, verified executable download, worker deny, direct sockets blocked');
  await guest(page, "git clone https://github.com/pointblank-fixture/upstream.git /workspace/repo && cd /workspace/repo && " +
    "git checkout -b browser-test && printf '%s\\n' 'browser commit' > readme.txt && git add readme.txt && " +
    "git -c user.name=Browser -c user.email=browser@example.test commit -m 'Browser change' && git push -u origin browser-test");
  const remote = await (await fixture('commit')).json();
  assert.match(remote.commit, /^[a-f0-9]{40}$/);
  assert.equal(remote.content, 'browser commit');
  const updated = await (await fixture('update', 'POST')).text();
  await guest(page, 'cd /workspace/repo && git fetch origin && git pull --ff-only && test "$(git rev-parse HEAD)" = ' +
    updated + ' && test "$(cat readme.txt)" = "updated outside the browser"');
  await connect(page, false);
  await guest(page, 'cd /workspace/repo && ! git push origin HEAD:refs/heads/unauthenticated');
  await connect(page);
  console.log('PASS native Git clone, checkout, commit, authenticated push, remote verification, external edit, fetch and pull');
  if (process.env.EXTRA_PACKAGE_TESTS) {
    await guest(page, 'pip download --no-deps --no-cache-dir packaging==25.0 -d /workspace/wheels && ls /workspace/wheels/packaging-25.0-py3-none-any.whl', 90000);
    await guest(page, 'apk add --no-cache nodejs npm && npm install --ignore-scripts --no-audit --no-fund --prefix /workspace/npm-test is-number@7.0.0 && node -e "process.exit(require(\'/workspace/npm-test/node_modules/is-number\')(5) ? 0 : 1)"', 180000);
    console.log('PASS pip download and npm install in Alpine');
  }
  await guest(page, "echo home > /root/kept.txt && echo config > /etc/pointblank-test && mkdir -p /root/.config/gh && " +
    "echo fixture-secret > /root/.git-credentials && echo fixture-session > /root/.config/gh/hosts.yml && echo fixture-netrc > /root/.netrc");
  await save(page);
  await page.reload();
  await ready(page);
  await verifyWorkspace(page);
  assert.match(await page.locator('#storage-usage').innerText(), /OPFS/);
  const second = await context.newPage();
  await second.goto(origin);
  await second.locator('#boot').getByText(/open in another tab/).waitFor({ timeout: 20000 });
  await second.close();
  await context.close();
  context = await chromium.launchPersistentContext(profile, launch);
  page = await boot(context);
  await verifyWorkspace(page);
  console.log('PASS persistent package, Git history, home, system file, refresh, browser restart, and tab lock');

  await page.locator('#workspace-settings').click();
  await page.locator('#snapshots').click();
  await page.locator('#snapshot-name').fill('Test recovery');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('#snapshot-list').getByText(/Test recovery/).waitFor({ timeout: 120000 });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const download = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#workspace-settings').click();
  await page.locator('#export-state').click();
  await (await download).saveAs(out);
  await status(page, /Workspace exported/);
  const exported = await readFile(out);
  const corrupt = Buffer.from(exported);
  corrupt[corrupt.length - 5] ^= 1;
  const corruptPath = join(temp, 'corrupt.pblinux');
  await writeFile(corruptPath, corrupt);
  await upload(page, corruptPath);
  await status(page, /integrity check failed/);
  await context.close();

  context = await chromium.launchPersistentContext(cleanProfile, launch);
  page = await boot(context);
  await setAutosave(page, '0');
  page.once('dialog', (dialog) => dialog.accept());
  const reloaded = page.waitForEvent('load', { timeout: 120000 });
  await upload(page, out);
  await reloaded;
  await ready(page);
  await verifyWorkspace(page);
  await guest(page, "test ! -e /root/.git-credentials && test ! -e /root/.config/gh && test ! -e /root/.netrc && ! curl -fsS https://fixture.example/smoke.sh");
  await fixture('deploy', 'POST');
  await page.reload();
  await ready(page);
  assert.match(await page.title(), /Pointblank Linux [2-9]/);
  await verifyWorkspace(page);
  console.log('PASS named snapshot, export, corrupt rejection, clean-profile import, credential exclusions, network off, simulated subsequent deploy');

  await guest(page, 'echo interrupted > /workspace/interrupted');
  await page.evaluate(() => {
    window.addEventListener('unhandledrejection', (event) => event.preventDefault());
    const original = FileSystemWritableFileStream.prototype.write;
    FileSystemWritableFileStream.prototype.write = async function (...args) {
      await original.apply(this, args);
      document.body.dataset.writePaused = 'yes';
      await new Promise(() => {});
    };
  });
  await page.locator('#workspace-settings').click();
  await page.locator('#save-state').click();
  await page.locator('body[data-write-paused=yes]').waitFor({ timeout: 120000 });
  await context.close();
  context = await chromium.launchPersistentContext(cleanProfile, launch);
  page = await boot(context);
  await guest(page, 'test ! -e /workspace/interrupted && test -f /workspace/repo/readme.txt');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1024 });
  await guest(page, 'echo quota > /workspace/quota');
  await page.locator('#workspace-settings').click();
  await page.locator('#save-state').click();
  await status(page, /Storage full/);
  await cdp.send('Storage.overrideQuotaForOrigin', { origin });
  await page.reload();
  await ready(page);
  await guest(page, 'test ! -e /workspace/quota && test -f /workspace/repo/readme.txt');
  console.log('PASS interrupted OPFS write and real Chromium quota exhaustion preserve the previous save');

  await context.close();
  context = await chromium.launchPersistentContext(fallbackProfile, launch);
  await context.addInitScript(() => Object.defineProperty(StorageManager.prototype, 'getDirectory', { value: undefined }));
  page = await boot(context);
  assert.match(await page.locator('#storage-usage').innerText(), /IndexedDB/);
  await setAutosave(page, '30');
  await guest(page, 'echo fallback > /workspace/idb');
  await status(page, /^Saved /);
  await page.reload();
  await ready(page);
  await guest(page, 'test "$(cat /workspace/idb)" = fallback');
  await setAutosave(page, '0');
  await page.locator('#workspace-settings').click();
  await page.locator('#snapshots').click();
  await page.locator('#snapshot-name').fill('Before reset');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('#snapshot-list').getByText(/Before reset/).waitFor({ timeout: 120000 });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await guest(page, 'echo new > /workspace/idb');
  await page.locator('#workspace-settings').click();
  await page.locator('#snapshots').click();
  await replaceWorkspace(page, page.getByRole('button', { name: 'Restore', exact: true }));
  await guest(page, 'test "$(cat /workspace/idb)" = fallback');
  await page.locator('#workspace-settings').click();
  await replaceWorkspace(page, page.locator('#reset-state'));
  await guest(page, 'test ! -e /workspace/idb');
  await page.locator('#workspace-settings').click();
  await page.locator('#snapshots').click();
  await page.locator('#snapshot-list').getByText(/Before reset/).waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByText('No named snapshots', { exact: true }).waitFor();
  console.log('PASS IndexedDB fallback, autosave, named restore, confirmed reset, and delete');
} finally {
  await context?.close();
  await rm(temp, { recursive: true, force: true });
}

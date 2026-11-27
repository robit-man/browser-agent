import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const publicNetwork = process.env.WORKSTATION_PUBLIC_NETWORK === '1';
const origin = process.env.WORKSTATION_TEST_ORIGIN || pathToFileURL(process.cwd() + '/index.html').href;
const browser = await chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.CHROMIUM_PATH });

try {
  const context = await browser.newContext({
    offline: origin.startsWith('file:'),
    viewport: { width: 1500, height: 925 },
  });
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 120000 });
  const ready = () => page.locator('#add-session:enabled').waitFor({ timeout: 90000 });
  await ready();
  const rows = page.locator('.xterm-rows');
  async function enter(command) {
    await page.locator('.xterm-screen').click();
    await page.keyboard.insertText(command);
    await page.keyboard.press('Enter');
  }
  let seq = 0;
  async function guest(command) {
    const number = ++seq;
    await enter('( ' + command + " ); rc=$?; printf '\\nDEVTOOLS_STATUS_%s=%s\\n' " + number + ' "$rc"');
    const result = rows.getByText(new RegExp('^DEVTOOLS_STATUS_' + number + '=\\d+$'));
    try {
      await result.waitFor({ timeout: 120000 });
      assert.equal(await result.innerText(), 'DEVTOOLS_STATUS_' + number + '=0');
    } catch (error) {
      console.error(await rows.innerText());
      throw error;
    }
    return rows.innerText();
  }

  const versions = await guest('apk info -e git git-init-template nodejs npm apt dpkg && ' +
    'git --version && node --version && npm --version && apk --version && apt --version');
  for (const line of versions.split('\n').map((value) => value.trim())) {
    if (/^(git version |v\d+\.\d+\.\d+$|\d+\.\d+\.\d+$|apk-tools |apt \d)/.test(line)) console.log(line);
  }
  await guest('mkdir /workspace/preloaded && cd /workspace/preloaded && git init -b main && npm init -y && ' +
    'npm pkg set scripts.test="node --check index.js" && printf "%s\\n" "console.log(42)" > index.js && npm test && ' +
    'git add index.js package.json && git -c user.name=Smoke -c user.email=smoke@example.test commit -m "Initial project"');
  console.log('PASS fresh Alpine starts with native Git, Node, npm, APK, and APT');

  await guest('apk info -e curl jq ripgrep nano make patch file zip btop && cd /workspace/preloaded && ' +
    "printf '%s\\n' '{\"ready\":true}' > tools.json && " +
    "curl -fsS file:///workspace/preloaded/tools.json | jq -e '.ready' >/dev/null && " +
    "printf '%s\\n' before > tools.txt && printf '%s\\n' '--- tools.txt' '+++ tools.txt' " +
    "'@@ -1 +1 @@' '-before' '+after' | patch --silent && " +
    "printf 'check:\\n\\t@rg -Fx after tools.txt\\n' | make -s -f - && " +
    "nano --version | grep -q 'GNU nano' && file -b tools.txt | grep -q 'ASCII text' && " +
    "zip -q tools.zip tools.txt && test \"$(unzip -p tools.zip tools.txt)\" = after && " +
    'btop --version && cloudflared --version');
  await guest('cd /workspace/preloaded && ' +
    "printf '%s\\n' ingress: '  - service: http_status:404' > tunnel-test.yml && " +
    'cloudflared tunnel --config tunnel-test.yml ingress validate');
  console.log('PASS all ten bundled tools run, including cloudflared ingress validation');

  await enter('btop');
  await rows.getByText(/Pid:.*Program:/i).first().waitFor();
  await page.keyboard.press('q');
  await rows.getByText('/workspace #', { exact: true }).last().waitFor();
  await enter('nano /workspace/preloaded/editor.txt');
  await rows.getByText(/GNU nano/).first().waitFor();
  await page.keyboard.insertText('NANO_SMOKE_OK');
  await page.keyboard.press('Control+o');
  await rows.getByText(/Write to File:/i).first().waitFor();
  await page.keyboard.press('Enter');
  await rows.getByText(/Wrote 1 line/).first().waitFor();
  await page.keyboard.press('Control+x');
  await rows.getByText('/workspace #', { exact: true }).last().waitFor();
  await guest('grep -qx NANO_SMOKE_OK /workspace/preloaded/editor.txt');
  console.log('PASS btop renders the process list and nano writes a file with Ctrl+O');

  await guest("grep -q '^_apt:' /etc/passwd && cd /workspace && " +
    'mkdir -p apt-smoke/DEBIAN apt-smoke/usr/share/pointblank-apt-smoke && ' +
    "printf '%s\\n' 'Package: pointblank-apt-smoke' 'Version: 1.0' 'Architecture: all' " +
    "'Maintainer: Pointblank <smoke@example.test>' 'Description: Local package smoke test' > apt-smoke/DEBIAN/control && " +
    "printf '%s\\n' APT_SMOKE_OK > apt-smoke/usr/share/pointblank-apt-smoke/status && " +
    'dpkg-deb --root-owner-group -Zgzip --build apt-smoke apt-smoke.deb && ' +
    'apt install -y ./apt-smoke.deb && dpkg-query -W pointblank-apt-smoke && ' +
    'grep -qx APT_SMOKE_OK /usr/share/pointblank-apt-smoke/status');
  console.log('PASS APT installed a local .deb and dpkg registered it');

  if (publicNetwork) {
    await page.getByRole('button', { name: 'NETWORK: ONLINE', exact: true }).waitFor({ timeout: 30000 });
    await guest("curl -fsS https://registry.npmjs.org/is-number/latest | jq -e '.name == \"is-number\"' >/dev/null && " +
      'apk add --no-cache bc && apk info -e bc && ' +
      'git clone https://github.com/robit-man/POINTBLANK.git /workspace/upstream && test -f /workspace/upstream/.git/HEAD && ' +
      'cd /workspace/preloaded && npm install is-number@7.0.0 && ' +
      'node -e "process.exit(require(\'is-number\')(42) ? 0 : 1)"');
    console.log('PASS native HTTPS curl, APK install, Git clone, and npm install and import on production');
  }

  await guest("printf '%s\\n' 'machine example.test login fixture password fixture' > /etc/apt/auth.conf.d/smoke.conf && " +
    "mkdir -p /root/.cloudflared && printf '%s\\n' fixture > /root/.cloudflared/test.json");
  await page.locator('#workspace-settings').click();
  await page.locator('#save-state').click();
  await page.waitForFunction(() => {
    const status = document.getElementById('save-status').textContent;
    return status.startsWith('Saved ') || (!status.includes('Saving') && !document.getElementById('save-state').disabled);
  }, null, { timeout: 120000 });
  assert.match(await page.locator('#save-status').textContent(), /^Saved /);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await ready();
  await guest('cd /workspace/preloaded && test "$(git log -1 --format=%s)" = "Initial project" && npm test && ' +
    'test "$(unzip -p tools.zip tools.txt)" = after && btop --version && cloudflared --version && ' +
    'dpkg-query -W pointblank-apt-smoke && grep -qx APT_SMOKE_OK /usr/share/pointblank-apt-smoke/status && ' +
    'test ! -e /etc/apt/auth.conf.d/smoke.conf && test ! -e /root/.cloudflared/test.json');
  console.log('PASS project and installed .deb survive reload without APT or cloudflared credentials');
} finally {
  await browser.close();
}

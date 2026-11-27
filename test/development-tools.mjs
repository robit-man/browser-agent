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
  await page.goto(origin, { timeout: 90000 });
  const ready = () => page.locator('#add-session:enabled').waitFor({ timeout: 90000 });
  await ready();
  let seq = 0;
  async function guest(command) {
    const number = ++seq;
    await page.locator('.xterm-screen').click();
    await page.keyboard.insertText('( ' + command + " ); rc=$?; printf '\\nDEVTOOLS_STATUS_%s=%s\\n' " + number + ' "$rc"');
    await page.keyboard.press('Enter');
    const rows = page.locator('.xterm-rows');
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
    await guest('apk add --no-cache jq && jq --version && ' +
      'git clone https://github.com/robit-man/POINTBLANK.git /workspace/upstream && test -f /workspace/upstream/.git/HEAD && ' +
      'cd /workspace/preloaded && npm install is-number@7.0.0 && ' +
      'node -e "process.exit(require(\'is-number\')(42) ? 0 : 1)"');
    console.log('PASS native APK install, public HTTPS Git clone, and npm install and import on production');
  }

  await guest("printf '%s\\n' 'machine example.test login fixture password fixture' > /etc/apt/auth.conf.d/smoke.conf");
  await page.locator('#workspace-settings').click();
  await page.locator('#save-state').click();
  await page.waitForFunction(() => {
    const status = document.getElementById('save-status').textContent;
    return status.startsWith('Saved ') || (!status.includes('Saving') && !document.getElementById('save-state').disabled);
  }, null, { timeout: 120000 });
  assert.match(await page.locator('#save-status').textContent(), /^Saved /);
  await page.reload({ timeout: 90000 });
  await ready();
  await guest('cd /workspace/preloaded && test "$(git log -1 --format=%s)" = "Initial project" && npm test && ' +
    'dpkg-query -W pointblank-apt-smoke && grep -qx APT_SMOKE_OK /usr/share/pointblank-apt-smoke/status && ' +
    'test ! -e /etc/apt/auth.conf.d/smoke.conf');
  console.log('PASS Git project and installed .deb survive reload and APT credentials are excluded');
} finally {
  await browser.close();
}

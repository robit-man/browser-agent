import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const site = process.env.WORKSTATION_URL;
const key = process.env.WORKSTATION_EGRESS_KEY || await readFile(process.env.WORKSTATION_KEY_FILE, 'utf8');
const baseline = process.env.WORKSTATION_BASELINE;
const token = process.env.TEST_GIT_TOKEN;
const repo = process.env.TEST_GIT_REPOSITORY || 'robit-man/pointblank-workstation-smoke';
const fixture = site + '/network-fixtures';
const bin = Buffer.alloc(1048576);
for (let i = 0; i < bin.length; i++) bin[i] = i % 251;
const checksum = createHash('sha256').update(bin).digest('hex');
const scriptChecksum = createHash('sha256').update('#!/bin/sh\nprintf "%s\\n" "POINTBLANK_SCRIPT_OK"\n').digest('hex');
const browser = await chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.CHROMIUM_PATH });
const viewport = { width: 1500, height: 950 };

async function load(url, upgraded) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const start = performance.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await (upgraded ? page.locator('#network-settings:enabled').waitFor({timeout: 90000}) :
    page.locator('#boot').waitFor({state:'detached',timeout:90000}));
  const session = await context.newCDPSession(page);
  const mem = await session.send('Runtime.getHeapUsage');
  console.log(JSON.stringify({ site: url, readyMs: Math.round(performance.now() - start),
    jsMiB: Math.round(mem.usedSize / 1048576), backingMiB: Math.round(mem.backingStorageSize / 1048576) }));
  return { page, context };
}

let seq = 0;
async function guest(page, command, timeout = 120000) {
  const number = ++seq;
  await page.locator('.xterm-screen').click();
  await page.keyboard.insertText('( ' + command + " ); rc=$?; printf '\\nPBL_STAGE_%s=%s\\n' " + number + ' "$rc"');
  await page.keyboard.press('Enter');
  const result = page.locator('.xterm-rows').getByText(new RegExp('^PBL_STAGE_' + number + '=\\d+$'));
  try {
    await result.waitFor({ timeout });
    assert.equal(await result.innerText(), 'PBL_STAGE_' + number + '=0');
  } catch (error) {
    console.error(await page.locator('.xterm-rows').innerText());
    throw error;
  }
  return await page.locator('.xterm-rows').innerText();
}

async function github(path, method = 'GET', body) {
  const response = await fetch('https://api.github.com/repos/' + repo + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok) throw Error('Independent GitHub API status ' + response.status + ' for ' + path);
  return response.json();
}

try {
  if (baseline) {
    const { page, context } = await load(baseline, false);
    const start = performance.now();
    await guest(page, 'echo baseline > /tmp/pointblank-smoke && test "$(cat /tmp/pointblank-smoke)" = baseline', 30000);
    console.log('Baseline terminal round trip ms', Math.round(performance.now() - start));
    await context.close();
  }
  const { page } = await load(site, true);
  const start = performance.now();
  await guest(page, 'echo stage > /workspace/stage-smoke && test "$(cat /workspace/stage-smoke)" = stage && python3 --version');
  console.log('Upgraded terminal round trip ms', Math.round(performance.now() - start));
  await page.locator('#network-settings').click();
  await page.locator('[name=key]').fill(key.trim());
  if (token) {
    await page.locator('[name=repository]').fill(repo);
    await page.locator('[name=username]').fill('x-access-token');
    await page.locator('[name=git-token]').fill(token);
  }
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  try { await page.getByRole('button', { name: 'NETWORK: ONLINE', exact: true }).waitFor({timeout:20000}); }
  catch (error) { console.error(await page.locator('#network-message').innerText()); throw error; }
  await guest(page, 'network status && network services && network test');
  await guest(page, 'apk add --no-cache curl git wget');
  const results = await guest(page, 'curl -fsS -w "FIRST %{time_total}\\n" ' + fixture + '/json && ' +
    'curl -fsS -w "REPEAT %{time_total}\\n" ' + fixture + '/json && ' +
    'curl -fsS -w "BINARY %{speed_download} bytes/sec\\n" ' + fixture + '/binary -o /workspace/test.bin && ' +
    "echo '" + checksum + "  /workspace/test.bin' | sha256sum -c");
  for (const row of results.split('\n')) if (/^(FIRST|REPEAT|BINARY) \d/.test(row)) console.log(row);
  await guest(page, 'wget -q -O /workspace/smoke.sh ' + fixture + '/smoke.sh && ' +
    "echo '" + scriptChecksum + "  /workspace/smoke.sh' | sha256sum -c && " +
    'test "$(sh /workspace/smoke.sh)" = POINTBLANK_SCRIPT_OK && ' +
    'test "$(curl -sS -X POST -d fixture -o /workspace/post.json -w \'%{http_code}\' ' + fixture + '/post)" = 201 && ' +
    'grep -q received /workspace/post.json && ' +
    'test "$(curl -sS -o /dev/null -w \'%{http_code}\' ' + fixture + '/missing)" = 404 && ' +
    'test "$(curl -sS -o /dev/null -w \'%{http_code}\' ' + fixture + '/redirect)" = 403 && ' +
    'test "$(curl -sS -o /dev/null -w \'%{http_code}\' ' + fixture + '/slow)" = 504 && ' +
    '! curl -fsS --max-time 1 ' + fixture + '/slow && ! curl -fsS https://169.254.169.254/');
  console.log('PASS deployed native curl, wget, apk, checksum, script execution, POST, 404, redirect denial, timeout and cancellation');
  await guest(page, 'git clone https://github.com/robit-man/POINTBLANK.git /workspace/public');
  console.log('PASS deployed native GitHub clone');
  if (token) {
    const branch = 'native-' + Date.now();
    await guest(page, 'git clone https://github.com/' + repo + '.git /workspace/controlled && cd /workspace/controlled && ' +
      'git checkout -b ' + branch + ' && echo from-linux > smoke.txt && git add smoke.txt && ' +
      'git -c user.name=Workstation -c user.email=workstation@example.test commit -m "Native Linux change" && ' +
      'git push -u origin ' + branch);
    const remote = await github('/contents/smoke.txt?ref=' + branch);
    assert.equal(Buffer.from(remote.content, 'base64').toString(), 'from-linux\n');
    const updated = await github('/contents/smoke.txt', 'PUT', {
      branch, sha: remote.sha, message: 'External acceptance test update',
      content: Buffer.from('updated-outside-linux\n').toString('base64'),
    });
    await guest(page, 'cd /workspace/controlled && git fetch origin && git pull --ff-only && ' +
      'test "$(git rev-parse HEAD)" = ' + updated.commit.sha +
      ' && test "$(cat smoke.txt)" = updated-outside-linux');
    console.log('PASS authenticated native GitHub commit, push, independent remote verification, external update, fetch and pull');
  }
  await guest(page, 'network logs && { curl -fsS --max-time 15 ' + fixture +
    '/slow > /tmp/pointblank-cancel & request=$!; sleep 0.3; network off && ! wait "$request"; } && ! curl -fsS ' + fixture + '/json');
  console.log('PASS native diagnostic commands and session disable');
} finally {
  await browser.close();
}

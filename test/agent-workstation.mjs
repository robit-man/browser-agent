import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.WORKSTATION_TEST_ORIGIN || 'http://127.0.0.1:18733';
const inference = process.env.WORKSTATION_TEST_WEBGPU === '1';
const browser = await chromium.launch({
  args: ['--no-sandbox', ...(inference ? ['--enable-unsafe-webgpu', '--use-angle=vulkan'] : [])],
  executablePath: process.env.CHROMIUM_PATH,
});

async function boot(page) {
  const failures = [];
  const failed = request => { if (request.isNavigationRequest()) failures.push(request.failure()?.errorText); };
  page.on('requestfailed', failed);
  try {
    assert.equal((await page.goto(origin, { waitUntil: 'commit', timeout: 120000 })).status(), 200);
    await page.locator('#add-session:enabled').waitFor({ timeout: 120000 });
  } catch (error) {
    console.error('Boot status:', await page.locator('#boot').allTextContents(), 'Navigation failures:', failures);
    throw error;
  } finally {
    page.off('requestfailed', failed);
  }
}

let sequence = 0;
async function guest(page, command, timeout = 45000) {
  const id = 'AGENT_WORKSTATION_' + ++sequence;
  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.insertText(command + "; rc=$?; printf '\\n%s=%s\\n' " + id + ' "$rc"');
  await page.keyboard.press('Enter');
  const rows = page.locator('.xterm-rows').first();
  const status = rows.getByText(new RegExp('^' + id + '=\\d+$'));
  try {
    await status.waitFor({ timeout });
    assert.equal((await status.textContent()).trim(), id + '=0');
    return await rows.innerText();
  } catch (error) { console.error(await rows.innerText()); throw error; }
}

try {
  if (inference) {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
    const profile = process.env.WORKSTATION_TEST_MODEL || 'qwen3-06b';
    assert.match(profile, /^[a-z0-9-]+$/);
    await boot(page);
    const adapter = await page.evaluate(async () => (await navigator.gpu?.requestAdapter())?.info.architecture);
    assert.ok(adapter, 'WebGPU adapter is required');
    const start = Date.now();
    const result = await guest(page, 'agent model verify ' + profile, 550000);
    assert.match(result, /Inference backend: FP32 WebGPU/);
    assert.match(result, /GPU execution: MODEL TOKEN GENERATION CONFIRMED/);
    assert.match(result, /Generated inference tokens: [1-9]\d*/);
    console.log(result.split('\n').filter(line => /^Inference backend:|^GPU execution:|^Generated inference tokens:|^WGSL GPU peak tracked:|^GGUF architecture:/.test(line)).join('\n'));
    console.log('PASS real ' + profile + ' verification from Alpine on ' + adapter + ' (' + (Date.now() - start) + ' ms)');
  } else {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
    // Replace token generation alone. The bundled runner still sends the actual
    // tool definitions and dispatches every returned call into the real guest.
    await page.addInitScript(() => {
      let station;
      Object.defineProperty(globalThis, 'workstation', {
        configurable: true,
        get: () => station,
        set(value) {
          station = value;
          const register = station.registerAgentTools;
          station.registerAgentTools = agent => {
            register(agent);
            register(agent);
            globalThis.testToolResults = [];
            agent.engine.completion = async ({ messages, tools }) => {
              globalThis.testToolNames = tools.map(tool => tool.function.name);
              const result = messages.filter(message => message.role === 'tool').map(message => message.content);
              if (result.length) {
                globalThis.testToolResults = result;
                return { content: 'WORKSPACE_AGENT_COMPLETED' };
              }
              const call = (name, args) => ({ type: 'function', function: { name, arguments: JSON.stringify(args) } });
              const request = messages.findLast(message => message.role === 'user')?.content;
              if (request === 'Open my workspace folder') return { tool_calls: [
                call('workspace_files', { action: 'open', path: '/workspace/agent fixture' }),
              ] };
              if (request === 'Open my tool packs') return { tool_calls: [
                call('workspace_tool_packs', { action: 'open' }),
              ] };
              return { tool_calls: [
                call('workspace_files', { action: 'list', path: '/workspace/agent fixture' }),
                call('workspace_files', { action: 'list', path: '/workspace/../etc' }),
                call('workspace_preview', { port: 18791, path: '/' }),
                call('workspace_preview', { port: '8124', path: '/' }),
                call('workspace_tool_packs', { action: 'list' }),
              ] };
            };
            return agent;
          };
        },
      });
    });
    await boot(page);
    const toolList = await guest(page, "agent tools | grep -Eo 'workspace_(files|preview|tool_packs)' | sort -u");
    for (const name of ['workspace_files', 'workspace_preview', 'workspace_tool_packs']) {
      assert.match(toolList, new RegExp('^' + name + '$', 'm'));
    }
    const list = await guest(page, "agent models | grep -E '^([1-9]|[0-9][0-9])\\. ' | wc -l");
    assert.match(list, /^25$/m);
    const selection = await guest(page, 'agent model 7 && agent model use qwen3-06b && agent model');
    assert.match(selection, /^Agent profile: qwen9b$/m);
    assert.match(selection, /^Agent profile: qwen3-06b$/m);
    assert.match(selection, /^Generative model: Qwen3 0\.6B \(Q4_K_M\)$/m);
    console.log('PASS automatic terminal tool discovery, 25 model profiles, legacy numeric selection, and the new alias');

    await guest(page, "network off && mkdir -p '/workspace/agent fixture' && printf '<h1>Agent workspace preview</h1>' " +
      "> '/workspace/agent fixture/index.html' && (cd '/workspace/agent fixture' && " +
      'nohup python3 -m http.server 8124 --bind 127.0.0.1 >/tmp/agent-preview.log 2>&1 </dev/null &)');
    const turn = await guest(page, 'agent "Show my workspace tools"');
    assert.match(turn, /^WORKSPACE_AGENT_COMPLETED$/m);
    const { names, results } = await page.evaluate(() => ({ names: testToolNames, results: testToolResults }));
    for (const name of ['workspace_files', 'workspace_preview', 'workspace_tool_packs', 'shell', 'read_file']) {
      assert.equal(names.filter(entry => entry === name).length, 1);
    }
    assert.equal(JSON.parse(results[0]).entries[0].name, 'index.html');
    assert.match(results[1], /TOOL ERROR: Choose a direct path under \/workspace/);
    assert.match(results[2], /TOOL ERROR: Choose an HTTP port other than the workspace gateway/);
    assert.deepEqual(JSON.parse(results[3]), { status: 200, port: 8124, path: '/' });
    assert.deepEqual(JSON.parse(results[4]).packs.map(pack => pack.id), ['shell', 'native']);
    await page.frameLocator('#workspace-preview-frame').getByRole('heading', { name: 'Agent workspace preview' }).waitFor();
    await page.locator('#workspace-preview-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await guest(page, 'agent "Open my workspace folder"');
    const files = page.locator('#workspace-files-dialog');
    await files.getByRole('button', { name: 'Download index.html', exact: true }).waitFor();
    await files.getByRole('button', { name: 'Close', exact: true }).click();
    await guest(page, 'agent "Open my tool packs"');
    const packs = page.locator('#workspace-packs-dialog');
    await packs.getByRole('button', { name: 'Install Shell tools', exact: true }).waitFor();
    console.log('PASS actual Alpine tool results, sandboxed preview, Files and Tool Packs dialogs, and rejection of path and port escapes');
  }
} finally {
  await browser.close();
}

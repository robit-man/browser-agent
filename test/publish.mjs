import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = 'https://linux.pointblankllc.com';
const shareOrigin = 'https://pointblank-linux-publish.pointblank-connect.workers.dev';
const keyFile = process.env.WORKSTATION_PUBLISH_TEST_KEY_FILE;
assert.ok(keyFile, 'Set WORKSTATION_PUBLISH_TEST_KEY_FILE to an authorized workspace egress-key file');
const key = (await readFile(keyFile, 'utf8')).trim();
const browser = await chromium.launch({
  args: ['--no-sandbox', ...JSON.parse(process.env.WORKSTATION_TEST_CHROMIUM_ARGS || '[]')],
  executablePath: process.env.CHROMIUM_PATH,
});

const server = `
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import time
import threading
import urllib.request
import hashlib
import base64
class Inner(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'Nested Alpine backend')
class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def respond(self, code, data=b'', content_type='text/plain', extra=()):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)
    def do_GET(self):
        if self.path == '/':
            return self.respond(200, b'<h1>Published from Alpine</h1><script src="/app.js"></script>', 'text/html')
        if self.path == '/app.js':
            return self.respond(200, b'document.body.dataset.loaded = "yes";', 'text/javascript')
        if self.path.startswith('/json'):
            data = json.dumps({'path': self.path, 'proto': self.headers.get('X-Forwarded-Proto'),
                               'cookie': self.headers.get('Cookie')}).encode()
            return self.respond(200, data, 'application/json')
        if self.path == '/redirect':
            return self.respond(302, extra=[('Location', 'http://127.0.0.1:8137/json?q=redirect')])
        if self.path == '/nested':
            with urllib.request.urlopen('http://127.0.0.1:8138/') as nested:
                return self.respond(nested.status, nested.read())
        if self.path == '/cookies':
            return self.respond(200, extra=[
                ('Set-Cookie', 'first=one; Path=/; Domain=pointblank-connect.workers.dev'),
                ('Set-Cookie', 'second=two; Path=/'),
                ('Set-Cookie', '__Host-pointblank-publication=app; Path=/; Secure')])
        if self.path == '/socket':
            secret = self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
            accept = base64.b64encode(hashlib.sha1(secret.encode()).digest()).decode()
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', accept)
            self.send_header('Sec-WebSocket-Protocol', 'demo')
            self.end_headers()
            self.close_connection = True
            for _ in range(2):
                frame = self.rfile.read(2)
                if len(frame) != 2: return
                length = frame[1] & 127
                mask = self.rfile.read(4)
                payload = bytes(value ^ mask[i % 4] for i, value in enumerate(self.rfile.read(length)))
                self.wfile.write(bytes([frame[0], length]) + payload)
                self.wfile.flush()
            self.rfile.read(2)
            return
        if self.path == '/stream':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', '22')
            self.end_headers()
            self.wfile.write(b'data: one\\n\\n')
            self.wfile.flush()
            time.sleep(0.6)
            self.wfile.write(b'data: two\\n\\n')
            return
        self.respond(404, b'guest missing')
    def do_HEAD(self):
        self.respond(200, b'head')
    def do_POST(self):
        data = self.rfile.read(int(self.headers['Content-Length']))
        return self.respond(201, data, 'application/octet-stream')
    do_PATCH = do_POST
inner = ThreadingHTTPServer(('127.0.0.1', 8138), Inner)
threading.Thread(target=inner.serve_forever, daemon=True).start()
ThreadingHTTPServer(('127.0.0.1', 8137), Handler).serve_forever()
`;

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(origin, { waitUntil: 'commit', timeout: 120000 });
  await page.locator('#add-session:enabled').waitFor({ timeout: 120000 });
  const rows = page.locator('.xterm-rows').first();
  let sequence = 0;
  async function guest(command, expectedCode = 0) {
    const stamp = 'PUBLISH_TEST_' + ++sequence;
    await page.locator('.xterm-helper-textarea').first().focus();
    await page.keyboard.insertText(command + "; rc=$?; printf '\\n%s=%s\\n' " + stamp + ' "$rc"');
    await page.keyboard.press('Enter');
    const line = rows.getByText(new RegExp('^' + stamp + '=\\d+$'));
    try {
      await line.waitFor({ timeout: 45000 });
      assert.equal((await line.textContent()).trim(), stamp + '=' + expectedCode);
      return await rows.innerText();
    } catch (error) { console.error((await rows.innerText()).split('\n').slice(-8).join('\n')); throw error; }
  }

  assert.match(await guest('publish 8137', 1), /Authorize before publishing/);
  await page.locator('#network-settings').click();
  await page.locator('#configure-network').click();
  await page.locator('[name=key]').fill(key);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#network-dialog').waitFor({ state: 'hidden', timeout: 30000 });
  assert.match(await guest('publish 18791', 1), /other than the workspace gateway port/);
  const source = Buffer.from(server).toString('base64');
  await guest('printf %s ' + source + ' | base64 -d > /tmp/publish-test.py && ' +
    '(nohup python3 /tmp/publish-test.py >/tmp/publish-test.log 2>&1 </dev/null &)');
  await guest("curl -fsS --noproxy '*' --retry 4 --retry-connrefused http://127.0.0.1:8137/json || " +
    '{ cat /tmp/publish-test.log >&2; exit 1; }');

  page.once('dialog', dialog => { assert.match(dialog.message(), /Publish guest port 8137/); void dialog.accept(); });
  const output = await guest('publish 8137');
  const publication = output.match(/https:\/\/pointblank-linux-publish\.pointblank-connect\.workers\.dev\/__pointblank_publish\/open\/[a-f0-9]{32}/)?.[0];
  assert.ok(publication, output);

  const viewer = await browser.newPage();
  assert.equal((await viewer.request.get(shareOrigin + '/')).status(), 403);
  assert.equal((await viewer.goto(publication, { timeout: 45000 })).status(), 200);
  await viewer.getByRole('heading', { name: 'Published from Alpine' }).waitFor();
  assert.equal(await viewer.locator('body').getAttribute('data-loaded'), 'yes');
  const data = await (await viewer.request.get(shareOrigin + '/json?q=abc')).json();
  assert.deepEqual(data, { path: '/json?q=abc', proto: 'https', cookie: null });
  assert.equal(await (await viewer.request.get(shareOrigin + '/nested')).text(), 'Nested Alpine backend');
  assert.equal((await viewer.request.get(shareOrigin + '/app.js', {
    headers: { 'Service-Worker': 'script' },
  })).status(), 403);
  const { status: cookieStatus, cookie } = await viewer.evaluate(async () => {
    const response = await fetch('/cookies');
    await response.text();
    const result = await (await fetch('/json')).json();
    return { status: response.status, cookie: result.cookie };
  });
  assert.equal(cookieStatus, 200);
  assert.deepEqual(cookie?.split('; ').sort(), ['first=one', 'second=two'],
    'Separate app cookies should be forwarded without exposing the publication cookie');
  assert.equal((await viewer.request.head(shareOrigin + '/')).status(), 200);
  assert.equal((await viewer.request.get(shareOrigin + '/missing')).status(), 404);
  const body = Buffer.from([0, 255, 100, 10, 15, 76]);
  const binary = await viewer.request.patch(shareOrigin + '/upload', { data: body });
  assert.equal(binary.status(), 201);
  assert.deepEqual(await binary.body(), body);
  assert.equal((await viewer.request.post(shareOrigin + '/upload', { data: Buffer.alloc(1024 * 1024 + 1) })).status(), 413);
  const redirect = await viewer.request.get(shareOrigin + '/redirect', { maxRedirects: 0 });
  assert.equal(redirect.status(), 302);
  assert.equal(redirect.headers().location, '/json?q=redirect');
  const chunks = await viewer.evaluate(async () => {
    const stream = (await fetch('/stream')).body.getReader();
    const next = async () => (await stream.read()).value;
    return [new TextDecoder().decode(await next()), new TextDecoder().decode(await next())];
  });
  assert.deepEqual(chunks, ['data: one\n\n', 'data: two\n\n']);
  const ws = await viewer.evaluate(() => new Promise((resolve, reject) => {
    const socket = new WebSocket(location.origin.replace(/^https/, 'wss') + '/socket', 'demo');
    socket.binaryType = 'arraybuffer';
    const responses = [];
    const timer = setTimeout(() => { socket.close(); reject(Error('WebSocket timed out')); }, 15000);
    socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('WebSocket upgrade failed')); });
    socket.addEventListener('open', () => socket.send('echo from browser'));
    socket.addEventListener('message', event => {
      responses.push(typeof event.data === 'string' ? event.data : Array.from(new Uint8Array(event.data)));
      if (responses.length === 1) socket.send(new Uint8Array([0, 255, 42]));
      else { clearTimeout(timer); socket.close(); resolve({ protocol: socket.protocol, responses }); }
    });
  }));
  assert.deepEqual(ws, { protocol: 'demo', responses: ['echo from browser', [0, 255, 42]] });
  console.log('PASS authorized guest publication, isolated viewer, nested Alpine backend, absolute JS assets, HTTP, streaming, and WebSocket echo');
  await guest('publish off');
  let status;
  for (let retry = 0; retry < 10; retry++) {
    status = (await viewer.request.get(shareOrigin + '/')).status();
    if (status === 503) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(status, 503);
  console.log('PASS stopping the guest publication revokes the HTTPS link');
} finally {
  await browser.close();
}

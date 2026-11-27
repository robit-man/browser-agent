import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { handleGateway } from '../cloudflare/worker.mjs';

const gateway = process.env.GATEWAY_URL || 'https://gateway.test';
const site = process.env.WORKSTATION_URL || 'https://workstation.test';
const key = process.env.WORKSTATION_KEY_FILE
  ? (await readFile(process.env.WORKSTATION_KEY_FILE, 'utf8')).trim()
  : 'gateway-test-authorization-key-fixture';
const remote = process.env.GATEWAY_URL !== undefined;
const audit = [];
const env = {
  WORKSTATION_ORIGINS: site,
  WORKSTATION_EGRESS_TOKEN: key,
  SESSION_TTL_SECONDS: 2,
  HTTP_DESTINATIONS: JSON.stringify([{ id: 'diagnostics', origin: site, paths: ['/network-fixtures'],
    methods: ['GET', 'HEAD', 'POST'], requestBytes: 65536, responseBytes: 2097152, timeoutMs: 50 }]),
};
const bytes = Buffer.alloc(1048576);
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
const expectedHash = createHash('sha256').update(bytes).digest('hex');

async function upstream(url, init) {
  const path = new URL(url).pathname.split('/').at(-1);
  if (path === 'slow') {
    await new Promise((resolve, reject) => {
      const fallback = setTimeout(resolve, 1000);
      init.signal.addEventListener('abort', () => { clearTimeout(fallback); reject(init.signal.reason); }, { once: true });
    });
  }
  if (path === 'redirect') return Response.redirect('https://example.com', 302);
  if (path === 'binary') return new Response(bytes);
  if (path === 'post') return Response.json({ received: true }, { status: 201 });
  return Response.json({ status: 'ok' });
}

async function request(path, headers = {}, method = 'GET', body, origin = site) {
  const req = new Request(gateway + path, { method, headers: { Origin: origin, ...headers }, body });
  const start = performance.now();
  const response = remote ? await fetch(req) : await handleGateway(req, env, upstream, (line) => audit.push(JSON.parse(line)));
  return { response, ms: Math.round(performance.now() - start) };
}

async function status(label, expected, ...args) {
  const { response, ms } = await request(...args);
  assert.equal(response.status, expected, label + ' ' + await response.clone().text());
  console.log(label, response.status, ms + 'ms', response.headers.get('X-Request-ID'));
  return response;
}

await status('health', 200, '/health');
await status('unapproved origin', 403, '/v1/capabilities', {}, 'GET', undefined, 'https://example.com');
await status('no session', 401, '/v1/services');
const session = await (await status('issue session', 201, '/v1/session', { 'X-Workspace-Key': key }, 'POST')).json();
let auth = { Authorization: 'Bearer ' + session.token };
await status('session status', 200, '/v1/session', auth);
assert.equal((await (await status('service registry', 200, '/v1/services', auth)).json())[0].id, 'diagnostics');
const route = '/v1/services/diagnostics';
const headers = (path, method) => ({ ...auth, 'X-Workspace-Path': path, 'X-Workspace-Method': method });
await status('unregistered service', 404, '/v1/services/arbitrary', auth, 'POST');
await status('private target rejected', 400, route, headers('//169.254.169.254/', 'GET'), 'POST');
await status('method denied', 403, route, headers('/network-fixtures/json', 'DELETE'), 'POST');
await status('over quota input', 413, route, headers('/network-fixtures/post', 'POST'), 'POST', bytes.subarray(0, 65537));
await status('redirect denied', 403, route, headers('/network-fixtures/redirect', 'GET'), 'POST');
const file = await status('binary retrieval', 200, route, headers('/network-fixtures/binary', 'GET'), 'POST');
assert.equal(createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex'), expectedHash);
await status('approved POST', 201, route, headers('/network-fixtures/post', 'POST'), 'POST', '{}');
await status('upstream timeout', 504, route, headers('/network-fixtures/slow', 'GET'), 'POST');
if (!remote) {
  env.WORKSTATION_EGRESS_TOKEN += '-rotated';
  await status('revoked token', 401, '/v1/session', auth);
  const renewed = await (await status('session renewal', 201, '/v1/session', { 'X-Workspace-Key': env.WORKSTATION_EGRESS_TOKEN }, 'POST')).json();
  auth = { Authorization: 'Bearer ' + renewed.token };
  const advance = Date.now;
  try {
    Date.now = () => advance() + 3000;
    await status('expired session', 401, '/v1/session', auth);
  } finally { Date.now = advance; }
  assert(audit.some((entry) => entry.reason === 'redirect_denied' && !!entry.requestId && !!entry.session));
  assert(!JSON.stringify(audit).includes(key));
}
if (remote && process.env.TEST_RATE_LIMIT === '1') {
  let rateLimited = false;
  for (let i = 0; i < 13; i++) {
    const { response } = await request('/v1/session', { 'X-Workspace-Key': 'fixture-invalid-key' }, 'POST');
    if (response.status === 429) { rateLimited = true; break; }
    assert.equal(response.status, 401);
  }
  assert(rateLimited, 'authentication rate limit did not activate');
  console.log('login rate limit', 429);
}

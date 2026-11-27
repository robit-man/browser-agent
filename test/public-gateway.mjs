import assert from 'node:assert/strict';
import { handlePublicGateway, publicGatewayPath } from '../cloudflare/worker.mjs';

const origin = 'https://linux.pointblankllc.com';
const unlimited = { limit: async () => ({ success: true }) };
const env = { PUBLIC_NETWORK_ORIGIN: origin, PUBLIC_CLIENT_LIMIT: unlimited, PUBLIC_REQUEST_LIMIT: unlimited };
const upstream = [];
const audit = [];

function request(path, { site = origin, fetchSite = 'same-origin', source, method = 'GET', headers, body, config = env } = {}) {
  return handlePublicGateway(new Request(site + publicGatewayPath + path, {
    method, body, headers: {
      'CF-Connecting-IP': '192.0.2.5', 'Sec-Fetch-Site': fetchSite, ...(source ? { Origin: source } : {}), ...headers,
    },
  }), config, async (url, init) => {
    upstream.push({ url, init });
    return new Response('fixture');
  }, (line) => audit.push(JSON.parse(line)));
}

function service(serviceId, path, method, headers = {}, body) {
  return request('/v1/services/' + serviceId, {
    method: 'POST', body, headers: { 'X-Workspace-Path': path, 'X-Workspace-Method': method, ...headers },
  });
}

const registry = await request('/v1/services');
assert.equal(registry.status, 200);
assert.equal(registry.headers.get('Access-Control-Allow-Origin'), null);
assert.equal(registry.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
assert.deepEqual((await registry.json()).map(({ id }) => id), ['github', 'npm', 'alpine', 'pypi', 'pypi-files']);
assert.equal((await request('/v1/services', { fetchSite: 'cross-site', source: 'https://external.test' })).status, 403);
assert.equal((await request('/v1/services', { site: 'https://linux.noclip.org' })).status, 403);

const readRefs = '/example/project.git/info/refs?service=git-upload-pack';
assert.equal((await service('github', readRefs, 'GET')).status, 200);
assert.equal((await service('github', '/example/project/git-upload-pack', 'POST', {
  'X-Workspace-Headers': JSON.stringify({ 'content-type': 'application/x-git-upload-pack-request', authorization: 'ignored' }),
}, 'payload')).status, 200);
assert.equal(upstream.at(-1).init.headers.has('Authorization'), false);
assert.equal((await service('github', '/example/project.git/info/refs?service=git-receive-pack', 'GET')).status, 403);
assert.equal((await service('github', '/example/project.git/git-receive-pack', 'POST')).status, 403);
assert.equal((await service('github', readRefs, 'GET', { 'X-Workspace-Git-Auth': 'Basic ignored' })).status, 403);
assert.equal((await service('github', readRefs, 'GET', { Authorization: 'Bearer ignored' })).status, 403);
assert.equal((await service('npm', '/is-number', 'GET')).status, 200);
assert.equal((await service('npm', '/is-number', 'PUT')).status, 403);
assert.equal((await service('npm', '//169.254.169.254/', 'GET')).status, 400);
assert.equal((await request('/v1/services', { config: { ...env, PUBLIC_CLIENT_LIMIT: null } })).status, 503);
assert.equal((await request('/v1/services', {
  config: { ...env, PUBLIC_CLIENT_LIMIT: { limit: async () => ({ success: false }) } },
})).status, 429);
assert.equal(upstream.length, 3);
assert(audit.some(({ event, status }) => event === 'workstation_public_egress' && status === 403));
console.log('PASS same-origin public registry, Git reads, package reads, denial of writes and credentials, origin checks, and rate limits');

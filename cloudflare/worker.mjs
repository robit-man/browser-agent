import { gitPackTimeoutMs, isGitPackDownload } from '../workstation-network-limits.mjs';

const MiB = 1024 * 1024;
const defaultRequestLimit = 16 * MiB;
const defaultResponseLimit = 64 * MiB;
const requestHeaders = ['accept', 'content-type', 'git-protocol', 'if-modified-since', 'if-none-match', 'range', 'user-agent'];
const responseHeaders = ['accept-ranges', 'content-encoding', 'content-range', 'content-type', 'etag', 'last-modified', 'location'];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const publicGatewayPath = '/api/workstation/public';
const publicServices = [
  { id: 'github', origin: 'https://github.com', publicGit: true, requestBytes: 2 * MiB },
  { id: 'npm', origin: 'https://registry.npmjs.org', paths: ['/'], methods: ['GET', 'HEAD'] },
  { id: 'alpine', origin: 'https://dl-cdn.alpinelinux.org', paths: ['/alpine/v3.24/main', '/alpine/v3.24/community'], methods: ['GET', 'HEAD'] },
  { id: 'pypi', origin: 'https://pypi.org', paths: ['/simple'], methods: ['GET', 'HEAD'] },
  { id: 'pypi-files', origin: 'https://files.pythonhosted.org', paths: ['/packages'], methods: ['GET', 'HEAD'] },
];

function bytes64(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function from64(value) {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));
}

function json(status, value) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function signingKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(key, value) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function openSession(request, env, key) {
  const provided = request.headers.get('X-Workspace-Key');
  if (!provided || provided.length > 256 ||
      !await crypto.subtle.verify('HMAC', key, await sign(key, env.WORKSTATION_EGRESS_TOKEN), encoder.encode(provided))) {
    return null;
  }
  const session = {
    id: crypto.randomUUID(),
    expires: Math.floor(Date.now() / 1000) + Number(env.SESSION_TTL_SECONDS || 3600),
  };
  const payload = bytes64(encoder.encode(JSON.stringify(session)));
  return { ...session, token: payload + '.' + bytes64(await sign(key, payload)) };
}

async function readSession(request, key) {
  const auth = request.headers.get('Authorization');
  const match = /^Bearer ([a-zA-Z0-9_-]{1,256})\.([a-zA-Z0-9_-]{43})$/.exec(auth || '');
  if (!match) return null;
  try {
    if (!await crypto.subtle.verify('HMAC', key, from64(match[2]), encoder.encode(match[1]))) return null;
    const session = JSON.parse(decoder.decode(from64(match[1])));
    if (session.expires > Math.floor(Date.now() / 1000)) return session;
  } catch {}
  return null;
}

function gitOperation(url, method) {
  if (url.origin !== 'https://github.com') return null;
  const match = /^\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!match) return { invalid: true };
  const [, repo, route] = match;
  const service = route === 'info/refs' ? url.searchParams.get('service') : route;
  const expectedQuery = route === 'info/refs' ? '?service=' + service : '';
  if (url.search !== expectedQuery || method !== (route === 'info/refs' ? 'GET' : 'POST') ||
      !['git-upload-pack', 'git-receive-pack'].includes(service)) return { invalid: true };
  return { repo: repo.toLowerCase(), write: service === 'git-receive-pack' };
}

function registry(env) {
  const services = JSON.parse(env.HTTP_DESTINATIONS || '[]');
  const repositories = JSON.parse(env.GIT_REPOSITORIES || '{}');
  if (Object.keys(repositories).length) services.push({ id: 'github', origin: 'https://github.com', repositories });
  return services;
}

function approved(service, url, method) {
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return false; }
  if (!service || url.origin !== service.origin || url.protocol !== 'https:' ||
      url.username || url.password || url.port || url.hash ||
      /[%\\\x00-\x20]/.test(path) || /(?:^|\/)\.\.?(?:\/|$)/.test(path) || path.includes('//')) return false;
  if (service.publicGit || service.repositories) {
    const git = gitOperation(url, method);
    if (!git || git.invalid) return false;
    if (service.publicGit) return !git.write;
    if (!Object.hasOwn(service.repositories, git.repo)) return false;
    return service.repositories[git.repo] === 'write' || (service.repositories[git.repo] === 'read' && !git.write);
  }
  return service.methods.includes(method) &&
    service.paths.some((prefix) => prefix === '/' || path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'));
}

async function boundedBody(request, limit) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const parts = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new RangeError('Request body exceeds service limit');
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return body;
}

function capResponse(body, limit, audit) {
  if (!body) return null;
  let size = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > limit) {
        audit.responseBytes = size;
        audit.log(502, 'response_limit', true);
        throw new RangeError('Response exceeds service limit');
      }
      controller.enqueue(chunk);
    },
  }));
}

async function forward(request, env, services, service, audit, upstreamFetch) {
  const path = request.headers.get('X-Workspace-Path') || '';
  const method = request.headers.get('X-Workspace-Method') || '';
  let url;
  try {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x20]/.test(path)) throw Error();
    url = new URL(path, service.origin);
  } catch { return audit.reply(400, 'invalid_target'); }
  audit.resource = service.id;
  audit.destination = url.hostname;
  audit.method = /^[A-Z]{3,10}$/.test(method) ? method : 'INVALID';
  if (!approved(service, url, method)) return audit.reply(403, 'destination_or_operation_denied');

  const headers = new Headers({ 'Accept-Encoding': 'identity' });
  try {
    const forwarded = JSON.parse(request.headers.get('X-Workspace-Headers') || '{}');
    for (const name of requestHeaders) if (typeof forwarded[name] === 'string') headers.set(name, forwarded[name]);
  } catch { return audit.reply(400, 'invalid_headers'); }
  if (service.publicGit || service.repositories) {
    const git = gitOperation(url, method);
    audit.repository = git.repo;
    const auth = request.headers.get('X-Workspace-Git-Auth');
    if (git.write && !auth) return audit.reply(401, 'git_credential_required');
    if (auth) {
      if (!/^Basic [A-Za-z0-9+/]{4,4096}={0,2}$/.test(auth)) return audit.reply(400, 'invalid_git_credential');
      headers.set('Authorization', auth);
    }
    if (method === 'POST') {
      const operation = git.write ? 'receive' : 'upload';
      if (headers.get('content-type') !== 'application/x-git-' + operation + '-pack-request') {
        return audit.reply(415, 'invalid_git_content_type');
      }
    }
  }

  const requestLimit = Math.min(defaultRequestLimit, service.requestBytes ?? defaultRequestLimit);
  const gitPack = service.id === 'github' && isGitPackDownload(url, method);
  const ceiling = gitPack ? Infinity : defaultResponseLimit;
  const responseLimit = Math.min(ceiling, service.responseBytes ?? ceiling);
  let body;
  try {
    if (Number(request.headers.get('Content-Length')) > requestLimit) return audit.reply(413, 'request_limit');
    if (!['GET', 'HEAD'].includes(method)) body = await boundedBody(request, requestLimit);
  } catch { return audit.reply(413, 'request_limit'); }
  audit.requestBytes = body?.byteLength || 0;
  const gitConnect = gitPack ? new AbortController() : null;
  const timer = gitConnect && setTimeout(() => gitConnect.abort(), gitPackTimeoutMs);
  const timeout = gitConnect?.signal ?? AbortSignal.timeout(Math.min(60000, service.timeoutMs || 30000));
  try {
    const fetchTarget = service.id === 'diagnostics' && env.DIAGNOSTICS ? env.DIAGNOSTICS.fetch.bind(env.DIAGNOSTICS) : upstreamFetch;
    const response = await fetchTarget(url.href, {
      method, headers, body, redirect: 'manual', signal: AbortSignal.any([request.signal, timeout]),
    });
    const location = response.headers.get('Location');
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, url);
      const nextMethod = response.status === 303 || ([301, 302].includes(response.status) && method === 'POST') ? 'GET' : method;
      if (!services.some((candidate) => approved(candidate, next, nextMethod))) {
        await response.body?.cancel().catch(() => {});
        return audit.reply(403, 'redirect_denied');
      }
    }
    const length = response.headers.get('Content-Length');
    audit.responseBytes = length === null ? null : Number(length);
    if (audit.responseBytes > responseLimit) {
      await response.body?.cancel().catch(() => {});
      return audit.reply(502, 'response_limit');
    }
    const safe = new Headers({ 'Cache-Control': 'no-store' });
    for (const name of responseHeaders) if (response.headers.has(name)) safe.set(name, response.headers.get(name));
    audit.log(response.status, 'upstream', true);
    const stream = Number.isFinite(responseLimit) ? capResponse(response.body, responseLimit, audit) : response.body;
    return new Response(stream, { status: response.status, headers: safe });
  } catch {
    return audit.reply(timeout.aborted ? 504 : 502, timeout.aborted ? 'upstream_timeout' : 'upstream_error');
  } finally {
    clearTimeout(timer);
  }
}

function auditRequest(writeLog, event) {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  return {
    requestId,
    log(status, reason, authorized = false) {
      const { session, resource, destination, method, repository, requestBytes, responseBytes } = this;
      writeLog(JSON.stringify({
        event, requestId, timestamp: new Date(started).toISOString(), session, resource,
        destination, method, repository, status, requestBytes, responseBytes, durationMs: Date.now() - started, authorized, reason,
      }));
    },
    reply(status, reason) {
      this.log(status, reason);
      return json(status, { error: reason });
    },
  };
}

export async function handlePublicGateway(request, env, upstreamFetch = fetch, writeLog = console.log) {
  const url = new URL(request.url);
  const publicOrigin = env.PUBLIC_NETWORK_ORIGIN;
  const audit = auditRequest(writeLog, 'workstation_public_egress');
  const respond = (response) => {
    const headers = new Headers(response.headers);
    headers.set('X-Request-ID', audit.requestId);
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(response.body, { status: response.status, headers });
  };
  const origin = request.headers.get('Origin');
  if (url.origin !== publicOrigin || !url.pathname.startsWith(publicGatewayPath + '/') ||
      url.search || (origin && origin !== publicOrigin) ||
      request.headers.get('Sec-Fetch-Site') !== 'same-origin') {
    return respond(audit.reply(403, 'origin_denied'));
  }
  if (request.headers.has('Authorization') || request.headers.has('X-Workspace-Git-Auth') ||
      request.headers.has('X-Workspace-Key')) {
    return respond(audit.reply(403, 'credentials_not_accepted'));
  }
  const client = request.headers.get('CF-Connecting-IP');
  if (!client || !env.PUBLIC_CLIENT_LIMIT || !env.PUBLIC_REQUEST_LIMIT) {
    return respond(audit.reply(503, 'rate_limit_unavailable'));
  }
  if (!(await env.PUBLIC_CLIENT_LIMIT.limit({ key: client })).success ||
      !(await env.PUBLIC_REQUEST_LIMIT.limit({ key: 'public' })).success) {
    return respond(audit.reply(429, 'request_rate_limit'));
  }
  const path = url.pathname.slice(publicGatewayPath.length);
  if (path === '/v1/services' && request.method === 'GET') {
    return respond(json(200, publicServices.map(({ id, origin }) => ({ id, origin }))));
  }
  const match = /^\/v1\/services\/([a-z0-9-]+)$/.exec(path);
  const service = match && publicServices.find(({ id }) => id === match[1]);
  if (!service || request.method !== 'POST') return respond(audit.reply(404, 'service_unavailable'));
  return respond(await forward(request, env, publicServices, service, audit, upstreamFetch));
}

export async function handleGateway(request, env, upstreamFetch = fetch, writeLog = console.log) {
  const { pathname } = new URL(request.url);
  const origin = request.headers.get('Origin') ||
    (request.headers.get('Sec-Fetch-Site') === 'same-origin' ? new URL(request.url).origin : null);
  const allowedOrigins = (env.WORKSTATION_ORIGINS || env.WORKSTATION_ORIGIN || '').split(',').map((part) => part.trim());
  const allowed = !!origin && allowedOrigins.includes(origin);
  const audit = auditRequest(writeLog, 'workstation_egress');
  const respond = (response) => {
    const headers = new Headers(response.headers);
    headers.set('X-Request-ID', audit.requestId);
    headers.set('Vary', 'Origin');
    if (allowed) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Expose-Headers', [...responseHeaders, 'X-Request-ID'].join(', '));
    }
    return new Response(response.body, { status: response.status, headers });
  };
  if (pathname === '/health' && request.method === 'GET') return respond(json(200, { status: 'ok' }));
  if (!allowed) return respond(audit.reply(403, 'origin_denied'));
  if (request.method === 'OPTIONS' && pathname.startsWith('/v1/')) {
    return respond(new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, X-Workspace-Key, X-Workspace-Path, X-Workspace-Method, X-Workspace-Headers, X-Workspace-Git-Auth',
      'Access-Control-Max-Age': '600',
    } }));
  }
  if (pathname === '/v1/capabilities' && request.method === 'GET') {
    return respond(json(200, { authentication: 'signed session', upstream: 'HTTPS', requestBytes: defaultRequestLimit,
      responseBytes: defaultResponseLimit, diagnosticService: 'diagnostics' }));
  }
  if (!env.WORKSTATION_EGRESS_TOKEN) return respond(audit.reply(503, 'authorization_unconfigured'));
  const key = await signingKey(env.WORKSTATION_EGRESS_TOKEN);
  if (pathname === '/v1/session' && request.method === 'POST') {
    const remote = request.headers.get('CF-Connecting-IP') || 'local';
    if (env.AUTH_LIMIT && !(await env.AUTH_LIMIT.limit({ key: remote })).success) return respond(audit.reply(429, 'authorization_rate_limit'));
    const issued = await openSession(request, env, key);
    if (!issued) return respond(audit.reply(401, 'authorization_failed'));
    audit.session = issued.id;
    audit.log(201, 'session_created', true);
    return respond(json(201, issued));
  }
  const session = await readSession(request, key);
  if (!session) return respond(audit.reply(401, 'session_required'));
  audit.session = session.id;
  if (env.REQUEST_LIMIT && !(await env.REQUEST_LIMIT.limit({ key: 'workstation' })).success) {
    return respond(audit.reply(429, 'request_rate_limit'));
  }
  if (pathname === '/v1/session' && request.method === 'GET') return respond(json(200, { id: session.id, expires: session.expires }));
  const services = registry(env);
  if (pathname === '/v1/services' && request.method === 'GET') return respond(json(200, services));
  const match = /^\/v1\/services\/([a-z0-9-]+)$/.exec(pathname);
  const service = match && services.find((entry) => entry.id === match[1]);
  if (!service || request.method !== 'POST') return respond(audit.reply(404, 'service_unavailable'));
  return respond(await forward(request, env, services, service, audit, upstreamFetch));
}

export default { fetch(request, env) { return handleGateway(request, env); } };

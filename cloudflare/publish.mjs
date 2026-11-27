import { DurableObject } from 'cloudflare:workers';

const protocol = 'pointblank-publish-v1';
const control = '/__pointblank_publish/';
const cookieName = '__Host-pointblank-publication';
const maximumRequest = 1024 * 1024;
const maximumResponse = 16 * 1024 * 1024;
const maximumWebSocket = 65535;
const maximumWebSocketTraffic = 32 * 1024 * 1024;
const webSocketText = new TextDecoder('utf-8', { fatal: true });
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length']);
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const noBody = new Set([204, 205, 304]);

function reply(status, message, headers) {
  const safe = new Headers(headers);
  safe.set('Cache-Control', 'no-store');
  if (message) safe.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(message, { status, headers: safe });
}

function headerPairs(headers) {
  const extra = new Set((headers.get('connection') || '').toLowerCase().split(',').map(name => name.trim()));
  return Array.from(headers).filter(([name]) => !hopHeaders.has(name) && !extra.has(name));
}

function packet(socket, message) {
  socket.send(JSON.stringify(message));
}

function cookies(request) {
  return (request.headers.get('cookie') || '').split(';').map(value => value.trim());
}

async function boundedBody(request) {
  if (!request.body) return new Uint8Array();
  if (Number(request.headers.get('Content-Length')) > maximumRequest) throw Error('request size');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximumRequest) {
        await reader.cancel().catch(() => {});
        throw Error('request size');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

function requestHeaders(request, url) {
  const headers = new Headers(headerPairs(request.headers));
  for (const name of [...headers.keys()]) {
    if (name.startsWith('cf-') || name.startsWith('x-forwarded-') || name === 'forwarded' ||
        name === 'host' || name === 'accept-encoding' || name === 'x-real-ip') headers.delete(name);
  }
  const appCookies = cookies(request)
    .filter(value => value && !value.startsWith(cookieName + '='));
  if (appCookies.length) headers.set('cookie', appCookies.join('; '));
  else headers.delete('cookie');
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', url.protocol.slice(0, -1));
  return Array.from(headers);
}

function responseHeaders(values) {
  const original = new Headers(values);
  const headers = new Headers(headerPairs(original));
  headers.delete('set-cookie');
  for (const cookie of original.getSetCookie()) {
    if (cookie.trimStart().toLowerCase().startsWith(cookieName.toLowerCase() + '=')) continue;
    headers.append('set-cookie', cookie.replace(/;\s*domain\s*=[^;]*/ig, ''));
  }
  for (const name of ['clear-site-data', 'alt-svc', 'report-to', 'nel', 'server', 'refresh']) headers.delete(name);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Origin-Agent-Cluster', '?1');
  return headers;
}

export class WorkspacePublication extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map();
    this.sequence = 0;
  }

  owner() {
    return this.ctx.getWebSockets('publisher').find(socket => socket.readyState === WebSocket.OPEN);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const owner = this.owner();
    if (url.pathname === control + 'connect') {
      const authorization = request.headers.get('X-Pointblank-Verified-Publisher');
      if (!authorization || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return reply(403, 'Publisher authorization required');
      }
      if (owner?.deserializeAttachment().expires > Date.now()) return reply(409, 'A server is already published');
      if (owner) this.stop(owner, 'expired');
      const expires = Number(authorization);
      if (!Number.isFinite(expires) || expires <= Date.now()) return reply(403, 'Publisher authorization expired');
      const pair = new WebSocketPair();
      const link = crypto.randomUUID().replaceAll('-', '');
      this.ctx.acceptWebSocket(pair[1], ['publisher']);
      pair[1].serializeAttachment({ link, expires });
      await this.ctx.storage.setAlarm(expires);
      packet(pair[1], { kind: 'ready', url: url.origin + control + 'open/' + link, expires });
      console.log(JSON.stringify({ event: 'workspace_publish', action: 'started', expires }));
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': protocol } });
    }

    const publication = owner?.deserializeAttachment();
    if (!publication || publication.expires <= Date.now()) return reply(503, 'No workspace is publishing');
    if (url.pathname.startsWith(control)) {
      if (request.method !== 'GET' || url.pathname !== control + 'open/' + publication.link) return reply(404, 'Publication unavailable');
      const age = Math.max(0, Math.floor((publication.expires - Date.now()) / 1000));
      return reply(302, null, { Location: '/', 'Referrer-Policy': 'no-referrer',
        'Clear-Site-Data': '"cache", "storage"',
        'Set-Cookie': cookieName + '=' + publication.link + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + age });
    }
    if (!cookies(request).includes(cookieName + '=' + publication.link)) return reply(403, 'Open the current publication link first');
    if (request.headers.has('service-worker') || request.headers.get('sec-fetch-dest') === 'serviceworker') {
      return reply(403, 'Service worker registration is unavailable on this origin');
    }
    if (!methods.has(request.method)) return reply(405, 'HTTP method unavailable');
    const upgrade = request.headers.get('upgrade');
    const websocket = upgrade?.toLowerCase() === 'websocket' && request.method === 'GET';
    if (upgrade && !websocket) return reply(426, 'Only WebSocket upgrades are supported');
    if (url.pathname.length + url.search.length > 8192) return reply(414, 'Publication URL exceeds 8192 characters');
    if (this.pending.size >= 8) return reply(429, 'Publication is busy');
    let body;
    try { body = await boundedBody(request); } catch { return reply(413, 'Request exceeds 1 MiB'); }
    if (this.owner() !== owner) return reply(503, 'Workspace disconnected');
    if (this.pending.size >= 8) return reply(429, 'Publication is busy');
    const id = ++this.sequence >>> 0;
    const stream = new TransformStream();
    return new Promise(resolve => {
      const job = { stream, resolve, writer: stream.writable.getWriter(), bytes: 0, started: Date.now(), websocket,
        method: request.method, signal: request.signal, reading: false };
      if (websocket) job.protocols = (request.headers.get('sec-websocket-protocol') || '')
        .split(',').map(value => value.trim()).filter(Boolean);
      job.cancel = () => this.finish(owner, id, 499, 'Viewer disconnected', true);
      this.pending.set(id, job);
      request.signal.addEventListener('abort', job.cancel, { once: true });
      if (request.signal.aborted) return job.cancel();
      this.arm(owner, id, job);
      try {
        packet(owner, { kind: websocket ? 'websocket' : 'request', id, method: request.method, path: url.pathname + url.search,
          headers: requestHeaders(request, url), hasBody: !!body.length });
        if (body.length) {
          const frame = new Uint8Array(4 + body.length);
          new DataView(frame.buffer).setUint32(0, id);
          frame.set(body, 4);
          owner.send(frame);
        }
      } catch { this.finish(owner, id, 502, 'Workspace disconnected'); }
    });
  }

  arm(owner, id, job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this.finish(owner, id, 504, 'Workspace request timed out', true), 30000);
  }

  finish(owner, id, status, reason, cancel = false) {
    const job = this.pending.get(id);
    if (!job) return;
    this.pending.delete(id);
    clearTimeout(job.timer);
    job.signal.removeEventListener('abort', job.cancel);
    if (cancel) try { packet(owner, { kind: 'cancel', id }); } catch {}
    if (reason && !job.responded) job.resolve(reply(status, reason));
    if (job.viewer) try { job.viewer.close(reason ? 1011 : 1000, reason || 'Closed'); } catch {}
    void (reason ? job.writer.abort(Error(reason)) : job.writer.close()).catch(() => {});
    console.log(JSON.stringify({ event: 'workspace_publish_http', method: job.method,
      status, durationMs: Date.now() - job.started, bytes: job.bytes }));
  }

  openViewer(owner, id, job, selected) {
    if (typeof selected !== 'string' || (selected && !job.protocols.includes(selected))) {
      this.finish(owner, id, 502, 'Guest selected an invalid WebSocket subprotocol', true);
      return;
    }
    const [client, viewer] = Object.values(new WebSocketPair());
    viewer.binaryType = 'arraybuffer';
    viewer.accept();
    job.viewer = viewer;
    job.responded = 101;
    clearTimeout(job.timer);
    job.signal.removeEventListener('abort', job.cancel);
    const disconnect = () => this.finish(owner, id, 101, undefined, true);
    viewer.addEventListener('close', disconnect);
    viewer.addEventListener('error', disconnect);
    viewer.addEventListener('message', event => {
      if (!this.pending.has(id)) return;
      const isText = typeof event.data === 'string';
      const bytes = isText ? new TextEncoder().encode(event.data) : new Uint8Array(event.data);
      if (bytes.length > maximumWebSocket || (job.bytes += bytes.length) > maximumWebSocketTraffic) {
        return this.finish(owner, id, 502, 'WebSocket transfer limit exceeded', true);
      }
      const frame = new Uint8Array(5 + bytes.length);
      new DataView(frame.buffer).setUint32(0, id);
      frame[4] = isText ? 1 : 0;
      frame.set(bytes, 5);
      try { owner.send(frame); } catch { disconnect(); }
    });
    const headers = selected ? { 'Sec-WebSocket-Protocol': selected } : undefined;
    job.resolve(new Response(null, { status: 101, webSocket: client, headers }));
  }

  async webSocketMessage(owner, data) {
    if (owner !== this.owner()) return;
    if (typeof data !== 'string') {
      if (!(data instanceof ArrayBuffer) || data.byteLength < 5 || data.byteLength > 65540) return this.stop(owner, 'invalid response');
      const id = new DataView(data).getUint32(0);
      const job = this.pending.get(id);
      if (!job) return;
      if (job.websocket) {
        const bytes = new Uint8Array(data, 5);
        if (!job.viewer || bytes.length > maximumWebSocket || (job.bytes += bytes.length) > maximumWebSocketTraffic) {
          return this.finish(owner, id, 502, 'WebSocket transfer limit exceeded', true);
        }
        try { job.viewer.send(new Uint8Array(data)[4] ? webSocketText.decode(bytes) : bytes); }
        catch { this.finish(owner, id, 502, 'WebSocket viewer disconnected', true); }
        return;
      }
      job.bytes += data.byteLength - 4;
      if (!job.responseBody || job.reading || job.bytes > maximumResponse) {
        return this.finish(owner, id, 502, 'Invalid or oversized guest response', true);
      }
      job.reading = true;
      this.arm(owner, id, job);
      try {
        await job.writer.write(new Uint8Array(data, 4));
        job.reading = false;
        if (this.pending.has(id)) packet(owner, { kind: 'ack', id });
      } catch { this.finish(owner, id, 499, 'Viewer disconnected', true); }
      return;
    }
    if (data.length > 65536) return this.stop(owner, 'invalid response');
    let message;
    try { message = JSON.parse(data); } catch { return this.stop(owner, 'invalid response'); }
    if (!message || typeof message !== 'object') return this.stop(owner, 'invalid response');
    const { id, kind } = message;
    const job = this.pending.get(id);
    if (!job) return;
    if (job.websocket) {
      if (kind === 'ws-open' && !job.viewer) return this.openViewer(owner, id, job, message.selected);
      if (kind === 'end' && job.viewer) return this.finish(owner, id, 101);
      return this.finish(owner, id, 502, 'Guest WebSocket failed', true);
    }
    if (kind === 'headers' && !job.responded) {
      const status = Number(message.status);
      if (!Number.isInteger(status) || status < 200 || status > 599) return this.finish(owner, id, 502, 'Invalid guest status', true);
      try {
        const body = job.method === 'HEAD' || noBody.has(status) ? null : job.stream.readable;
        const response = new Response(body, { status, headers: responseHeaders(message.headers), encodeBody: 'manual' });
        job.responseBody = !!body;
        job.responded = status;
        job.resolve(response);
        this.arm(owner, id, job);
      } catch { this.finish(owner, id, 502, 'Invalid guest HTTP headers', true); }
    } else if (kind === 'end' && job.responded) {
      this.finish(owner, id, job.responded);
    } else {
      this.finish(owner, id, 502, 'Guest server request failed');
    }
  }

  stop(owner, reason) {
    if (!owner) return;
    for (const id of this.pending.keys()) this.finish(owner, id, 503, 'Workspace disconnected');
    try { owner.close(1000, reason); } catch {}
    console.log(JSON.stringify({ event: 'workspace_publish', action: 'stopped', reason }));
  }

  webSocketClose(owner) {
    if (!this.owner() || this.owner() === owner) this.stop(owner, 'closed');
  }

  webSocketError(owner) {
    if (!this.owner() || this.owner() === owner) this.stop(owner, 'connection error');
  }

  async alarm() {
    const owner = this.owner();
    if (owner?.deserializeAttachment().expires <= Date.now()) this.stop(owner, 'expired');
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.origin !== env.PUBLISH_ORIGIN) return reply(404, 'Publication unavailable');
    if (url.pathname === control + 'connect') {
      const [version, secret, extra] = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(v => v.trim());
      if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' ||
          request.headers.get('Origin') !== env.WORKSTATION_ORIGIN || version !== protocol || extra !== undefined ||
          !secret || !/^[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{43}$/.test(secret)) return reply(403, 'Publisher authorization required');
      if (!(await env.PUBLISH_AUTH_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' })).success) {
        return reply(429, 'Publication authentication rate limit');
      }
      const response = await env.NETWORK.fetch('https://network.pointblankllc.com/v1/session', {
        headers: { Origin: env.WORKSTATION_ORIGIN, Authorization: 'Bearer ' + secret },
      });
      if (!response.ok) return reply(403, 'Publisher authorization expired');
      const { expires } = await response.json();
      const headers = new Headers({ Upgrade: 'websocket', 'X-Pointblank-Verified-Publisher': String(expires * 1000) });
      return env.PUBLICATION.getByName('workspace').fetch(new Request(url, { headers }));
    }
    if (request.headers.has('X-Pointblank-Verified-Publisher')) return reply(403, 'Invalid publication request');
    if (url.pathname.startsWith(control)) {
      if (!/^\/__pointblank_publish\/open\/[a-f0-9]{32}$/.test(url.pathname)) return reply(404, 'Publication unavailable');
    } else if (!cookies(request).some(item => /^__Host-pointblank-publication=[a-f0-9]{32}$/.test(item))) {
      return reply(403, 'Open the current publication link first');
    }
    if (!(await env.PUBLISH_VIEW_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' })).success) {
      return reply(429, 'Publication request rate limit');
    }
    return env.PUBLICATION.getByName('workspace').fetch(request);
  },
};

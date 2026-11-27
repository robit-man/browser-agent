const proxyAddress = 'http://127.0.0.1:18791';
const proxyRoot = '/run/pointblank-egress';
const productionGateway = 'https://network.pointblankllc.com';
const localGateway = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const gateway = document.querySelector('meta[name=workstation-gateway]')?.content ||
  (localGateway ? location.origin : productionGateway);
const maxRequest = 16 * MiB;
const maxResponse = 64 * MiB;

// The proxy leaves CONNECT credentials and certificates in RAM-backed /run.
const proxyProgram = String.raw`import http.server
import json
import os
import re
import tempfile
import socketserver
import ssl
import subprocess
from urllib.parse import urlsplit

ROOT = '/run/pointblank-egress'
BRIDGE = '/usr/local/libexec/browser-agent/_egress'
LIMIT = 16 * 1024 * 1024
HOST = re.compile(r'[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\Z')

class Proxy(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def setup(self):
        self.request.settimeout(75)
        super().setup()

    def do_CONNECT(self):
        host, sep, port = self.path.rpartition(':')
        if not sep or port != '443' or not HOST.fullmatch(host) or host.endswith('.'):
            return self.send_error(403, 'HTTPS CONNECT requires a DNS hostname on port 443')
        certdir = os.path.join(ROOT, host.lower())
        try:
            os.makedirs(certdir, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=certdir) as cert:
                subprocess.run([BRIDGE, 'certificate', host.lower()], stdin=subprocess.DEVNULL,
                               stdout=cert, check=True, timeout=25)
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.load_cert_chain(cert.name, os.path.join(ROOT, 'leaf.key'))
        except (OSError, subprocess.SubprocessError, ValueError):
            return self.send_error(403, 'Host unavailable or networking authorization required')
        self.send_response_only(200, 'Connection Established')
        self.end_headers()
        self.wfile.flush()
        try:
            with context.wrap_socket(self.connection, server_side=True) as tunnel:
                Inner(tunnel, self.client_address, (self.server, host.lower()))
        except (OSError, ssl.SSLError):
            pass
        self.close_connection = True

    def forward(self, target):
        chunks = self.headers.get('Transfer-Encoding', '').lower()
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if chunks:
                if chunks != 'chunked' or self.headers.get('Content-Length'):
                    return self.send_error(400, 'Invalid request framing')
                body = self.read_chunks()
                length = len(body)
            elif 0 <= length <= LIMIT:
                body = self.rfile.read(length)
                if length != len(body):
                    return self.send_error(400, 'Incomplete request')
            else:
                return self.send_error(413, 'Request body exceeds 16 MiB')
        except OverflowError:
            return self.send_error(413, 'Request body exceeds 16 MiB')
        except (OSError, ValueError):
            return self.send_error(400, 'Invalid request body')
        meta = {'target': target, 'method': self.command,
                'headers': {k.lower(): v for k, v in self.headers.items()
                            if k.lower() in ('accept', 'content-type', 'git-protocol', 'if-modified-since',
                                            'if-none-match', 'range', 'user-agent')},
                'length': length}
        with subprocess.Popen([BRIDGE, 'request'], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as child:
            try:
                child.stdin.write(json.dumps(meta).encode() + b'\n')
                child.stdin.write(body)
                child.stdin.close()
                result = json.loads(child.stdout.readline(65536))
                self.send_response_only(result['status'])
                for key, value in result['headers'].items():
                    self.send_header(key, value)
                send_body = self.command != 'HEAD' and result['status'] not in (204, 304)
                if send_body:
                    self.send_header('transfer-encoding', 'chunked')
                self.send_header('connection', 'close')
                self.end_headers()
                self.close_connection = True
                if send_body:
                    while chunk := child.stdout.read1(65536):
                        self.wfile.write(f'{len(chunk):x}\r\n'.encode() + chunk + b'\r\n')
                    if child.wait() == 0:
                        self.wfile.write(b'0\r\n\r\n')
            except (OSError, ValueError, KeyError):
                self.close_connection = True
                child.kill()
            finally:
                child.wait()

    def read_chunks(self):
        body = bytearray()
        while True:
            line = self.rfile.readline(128)
            if not re.fullmatch(rb'[0-9A-Fa-f]{1,8}\r\n', line):
                raise ValueError('Invalid chunk length')
            size = int(line, 16)
            if len(body) + size > LIMIT:
                raise OverflowError('Request body exceeds 16 MiB')
            chunk = self.rfile.read(size)
            if len(chunk) != size or self.rfile.read(2) != b'\r\n':
                raise ValueError('Truncated chunk')
            if not size:
                return body
            body.extend(chunk)

    def do_GET(self):
        url = urlsplit(self.path)
        if url.scheme not in ('http', 'https') or not url.netloc:
            return self.send_error(400, 'Use an absolute HTTP URL')
        self.forward(self.path)

    do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_GET

class Inner(Proxy):
    def __init__(self, tunnel, address, server_info):
        server, self.host = server_info
        super().__init__(tunnel, address, server)

    def do_CONNECT(self):
        self.send_error(405, 'Nested CONNECT is unavailable')

    def do_GET(self):
        if not self.path.startswith('/') or not self.path.isascii():
            return self.send_error(400, 'Use an absolute request path')
        self.forward('https://' + self.host + self.path)

    do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_GET

class Server(http.server.ThreadingHTTPServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = 'localhost'
        self.server_port = self.server_address[1]

server = Server(('127.0.0.1', 18791), Proxy)
open(os.path.join(ROOT, 'ready'), 'w').close()
server.serve_forever()
`;

const concat = (...arrays) => {
  const result = new Uint8Array(arrays.reduce((length, bytes) => length + bytes.length, 0));
  let offset = 0;
  for (const bytes of arrays) { result.set(bytes, offset); offset += bytes.length; }
  return result;
};

function der(tag, ...fields) {
  const body = concat(...fields);
  const length = body.length;
  const size = length < 128 ? [length] : length < 256 ? [129, length] : [130, length >> 8, length & 255];
  return concat(Uint8Array.of(tag, ...size), body);
}

const seq = (...fields) => der(0x30, ...fields);
const oid = (...bytes) => der(6, Uint8Array.of(...bytes));
const octets = (...fields) => der(4, ...fields);
const bitString = (bytes) => der(3, Uint8Array.of(0), bytes);
const signatureAlgorithm = seq(oid(42, 134, 72, 134, 247, 13, 1, 1, 11), der(5));
const subject = (name) => seq(der(0x31, seq(oid(85, 4, 3), der(12, encoder.encode(name)))));
const extension = (id, value, critical = false) => seq(oid(85, 29, id),
  ...(critical ? [der(1, Uint8Array.of(255))] : []), octets(value));

function time(date) {
  const value = date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
  return der(23, encoder.encode(value));
}

function pem(type, bytes) {
  return '-----BEGIN ' + type + '-----\n' + bytes.toBase64().match(/.{1,64}/g).join('\n') + '\n-----END ' + type + '-----\n';
}

async function certificates() {
  const params = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1) };
  const [ca, leaf] = await Promise.all([
    crypto.subtle.generateKey(params, false, ['sign', 'verify']),
    crypto.subtle.generateKey(params, true, ['sign', 'verify']),
  ]);
  const [caPub, leafPub, leafKey] = await Promise.all([
    crypto.subtle.exportKey('spki', ca.publicKey),
    crypto.subtle.exportKey('spki', leaf.publicKey),
    crypto.subtle.exportKey('pkcs8', leaf.privateKey),
  ]);
  const authority = subject('Pointblank Linux session proxy');
  async function sign(host) {
    const serial = crypto.getRandomValues(new Uint8Array(16));
    serial[0] = (serial[0] & 0x7f) || 1;
    const now = Date.now();
    const extensions = host
      ? [extension(19, seq(), true), extension(17, seq(der(0x82, encoder.encode(host))))]
      : [extension(19, seq(der(1, Uint8Array.of(255))), true),
         extension(15, der(3, Uint8Array.of(1, 6)), true)];
    const body = seq(der(0xa0, der(2, Uint8Array.of(2))), der(2, serial), signatureAlgorithm,
      authority, seq(time(new Date(now - 3600000)), time(new Date(now + 7 * 86400000))),
      host ? subject(host) : authority, new Uint8Array(host ? leafPub : caPub),
      der(0xa3, seq(...extensions)));
    const signature = new Uint8Array(await crypto.subtle.sign(params.name, ca.privateKey, body));
    return pem('CERTIFICATE', seq(body, signatureAlgorithm, bitString(signature)));
  }
  return { authority: await sign(), key: pem('PRIVATE KEY', new Uint8Array(leafKey)), sign };
}

function newEgress() {
  let permission = null;
  let sessionCertificates;
  const history = [];
  let generation = new AbortController();
  const hostPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  async function call(path, { method = 'GET', headers, body, signal }) {
    return fetch(gateway + path, {
      method, headers, body, signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
    });
  }
  function disable() {
    permission = null;
    generation.abort();
    generation = new AbortController();
  }
  function currentPermission() {
    if (permission && permission.expires <= Date.now() / 1000) {
      disable();
      networkStatus();
    }
    return permission;
  }
  function selectService(access, url) {
    if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password || url.hash) return;
    return access.services.find((entry) => entry.origin === 'https://' + url.hostname);
  }
  async function requestUpstream(access, url, method, headers, body, signal) {
    const service = selectService(access, url);
    if (!service) return Response.json({ error: 'destination_or_operation_denied' }, { status: 403 });
    const outbound = {
      Authorization: 'Bearer ' + access.token,
      'X-Workspace-Path': url.pathname + url.search,
      'X-Workspace-Method': method,
      'X-Workspace-Headers': JSON.stringify(headers),
    };
    if (access.gitToken && service.id === 'github' &&
        (url.pathname.toLowerCase().startsWith('/' + access.repo + '.git/') ||
         url.pathname.toLowerCase().startsWith('/' + access.repo + '/'))) {
      outbound['X-Workspace-Git-Auth'] = 'Basic ' + btoa(access.username + ':' + access.gitToken);
    }
    const response = await call('/v1/services/' + service.id, {
      method: 'POST', headers: outbound, body: ['GET', 'HEAD'].includes(method) ? undefined : body, signal,
    });
    history.unshift({ time: new Date().toISOString(), service: service.id, method, status: response.status,
      id: response.headers.get('X-Request-ID') });
    if (history.length > 30) history.pop();
    if (response.status === 401 && !response.headers.get('content-type')?.includes('application/x-git')) {
      const reason = await response.clone().json().catch(() => null);
      if (reason?.error === 'session_required') { disable(); networkStatus(); }
    }
    return response;
  }
  return {
    disable,
    get connected() { return !!currentPermission(); },
    get secrets() { return currentPermission() ? [permission.token, permission.gitToken].filter(Boolean) : []; },
    services() { return currentPermission()?.services ?? []; },
    logs() { return history.slice(); },
    expires() { return currentPermission()?.expires; },
    async enable(token, repo, username, gitToken) {
      if (token.length < 24 || token.length > 256) throw Error('Enter the workstation egress key');
      if (gitToken && (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[a-zA-Z0-9-]{1,39}$/.test(username) ||
          !/^(?:github_pat_[a-zA-Z0-9_]+|ghs_[a-zA-Z0-9]+)$/.test(gitToken))) {
        throw Error('Enter the GitHub repository, username, and a fine-grained or installation token');
      }
      if (!isSecureContext || !['https:', 'http:'].includes(location.protocol)) throw Error('Open the workstation from its HTTPS origin');
      const signal = AbortSignal.any([generation.signal, AbortSignal.timeout(15000)]);
      const response = await call('/v1/session', { method: 'POST', headers: { 'X-Workspace-Key': token }, signal });
      if (response.status !== 201) throw Error('Worker authorization failed (HTTP ' + response.status + ')');
      const session = await response.json();
      const discovered = await call('/v1/services', { headers: { Authorization: 'Bearer ' + session.token }, signal });
      if (!discovered.ok) throw Error('Worker service discovery failed (HTTP ' + discovered.status + ')');
      const services = await discovered.json();
      if (!Array.isArray(services) || !services.length) throw Error('The Worker has no configured services');
      disable();
      permission = { ...session, services, repo: repo.toLowerCase(), username, gitToken };
    },
    async browserRequest(target, method, signal) {
      const access = currentPermission();
      if (!access) throw Error('Enable authorized networking in the browser toolbar');
      return requestUpstream(access, new URL(target), method, {}, undefined,
        AbortSignal.any([generation.signal, signal ?? AbortSignal.timeout(60000)]));
    },
    async setup(vm) {
      sessionCertificates ||= certificates();
      const cert = await sessionCertificates;
      await guestExec(vm, 'mkdir -m 700 -p ' + proxyRoot);
      await guestExec(vm, 'umask 077; cat > ' + proxyRoot + '/leaf.key', { input: cert.key });
      await guestExec(vm, 'cat > ' + proxyRoot + '/ca.pem', { input: cert.authority });
    },
    async handler(ctx) {
      const [type, host] = ctx.args ?? [];
      const writer = ctx.stdout.getWriter();
      try {
        if (type === 'certificate') {
          const access = currentPermission();
          if (!access || !hostPattern.test(host) || !selectService(access, new URL('https://' + host))) return 1;
          await writer.write(await (await sessionCertificates).sign(host));
          return 0;
        }
        const signal = AbortSignal.any([ctx.signal, generation.signal, AbortSignal.timeout(65000)]);
        const parts = [];
        let size = 0;
        const reader = ctx.stdin.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > maxRequest + 16384) throw Error('Proxy request exceeds 16 MiB');
            parts.push(value);
          }
        } finally { reader.releaseLock(); }
        const bytes = concat(...parts);
        const newline = bytes.indexOf(10);
        if (type !== 'request' || newline < 0 || newline > 16384) throw Error('Invalid proxy request');
        const { target, method, headers, length } = JSON.parse(decoder.decode(bytes.subarray(0, newline)));
        const url = new URL(target);
        const body = bytes.subarray(newline + 1);
        if (length !== body.length || length > maxRequest) throw Error('Invalid proxy body');
        const access = currentPermission();
        if (!access) {
          await writer.write(JSON.stringify({ status: 403, headers: {} }) + '\n');
          await writer.write('Enable authorized networking in the browser toolbar\n');
          return 0;
        }
        const response = await requestUpstream(access, url, method, headers, body, signal);
        const safe = {};
        for (const key of ['accept-ranges', 'content-range', 'content-type', 'etag', 'last-modified', 'location']) {
          if (response.headers.has(key)) safe[key] = response.headers.get(key);
        }
        await writer.write(JSON.stringify({ status: response.status, headers: safe }) + '\n');
        if (response.body && method !== 'HEAD') {
          const stream = response.body.getReader();
          let sent = 0;
          try {
            for (;;) {
              const { value, done } = await stream.read();
              if (done) break;
              sent += value.length;
              if (sent > maxResponse) throw Error('Proxy response exceeds 64 MiB');
              await writer.write(value);
            }
          } finally { await stream.cancel().catch(() => {}); }
        }
        return 0;
      } catch {
        await writer.abort().catch(() => {});
        return 1;
      } finally {
        try { await writer.close(); } catch {}
      }
    },
  };
}

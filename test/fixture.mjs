import { spawnSync, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { handleGateway } from '../cloudflare/worker.mjs';

const port = Number(process.env.BROWSER_TEST_PORT || 18733);
const origin = 'http://127.0.0.1:' + port;
const dir = await mkdtemp(join(tmpdir(), 'pointblank-git-'));
const remote = join(dir, 'upstream.git');
const key = 'workstation-fixture-key-with-32-characters';
const user = 'fixture';
const token = 'github_pat_fixtureOnly000000000000000000000000000000';
const auth = 'Basic ' + Buffer.from(user + ':' + token).toString('base64');
let deployment = 1;
const script = '#!/bin/sh\nprintf "%s\\n" "POINTBLANK_SCRIPT_OK"\n';
const env = {
  WORKSTATION_ORIGIN: origin,
  WORKSTATION_EGRESS_TOKEN: key,
  GIT_REPOSITORIES: '{"pointblank-fixture/upstream":"write","robit-man/pointblank":"read"}',
  HTTP_DESTINATIONS: JSON.stringify([
    { id: 'alpine', origin: 'https://dl-cdn.alpinelinux.org', paths: ['/alpine/v3.24'], methods: ['GET', 'HEAD'] },
    { id: 'diagnostics', origin: 'https://fixture.example', paths: ['/smoke.sh', '/network-fixtures'], methods: ['GET', 'HEAD'] },
    { id: 'pypi', origin: 'https://pypi.org', paths: ['/simple'], methods: ['GET', 'HEAD'] },
    { id: 'pypi-files', origin: 'https://files.pythonhosted.org', paths: ['/packages'], methods: ['GET', 'HEAD'] },
    { id: 'npm', origin: 'https://registry.npmjs.org', paths: ['/is-number'], methods: ['GET', 'HEAD'] },
  ]),
};

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw Error(result.stderr || String(result.error));
  return result.stdout.trim();
}
const author = ['-c', 'user.email=test@example.test', '-c', 'user.name=Fixture'];
git(dir, 'init', '--bare', '--initial-branch=main', remote);
git(remote, 'config', 'http.receivepack', 'true');
git(dir, 'clone', remote, join(dir, 'editor'));
const editor = join(dir, 'editor');
await writeFile(join(editor, 'readme.txt'), 'original\n');
git(editor, 'add', 'readme.txt');
git(editor, ...author, 'commit', '-m', 'Seed');
git(editor, 'push', 'origin', 'main');

async function upstream(address, init) {
  const url = new URL(address);
  if (url.hostname === 'fixture.example') {
    return new Response(init.method === 'HEAD' ? null : (url.pathname.endsWith('/json') ? '{"status":"ok"}' : script), { headers: { 'content-type': 'text/plain' } });
  }
  if (url.hostname !== 'github.com' || !url.pathname.startsWith('/pointblank-fixture/')) return fetch(address, init);
  if (init.headers.get('Authorization') !== auth) return new Response('Fixture requires a scoped credential\n', { status: 401 });
  const path = url.pathname.replace(/^\/pointblank-fixture\/upstream(?:\.git)?\//, '/upstream.git/');
  const child = spawn('git', ['http-backend'], { env: {
    ...process.env, GIT_PROJECT_ROOT: dir, GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: path, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: init.method,
    CONTENT_LENGTH: String(init.body?.byteLength || 0), CONTENT_TYPE: init.headers.get('content-type') || '',
    HTTP_GIT_PROTOCOL: init.headers.get('git-protocol') || '', REMOTE_USER: user,
  }, stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.end(init.body ? Buffer.from(init.body) : undefined);
  const output = [];
  for await (const chunk of child.stdout) output.push(chunk);
  const data = Buffer.concat(output);
  const separator = data.indexOf('\r\n\r\n');
  if (separator < 0) return new Response('git http-backend failed\n', { status: 502 });
  const headers = new Headers();
  let status = 200;
  for (const line of data.subarray(0, separator).toString().split('\r\n')) {
    const colon = line.indexOf(':');
    const name = line.slice(0, colon), value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
    else headers.append(name, value);
  }
  return new Response(data.subarray(separator + 4), { status, headers });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.pathname === '/health' || url.pathname.startsWith('/v1/')) {
      const response = await handleGateway(new Request(url, {
        method: req.method, headers: req.headers,
        body: req.method === 'POST' ? Readable.toWeb(req) : undefined, duplex: 'half',
      }), env, upstream, (message) => console.log(message));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
      return;
    }
    if (url.pathname === '/test/commit') {
      const commit = git(remote, 'rev-parse', 'refs/heads/browser-test');
      const content = git(remote, 'show', 'browser-test:readme.txt');
      res.end(JSON.stringify({ commit, content }));
      return;
    }
    if (url.pathname === '/test/update' && req.method === 'POST') {
      git(editor, 'fetch', 'origin');
      git(editor, 'checkout', '-B', 'browser-test', 'origin/browser-test');
      await writeFile(join(editor, 'readme.txt'), 'updated outside the browser\n');
      git(editor, 'add', 'readme.txt');
      git(editor, ...author, 'commit', '-m', 'External update');
      git(editor, 'push', 'origin', 'browser-test');
      res.end(git(editor, 'rev-parse', 'HEAD'));
      return;
    }
    if (url.pathname === '/test/script-hash') {
      res.end(createHash('sha256').update(script).digest('hex'));
      return;
    }
    if (url.pathname === '/test/deploy' && req.method === 'POST') {
      deployment += 1;
      res.end(String(deployment));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      const html = process.env.BROWSER_TEST_HTML || 'index.html';
      if (deployment === 1) createReadStream(html).pipe(res);
      else res.end((await readFile(html, 'utf8')).replace('<title>Pointblank Linux</title>', '<title>Pointblank Linux ' + deployment + '</title>'));
      return;
    }
    res.writeHead(404).end();
  } catch (error) {
    res.writeHead(500).end(error.message);
  }
});

server.listen(port, '127.0.0.1', () => console.log('Fixture ready on ' + origin));

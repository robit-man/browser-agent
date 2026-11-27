const cache = { 'Cache-Control': 'public, max-age=0, must-revalidate, no-transform' };
const prefix = '/network-fixtures/';
const script = '#!/bin/sh\nprintf "%s\\n" "POINTBLANK_SCRIPT_OK"\n';

function diagnostics(path, request) {
  if (request.method === 'POST' && path === 'post') {
    return Response.json({ received: true }, { status: 201 });
  }
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  const payload = (body) => request.method === 'HEAD' ? null : body;
  if (path === 'json') return new Response(payload('{"status":"ok","service":"pointblank"}\n'), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (path === 'smoke.sh') return new Response(payload(script), { headers: { 'Content-Type': 'text/plain' } });
  if (path === 'binary') {
    const bytes = new Uint8Array(1048576);
    bytes.set(Uint8Array.from({ length: 251 }, (_, i) => i));
    for (let count = 251; count < bytes.length; count *= 2) bytes.set(bytes.subarray(0, Math.min(count, bytes.length - count)), count);
    return new Response(payload(bytes), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length } });
  }
  if (path === 'redirect') return Response.redirect('https://example.com/', 302);
  if (path === 'slow') return new Promise((resolve) => setTimeout(() => resolve(new Response(payload('slow\n'))), 8000));
  return new Response(payload('missing\n'), { status: 404 });
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(prefix)) return diagnostics(url.pathname.slice(prefix.length), request);
    if (url.pathname !== '/' && url.pathname !== '/index.html') return new Response('Not found', { status: 404 });
    if (request.method === 'HEAD') return new Response(null, { headers: { ...cache, 'Content-Type': 'text/html; charset=utf-8' } });
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const chunk = (name) => env.ASSETS.fetch(new Request(new URL('/' + name, url)));
    const [lengthFile, first, second] = await Promise.all([
      chunk('index-length.txt'), chunk('index-part-1.bin'), chunk('index-part-2.bin'),
    ]);
    const parts = [first, second];
    if (!lengthFile.ok || parts.some((part) => !part.ok)) {
      return new Response('Release assets are unavailable', { status: 503 });
    }
    const size = Number(await lengthFile.text());
    if (!Number.isSafeInteger(size) || size < 1) return new Response('Invalid release asset length', { status: 503 });
    const { readable, writable } = new FixedLengthStream(size);
    const append = async () => {
      for (const part of parts) await part.body.pipeTo(writable, { preventClose: true });
      await writable.close();
    };
    context.waitUntil(append().catch((error) => writable.abort(error).catch(() => {})));
    return new Response(readable, {
      headers: { ...cache, 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'identity' },
      encodeBody: 'manual',
    });
  },
};

const workspacePreviewTags = new Set((
  'a abbr address article aside b blockquote br caption cite code col colgroup dd details div dl dt em figcaption ' +
  'figure footer h1 h2 h3 h4 h5 h6 header hr i img kbd li link main mark nav ol p pre s samp section small span ' +
  'strong style sub summary sup table tbody td th thead time tr tfoot u ul var wbr'
).split(' '));
const workspacePreviewAttributes = new Set([
  'alt', 'class', 'colspan', 'datetime', 'dir', 'height', 'id', 'lang', 'open', 'role', 'rowspan', 'scope',
  'start', 'style', 'title', 'width',
]);
const workspacePreviewImages = new Set([
  'image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp', 'image/x-icon',
]);
const workspacePreviewPolicy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' blob:; " +
  "img-src blob:; font-src blob:; form-action 'none'; base-uri 'none'";

function workspacePreviewURL(value, base) {
  const target = new URL(value, base);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname) ||
      target.port !== base.port || target.username || target.password || target.pathname.startsWith('//')) {
    throw Error('The address leaves the selected guest origin');
  }
  target.hostname = '127.0.0.1';
  return target;
}

async function workspacePreviewFetch(url, job) {
  for (let redirects = 0; redirects <= 4; redirects++) {
    job.signal.throwIfAborted();
    if (++job.requests > 48) throw Error('Preview exceeds 48 requests');
    const reply = await workspaceTool('preview', {
      port: Number(url.port || 80),
      path: url.pathname + url.search,
    }, { limit: 8 * MiB + 4096, timeout: 16000, signal: job.signal });
    const header = await reply.slice(0, 4096).text();
    const line = header.indexOf('\n');
    if (line < 0) throw Error('Invalid guest response');
    const { status, type, location } = JSON.parse(header.slice(0, line));
    if (status >= 300 && status < 400 && location) {
      url = workspacePreviewURL(location, url);
      continue;
    }
    const body = reply.slice(line + 1, undefined, type);
    job.loaded += body.size;
    if (job.loaded > 24 * MiB) throw Error('Preview exceeds 24 MiB');
    return { status, type, body, url };
  }
  throw Error('The guest server redirected too many times');
}

function workspacePreviewBlob(blob, job) {
  const url = URL.createObjectURL(blob);
  job.urls.push(url);
  return url;
}

// The template is inert. Only sanitized nodes reach the script-disabled iframe.
async function renderWorkspacePreview(reply, job) {
  const template = document.createElement('template');
  const cache = new Map();
  async function resource(value, base, kind) {
    try {
      const target = workspacePreviewURL(value, base);
      target.hash = '';
      const key = target.href + ' ' + kind;
      if (!cache.has(key)) {
        cache.set(key, (async () => {
          const asset = await workspacePreviewFetch(target, job);
          if (asset.status < 200 || asset.status >= 300) throw Error('Resource is unavailable');
          if (kind === 'css' && asset.type === 'text/css') {
            return workspacePreviewBlob(new Blob([await css(await asset.body.text(), asset.url)], { type: 'text/css' }), job);
          }
          if (kind !== 'css' && (workspacePreviewImages.has(asset.type) ||
              (kind === 'style' && /^font\/woff2?$/.test(asset.type)))) {
            return workspacePreviewBlob(asset.body, job);
          }
          throw Error('Resource type is unavailable');
        })());
      }
      return await cache.get(key);
    } catch {
      job.signal.throwIfAborted();
      job.missing = true;
      return '';
    }
  }

  async function css(text, base) {
    let output = '', offset = 0;
    for (const match of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi)) {
      output += text.slice(offset, match.index);
      const url = await resource(match[1] ?? match[2] ?? match[3], base, 'style');
      output += url ? 'url("' + url + '")' : 'none';
      offset = match.index + match[0].length;
    }
    return output + text.slice(offset);
  }

  if (['text/html', 'application/xhtml+xml'].includes(reply.type)) {
    const input = await reply.body.text();
    template.innerHTML = input;
    const elements = template.content.querySelectorAll('*');
    if (elements.length > 10000) throw Error('The page contains too many elements to preview');
    if (template.content.querySelector('script, iframe, form')) job.inactive = true;
    for (const element of elements) {
      job.signal.throwIfAborted();
      if (!template.content.contains(element)) continue;
      const name = element.localName;
      if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !workspacePreviewTags.has(name)) {
        element.remove();
        continue;
      }
      const href = element.getAttribute('href');
      const src = element.getAttribute('src');
      const stylesheet = name === 'link' && element.rel.toLowerCase() === 'stylesheet';
      for (const attribute of [...element.attributes]) {
        if (!workspacePreviewAttributes.has(attribute.name) && !attribute.name.startsWith('aria-')) {
          element.removeAttribute(attribute.name);
        }
      }
      if (element.hasAttribute('style')) {
        element.setAttribute('style', await css(element.getAttribute('style'), reply.url));
      }
      if (name === 'style') {
        element.textContent = (await css(element.textContent, reply.url)).replaceAll('<', '\\3c ');
      } else if (name === 'link') {
        const url = href && stylesheet && await resource(href, reply.url, 'css');
        if (url) { element.rel = 'stylesheet'; element.href = url; }
        else element.remove();
      } else if (name === 'img' && src) {
        const url = await resource(src, reply.url, 'image');
        if (url) element.src = url;
      } else if (name === 'a' && href) {
        try {
          const target = workspacePreviewURL(href, reply.url);
          element.href = 'about:srcdoc';
          element.dataset.previewTarget = target.href;
        } catch { /* External link labels remain readable. */ }
      }
    }
  } else if (reply.type.startsWith('text/') || reply.type === 'application/json' || reply.type.endsWith('+json')) {
    const text = document.createElement('pre');
    text.textContent = await reply.body.text();
    template.content.append(text);
  } else if (workspacePreviewImages.has(reply.type)) {
    const image = document.createElement('img');
    image.src = workspacePreviewBlob(reply.body, job);
    template.content.append(image);
  } else {
    throw Error('The response format cannot be displayed in this preview');
  }
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="' + workspacePreviewPolicy + '">' +
    '<style>img{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>' +
    template.innerHTML + '</body></html>';
}

function installWorkspacePreview() {
  const dialog = byId('workspace-preview-dialog');
  const form = byId('workspace-preview-form');
  const port = byId('workspace-preview-port');
  const path = byId('workspace-preview-path');
  const frame = byId('workspace-preview-frame');
  const result = byId('workspace-preview-status');
  const back = byId('workspace-preview-back');
  const refresh = byId('workspace-preview-refresh');
  const history = [];
  let pending, screen;

  function release(job) {
    for (const url of job.urls) URL.revokeObjectURL(url);
    job.urls.length = 0;
  }

  function update() {
    back.disabled = !!pending || !history.length;
    refresh.disabled = !!pending || !screen;
  }

  async function open(url, record = true) {
    if (pending) pending.controller.abort();
    const controller = new AbortController();
    const job = { controller, signal: controller.signal, urls: [], requests: 0, loaded: 0, missing: false, inactive: false };
    pending = job;
    update();
    result.textContent = 'Connecting to the guest server…';
    try {
      const reply = await workspacePreviewFetch(url, job);
      const html = await renderWorkspacePreview(reply, job);
      job.signal.throwIfAborted();
      if (screen) {
        if (record && screen.url.href !== reply.url.href) history.push(screen.url);
        release(screen);
      }
      screen = { url: reply.url, urls: job.urls };
      port.value = reply.url.port || '80';
      path.value = reply.url.pathname + reply.url.search + reply.url.hash;
      frame.srcdoc = html;
      frame.hidden = false;
      result.textContent = 'HTTP ' + reply.status +
        (job.inactive ? ' · Static preview' : '') + (job.missing ? ' · Some resources unavailable' : '');
    } catch (error) {
      release(job);
      if (!job.signal.aborted) result.textContent = error.message;
    } finally {
      if (pending === job) { pending = undefined; update(); }
    }
  }

  frame.addEventListener('load', () => {
    const view = frame.contentDocument;
    if (!view || !screen) return;
    function scrollToFragment(hash) {
      if (!hash) return;
      try { view.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView(); } catch {}
    }
    view.addEventListener('click', event => {
      const link = event.target.closest?.('a[data-preview-target]');
      if (!link) return;
      event.preventDefault();
      const target = workspacePreviewURL(link.dataset.previewTarget, screen.url);
      if (target.pathname === screen.url.pathname && target.search === screen.url.search && target.hash) {
        scrollToFragment(target.hash);
      } else void open(target);
    });
    scrollToFragment(screen.url.hash);
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    try {
      const number = Number(port.value);
      if (!Number.isInteger(number) || number < 1 || number > 65535 || number === 18791) {
        throw Error('Choose an HTTP port other than the workspace gateway port');
      }
      if (!path.value.startsWith('/') || path.value.startsWith('//')) throw Error('Enter a path starting with /');
      const base = new URL('http://127.0.0.1:' + number);
      void open(workspacePreviewURL(path.value, base));
    } catch (error) { result.textContent = error.message; }
  });
  back.addEventListener('click', () => { if (history.length) void open(history.pop(), false); });
  refresh.addEventListener('click', () => { if (screen) void open(screen.url, false); });
  byId('open-workspace-preview').addEventListener('click', () => dialog.showModal());
  dialog.addEventListener('close', () => {
    pending?.controller.abort();
    pending = undefined;
    if (screen) release(screen);
    screen = undefined;
    history.length = 0;
    frame.removeAttribute('srcdoc');
    frame.hidden = true;
    result.textContent = '';
    update();
  });
}

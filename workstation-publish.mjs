const publicationOrigin = 'https://pointblank-linux-publish.pointblank-connect.workers.dev';
const publicationProtocol = 'pointblank-publish-v1';
const publicationControl = '/__pointblank_publish/';
let workspacePublication;

function adaptPublicationTransport(source) {
  // Fetch Request and Response guards strip Cookie and Set-Cookie. The
  // loopback HTTP codec can carry those headers for an authorized publication.
  const start = source.indexOf('async function cl(e,t,n){');
  const marker = 'throw te(e),e}if(E.kind===`none`)';
  const end = source.indexOf(marker, start);
  if (start < 0 || end <= start) throw Error('The bundled guest HTTP codec changed');
  let wire = source.slice(start, end + marker.length);
  wire = replaceRequired(wire, 'a=new URL(i.url);',
    'a=new URL(i.url),publishHeaders=n?.workstationPublication?.headers??i.headers;');
  wire = replaceRequired(wire, 'i.headers.get(`host`)', 'publishHeaders.get(`host`)');
  wire = replaceRequired(wire, 'of i.headers)', 'of publishHeaders)');
  wire = replaceRequired(wire, 'i.headers.has(`accept-encoding`)', 'publishHeaders.has(`accept-encoding`)');
  wire = replaceRequired(wire, marker, 'throw te(e),e}n?.workstationPublication?.capture(D);if(E.kind===`none`)');
  return source.slice(0, start) + wire + source.slice(end + marker.length);
}

function publishConnector(port, authorization) {
  const endpoint = new URL(publicationControl + 'connect', publicationOrigin);
  endpoint.protocol = 'wss:';
  const socket = new WebSocket(endpoint, [publicationProtocol, authorization.token]);
  socket.binaryType = 'arraybuffer';
  const jobs = new Map();
  const guestOrigin = new URL('http://127.0.0.1:' + port).origin;
  const controller = new AbortController();
  const signal = AbortSignal.any([authorization.signal, controller.signal]);
  let start, fail;
  const connection = { port, url: '', close: () => controller.abort() };
  const ready = new Promise((resolve, reject) => { start = resolve; fail = reject; });
  const timer = setTimeout(() => {
    fail(Error('Publication could not connect. Check gateway authorization and whether a server is already published.'));
    connection.close();
  }, 12000);
  function send(message) {
    if (!signal.aborted && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
  function abortJob(job) {
    job.controller.abort();
    job.ack?.();
  }
  signal.addEventListener('abort', () => {
    for (const job of jobs.values()) abortJob(job);
    socket.close();
  }, { once: true });
  socket.addEventListener('close', () => {
    clearTimeout(timer);
    fail(Error('Publication was rejected or disconnected. Only one server can publish at a time.'));
    connection.close();
    if (workspacePublication === connection) workspacePublication = undefined;
  });

  async function serve(message, job, body) {
    const { id } = message;
    const active = AbortSignal.any([signal, job.controller.signal]);
    try {
      const target = new URL(message.path, guestOrigin);
      if (target.origin !== guestOrigin || target.username || target.password) throw Error('Guest origin mismatch');
      let headers;
      const response = await runtime.vm.fetch(target.href, {
        method: message.method, body, signal: active, redirect: 'manual',
        workstationPublication: {
          headers: new Headers(message.headers),
          capture(value) { headers = value; },
        },
      });
      if (headers.has('location')) {
        const next = new URL(headers.get('location'), guestOrigin);
        if (next.origin === guestOrigin ||
            (next.hostname === 'localhost' && Number(next.port || 80) === port && next.protocol === 'http:')) {
          headers.set('location', next.pathname + next.search + next.hash);
        }
      }
      const pairs = Array.from(headers).filter(([name]) => name !== 'set-cookie');
      for (const cookie of headers.getSetCookie()) pairs.push(['set-cookie', cookie]);
      send({ kind: 'headers', id, status: response.status, headers: pairs });

      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (let i = 0; i < value.length; i += 65536) {
              active.throwIfAborted();
              const bytes = value.subarray(i, i + 65536);
              const frame = new Uint8Array(4 + bytes.length);
              new DataView(frame.buffer).setUint32(0, id);
              frame.set(bytes, 4);
              await new Promise(resolve => {
                job.ack = resolve;
                socket.send(frame);
              });
              job.ack = undefined;
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      send({ kind: 'end', id });
    } catch {
      if (!active.aborted) send({ kind: 'error', id });
    } finally { jobs.delete(id); }
  }

  socket.addEventListener('message', event => {
    if (signal.aborted) return;
    if (event.data instanceof ArrayBuffer) {
      if (event.data.byteLength < 5 || event.data.byteLength > 1024 * 1024 + 4) return connection.close();
      const id = new DataView(event.data).getUint32(0);
      const job = jobs.get(id);
      if (job?.websocket) {
        const view = new Uint8Array(event.data);
        try {
          if (!job.send || view.byteLength > 65540) throw Error('Unexpected WebSocket frame');
          void job.send(view[4] === 1, view.subarray(5)).catch(() => abortJob(job));
        } catch { abortJob(job); }
      } else if (job?.message) {
        const message = job.message;
        job.message = undefined;
        void serve(message, job, new Uint8Array(event.data, 4));
      }
      return;
    }
    let message;
    try { message = JSON.parse(event.data); } catch { return connection.close(); }
    const { kind, id } = message;
    if (kind === 'ready' && !connection.url) {
      if (typeof message.url !== 'string' ||
          !message.url.startsWith(publicationOrigin + publicationControl + 'open/')) return connection.close();
      clearTimeout(timer);
      connection.url = message.url;
      start(connection);
    } else if (kind === 'websocket' && !jobs.has(id) && jobs.size < 8) {
      const job = { controller: new AbortController(), websocket: true };
      jobs.set(id, job);
      const active = AbortSignal.any([signal, job.controller.signal]);
      const target = new URL(message.path, guestOrigin);
      if (target.origin !== guestOrigin) {
        send({ kind: 'error', id });
        jobs.delete(id);
        return;
      }
      void openGuestWebSocket(runtime.vm, target, message.headers, active, {
        open(selected, sendGuest) {
          job.send = sendGuest;
          send({ kind: 'ws-open', id, selected });
        },
        message(isText, bytes) {
          if (socket.bufferedAmount > 1024 * 1024) throw Error('Publication relay is busy');
          const frame = new Uint8Array(5 + bytes.length);
          new DataView(frame.buffer).setUint32(0, id);
          frame[4] = isText ? 1 : 0;
          frame.set(bytes, 5);
          socket.send(frame);
        },
      }).then(() => send({ kind: 'end', id }), () => send({ kind: 'error', id }))
        .finally(() => jobs.delete(id));
    } else if (kind === 'request' && !jobs.has(id) && jobs.size < 8) {
      const job = { controller: new AbortController(), message: message.hasBody ? message : undefined };
      jobs.set(id, job);
      if (!message.hasBody) void serve(message, job);
    } else if (kind === 'ack') {
      jobs.get(id)?.ack?.();
    } else if (kind === 'cancel') {
      const job = jobs.get(id);
      if (job) {
        abortJob(job);
        if (job.message) jobs.delete(id);
      }
    }
  });

  return { connection, ready };
}

async function publishCommand(context) {
  const [action = 'status', extra] = context.args ?? [];
  const writer = context.stdout.getWriter();
  let result = 0;
  try {
    if (extra !== undefined) throw Error('Usage: publish PORT | status | off');
    if (action === 'status') {
      const current = workspacePublication;
      await writer.write(current ? 'Publishing guest port ' + current.port + '\n' + current.url + '\n' : 'Publication is off\n');
    } else if (action === 'off') {
      workspacePublication?.close();
      workspacePublication = undefined;
      await writer.write('Publication stopped\n');
    } else {
      const port = Number(action);
      if (!/^\d{1,5}$/.test(action) || !Number.isInteger(port) || port < 1 || port > 65535 || port === 18791) {
        throw Error('Choose an HTTP port other than the workspace gateway port');
      }
      if (workspacePublication) throw Error('Run publish off before publishing another port');
      if (location.origin !== 'https://linux.pointblankllc.com') throw Error('Open the hosted Linux workstation to publish a port');
      const authorization = egress.publicationAuthorization();
      if (!authorization) throw Error('Use Networking → Authorize before publishing a port');
      const check = await runtime.vm.connect(port, { signal: AbortSignal.timeout(5000) })
        .catch(error => { throw Error('Could not reach guest port ' + port + ' (' + error.message + ')'); });
      await check.close();
      if (!confirm('Publish guest port ' + port + '? Anyone with the link can access this server until you stop publishing.')) {
        throw Error('Publication canceled');
      }
      const { connection, ready } = publishConnector(port, authorization);
      workspacePublication = connection;
      const interrupt = () => connection.close();
      context.signal?.addEventListener('abort', interrupt, { once: true });
      try {
        await ready;
      } catch (error) {
        if (workspacePublication === connection) workspacePublication = undefined;
        throw error;
      } finally { context.signal?.removeEventListener('abort', interrupt); }
      await writer.write('Publishing guest port ' + port + '\n' + connection.url + '\n');
      await writer.write('Run publish off to stop. Keep this browser tab open.\n');
    }
  } catch (error) {
    result = 1;
    await writer.write(error.message + '\n');
  } finally { await writer.close(); }
  return result;
}

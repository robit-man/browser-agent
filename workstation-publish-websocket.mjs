const guestWebSocketLimit = 65535;
const guestWebSocketGUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const guestWebSocketText = new TextDecoder('utf-8', { fatal: true });

function guestSocketReader(reader) {
  let buffer = new Uint8Array();
  async function fill() {
    const { done, value } = await reader.read();
    if (done) throw Error('Guest closed the connection');
    if (!buffer.length) { buffer = value; return; }
    const next = new Uint8Array(buffer.length + value.length);
    next.set(buffer);
    next.set(value, buffer.length);
    buffer = next;
  }
  const take = count => {
    const head = buffer.subarray(0, count);
    buffer = buffer.subarray(count);
    return head;
  };
  return {
    async headers() {
      for (;;) {
        for (let i = 0; i + 3 < buffer.length; i++) {
          if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
            return decoder.decode(take(i + 4));
          }
        }
        if (buffer.length >= 16384) throw Error('Guest upgrade header is too large');
        await fill();
      }
    },
    async bytes(count) {
      while (buffer.length < count) await fill();
      return take(count);
    },
  };
}

function maskGuestFrame(opcode, bytes) {
  const length = bytes.length;
  const offset = length < 126 ? 2 : 4;
  const frame = new Uint8Array(offset + 4 + length);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | (offset === 2 ? length : 126);
  if (offset === 4) new DataView(frame.buffer).setUint16(2, length);
  const mask = crypto.getRandomValues(frame.subarray(offset, offset + 4));
  for (let i = 0; i < length; i++) frame[offset + 4 + i] = bytes[i] ^ mask[i % 4];
  return frame;
}

async function openGuestWebSocket(vm, target, requestHeaders, signal, handlers) {
  const port = Number(target.port || 80);
  const socket = await vm.connect(port, { signal });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const incoming = guestSocketReader(reader);
  let writes = 0;
  function close() {
    void Promise.resolve(socket.close()).catch(() => {});
  }
  signal.addEventListener('abort', close, { once: true });
  function send(opcode, bytes) {
    if (bytes.length > guestWebSocketLimit || writes >= 16) throw Error('Guest WebSocket transfer limit exceeded');
    writes++;
    return writer.write(maskGuestFrame(opcode, bytes)).finally(() => { writes--; });
  }
  try {
    signal.throwIfAborted();
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const headers = new Headers(requestHeaders);
    const protocols = (headers.get('sec-websocket-protocol') || '').split(',').map(value => value.trim()).filter(Boolean);
    for (const name of [...headers.keys()]) {
      if (name.startsWith('sec-websocket-') || name === 'host' || name === 'expect') headers.delete(name);
    }
    headers.set('host', target.host);
    headers.set('connection', 'Upgrade');
    headers.set('upgrade', 'websocket');
    headers.set('sec-websocket-key', key);
    headers.set('sec-websocket-version', '13');
    if (protocols.length) headers.set('sec-websocket-protocol', protocols.join(', '));
    const header = 'GET ' + target.pathname + target.search + ' HTTP/1.1\r\n' +
      Array.from(headers, ([name, value]) => name + ': ' + value + '\r\n').join('') + '\r\n';
    await writer.write(encoder.encode(header));

    const [status, ...fields] = (await incoming.headers()).trimEnd().split('\r\n');
    if (!/^HTTP\/1\.[01] 101\b/.test(status)) throw Error('Guest refused the WebSocket upgrade');
    const response = new Headers(fields.map(field => {
      const colon = field.indexOf(':');
      return [field.slice(0, colon), field.slice(colon + 1).trim()];
    }));
    const accepted = btoa(String.fromCharCode(...new Uint8Array(
      await crypto.subtle.digest('SHA-1', encoder.encode(key + guestWebSocketGUID)),
    )));
    const selected = response.get('sec-websocket-protocol') || '';
    if (response.get('sec-websocket-accept') !== accepted ||
        response.get('upgrade')?.toLowerCase() !== 'websocket' ||
        !response.get('connection')?.toLowerCase().split(',').some(value => value.trim() === 'upgrade') ||
        response.has('sec-websocket-extensions') || (selected && !protocols.includes(selected))) {
      throw Error('Guest returned an invalid WebSocket handshake');
    }
    handlers.open(selected, (text, bytes) => send(text ? 1 : 2, bytes));

    let fragments = [], total = 0, type;
    while (!signal.aborted) {
      const [first, second] = await incoming.bytes(2);
      const final = !!(first & 0x80);
      const opcode = first & 15;
      let length = second & 127;
      if (first & 0x70 || second & 0x80 || length === 127 || (opcode >= 8 && (!final || length > 125))) {
        throw Error('Unsupported guest WebSocket frame');
      }
      if (length === 126) {
        const extended = await incoming.bytes(2);
        length = extended[0] * 256 + extended[1];
      }
      const data = await incoming.bytes(length);
      if (opcode === 8) {
        await send(8, data);
        return;
      }
      if (opcode === 9) { await send(10, data); continue; }
      if (opcode === 10) continue;
      if (opcode !== 0) {
        if (type || (opcode !== 1 && opcode !== 2)) throw Error('Invalid guest WebSocket opcode');
        type = opcode;
      } else if (!type) throw Error('Invalid guest WebSocket continuation');
      if ((total += length) > guestWebSocketLimit) throw Error('Guest WebSocket message exceeds 65535 bytes');
      fragments.push(data);
      if (final) {
        const payload = new Uint8Array(total);
        let offset = 0;
        for (const part of fragments) { payload.set(part, offset); offset += part.length; }
        if (type === 1) guestWebSocketText.decode(payload);
        handlers.message(type === 1, payload);
        fragments = [];
        total = 0;
        type = undefined;
      }
    }
  } finally {
    signal.removeEventListener('abort', close);
    close();
    reader.releaseLock();
    writer.releaseLock();
  }
}

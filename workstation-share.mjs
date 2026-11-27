const shareBytes = new TextEncoder();
const shareOrigin = 'https://tty.pointblankllc.com/';
const shareQueueLimit = 1048576;
const maxSharePeers = 6;
const shareCursorColors = ['#a7edc1', '#a5d8ff', '#ffcba7', '#e0c5ff', '#ffe48a', '#ffb7cc', '#b9e8e8'];

function installTerminalSharing(workspace) {
  const api = window.TTYShare;
  if (!api) throw Error('TTY sharing transport did not load.');
  const { kind, pack, unpack } = api;
  const dialog = byId('share-dialog');
  const pinFields = [...dialog.querySelectorAll('.share-pin-cell')];
  const clearPin = () => pinFields.forEach((field) => { field.value = ''; });
  const flows = new Set();
  const abort = new AbortController();
  const on = (id, type, fn) => byId(id).addEventListener(type, fn, { signal: abort.signal });
  let subject, pending, connecting = false, camera, cameraFrame, scanGeneration = 0;

  function usable(session) { return session?.state === 'online' && !session.guest && !session.maintenance; }
  function canOffer(session) { return usable(session) && session.shares.size < maxSharePeers; }
  function message(text) { byId('share-status').textContent = text; }
  function permissions(prefix) {
    return { view: byId(prefix + 'view').checked, write: byId(prefix + 'write').checked };
  }

  function stopCamera() {
    scanGeneration++;
    cancelAnimationFrame(cameraFrame);
    for (const track of camera?.getTracks() ?? []) track.stop();
    camera = undefined;
    const video = byId('share-camera');
    video.srcObject = null;
    video.hidden = true;
    byId('share-scan').textContent = 'Scan invite QR';
  }

  function setTab(join) {
    byId('share-tab').setAttribute('aria-selected', String(!join));
    byId('share-connect-tab').setAttribute('aria-selected', String(join));
    byId('share-panel').hidden = join;
    byId('share-join').hidden = !join;
    if (!join) stopCamera();
  }

  function draw() {
    const flow = pending;
    byId('share-generate').disabled = Boolean(flow) || !workspace.canAdd() && !usable(subject);
    byId('share-invitation').hidden = !flow?.invite || Boolean(flow.request);
    byId('share-approval').hidden = !flow?.request;
    byId('share-mode').options[1].disabled = !canOffer(subject);
    if (!canOffer(subject)) byId('share-mode').value = 'request';
    byId('share-offer-limits').hidden = byId('share-mode').value !== 'give';
    byId('share-verify').disabled = Boolean(flow) || !workspace.canAdd() && byId('share-mode').value === 'request';
    const list = byId('share-peers');
    list.replaceChildren();
    for (const link of flows) {
      if (!link.approved || !link.session) continue;
      const row = document.createElement('li');
      row.className = 'share-peer';
      const label = document.createElement('span');
      label.textContent = link.session.name + ' · ' + (link.permissions.write
        ? (link.permissions.view ? 'View and control' : 'Control only') : 'View only');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Disconnect';
      button.addEventListener('click', () => end(link, 'Terminal sharing ended.'));
      row.append(label, button);
      list.append(row);
    }
  }

  function open(session, url) {
    subject = usable(session) ? session : undefined;
    byId('share-invite-hint').textContent = subject
      ? 'Create a one-time invite to ' + subject.name + '. Approve access when the peer enters the PIN.'
      : 'Create a one-time invite to receive a terminal.';
    if (!dialog.open) {
      message('');
      setTab(Boolean(url));
      if (url) byId('share-link').value = url;
      dialog.showModal();
      if (url && !coarsePointer.matches) pinFields[0].focus();
    }
    draw();
  }

  function end(flow, reason, notify = true) {
    if (flow.ended) return;
    flow.ended = true;
    clearInterval(flow.countdown);
    clearTimeout(flow.screenDeadline);
    flows.delete(flow);
    if (pending === flow) pending = undefined;
    const session = flow.session;
    if (flow.owner) {
      session.shares.delete(flow);
      setCursor(session, flow.peerId, null);
      broadcastCursor(session, flow.peerId, null);
      session.share.dataset.shared = String(session.shares.size > 0);
    } else if (session) {
      session.cursorLayer.replaceChildren();
      session.cursors.clear();
      session.panel.dataset.state = session.state = 'ended';
      session.term.options.disableStdin = true;
      session.term.writeln('\r\n[' + reason + ']');
    }
    if (notify) {
      if (flow.invite) flow.invite.close(reason);
      else flow.pair?.close(reason);
    }
    if (dialog.open) message(reason);
    draw();
  }

  function startFlow() {
    const flow = { subject };
    flows.add(flow);
    pending = flow;
    draw();
    return flow;
  }

  function showPeerScreen(flow) {
    if (flow.ended || flow.buffer) return;
    const session = flow.session;
    const term = session.term;
    flow.buffer = [];
    flow.queued = 0;
    term.write('', () => {
      if (flow.ended) return;
      try {
        let screen = null;
        if (flow.permissions.view) {
          screen = session.serializer.serialize({ scrollback: 0 });
          flow.capturedAlternate = term.buffer.active.type === 'alternate';
          if (flow.capturedAlternate) {
            const hidden = session.serializer.serialize({ scrollback: 0, excludeAltBuffer: true, excludeModes: true });
            screen = screen.slice(hidden.length);
          }
        }
        flow.pair.send(kind.screen, pack({ cols: term.cols, rows: term.rows, user: 'alpine', screen,
          permissions: flow.permissions, peerId: flow.peerId }));
        if (!flow.screenSent && flow.permissions.view) {
          if (session.cursor) flow.pair.send(kind.cursor, pack({ peer: 0, position: session.cursor }));
          for (const [peer, cursor] of session.cursors) {
            if (peer !== flow.peerId) flow.pair.send(kind.cursor, pack({ peer, position: cursor.position }));
          }
        }
        flow.screenSent = true;
        for (const [type, bytes] of flow.buffer) send(flow, type, bytes);
        flow.buffer = null;
      } catch { end(flow, 'Could not capture the terminal screen.'); }
    });
  }

  function activate(flow, owner) {
    flow.approved = true;
    pending = undefined;
    clearInterval(flow.countdown);
    if (owner) {
      if (!canOffer(flow.subject)) { end(flow, 'The selected terminal is unavailable.'); return; }
      const session = flow.session = flow.subject;
      flow.owner = true;
      flow.peerId = session.nextPeer++;
      session.shares.add(flow);
      session.share.dataset.shared = 'true';
      message('Peer ' + flow.peerId + ' connected.');
      showPeerScreen(flow);
    } else {
      message('Opening the shared terminal…');
      flow.screenDeadline = setTimeout(() => end(flow, 'The peer did not send a terminal.'), 15000);
    }
    draw();
  }

  function send(flow, type, bytes) {
    for (let start = 0; start < bytes.length && !flow.ended; start += 32768) {
      void flow.pair.send(type, bytes.subarray(start, start + 32768));
    }
  }

  function mirror(flow, type, bytes) {
    if (flow.ended) return;
    if (!flow.buffer) { send(flow, type, bytes); return; }
    flow.queued += bytes.length;
    if (flow.queued > shareQueueLimit) end(flow, 'The terminal changed too quickly to share.');
    else flow.buffer.push([type, bytes.slice()]);
  }

  function size(bytes) {
    const frame = unpack(bytes);
    const { cols, rows } = frame;
    if (!Number.isInteger(cols) || cols < 1 || cols > 1024 || !Number.isInteger(rows) || rows < 1 || rows > 512 ||
        cols * rows > 65536) throw Error('Invalid shared terminal size.');
    return frame;
  }

  function writeRemote(flow, data) {
    const session = flow.session;
    flow.writes = (flow.writes || 0) + data.length;
    if (flow.writes > shareQueueLimit) { end(flow, 'The shared terminal sent too much output.'); return; }
    session.term.write(data, () => { flow.writes -= data.length; });
  }

  function receive(flow, type, bytes) {
    if (!flow.approved || flow.ended) return;
    const session = flow.session;
    if (type === kind.cursor) {
      if (flow.screenSent && flow.permissions.view) receiveCursor(flow, bytes);
      return;
    }
    if (flow.owner) {
      if (type === kind.input && flow.permissions.write && bytes.length <= 65536 && usable(session)) {
        flow.inputBytes = (flow.inputBytes || 0) + bytes.length;
        if (flow.inputBytes > shareQueueLimit) { end(flow, 'The terminal cannot keep up with shared input.'); return; }
        Promise.resolve(session.pty.write(bytes)).catch(() => end(flow, 'The Alpine shell stopped accepting input.'))
          .finally(() => { flow.inputBytes -= bytes.length; });
      }
      return;
    }
    if (type === kind.screen) {
      const { cols, rows, user, screen, permissions: access, peerId } = size(bytes);
      if (!api.hasPermissions(access) || (access.view ? typeof screen !== 'string' : screen !== null) ||
          typeof user !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(user) ||
          !Number.isSafeInteger(peerId) || peerId < 1 || (flow.peerId && flow.peerId !== peerId) ||
          (flow.permissions && (flow.permissions.view !== access.view || flow.permissions.write !== access.write))) {
        end(flow, 'Invalid shared terminal screen.');
        return;
      }
      flow.permissions = access;
      flow.peerId = peerId;
      flow.screenSent = true;
      if (session) {
        session.term.write('', () => { if (!flow.ended) resizeGuestTerminal(session, cols, rows); });
        if (access.view) writeRemote(flow, '\x1bc' + screen);
      } else {
        if (!workspace.canAdd()) { end(flow, 'Close a terminal before receiving another session.'); return; }
        clearTimeout(flow.screenDeadline);
        flow.session = workspace.addGuest(user, cols, rows, flow);
        if (access.view) writeRemote(flow, screen);
        else flow.session.term.writeln('Write-only terminal. Output is hidden.');
        dialog.close();
        if (!coarsePointer.matches) requestAnimationFrame(() => {
          if (!flow.ended) workspace.focus(flow.session);
        });
      }
    } else if (session && type === kind.output && flow.permissions.view) writeRemote(flow, bytes);
    else if (session && type === kind.resize) {
      const { cols, rows } = size(bytes);
      session.term.write('', () => { if (!flow.ended) resizeGuestTerminal(session, cols, rows); });
    } else if (type === kind.output || type === kind.resize) end(flow, 'The shared terminal screen was missing.');
  }

  function validCursor(position) {
    return position === null || (Array.isArray(position) && position.length === 2 &&
      position.every((coordinate) => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1));
  }

  function setCursor(session, peer, position) {
    let cursor = session.cursors.get(peer);
    if (!position) {
      cursor?.element.remove();
      session.cursors.delete(peer);
      return;
    }
    if (!cursor && session.cursors.size < maxSharePeers) {
      const element = document.createElement('span');
      element.className = 'peer-cursor';
      element.textContent = peer ? '↖ Peer ' + peer : '↖ Owner';
      element.style.color = shareCursorColors[peer % shareCursorColors.length];
      session.cursorLayer.append(element);
      session.cursors.set(peer, cursor = { element });
    }
    if (!cursor) return;
    cursor.position = position;
    cursor.element.style.left = position[0] * 100 + '%';
    cursor.element.style.top = position[1] * 100 + '%';
  }

  function broadcastCursor(session, peer, position) {
    const packet = pack({ peer, position });
    for (const flow of session.shares) {
      if (flow.screenSent && flow.permissions.view && flow.peerId !== peer) flow.pair.send(kind.cursor, packet);
    }
  }

  function receiveCursor(flow, bytes) {
    if (bytes.length > 160) return;
    const { position, peer } = unpack(bytes);
    if (!validCursor(position)) return;
    if (flow.owner) {
      const now = performance.now();
      if (position && now - (flow.lastCursor ?? -Infinity) < 30) return;
      flow.lastCursor = now;
      setCursor(flow.session, flow.peerId, position);
      broadcastCursor(flow.session, flow.peerId, position);
    } else if (Number.isSafeInteger(peer) && peer >= 0 && peer !== flow.peerId) setCursor(flow.session, peer, position);
  }

  function wireCursor(session) {
    const layer = session.cursorLayer = document.createElement('div');
    layer.className = 'peer-cursors';
    layer.setAttribute('aria-hidden', 'true');
    session.content.append(layer);
    session.cursors = new Map();
    const screen = session.content.querySelector('.xterm-screen');
    function publish(position) {
      session.cursor = position;
      if (!session.guest) broadcastCursor(session, 0, position);
      else if (session.guest.permissions.view && !session.guest.ended) session.guest.pair.send(kind.cursor, pack({ position }));
    }
    session.term.onRender(() => {
      layer.style.width = screen.style.width;
      layer.style.height = screen.style.height;
    });
    session.content.addEventListener('pointermove', (event) => {
      if (!session.shares.size && !session.guest) return;
      if (performance.now() - (session.lastCursor ?? -Infinity) < 40) return;
      session.lastCursor = performance.now();
      const rect = screen.getBoundingClientRect();
      const relative = [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
      const position = relative.map((coordinate) => Math.round(coordinate * 1000) / 1000);
      publish(validCursor(position) ? position : null);
    });
    session.clearCursor = () => { if (session.cursor) publish(null); };
    session.content.addEventListener('pointerleave', session.clearCursor);
  }

  async function createInvite() {
    if (pending || !dialog.open) return;
    const flow = startFlow();
    message('Connecting to the relay…');
    try {
      const invite = await api.createInvite({
        onRequest(mode, access, pair, allow) {
          if (flow.ended) { pair.close('The invite was canceled.'); return; }
          if ((mode === 'request' && !canOffer(flow.subject)) || (mode === 'give' && !workspace.canAdd())) {
            end(flow, 'This terminal cannot accept the requested sharing mode.');
            return;
          }
          flow.pair = pair;
          flow.request = { mode, access, allow };
          byId('share-limits').hidden = mode === 'give';
          byId('share-view').checked = true;
          byId('share-write').checked = false;
          byId('share-approval-detail').textContent = mode === 'request'
            ? 'A peer requests access to ' + flow.subject.name + '.'
            : 'A peer offers ' + (access.write ? (access.view ? 'view and control' : 'control only') : 'view only') + ' access.';
          byId('share-approve').textContent = mode === 'give' ? 'Accept terminal' : 'Approve and share';
          setTab(false);
          message('');
          draw();
        },
        onPacket: (type, bytes) => receive(flow, type, bytes),
        onClose: (reason) => end(flow, reason, false),
      });
      if (flow.ended) { invite.close('The invite was canceled.'); return; }
      flow.invite = invite;
      const link = new URL(shareOrigin);
      link.hash = new URL(invite.url).hash;
      byId('share-invite-url').value = link.href;
      byId('share-open-tty').href = link.href;
      byId('share-pin').textContent = invite.pin;
      const qr = byId('share-qr');
      qr.src = terminalInviteQR(link.href);
      qr.hidden = false;
      const countdown = () => {
        byId('share-expiry').textContent = 'Expires in ' + Math.max(0, Math.ceil((invite.expires - Date.now()) / 1000)) + 's';
      };
      countdown();
      flow.countdown = setInterval(countdown, 1000);
      message('');
      draw();
    } catch (error) { end(flow, 'Could not create a TTY invite. ' + error.message); }
  }

  async function join(event) {
    event.preventDefault();
    if (pending || connecting) return;
    const invite = api.parseInvite(byId('share-link').value);
    const pin = pinFields.map((field) => field.value).join('');
    const mode = byId('share-mode').value;
    const offer = mode === 'give', access = offer ? permissions('share-offer-') : null;
    if (!invite || !api.pinPattern.test(pin)) { message('Enter a valid TTY invite and four-character PIN.'); return; }
    if (offer && (!canOffer(subject) || !api.hasPermissions(access))) { message('Select a terminal and at least one permission.'); return; }
    const flow = startFlow();
    flow.permissions = access;
    connecting = true;
    stopCamera();
    clearPin();
    message('Waiting for approval…');
    try {
      const pair = await api.joinInvite(invite, pin, mode, access, {
        onReady(approved) {
          flow.pair = approved;
          if (!flow.ended) activate(flow, offer);
        },
        onPacket: (type, bytes) => receive(flow, type, bytes),
        onClose: (reason) => end(flow, reason, false),
      });
      if (flow.ended) pair.close('The connection was canceled.');
      else flow.pair = pair;
    } catch (error) { end(flow, 'Could not connect to TTY. ' + error.message); }
    finally { connecting = false; }
  }

  async function scan() {
    if (camera) { stopCamera(); return; }
    const generation = ++scanGeneration;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      if (generation !== scanGeneration || !dialog.open) { stream.getTracks().forEach((track) => track.stop()); return; }
      camera = stream;
      const video = byId('share-camera'), canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      video.srcObject = camera;
      video.hidden = false;
      byId('share-scan').textContent = 'Stop scanning';
      await video.play();
      let lastFrame = 0;
      function capture(now) {
        if (!camera || scanGeneration !== generation) return;
        if (video.readyState >= 2 && now - lastFrame > 120) {
          lastFrame = now;
          canvas.width = Math.min(640, video.videoWidth);
          canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          const result = window.TTYShareVendor.jsQR(pixels.data, canvas.width, canvas.height);
          if (result && api.parseInvite(result.data)) {
            byId('share-link').value = result.data;
            stopCamera();
            pinFields[0].focus();
            return;
          }
        }
        cameraFrame = requestAnimationFrame(capture);
      }
      cameraFrame = requestAnimationFrame(capture);
    } catch {
      if (scanGeneration === generation) {
        stopCamera();
        message('Camera unavailable. Paste the TTY invite link to connect.');
      }
    }
  }

  on('share-tab', 'click', () => setTab(false));
  on('share-connect-tab', 'click', () => setTab(true));
  on('share-mode', 'change', draw);
  on('share-generate', 'click', () => { void createInvite(); });
  on('share-join', 'submit', (event) => { void join(event); });
  on('share-scan', 'click', () => { void scan(); });
  on('share-decline', 'click', () => { if (pending) end(pending, 'The request was declined.'); });
  on('share-cancel', 'click', () => { if (pending) end(pending, 'Invite canceled.'); });
  on('share-close', 'click', () => dialog.close());
  on('share-approve', 'click', () => {
    const flow = pending;
    if (!flow?.request) return;
    const owner = flow.request.mode === 'request';
    flow.permissions = owner ? permissions('share-') : flow.request.access;
    if (!api.hasPermissions(flow.permissions)) { message('Select at least one permission.'); return; }
    if (flow.request.allow()) activate(flow, owner);
  });
  on('share-copy', 'click', async () => {
    const url = byId('share-invite-url');
    try { await navigator.clipboard.writeText(url.value); message('TTY link copied. Send the PIN separately.'); }
    catch { url.focus(); url.select(); }
  });
  on('share-dialog', 'close', () => {
    if (dialog.open) return;
    stopCamera();
    if (pending) end(pending, 'The invite was canceled.');
    clearPin();
    byId('share-pin').textContent = '';
    byId('share-invite-url').value = byId('share-link').value = '';
    byId('share-qr').removeAttribute('src');
    byId('share-open-tty').removeAttribute('href');
  });

  function enterPin(text, start) {
    const chars = [...text.toUpperCase()].filter((char) => api.pinAlphabet.includes(char));
    for (let i = 0; i < chars.length && start + i < pinFields.length; i++) pinFields[start + i].value = chars[i];
    if (chars.length) pinFields[Math.min(start + chars.length, pinFields.length - 1)].focus();
  }
  for (const [index, field] of pinFields.entries()) {
    field.addEventListener('input', () => {
      const value = field.value;
      field.value = '';
      enterPin(value, index);
    });
    field.addEventListener('paste', (event) => {
      event.preventDefault();
      const value = event.clipboardData.getData('text/plain');
      enterPin(value, value.trim().length === pinFields.length ? 0 : index);
    });
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' && !field.value && index) pinFields[index - 1].focus();
    });
  }

  function endAll() {
    stopCamera();
    for (const flow of flows) end(flow, 'Terminal sharing ended.');
  }
  window.addEventListener('pagehide', endAll, { signal: abort.signal });
  if (api.parseInvite(location.href)) {
    const invite = location.href;
    history.replaceState(history.state, '', location.pathname + location.search);
    const ready = new MutationObserver(() => {
      if (byId('add-session').disabled || byId('boot')) return;
      ready.disconnect();
      open(workspace.active(), invite);
    });
    ready.observe(byId('terminals'), { childList: true });
    abort.signal.addEventListener('abort', () => ready.disconnect(), { once: true });
  }

  return {
    open, wireCursor,
    output(session, bytes) {
      for (const flow of session.shares) if (flow.permissions.view) mirror(flow, kind.output, bytes);
    },
    resized(session, cols, rows) {
      for (const flow of session.shares) mirror(flow, kind.resize, pack({ cols, rows }));
    },
    normalBuffer(session) {
      for (const flow of session.shares) if (flow.capturedAlternate) showPeerScreen(flow);
    },
    input(session, data) {
      const flow = session.guest;
      if (flow.permissions.write && !flow.ended) send(flow, kind.input, typeof data === 'string' ? shareBytes.encode(data) : data);
    },
    endSession(session) {
      for (const flow of flows) if (flow.session === session || flow.subject === session) end(flow, 'The terminal disconnected.');
    },
    dispose() { endAll(); abort.abort(); },
  };
}

function terminalInviteQR(url) {
  const qr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = (qr.size + 8) * 6;
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) context.fillRect((x + 4) * 6, (y + 4) * 6, 6, 6);
  }
  return canvas.toDataURL('image/png');
}

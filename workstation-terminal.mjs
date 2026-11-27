const terminalLimit = 12;
const terminalFontKey = 'pointblank-linux-terminal-font';
const sidebarKey = 'pointblank-linux-sidebar';
const coarsePointer = matchMedia('(any-pointer: coarse)');
const getTerminalPreference = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const setTerminalPreference = (key, value) => { try { localStorage.setItem(key, value); } catch {} };

function terminalButton(label, className, icon) {
  const button = document.createElement('button');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.className = className;
  if (icon) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS(svg.namespaceURI, 'use');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'control-icon');
    svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', '#icon-' + icon);
    svg.append(use);
    button.append(svg);
  }
  return button;
}

function terminalLeaves(node) {
  return !node ? [] : node.axis ? [...terminalLeaves(node.first), ...terminalLeaves(node.second)] : [node];
}

function replaceTerminal(node, target, replacement) {
  if (node === target) return replacement;
  if (!node?.axis) return node;
  node.first = replaceTerminal(node.first, target, replacement);
  node.second = replaceTerminal(node.second, target, replacement);
  return !node.first || !node.second ? node.first || node.second : node;
}

async function attachTerminals(vm, firstTerm, firstFit, Terminal, Fit, WebLinks, handleInput) {
  const sessions = new Set();
  const panes = byId('panes'), app = byId('app'), tabs = byId('tabs');
  const sidebar = byId('session-sidebar'), toggle = byId('toggle-sessions');
  const fontMenu = byId('pane-font-menu'), textMenu = byId('term-menu');
  const overlay = byId('dock-targets'), trash = byId('sidebar-trash');
  const closeDialog = byId('close-terminal-dialog');
  const events = new AbortController();
  const on = (element, type, handler) => element.addEventListener(type, handler, { signal: events.signal });
  const opts = firstTerm.options;
  let tree, active, fontSession, textSession, closing, drag, renderFrame, sequence = 0, booting = true;
  const suppressedClicks = new WeakMap();
  let defaultFont = Number(getTerminalPreference(terminalFontKey)) || 13;
  defaultFont = Math.max(8, Math.min(32, defaultFont));
  const keyboard = installTerminalKeyboard(() => active, send, events.signal);
  const sharing = installTerminalSharing({
    addGuest: (name, cols, rows, flow) => {
      const session = createSession(name, flow);
      show(session, active, active ? 'right' : undefined);
      resizeGuestTerminal(session, cols, rows);
      return session;
    },
    canAdd: () => sessions.size < terminalLimit,
    active: () => active,
    focus: (session) => { if (sessions.has(session)) select(session); },
  });

  function sidebarOpen(open) {
    app.dataset.sidebarOpen = String(open);
    sidebar.inert = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = open ? 'Hide sessions' : 'Show sessions';
    toggle.setAttribute('aria-label', toggle.title);
    setTerminalPreference(sidebarKey, String(open));
    scheduleFit();
  }

  function scheduleFit() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      for (const session of terminalLeaves(tree)) fit(session);
      if (fontSession) positionMenu(fontMenu, fontSession.label.getBoundingClientRect());
    });
  }

  function fit(session) {
    if (!session.content.clientWidth || !session.content.clientHeight) return;
    if (session.guest) {
      const screen = session.content.querySelector('.xterm-screen');
      session.content.style.width = screen.style.width;
      session.content.style.height = screen.style.height;
    } else session.fit.fit();
  }

  function focus() {
    active?.term.focus();
  }

  function select(session, focusTerm = true) {
    if (active !== session) keyboard.clear();
    active = session;
    reflectSelection();
    if (focusTerm && (!coarsePointer.matches || app.dataset.keyboard === 'true')) focus();
  }

  function reflectSelection() {
    for (const session of sessions) {
      session.panel.dataset.active = String(active === session);
      session.row.dataset.selected = String(active === session);
      session.tab.setAttribute('aria-selected', String(active === session));
      session.row.dataset.touchClose = String(active === session);
    }
    for (const id of ['add-session', 'add-sidebar-session', 'split-right', 'split-down', 'maintenance-shell']) {
      byId(id).disabled = booting || sessions.size >= terminalLimit;
    }
    keyboard.update();
  }

  function listConnections() {
    const list = byId('connection-sessions');
    list.replaceChildren();
    for (const session of sessions) {
      const row = document.createElement('li');
      const button = terminalButton(session.name, 'connection-session');
      const state = document.createElement('small');
      const kind = session.guest ? 'Shared' : session.maintenance ? 'Maintenance' : 'Local';
      state.textContent = kind + ' · ' + session.state;
      button.append(session.name, state);
      button.addEventListener('click', () => show(session));
      row.append(button);
      list.append(row);
    }
  }

  function splitElement(node) {
    if (!node.axis) return node.panel;
    const split = document.createElement('div');
    split.className = 'pane-split';
    split.dataset.axis = node.axis;
    const divider = document.createElement('div');
    divider.className = 'pane-divider';
    divider.tabIndex = 0;
    divider.setAttribute('role', 'separator');
    const horizontal = node.axis === 'row';
    divider.setAttribute('aria-orientation', horizontal ? 'vertical' : 'horizontal');
    divider.setAttribute('aria-label', 'Resize split');
    function ratio(value) {
      node.ratio = Math.max(.12, Math.min(.88, value));
      split.style.setProperty('--first', node.ratio + 'fr');
      split.style.setProperty('--second', (1 - node.ratio) + 'fr');
      divider.setAttribute('aria-valuenow', String(Math.round(node.ratio * 100)));
      scheduleFit();
    }
    divider.setAttribute('aria-valuemin', '12');
    divider.setAttribute('aria-valuemax', '88');
    divider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      divider.setPointerCapture(event.pointerId);
      divider.dataset.resizing = 'true';
    });
    divider.addEventListener('lostpointercapture', () => { delete divider.dataset.resizing; });
    divider.addEventListener('pointermove', (event) => {
      if (!divider.hasPointerCapture(event.pointerId)) return;
      const rect = split.getBoundingClientRect();
      ratio(horizontal ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height);
    });
    divider.addEventListener('keydown', (event) => {
      const step = horizontal ? { ArrowLeft: -.05, ArrowRight: .05 } : { ArrowUp: -.05, ArrowDown: .05 };
      if (!(event.key in step)) return;
      event.preventDefault();
      ratio(node.ratio + step[event.key]);
    });
    ratio(node.ratio);
    split.append(splitElement(node.first), divider, splitElement(node.second));
    return split;
  }

  function draw() {
    closeFontMenu();
    panes.replaceChildren(...(tree ? [splitElement(tree)] : []));
    scheduleFit();
  }

  function show(session, target = active, edge) {
    const onScreen = terminalLeaves(tree);
    if (!edge && onScreen.includes(session)) { select(session); return; }
    if (target === session) return;
    tree = replaceTerminal(tree, session, null);
    if (!tree || !target || !terminalLeaves(tree).includes(target)) tree = session;
    else if (!edge) tree = replaceTerminal(tree, target, session);
    else {
      const before = edge === 'left' || edge === 'top';
      const axis = edge === 'left' || edge === 'right' ? 'row' : 'column';
      tree = replaceTerminal(tree, target, { axis, ratio: .5, first: before ? session : target, second: before ? target : session });
    }
    draw();
    select(session);
  }

  function minimize(session) {
    closeFontMenu();
    session.clearCursor();
    tree = replaceTerminal(tree, session, null);
    draw();
    select(terminalLeaves(tree).includes(active) ? active : terminalLeaves(tree)[0]);
  }

  function disposeSession(session) {
    sessions.delete(session);
    sharing.endSession(session);
    session.reader?.cancel().catch(() => {});
    const done = session.pty?.close();
    done?.catch(() => {});
    session.term.dispose();
    session.row.remove();
    return done;
  }

  function requestClose(session) {
    if (closeDialog.open) return;
    closing = session;
    closeDialog.returnValue = '';
    closeDialog.showModal();
    closeDialog.querySelector('button').focus();
  }

  function send(session, data) {
    if (session.state !== 'online') return;
    if (session.guest) sharing.input(session, data);
    else if (session.pty) {
      try { Promise.resolve(handleInput(data, session.pty)).catch(() => {}); } catch {}
    }
  }

  function createSession(name, guest, initial = false, maintenance = false) {
    const id = ++sequence;
    const term = initial ? firstTerm : new Terminal({ ...opts, fontSize: defaultFont, theme: { ...opts.theme } });
    const fitAddon = initial ? firstFit : new Fit();
    const content = initial ? byId('terminal') : document.createElement('div');
    const panel = document.createElement('section'), bar = document.createElement('header');
    const padded = document.createElement('div'), actions = document.createElement('div');
    const row = document.createElement('div');
    const label = terminalButton(name + ' text size', 'pane-label');
    const share = terminalButton('Share ' + name, 'pane-action pane-share', 'share');
    const fork = terminalButton('Fork ' + name + ' in the same directory', 'pane-action pane-fork', 'fork');
    const hide = terminalButton('Minimize ' + name, 'pane-minimize', 'minus');
    const close = terminalButton('Close ' + name, 'pane-close', 'close');
    const tab = terminalButton(name, 'tab-select');
    const tabClose = terminalButton('Close ' + name, 'tab-close', 'close');
    const session = { id, name, term, fit: fitAddon, content, panel, label, row, tab, share, guest, maintenance,
      state: guest ? 'online' : 'starting', shares: new Set(), nextPeer: 1 };
    sessions.add(session);
    panel.className = 'terminal-panel';
    panel.id = 'terminal-session-' + id;
    panel.dataset.guest = String(Boolean(guest));
    panel.setAttribute('aria-label', name);
    panel.dataset.state = session.state;
    bar.className = 'pane-bar';
    padded.className = 'terminal-with-padding';
    content.className = 'terminal-content';
    actions.className = 'pane-actions';
    row.className = 'tab-row';
    tab.textContent = label.textContent = name;
    label.setAttribute('aria-controls', 'pane-font-menu');
    label.setAttribute('aria-expanded', 'false');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panel.id);
    if (guest || maintenance) share.hidden = fork.hidden = true;
    row.append(tab, tabClose);
    tabs.append(row);
    actions.append(share, fork, hide, close);
    bar.append(label, actions);
    padded.append(content);
    panel.append(bar, padded);
    panes.append(panel);
    if (!initial) {
      term.loadAddon(fitAddon);
      if (!guest) term.loadAddon(new WebLinks());
      term.open(content);
    }
    if (!guest) {
      session.serializer = new window.TTYShareVendor.SerializeAddon();
      term.loadAddon(session.serializer);
      term.buffer.onBufferChange((buffer) => {
        if (buffer.type === 'normal') sharing.normalBuffer(session);
      });
    }
    if (!guest && !maintenance) term.parser.registerOscHandler(5378, (path) => {
      if (path.startsWith('/') && !/[\x00-\x1f\x7f]/.test(path) && path.length <= 4096) session.directory = path;
      return true;
    });
    term.options.fontSize = defaultFont;
    sharing.wireCursor(session);
    if (guest) {
      term.options.disableStdin = !guest.permissions.write;
      term.textarea.readOnly = !guest.permissions.write;
    }
    term.onData((data) => {
      const mapped = keyboard.apply(session, data);
      if (mapped !== data) session.resetMobileInput?.();
      send(session, mapped);
    });
    term.onBinary((data) => send(session, Uint8Array.from(data, (char) => char.charCodeAt(0))));
    term.onResize(({ cols, rows }) => {
      session.pty?.resize(cols, rows);
      sharing.resized(session, cols, rows);
    });
    wireTerminalSelection(session, showTextMenu);
    wireTerminalTouchScroll(session);
    session.resetMobileInput = wireTerminalInput(session, send);
    content.addEventListener('focusin', () => select(session, false));
    content.addEventListener('pointerdown', () => select(session, false));
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const shortcut = (event.ctrlKey || event.metaKey) && event.shiftKey;
      if (shortcut && event.code === 'KeyC' && term.hasSelection() && navigator.clipboard?.writeText) {
        event.preventDefault();
        void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (shortcut && event.code === 'KeyV' && navigator.clipboard?.readText) {
        event.preventDefault();
        void navigator.clipboard.readText().then((value) => { if (active === session) term.paste(value); }).catch(() => {});
        return false;
      }
      return !keyboard.handleKey(session, event);
    });
    tab.addEventListener('click', () => show(session));
    label.addEventListener('click', () => {
      select(session, false);
      const reopen = fontSession !== session;
      closeFontMenu();
      if (!reopen) return;
      fontSession = session;
      label.setAttribute('aria-expanded', 'true');
      fontMenu.hidden = false;
      displayFontSize();
      positionMenu(fontMenu, label.getBoundingClientRect());
    });
    fork.addEventListener('click', () => { void newShell(session, 'right', { directory: session.directory }); });
    share.addEventListener('click', () => sharing.open(session));
    hide.addEventListener('click', () => minimize(session));
    close.addEventListener('click', () => requestClose(session));
    tabClose.addEventListener('click', () => requestClose(session));
    bindDrag(tab, session);
    bindDrag(bar, session);
    return session;
  }

  async function startShell(session) {
    try {
      const command = 'cd -- "$1" 2>/dev/null || cd /workspace; ' +
        'export LANG=C.UTF-8 PS1=' + shellQuote(String.raw`\w \$ `) +
        '; exec bash --noprofile --rcfile ' + shellQuote(shellHistoryRC) + ' -i';
      const args = session.maintenance ? ['-i'] :
        ['-c', 'exec docker exec -it botpsy-alpine bash --noprofile --norc -c ' + shellQuote(command) + ' bash ' +
          shellQuote(session.directory || '/workspace')];
      const pty = await vm.spawn('sh', args, {
        cols: Math.max(1, session.term.cols), rows: Math.max(1, session.term.rows),
        env: { TERM: 'xterm-256color', HOME: '/root', PATH: '/run/kw/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/kw/bin' },
      });
      if (!sessions.has(session)) { await pty.close(); return; }
      session.pty = pty;
      session.panel.dataset.state = session.state = 'online';
      pty.resize(session.term.cols, session.term.rows);
      void pty.ended.catch(() => {});
      const reader = session.reader = pty.output.getReader();
      keyboard.update();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done || !sessions.has(session)) break;
            session.term.write(value);
            sharing.output(session, value);
          }
        } catch (error) {
          if (sessions.has(session)) session.term.writeln(String(error));
        } finally {
          if (sessions.has(session)) {
            session.panel.dataset.state = session.state = 'ended';
            session.term.writeln('\r\n[Session ended]');
            sharing.endSession(session);
            keyboard.update();
          }
        }
      })();
    } catch (error) {
      if (sessions.has(session)) {
        session.startError = error;
        session.panel.dataset.state = session.state = 'ended';
        session.term.writeln('Could not start Alpine shell: ' + error.message);
      }
    }
  }

  async function newShell(target = active, edge, { maintenance = false, directory } = {}) {
    if (sessions.size >= terminalLimit) return;
    const session = createSession((maintenance ? 'Maintenance ' : 'Alpine ') + (sequence + 1), null, false, maintenance);
    session.directory = directory;
    show(session, target, edge);
    if (sessions.size === 2) sidebarOpen(true);
    await startShell(session);
  }

  function displayFontSize() {
    const size = fontSession.term.options.fontSize;
    byId('pane-font-value').textContent = size + ' px';
    byId('pane-font-smaller').disabled = size <= 8;
    byId('pane-font-larger').disabled = size >= 32;
  }

  function closeFontMenu() {
    fontSession?.label.setAttribute('aria-expanded', 'false');
    fontMenu.hidden = true;
    fontSession = undefined;
  }

  function positionMenu(menu, rect) {
    const view = window.visualViewport;
    const left = view?.offsetLeft ?? 0;
    const top = view?.offsetTop ?? 0;
    menu.style.left = Math.max(left + 5, Math.min(rect.left, left + (view?.width ?? innerWidth) - menu.offsetWidth - 5)) + 'px';
    menu.style.top = Math.max(top + 5, Math.min(rect.bottom + 4, top + (view?.height ?? innerHeight) - menu.offsetHeight - 5)) + 'px';
  }

  for (const [id, step] of [['pane-font-smaller', -1], ['pane-font-larger', 1]]) {
    on(byId(id), 'mousedown', (event) => event.preventDefault());
    on(byId(id), 'click', () => {
      defaultFont = fontSession.term.options.fontSize += step;
      setTerminalPreference(terminalFontKey, defaultFont);
      displayFontSize();
      scheduleFit();
    });
  }

  function closeTextMenu() {
    textMenu.hidden = true;
    byId('term-paste-field').hidden = true;
    byId('term-paste-field').value = '';
  }

  function showTextMenu(session, x, y) {
    textSession = session;
    byId('term-copy').disabled = !session.term.hasSelection();
    byId('term-paste').disabled = session.state !== 'online' || Boolean(session.guest && !session.guest.permissions.write);
    byId('term-paste-field').hidden = true;
    textMenu.hidden = false;
    const { width, height } = textMenu.getBoundingClientRect();
    positionMenu(textMenu, { left: x - width / 2, bottom: y - height - 14 > 8 ? y - height - 14 : y + 10 });
  }

  on(byId('term-copy'), 'click', async () => {
    try { await navigator.clipboard.writeText(textSession.term.getSelection()); } catch {}
    closeTextMenu();
  });
  on(byId('term-paste'), 'click', async () => {
    try { textSession.term.paste(await navigator.clipboard.readText()); closeTextMenu(); }
    catch {
      byId('term-paste-field').hidden = false;
      byId('term-paste-field').focus();
    }
  });
  on(byId('term-paste-field'), 'paste', (event) => {
    event.preventDefault();
    textSession.term.paste(event.clipboardData.getData('text/plain'));
    closeTextMenu();
    focus();
  });
  on(byId('term-select-all'), 'click', () => {
    textSession.term.selectAll();
    byId('term-copy').disabled = false;
  });

  function bindDrag(element, session) {
    element.addEventListener('click', (event) => {
      if (!suppressedClicks.has(element)) return;
      if (event.detail && suppressedClicks.get(element) >= performance.now()) event.stopImmediatePropagation();
      suppressedClicks.delete(element);
    }, { capture: true });
    element.addEventListener('pointerdown', (event) => {
      suppressedClicks.delete(element);
      if (event.button !== 0 || element.disabled || (element.classList.contains('pane-bar') && event.target.closest('.pane-actions'))) return;
      drag = { element, session, id: event.pointerId, x: event.clientX, y: event.clientY };
    });
  }

  function dropTarget(x, y) {
    const bounds = byId('terminals').getBoundingClientRect();
    const bin = trash.getBoundingClientRect();
    if (!trash.hidden && x >= bin.left && x <= bin.right && y >= bin.top && y <= bin.bottom) return { trash: true };
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
    const target = terminalLeaves(tree).find((session) => {
      const rect = session.panel.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
    if (target && target === drag.session) return;
    const rect = target?.panel.getBoundingClientRect() ?? bounds;
    const dx = (x - rect.left) / rect.width - .5, dy = (y - rect.top) / rect.height - .5;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const edge = !target ? undefined : horizontal ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'top' : 'bottom');
    return { target, edge,
      left: rect.left - bounds.left + (edge === 'right' ? rect.width / 2 : 0),
      top: rect.top - bounds.top + (edge === 'bottom' ? rect.height / 2 : 0),
      width: rect.width / (edge && horizontal ? 2 : 1),
      height: rect.height / (edge && !horizontal ? 2 : 1) };
  }

  const highlight = document.createElement('div');
  highlight.className = 'dock-target';
  highlight.dataset.highlight = 'true';
  overlay.append(highlight);
  on(window, 'pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.started) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 7) return;
      drag.started = true;
      drag.element.setPointerCapture(event.pointerId);
      app.dataset.dragging = 'true';
      overlay.hidden = false;
      if (drag.session) {
        drag.session.row.dataset.dragged = 'true';
        trash.hidden = sidebar.inert;
      }
      closeFontMenu();
    }
    const drop = drag.drop = dropTarget(event.clientX, event.clientY);
    trash.dataset.over = String(Boolean(drop?.trash));
    highlight.hidden = !drop || drop.trash;
    if (!highlight.hidden) for (const key of ['left', 'top', 'width', 'height']) highlight.style[key] = drop[key] + 'px';
  });

  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const { element, started, session } = drag;
    const drop = started && event.type === 'pointerup' ? dropTarget(event.clientX, event.clientY) : undefined;
    drag = undefined;
    if (!started) return;
    suppressedClicks.set(element, performance.now() + 300);
    overlay.hidden = trash.hidden = true;
    delete app.dataset.dragging;
    if (session) delete session.row.dataset.dragged;
    if (drop?.trash && session) requestClose(session);
    else if (drop && session) show(session, drop.target, drop.edge);
    else if (drop) void newShell(drop.target, drop.edge);
  }

  on(window, 'pointerup', finishDrag);
  on(window, 'pointercancel', finishDrag);
  on(document, 'pointerdown', (event) => {
    if (!fontMenu.hidden && !fontMenu.contains(event.target) && !event.target.closest('.pane-label')) closeFontMenu();
    if (!textMenu.hidden && !textMenu.contains(event.target)) closeTextMenu();
  });
  on(document, 'keydown', (event) => {
    if (event.key === 'Escape' && (!fontMenu.hidden || !textMenu.hidden)) {
      event.stopPropagation();
      closeFontMenu();
      closeTextMenu();
    }
  });
  bindDrag(byId('add-session'), null);
  for (const id of ['add-session', 'add-sidebar-session']) on(byId(id), 'click', () => { void newShell(); });
  on(toggle, 'click', () => sidebarOpen(sidebar.inert));
  on(byId('network-settings'), 'click', listConnections);
  on(byId('split-right'), 'click', () => { void newShell(active, 'right'); });
  on(byId('split-down'), 'click', () => { void newShell(active, 'bottom'); });
  on(byId('maintenance-shell'), 'click', () => { void newShell(active, undefined, { maintenance: true }); });
  for (const id of ['share-workspace', 'connection-sharing']) on(byId(id), 'click', () => sharing.open(active));
  on(closeDialog, 'close', () => {
    if (closing && closeDialog.returnValue === 'close') {
      const session = closing;
      disposeSession(session);
      minimize(session);
    }
    closing = undefined;
  });

  const observer = new ResizeObserver(scheduleFit);
  observer.observe(panes);
  sidebarOpen(getTerminalPreference(sidebarKey) === 'true');
  const first = createSession('Alpine 1', null, true);
  show(first);
  await startShell(first);
  if (first.state !== 'online') {
    events.abort();
    observer.disconnect();
    sharing.dispose();
    throw first.startError || Error('Could not start the Alpine shell.');
  }
  booting = false;
  reflectSelection();
  return {
    focus() { if (!coarsePointer.matches) focus(); },
    get active() { return active; },
    dispose() {
      events.abort();
      observer.disconnect();
      cancelAnimationFrame(renderFrame);
      sharing.dispose();
      return Promise.allSettled([...sessions].map(disposeSession));
    },
  };
}

function resizeGuestTerminal(session, cols, rows) {
  session.term.resize(cols, rows);
  const screen = session.content.querySelector('.xterm-screen');
  session.content.style.width = screen.style.width;
  session.content.style.height = screen.style.height;
}

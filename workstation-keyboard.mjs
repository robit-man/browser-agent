// Key layout and xterm sequences from the Pointblank TTY client.
function installTerminalKeyboard(getActive, send, signal) {
  const app = byId('app'), softKeys = byId('soft-keys');
  const modifiers = {Ctrl: false, Shift: false, Alt: false};
  const modifierButtons = new Map();
  let keyboardOpen = false, normalHeight = 0, lastWidth = 0;
  function clearModifiers() {
    for (const [key, button] of modifierButtons) {
      modifiers[key] = false;
      button.setAttribute('aria-pressed', 'false');
    }
  }

  function update() {
    const viewport = window.visualViewport;
    const width = viewport?.width ?? innerWidth;
    const top = viewport?.offsetTop ?? 0;
    const bounds = navigator.virtualKeyboard?.boundingRect;
    const visibleHeight = viewport?.height ?? innerHeight;
    const height = bounds?.height && bounds.top > top ? Math.min(visibleHeight, bounds.top - top) : visibleHeight;
    if (Math.abs(width - lastWidth) > 24) {
      normalHeight = visibleHeight;
      lastWidth = width;
    }
    normalHeight = Math.max(normalHeight, height, document.documentElement.clientHeight);
    const occluded = Math.max(normalHeight - height, bounds?.height || 0);
    const wasOpen = keyboardOpen;
    keyboardOpen = coarsePointer.matches && occluded >= Math.min(105, normalHeight * .18) && (viewport?.scale ?? 1) === 1;
    if (wasOpen && !keyboardOpen) clearModifiers();
    document.documentElement.style.setProperty('--viewport-top', top + 'px');
    document.documentElement.style.setProperty('--viewport-height', height + 'px');
    app.dataset.keyboard = String(keyboardOpen);
    const active = getActive();
    softKeys.hidden = !(keyboardOpen && active?.state === 'online' &&
      (!active.guest || active.guest.permissions.write) && document.activeElement === active.term.textarea &&
      !document.querySelector('dialog[open]'));
  }

  const cursorKeys = new Map([
    ['ArrowLeft', 'D'], ['ArrowUp', 'A'], ['ArrowDown', 'B'], ['ArrowRight', 'C'],
    ['Home', 'H'], ['End', 'F']
  ]);
  const functionKeys = new Map([['F1', 'P'], ['F2', 'Q'], ['F3', 'R'], ['F4', 'S']]);
  // Map xterm's numbered escape sequences for the remaining navigation keys.
  const numberedKeys = new Map([
    ['Insert', 2], ['Delete', 3], ['PageUp', 5], ['PageDown', 6],
    ['F5', 15], ['F6', 17], ['F7', 18], ['F8', 19], ['F9', 20], ['F10', 21], ['F11', 23], ['F12', 24]
  ]);
  const simpleKeys = new Map([['Escape', '\x1b'], ['Tab', '\t'], ['Backspace', '\x7f'], ['Enter', '\r']]);
  const specialKeys = new Set([...cursorKeys.keys(), ...functionKeys.keys(), ...numberedKeys.keys(), ...simpleKeys.keys()]);
  const shifted = Object.fromEntries(Array.from('\x601234567890-=\\[];\',./',
    (character, index) => [character, '~!@#$%^&*()_+|{}:"<>?'[index]]));
  const controls = new Map([
    [' ', '\0'], ['@', '\0'], ['2', '\0'], ['[', '\x1b'], ['3', '\x1b'],
    ['\\', '\x1c'], ['4', '\x1c'], [']', '\x1d'], ['5', '\x1d'],
    ['^', '\x1e'], ['6', '\x1e'], ['_', '\x1f'], ['-', '\x1f'], ['7', '\x1f'], ['?', '\x7f'], ['8', '\x7f']
  ]);

  function hasModifiers() {
    return modifiers.Ctrl || modifiers.Shift || modifiers.Alt;
  }

  function encodeSpecial(key, event = {}) {
    const ctrl = modifiers.Ctrl || event.ctrlKey;
    const shift = modifiers.Shift || event.shiftKey;
    const alt = modifiers.Alt || event.altKey;
    const parameter = 1 + Number(Boolean(shift)) + 2 * Number(Boolean(alt)) + 4 * Number(Boolean(ctrl));
    const cursor = cursorKeys.get(key);
    if (cursor) {
      if (parameter > 1) return '\x1b[1;' + parameter + cursor;
      return (getActive().term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + cursor;
    }
    const fn = functionKeys.get(key);
    if (fn) return parameter > 1 ? '\x1b[1;' + parameter + fn : '\x1bO' + fn;
    if (numberedKeys.has(key)) {
      return '\x1b[' + numberedKeys.get(key) + (parameter > 1 ? ';' + parameter : '') + '~';
    }
    if (key === 'Tab' && shift) return '\x1b[Z';
    const value = key === 'Backspace' && ctrl ? '\b' : simpleKeys.get(key);
    return (alt ? '\x1b' : '') + value;
  }

  function sendSpecial(key, event) {
    const active = getActive();
    if (!active || active.state !== 'online') return;
    const data = encodeSpecial(key, event);
    clearModifiers();
    send(active, data);
  }

  function applyTypedModifiers(data) {
    if (!hasModifiers()) return data;
    if (data === '\t' || data === '\r' || data === '\x7f') {
      const key = data === '\t' ? 'Tab' : data === '\r' ? 'Enter' : 'Backspace';
      const value = encodeSpecial(key);
      clearModifiers();
      return value;
    }
    if (Array.from(data).length !== 1 || data < ' ') return data;
    let value = modifiers.Shift ? (shifted[data] || data.toUpperCase()) : data;
    if (modifiers.Ctrl) {
      if (/^[a-z]$/i.test(value)) value = String.fromCharCode(value.toUpperCase().charCodeAt(0) - 64);
      else value = controls.get(value) ?? value;
    }
    if (modifiers.Alt) value = '\x1b' + value;
    clearModifiers();
    return value;
  }

  const keyLabels = [
    ['Ctrl', 'Ctrl'], ['Shift', 'Shift'], ['Alt', 'Alt'], ['Escape', 'Esc'], ['Tab', 'Tab'],
    ['ArrowLeft', '←'], ['ArrowUp', '↑'], ['ArrowDown', '↓'], ['ArrowRight', '→'],
    ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PgUp'], ['PageDown', 'PgDn'],
    ['Backspace', '⌫'], ['Delete', 'Del'], ['Insert', 'Ins'], ['Enter', 'Enter'],
    ...Array.from({length: 12}, (_, index) => ['F' + (index + 1), 'F' + (index + 1)])
  ];
  for (const [key, label] of keyLabels) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-label', key.replace(/^Arrow/, 'Arrow '));
    if (Object.hasOwn(modifiers, key)) {
      modifierButtons.set(key, button);
      button.setAttribute('aria-pressed', 'false');
    }
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      if (modifierButtons.has(key)) {
        modifiers[key] = !modifiers[key];
        button.setAttribute('aria-pressed', String(modifiers[key]));
      } else {
        sendSpecial(key);
      }
      getActive()?.term.focus();
    });
    softKeys.append(button);
  }

  window.addEventListener('resize', update, { signal });
  window.visualViewport?.addEventListener('resize', update, { signal });
  window.visualViewport?.addEventListener('scroll', update, { signal });
  navigator.virtualKeyboard?.addEventListener('geometrychange', update, { signal });
  document.addEventListener('focusin', update, { signal });
  document.addEventListener('focusout', () => requestAnimationFrame(update), { signal });
  update();
  return {
    clear: clearModifiers,
    handleKey(session, event) {
      if (session !== getActive() || !hasModifiers() || !specialKeys.has(event.key)) return false;
      event.preventDefault();
      sendSpecial(event.key, event);
      return true;
    },
    update,
    apply(session, data) { return session === getActive() ? applyTypedModifiers(data) : data; },
  };
}

function cellAt(session, x, y) {
  const term = session.term;
  const rect = (term.element.querySelector('.xterm-screen') || term.element).getBoundingClientRect();
  const col = Math.max(0, Math.min(term.cols - 1, Math.floor((x - rect.left) / (rect.width / term.cols))));
  const row = Math.max(0, Math.min(term.rows - 1, Math.floor((y - rect.top) / (rect.height / term.rows))));
  return {col, row: row + term.buffer.active.viewportY};
}

function wordAt(session, cell) {
  const line = session.term.buffer.active.getLine(cell.row);
  const text = line ? line.translateToString(false) : '';
  const word = character => Boolean(character) && !/[\s"'`()<>\[\]{}|,;]/.test(character);
  if (!word(text[cell.col])) return [cell, cell];
  let start = cell.col, end = cell.col;
  while (start > 0 && word(text[start - 1])) start--;
  while (end < text.length - 1 && word(text[end + 1])) end++;
  return [{col: start, row: cell.row}, {col: end, row: cell.row}];
}

function selectCells(session, from, to) {
  const cols = session.term.cols;
  const [start, end] = from.row * cols + from.col <= to.row * cols + to.col ? [from, to] : [to, from];
  session.term.select(start.col, start.row, (end.row - start.row) * cols + end.col - start.col + 1);
}

// Touch events keep going to the node the touch started on, and xterm
// replaces row nodes as it redraws. Listening on that node itself still
// works after it leaves the document; its ancestors stop hearing anything.
function followTouch(event, handlers) {
  const targets = new Set([...event.touches].map(touch => touch.target).filter(Boolean));
  const stop = () => {
    for (const target of targets) {
      for (const [type, handler] of Object.entries(handlers)) target.removeEventListener(type, handler);
      target.removeEventListener('touchend', ended);
      target.removeEventListener('touchcancel', ended);
    }
  };
  const ended = event => { if (!event.touches.length) stop(); };
  for (const target of targets) {
    for (const [type, handler] of Object.entries(handlers)) target.addEventListener(type, handler, {passive: false});
    target.addEventListener('touchend', ended);
    target.addEventListener('touchcancel', ended);
  }
}

// Extend a selection from the word it started on to CELL, in either direction.
function extendSelection(session, word, cell) {
  const [start, end] = word;
  const before = cell.row < start.row || (cell.row === start.row && cell.col < start.col);
  selectCells(session, before ? end : start, cell);
}

function wireTerminalSelection(session, showTermMenu) {
  const element = session.term.element;
  let press = null, lastTouch = 0, lastTap = null;
  const cancel = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  const move = event => {
    if (!press || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (!press.active) {
      if (Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > 10) cancel();
      return;
    }
    // Selecting: keep the viewport and the program's mouse handling still.
    event.preventDefault();
    event.stopPropagation();
    press.x = touch.clientX;
    press.y = touch.clientY;
    extendSelection(session, press.word, cellAt(session, press.x, press.y));
  };
  const finish = event => {
    lastTouch = performance.now();
    // A short, still touch is a tap; a second one soon after starts a selection.
    lastTap = press && !press.active && lastTouch - press.started < 250
      ? {time: lastTouch, x: press.x, y: press.y} : null;
    if (press?.active) {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      showTermMenu(session, press.x, press.y);
    }
    cancel();
  };
  element.addEventListener('touchstart', event => {
    lastTouch = performance.now();
    cancel();
    if (event.touches.length !== 1) {
      lastTap = null;
      return;
    }
    const touch = event.touches[0];
    const tap = lastTap;
    lastTap = null;
    if (tap && lastTouch - tap.time < 320 && Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) < 30) {
      // Double tap: select from here, and keep this touch from the program.
      event.preventDefault();
      event.stopPropagation();
      press = {x: touch.clientX, y: touch.clientY, active: true, started: lastTouch};
      press.word = wordAt(session, cellAt(session, press.x, press.y));
      selectCells(session, ...press.word);
      followTouch(event, {touchmove: move, touchend: finish, touchcancel: finish});
      return;
    }
    press = {x: touch.clientX, y: touch.clientY, active: false, word: null, started: lastTouch};
    press.timer = setTimeout(() => {
      if (!press) return;
      press.active = true;
      press.word = wordAt(session, cellAt(session, press.x, press.y));
      selectCells(session, ...press.word);
      navigator.vibrate?.(8);
    }, 450);
    followTouch(event, {touchmove: move, touchend: finish, touchcancel: finish});
  }, {passive: false, capture: true});
  // When a program tracks the mouse (Claude Code, Codex), xterm sends clicks to
  // it instead of selecting. A double-click then drag selects text anyway.
  element.addEventListener('mousedown', event => {
    // A right-click on a selection opens the menu; a program tracking the
    // mouse would otherwise receive it and xterm would drop the selection.
    if (event.button === 2 && session.term.hasSelection()) {
      event.stopPropagation();
      return;
    }
    if (event.button !== 0 || event.detail !== 2 || session.term.modes.mouseTrackingMode === 'none') return;
    event.preventDefault();
    event.stopPropagation();
    session.term.focus();
    const word = wordAt(session, cellAt(session, event.clientX, event.clientY));
    selectCells(session, ...word);
    const move = moved => {
      moved.stopPropagation();
      extendSelection(session, word, cellAt(session, moved.clientX, moved.clientY));
    };
    const up = released => {
      released.stopPropagation();
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      if (session.term.hasSelection()) showTermMenu(session, released.clientX, released.clientY);
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  }, true);
  element.addEventListener('contextmenu', event => {
    event.preventDefault();
    // Android also reports a long press as a context menu; the touch path handles it.
    if (performance.now() - lastTouch < 1000) return;
    showTermMenu(session, event.clientX, event.clientY);
  });
}

function wireTerminalDictation(session, send) {
  const field = session.term.textarea;
  // Listen on the container in the capture phase so this runs before xterm's
  // own listeners on the field in every browser.
  const element = session.term.element;
  const on = (type, handler) => element.addEventListener(type, event => {
    if (event.target === field) handler(event);
  }, true);
  let sent = '', base = null, spaceKeyTime = null;
  const repeatsSpace = (event) => spaceKeyTime !== null &&
    event.timeStamp >= spaceKeyTime && event.timeStamp - spaceKeyTime <= 120;
  const reset = () => {
    sent = '';
    base = null;
    spaceKeyTime = null;
    field.value = '';
  };
  session.term.onKey(({ key, domEvent }) => {
    if (coarsePointer.matches && key === ' ' && !domEvent.isComposing) spaceKeyTime = domEvent.timeStamp;
  });
  on('keypress', (event) => {
    if ((event.key === ' ' || event.charCode === 32) && repeatsSpace(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  on('beforeinput', event => {
    base = event.inputType === 'insertText' && !event.isComposing ? field.value : null;
  });
  on('input', event => {
    if (event.inputType !== 'insertText' || event.isComposing) return;
    // Browsers that skip beforeinput leave the field as it was last sent.
    const before = base ?? sent;
    base = null;
    // Some phone keyboards also emit insertText for a space xterm already sent.
    const duplicateSpace = event.data === ' ' && repeatsSpace(event) &&
      (field.value === before || field.value === before + ' ');
    spaceKeyTime = null;
    if (duplicateSpace) {
      field.value = before;
      event.stopPropagation();
      return;
    }
    // A plain insert at the end is xterm's to send. It also knows when a key
    // press already sent the character (Shift+letter), so it never doubles.
    if (before !== sent && before !== '' || field.value === before + (event.data ?? '')) {
      sent = field.value;
      return;
    }
    event.stopPropagation();
    const previous = Array.from(sent), next = Array.from(field.value);
    let same = 0;
    while (same < previous.length && same < next.length && previous[same] === next[same]) same++;
    const edit = '\x7f'.repeat(previous.length - same) + next.slice(same).join('');
    sent = field.value;
    if (edit) send(session, edit);
  });
  // A key press or leaving the terminal ends the dictation run.
  on('keydown', event => {
    spaceKeyTime = null;
    if (!event.isComposing && event.keyCode !== 229) reset();
  });
  field.addEventListener('blur', reset);
}

// Two-finger drags become wheel events, so xterm treats them exactly like a
// desktop wheel or trackpad: mouse-wheel reports when the program tracks the
// mouse (Claude Code, Codex, vim, less), arrow keys in an alternate screen
// without mouse tracking, and local scrollback otherwise.
function wireTerminalTouchScroll(session) {
  const element = session.term.element;
  const screen = element.querySelector('.xterm-screen') || element;
  let last = null;
  const midpoint = touches => ({
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2
  });
  const move = event => {
    if (event.touches.length !== 2 || !last) return;
    // Keep xterm's one-finger viewport scroll and the page from also moving.
    event.preventDefault();
    event.stopPropagation();
    const point = midpoint(event.touches);
    const deltaY = last.y - point.y, deltaX = last.x - point.x;
    last = point;
    if (!deltaY) return;
    screen.dispatchEvent(new WheelEvent('wheel', {
      deltaX, deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL, clientX: point.x, clientY: point.y,
      bubbles: true, cancelable: true
    }));
  };
  const end = event => { if (event.touches.length !== 2) last = null; };
  element.addEventListener('touchstart', event => {
    if (event.touches.length !== 2) return;
    last = midpoint(event.touches);
    followTouch(event, {touchmove: move, touchend: end, touchcancel: end});
  }, {passive: true, capture: true});
}

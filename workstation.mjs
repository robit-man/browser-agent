let workspaceStorage, workspaceLock, startup, runtime, active, agentMemory;
let workspaceReady = false, busy = false, saveTimer;
let networkState = 'OFFLINE';
let restored = false, storageHealthy = true, pendingRecovery = false, userSelectedNetwork = false;
const egress = newEgress();
const workspaceGroup = '/sys/fs/cgroup/pointblank-workspace';
const byId = (id) => document.getElementById(id);
const checkpointKeys = ['checkpoint-a', 'checkpoint-b'];
const preferenceKey = 'pointblank-linux-autosave';
const defaultAutosave = 60;
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const savedLabel = (entry) => 'Saved ' + new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function autosaveSeconds() {
  try {
    const value = localStorage.getItem(preferenceKey);
    if (value === null) return defaultAutosave;
    return [0, 30, 60, 180].includes(Number(value)) ? Number(value) : defaultAutosave;
  } catch { return defaultAutosave; }
}

async function guestExec(vm, command, options) {
  const result = await vm.exec('sh', ['-c', command], options);
  if ((result.code ?? result.exitCode) !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr : decoder.decode(result.stderr);
    throw Error(stderr.trim().slice(0, 700) || 'Linux command failed');
  }
  return result.stdout;
}

async function loadWorkspace() {
  const db = await openDatabase().catch(() => null);
  workspaceLock = await acquireWorkspace().catch(() => ({ exclusive: false }));
  if (workspaceLock.inUse) {
    byId('boot').textContent = 'Workspace is open in another tab. Close that tab and reload here.';
    status('Workspace in use');
    byId('storage-usage').textContent = 'Available after the other tab closes';
    return false;
  }
  agentMemory = await agentStorage(db).catch(() => undefined);
  if (!workspaceLock.exclusive) {
    status('Session only · browser locking unavailable');
    return true;
  }
  try {
    workspaceStorage = await openStorage(db);
    const slots = await Promise.all(checkpointKeys.map(async (key) => {
      const file = await workspaceStorage.get(key);
      if (!file?.size) return null;
      try { return { key, file, ...(await readSnapshot(file, { headerOnly: true })) }; }
      catch { pendingRecovery = true; return null; }
    }));
    const candidates = slots.filter(Boolean).sort((a, b) => b.metadata.generation - a.metadata.generation);
    for (const candidate of candidates) {
      try {
        const entry = await readSnapshot(candidate.file);
        active = { key: candidate.key, ...entry };
        if (!entry.metadata.reset) startup = entry;
        break;
      } catch { pendingRecovery = true; }
    }
    if (!active && pendingRecovery) storageHealthy = false;
    const legacy = !active && (await indexedDB.databases?.().catch(() => []) || [])
      .some(({ name }) => name === 'kwdisk:browser-agent-v1');
    restored = !!startup;
    if (!active && pendingRecovery) status('Workspace recovery failed · import a backup or reset');
    else if (pendingRecovery) status('Recovered the previous verified save');
    else if (startup) status('Restoring workspace…');
    else status(workspaceStorage.name + ' ready');
    runtime = { legacy };
  } catch (error) {
    workspaceStorage = undefined;
    status('Session only · ' + error.message);
  }
  await storageStatus();
  return true;
}

async function commitWorkspace(entry) {
  const key = active?.key === checkpointKeys[0] ? checkpointKeys[1] : checkpointKeys[0];
  const metadata = { ...entry.metadata, generation: (active?.metadata.generation || 0) + 1 };
  await workspaceStorage.put(key, packageSnapshot(metadata, entry.tar));
  active = { key, metadata, tar: entry.tar };
  storageHealthy = true;
}

async function capture(name) {
  if (credentialText.test(name) || egress.secrets.some((secret) => name.includes(secret))) throw Error('Use a snapshot name without credentials');
  const { vm } = runtime;
  const args = skipped.map((path) => '--exclude ' + shellQuote(path)).join(' ');
  const command = 'cd /run/pointblank-workspace && sync && tar -cf - ' + args + ' .';
  let tar, proc, timer;
  try {
    await guestExec(vm, 'echo 1 > ' + workspaceGroup + '/cgroup.freeze; ' +
      'for i in $(seq 1 30); do grep -q "^frozen 1$" ' + workspaceGroup +
      '/cgroup.events && exit 0; sleep 0.1; done; exit 1');
    proc = await vm.spawn('/bin/sh', ['-c', command], { pty: false });
    timer = setTimeout(() => proc.kill('TERM'), 120000);
    await proc.stdin.close();
    const limiter = new TransformStream({
      start() { this.bytes = 0; },
      transform(chunk, controller) {
        this.bytes += chunk.byteLength;
        if (this.bytes > maxFilesystem) throw Error('Filesystem exceeds 196 MiB');
        controller.enqueue(chunk);
      },
    });
    const archive = new Response(proc.stdout.pipeThrough(limiter).pipeThrough(new CompressionStream('gzip'))).blob();
    const [, stderr, blob] = await Promise.all([proc.ended, new Response(proc.stderr).text(), archive]);
    if (proc.exitCode !== 0) throw Error(stderr.trim().slice(0, 600) || 'Could not archive the workspace');
    tar = blob;
  } finally {
    clearTimeout(timer);
    await proc?.close().catch(() => {});
    await guestExec(vm, 'echo 0 > ' + workspaceGroup + '/cgroup.freeze');
  }
  if (!tar.size || tar.size > maxArchive) throw Error('Snapshot exceeds 128 MiB');
  await validateTar(tar, egress.secrets);
  return { metadata: { ...snapshotMetadata(name, true), bytes: tar.size, sha256: await digest(tar) }, tar };
}

async function save() {
  if (!storageHealthy) throw Error('Import a verified backup or reset the workspace to resume saving');
  const entry = await capture('Workspace');
  if (active?.metadata.sha256 !== entry.metadata.sha256) await commitWorkspace(entry);
  status(savedLabel(active.metadata));
}

function status(message) { byId('save-status').textContent = message; }

function updateControls() {
  const enabled = workspaceReady && !busy;
  for (const id of ['save-state', 'snapshots', 'reset-state', 'import-state']) {
    byId(id).disabled = !enabled || !workspaceStorage || (id === 'save-state' && !storageHealthy);
  }
  byId('export-state').disabled = !enabled;
  byId('autosave').disabled = !workspaceStorage;
  byId('network-settings').disabled = !enabled;
  byId('storage-protect').disabled = !workspaceStorage || !navigator.storage?.persist;
}

async function storageStatus() {
  const label = byId('storage-usage');
  if (!workspaceStorage) { label.textContent = 'Storage unavailable'; return; }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    label.textContent = workspaceStorage.name + ' · ' + Math.round(usage / MiB) + ' / ' +
      Math.round(quota / MiB) + ' MiB' + (persisted ? ' · protected' : '');
  } catch { label.textContent = workspaceStorage.name + ' · quota unavailable'; }
}

function scheduleAutosave() {
  clearInterval(saveTimer);
  const seconds = autosaveSeconds();
  if (workspaceStorage && seconds) saveTimer = setInterval(() => {
    if (workspaceReady && !busy && storageHealthy) void operation('Autosaving…', save);
  }, seconds * 1000);
}

async function operation(message, action) {
  if (busy || !workspaceReady) return;
  busy = true;
  updateControls();
  status(message);
  try { await action(); }
  catch (error) {
    status(error.name === 'QuotaExceededError' ? 'Storage full · previous save retained' : error.message);
  } finally {
    busy = false;
    updateControls();
    void storageStatus();
  }
}

async function protectStorage() {
  if (!workspaceStorage || !navigator.storage?.persist) return;
  const granted = await navigator.storage.persist();
  await storageStatus();
  return granted;
}

function download({ metadata, tar }) {
  if (!tar.size) throw Error('This workspace has no filesystem snapshot');
  const safe = { ...snapshotMetadata(metadata.name, true), createdAt: metadata.createdAt, bytes: metadata.bytes, sha256: metadata.sha256 };
  const blob = packageSnapshot(safe, tar);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = metadata.name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 64) + '.pblinux';
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function restartWith(entry) {
  await commitWorkspace(entry);
  if (entry.metadata.reset) {
    const previous = checkpointKeys.find((key) => key !== active.key);
    await workspaceStorage.remove(previous).catch(console.warn);
  }
  egress.disable();
  location.reload();
}

async function showSnapshots() {
  const list = byId('snapshot-list');
  list.replaceChildren();
  const keys = (await workspaceStorage.list()).filter((key) => key.startsWith('snapshot-'));
  const records = await Promise.all(keys.map(async (key) => {
    try { return { key, ...(await readSnapshot(await workspaceStorage.get(key), { headerOnly: true })) }; }
    catch { return { key, metadata: { name: 'Unreadable snapshot', createdAt: '' } }; }
  }));
  for (const { key, metadata } of records.sort((a, b) => b.metadata.createdAt.localeCompare(a.metadata.createdAt))) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = metadata.name + (metadata.createdAt ? ' · ' + new Date(metadata.createdAt).toLocaleString() : '');
    row.append(label);
    function button(text, callback) {
      const control = document.createElement('button');
      control.type = 'button';
      control.textContent = text;
      control.addEventListener('click', callback);
      row.append(control);
    }
    if (metadata.createdAt) {
      button('Restore', () => {
        if (!confirm('Replace the current workspace with “' + metadata.name + '”? Unsaved changes will be lost.')) return;
        byId('snapshot-dialog').close();
        void operation('Restoring snapshot…', async () => {
          const entry = await readSnapshot(await workspaceStorage.get(key));
          await restartWith(entry);
        });
      });
      button('Export', () => {
        byId('snapshot-dialog').close();
        void operation('Exporting snapshot…', async () => {
          download(await readSnapshot(await workspaceStorage.get(key)));
          status('Snapshot exported');
        });
      });
    }
    button('Delete', () => {
      if (!confirm('Delete “' + metadata.name + '”?')) return;
      void operation('Deleting snapshot…', async () => {
        await workspaceStorage.remove(key);
        await showSnapshots();
        status('Snapshot deleted');
      });
    });
    list.append(row);
  }
  if (!records.length) {
    const row = document.createElement('li');
    row.textContent = 'No named snapshots';
    list.append(row);
  }
}

async function prepareGuest(vm) {
  runtime ??= {};
  runtime.vm = vm;
  await guestExec(vm, 'mkdir -p ' + workspaceGroup + ' && test -f ' + workspaceGroup + '/cgroup.freeze');
  await egress.setup(vm);
  await guestExec(vm, 'cat > ' + proxyRoot + '/proxy.py', { input: proxyProgram });
  if (startup) {
    await guestExec(vm, 'cat > /tmp/pointblank-restore.tar.gz', { input: new Uint8Array(await startup.tar.arrayBuffer()) });
  }
}

async function prepareTerminal(vm, terminal, network) {
  runtime.terminal = terminal;
  runtime.network = network;
  await guestExec(vm, 'mount --bind /run/pointblank-workspace/workspace /workspace');
  if (runtime.legacy && !restored) {
    await guestExec(vm, 'if test -d /data/browser-agent-workspace; then cp -a /data/browser-agent-workspace/. /workspace/; fi');
  }
  await guestExec(vm, [
    'root=/run/pointblank-workspace',
    'install -d -m 755 "$root/usr/local/bin" "$root/usr/local/libexec/browser-agent"',
    'cp -L /run/kw/bin/_egress "$root/usr/local/libexec/browser-agent/_egress"',
    'chmod 755 "$root/usr/local/libexec/browser-agent/_egress"',
    'cat "$root/etc/ssl/certs/ca-certificates.crt" ' + proxyRoot + '/ca.pem > ' + proxyRoot + '/bundle.pem',
    'printf "%s\\n" ' + shellQuote('ca_certificate=' + proxyRoot + '/bundle.pem') + ' > ' + proxyRoot + '/wgetrc',
    'cat /mnt/oci/bin/alpine-agent > "$root/usr/local/bin/agent"',
    'cp -L /run/kw/bin/_network "$root/usr/local/libexec/browser-agent/_network"',
    'cat /mnt/oci/bin/alpine-network > "$root/usr/local/bin/network"',
    'chmod 755 "$root/usr/local/bin/agent" "$root/usr/local/bin/network" "$root/usr/local/libexec/browser-agent/_network"',
  ].join(' && '));
  const proxy = await vm.spawn('/bin/sh', ['-c', 'exec docker exec botpsy-alpine python3 -I ' + proxyRoot + '/proxy.py'], { pty: false });
  void proxy.ended.catch(() => {});
  const discard = () => new WritableStream({ write() {} });
  void proxy.stdout.pipeTo(discard()).catch(() => {});
  let proxyError = '';
  void proxy.stderr.pipeTo(new WritableStream({ write(bytes) { proxyError = (proxyError + decoder.decode(bytes)).slice(-1200); } })).catch(() => {});
  try {
    await guestExec(vm, 'for i in $(seq 1 100); do test -f ' + proxyRoot +
      '/ready && exit 0; sleep 0.2; done; echo "Guest proxy could not start" >&2; exit 1');
  } catch (error) {
    throw Error(error.message + (proxyError ? '\n' + proxyError.trim() : ''));
  }
}

function ready() {
  workspaceReady = true;
  if (workspaceStorage && storageHealthy && !pendingRecovery) status(active && !active.metadata.reset ? savedLabel(active.metadata) : 'Ready to save');
  updateControls();
  scheduleAutosave();
  if (runtime?.legacy && workspaceStorage && storageHealthy) void operation('Migrating the previous workspace…', save);
}

function networkStatus() {
  if (!egress.connected && networkState === 'ONLINE') networkState = 'AUTH REQUIRED';
  byId('network-settings').textContent = 'NETWORK: ' + networkState;
}

function openNetworkSettings() {
  const dialog = byId('network-dialog');
  if (!dialog.open) dialog.showModal();
  if (!egress.connected) networkState = 'AUTH REQUIRED';
  networkStatus();
}

async function networkCommand(context) {
  const action = context.args?.[0] || 'status';
  const writer = context.stdout.getWriter();
  let status = 0;
  let text;
  try {
    if (action === 'on') {
      openNetworkSettings();
      text = 'Authorize in the browser network dialog.';
    } else if (action === 'off') {
      runtime.network.set('disable');
      text = 'NETWORK: OFFLINE';
    } else if (action === 'status') {
      networkStatus();
      text = 'NETWORK: ' + networkState;
      if (egress.expires()) text += ' · expires ' + new Date(egress.expires() * 1000).toISOString();
    } else if (action === 'services') {
      text = egress.services().map(({ id, origin }) => id + ' ' + origin).join('\n') || 'Authorize networking first.';
    } else if (action === 'logs') {
      text = egress.logs().map(({ time, service, method, status, id }) =>
        [time, method, service, status, id].join(' ')).join('\n') || 'No requests in this tab.';
    } else if (action === 'test') {
      const target = egress.services().find(({ id }) => id === 'diagnostics');
      if (!target) throw Error('Authorize networking and enable the diagnostics service.');
      const response = await egress.browserRequest(target.origin + '/network-fixtures/json', 'GET', context.signal);
      text = 'Diagnostics HTTP ' + response.status + ' · ' + (response.headers.get('X-Request-ID') || '');
      status = response.ok ? 0 : 1;
      await response.body?.cancel();
    } else throw Error('Usage: network [on|off|status|test|services|logs]');
  } catch (error) { text = error.message; status = 1; }
  await writer.write(text + '\n');
  await writer.close();
  return status;
}

function installUI() {
  byId('autosave').value = String(autosaveSeconds());
  byId('autosave').addEventListener('change', (event) => {
    try { localStorage.setItem(preferenceKey, event.target.value); } catch {}
    scheduleAutosave();
  });
  byId('save-state').addEventListener('click', () => {
    void protectStorage().catch(() => {});
    void operation('Saving workspace…', save);
  });
  byId('export-state').addEventListener('click', () => operation('Preparing export…', async () => {
    download(await capture('Workspace'));
    status('Workspace exported');
  }));
  byId('import-state').addEventListener('click', () => byId('snapshot-file').click());
  byId('snapshot-file').addEventListener('change', (event) => {
    const [file] = event.target.files;
    event.target.value = '';
    if (!file) return;
    void operation('Checking snapshot…', async () => {
      const entry = await readSnapshot(file, { portable: true });
      if (!confirm('Replace the current workspace with “' + entry.metadata.name + '”? Unsaved changes will be lost.')) {
        status('Import canceled');
        return;
      }
      await restartWith({ metadata: { ...entry.metadata, offline: true }, tar: entry.tar });
    });
  });
  byId('snapshots').addEventListener('click', () => {
    showSnapshots().then(() => byId('snapshot-dialog').showModal()).catch((error) => status(error.message));
  });
  byId('snapshot-create').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = byId('snapshot-name');
    const name = input.value.trim();
    if (!name) return;
    void operation('Creating snapshot…', async () => {
      const entry = await capture(name);
      await workspaceStorage.put('snapshot-' + crypto.randomUUID(), packageSnapshot(entry.metadata, entry.tar));
      input.value = '';
      await showSnapshots();
      status('Snapshot created');
    });
  });
  byId('reset-state').addEventListener('click', () => {
    if (!confirm('Reset the current Linux workspace? This clears the active filesystem. Named snapshots are kept.')) return;
    void operation('Resetting workspace…', () => restartWith({
      metadata: { ...snapshotMetadata('New workspace', true), reset: true }, tar: new Blob(),
    }));
  });
  byId('storage-protect').addEventListener('click', async () => {
    try {
      const granted = await protectStorage();
      status(granted ? 'Persistent storage granted' : 'Browser storage is best effort');
    } catch (error) { status(error.message); }
  });
  byId('network-settings').addEventListener('click', openNetworkSettings);
  byId('network-connect').addEventListener('submit', async (event) => {
    event.preventDefault();
    const field = (name) => event.target.elements.namedItem(name);
    const submit = event.submitter;
    const message = byId('network-message');
    submit.disabled = true;
    message.textContent = 'Checking Worker authorization…';
    networkState = 'CONNECTING';
    networkStatus();
    try {
      await egress.enable(field('key').value.trim(), field('repository').value.trim(),
        field('username').value.trim(), field('git-token').value.trim());
      userSelectedNetwork = true;
      networkState = 'ONLINE';
      runtime.network.set('direct');
      networkStatus();
      byId('network-dialog').close();
    } catch (error) { networkState = 'ERROR'; networkStatus(); message.textContent = error.message; }
    finally {
      field('key').value = field('git-token').value = '';
      submit.disabled = false;
    }
  });
  byId('network-disable').addEventListener('click', () => {
    egress.disable();
    runtime?.network.set('disable');
    networkStatus();
    byId('network-dialog').close();
  });
  window.addEventListener('pagehide', () => {
    egress.disable();
    userSelectedNetwork = false;
    if (runtime?.network) runtime.network.set('disable');
  });
  window.addEventListener('pageshow', networkStatus);
  updateControls();
}

const alpineNetwork = '#!/bin/sh\nexec /usr/local/libexec/browser-agent/_network "$@"\n';

const alpineAgent = `#!/bin/sh
bridge=/usr/local/libexec/browser-agent/_agent
if [ "$#" -eq 0 ] && [ -t 0 ] && [ -t 1 ]; then
  exec bash --noprofile --norc /usr/local/libexec/browser-agent/session
fi
exec "$bridge" "$@"
`;

function bindNetwork(network) {
  const set = network.set.bind(network);
  network.set = (mode) => {
    if (mode === 'relay') throw Error('Use the Network toolbar for authorized HTTPS');
    if (mode === 'disable') {
      egress.disable();
      userSelectedNetwork = false;
      networkState = 'OFFLINE';
      set('disable');
    } else {
      if (!userSelectedNetwork) throw Error('Authorize networking with the Network toolbar');
      set('direct');
    }
    networkStatus();
  };
  network.status = () => egress.connected ? 'Network: authorized HTTP/HTTPS proxy\n' : 'Network: off · enable it from the toolbar\n';
  network.request = (url, signal) => egress.browserRequest(url, 'GET', signal);
  network.checkHttps = async (host, signal) => {
    const response = await egress.browserRequest('https://' + host + '/', 'HEAD', signal);
    return { host, reached: response.ok, http_status: response.status, via: 'authorized HTTPS proxy' };
  };
}

function replaceRequired(source, anchor, replacement) {
  const offset = source.indexOf(anchor);
  if (offset < 0 || source.indexOf(anchor, offset + anchor.length) >= 0) {
    throw Error('The bundled terminal changed around ' + anchor.slice(0, 60));
  }
  return source.slice(0, offset) + replacement + source.slice(offset + anchor.length);
}

function adaptDocker(script) {
  script = replaceRequired(script, '  prepare_image_layers "$IMG_KEY"\n  LOWER=$(cat "$DOCKER_ROOT/images/$IMG_KEY/lowerdir")', `  if [ "$CUSTOM_NAME" != botpsy-alpine ] || [ ! -f /tmp/pointblank-restore.tar.gz ]; then
    prepare_image_layers "$IMG_KEY"
    LOWER=$(cat "$DOCKER_ROOT/images/$IMG_KEY/lowerdir")
  fi`);
  const start = script.indexOf('  # Mount real Linux overlayfs');
  const end = script.indexOf('  # Minimal container virtual filesystems');
  if (start < 0 || end <= start) throw Error('The bundled container setup changed');
  script = script.slice(0, start) + `  if [ "$CNAME" = botpsy-alpine ] && [ -f /tmp/pointblank-restore.tar.gz ]; then
    tar -xzf /tmp/pointblank-restore.tar.gz -C "$CDIR/merged"
    rm /tmp/pointblank-restore.tar.gz
  else
    mount -t overlay overlay -o "lowerdir=$LOWER,upperdir=$CDIR/upper,workdir=$CDIR/work" "$CDIR/merged"
  fi
  if [ "$CNAME" = botpsy-alpine ]; then
    mkdir -p "$CDIR/merged/workspace" "$CDIR/merged${proxyRoot}"
    mount --bind ${proxyRoot} "$CDIR/merged${proxyRoot}"
    ln -sfn "$CDIR/merged" /run/pointblank-workspace
  fi

` + script.slice(end);
  script = replaceRequired(script, 'hostname "$CID" 2>/dev/null || true',
    `[ "$CNAME" != botpsy-alpine ] || echo 0 > ${workspaceGroup}/cgroup.procs
hostname "$CID" 2>/dev/null || true`);
  return replaceRequired(script,
    '  CDIR="$DOCKER_ROOT/containers/$CID"\n  if [ -f "$CDIR/pid" ] && kill -0', `  CDIR="$DOCKER_ROOT/containers/$CID"
  if [ "$TARGET" = botpsy-alpine ]; then
    echo 0 > ${workspaceGroup}/cgroup.procs
    set -- /usr/bin/env TERM=xterm-256color HOME=/root HISTFILE=/dev/null GIT_TERMINAL_PROMPT=0 \\
      http_proxy=${proxyAddress} https_proxy=${proxyAddress} HTTPS_PROXY=${proxyAddress} \\
      no_proxy=localhost,127.0.0.1,::1 NO_PROXY=localhost,127.0.0.1,::1 \\
      SSL_CERT_FILE=${proxyRoot}/bundle.pem CURL_CA_BUNDLE=${proxyRoot}/bundle.pem \\
      GIT_SSL_CAINFO=${proxyRoot}/bundle.pem REQUESTS_CA_BUNDLE=${proxyRoot}/bundle.pem \\
      PIP_CERT=${proxyRoot}/bundle.pem WGETRC=${proxyRoot}/wgetrc NODE_EXTRA_CA_CERTS=${proxyRoot}/ca.pem "$@"
  fi
  if [ -f "$CDIR/pid" ] && kill -0`);
}

function adaptEntry(source) {
  const hooks = [
    ['r.writeFile(`/bin/docker`,H_),r.writeFile(`/bin/agent`,Jx)',
      'r.writeFile(`/bin/docker`,workstation.adaptDocker(H_)),r.writeFile(`/bin/agent`,Jx),r.writeFile(`/bin/alpine-agent`,workstation.alpineAgent),r.writeFile(`/bin/alpine-network`,workstation.alpineNetwork)'],
    ['S=new Kx(Gh),ee=x.get(`persist`)===`1`',
      'S=new Kx(Gh,new URL(location.pathname,location.href)),ee=workstation.legacy'],
    ['commands:{_oci:b,_agent:w}});let e=new lS(l,S)',
      'commands:{_oci:b,_agent:w,_egress:workstation.egress.handler,_network:workstation.networkCommand}});await workstation.prepareGuest(l);workstation.bindNetwork(S);let e=new lS(l,S)'],
    ['memory:new Ux,documentModel:n', 'memory:new Ux(workstation.agentMemory),documentModel:n'],
    ['await u.tools.ensure().catch(e=>{f=e})',
      'await u.tools.ensure();await workstation.prepareTerminal(l,i,S)'],
    ['let te=await l.spawn(`sh`,[],', 'let te=await l.spawn(`sh`,[`-c`,`docker exec -it botpsy-alpine bash --noprofile --norc -c "cd /workspace; exec bash --noprofile --norc -i"; exec sh -i`],'],
    ['gT.remove(),bT.focus(),bT.preloadModel()', 'gT.remove(),bT.focus(),bT.preloadModel(),workstation.ready()'],
    ['Native guest internet commands require a relay.', 'Native HTTP and HTTPS use the workstation proxy after authorization.'],
    ['agent network status | test | direct | fetch URL [PATH] | relay WSS_URL | disable',
      'agent network status | test | fetch URL [PATH] | disable'],
  ];
  for (const [anchor, replacement] of hooks) source = replaceRequired(source, anchor, replacement);
  return source;
}

globalThis.workstation = {
  alpineAgent, alpineNetwork, adaptDocker, adaptEntry, prepareGuest, prepareTerminal, bindNetwork, networkCommand, ready, egress,
  get legacy() { return !!runtime?.legacy; },
  get agentMemory() { return agentMemory ?? {}; },
};

installUI();
const bootWorkstation = await loadWorkspace();

const workspaceToolPacks = new Map([
  ['shell', { packages: ['fzf', 'shellcheck'], space: 24 * MiB, name: 'Shell tools' }],
  ['native', { packages: ['build-base', 'pkgconf', 'linux-headers'], space: 300 * MiB, name: 'Native build' }],
]);

async function workspaceProcess(args, { limit = MiB, timeout = 30000, signal, onOutput } = {}) {
  const activeSignal = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
  activeSignal.throwIfAborted();
  const command = 'exec docker exec botpsy-alpine ' + args.map(shellQuote).join(' ');
  const proc = await runtime.vm.spawn('/bin/sh', ['-c', command], { pty: false });
  const cancel = () => { void Promise.resolve().then(() => proc.kill('TERM')).catch(() => {}); };
  activeSignal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let bytesRead = 0, errorText = '';
  const stdout = new TextDecoder();
  const stderr = new TextDecoder();
  try {
    if (activeSignal.aborted) { cancel(); activeSignal.throwIfAborted(); }
    await Promise.all([
      proc.stdin.close(),
      proc.stdout.pipeTo(new WritableStream({
        write(chunk) {
          bytesRead += chunk.byteLength;
          if (bytesRead > limit) throw Error('The Linux response exceeded the transfer limit');
          if (onOutput) onOutput(stdout.decode(chunk, { stream: true }));
          else chunks.push(chunk);
        },
      }), { signal: activeSignal }),
      proc.stderr.pipeTo(new WritableStream({
        write(chunk) {
          const text = stderr.decode(chunk, { stream: true });
          errorText = (errorText + text).slice(-4000);
          onOutput?.(text);
        },
      }), { signal: activeSignal }),
      proc.ended,
    ]);
    activeSignal.throwIfAborted();
    if (proc.exitCode !== 0) throw Error(errorText.trim() || 'Linux command failed');
    return new Blob(chunks);
  } catch (error) {
    cancel();
    if (activeSignal.reason?.name === 'TimeoutError') throw Error('The Linux operation timed out');
    throw error;
  } finally {
    activeSignal.removeEventListener('abort', cancel);
    await proc.close().catch(() => {});
  }
}

function workspaceTool(action, input, options) {
  return workspaceProcess(['python3', '-I', proxyRoot + '/workspace-tools.py', action, JSON.stringify(input)], options);
}

async function workspaceFolderEntries(path, signal) {
  const data = await workspaceTool('list', path, { limit: 4 * MiB, signal });
  return JSON.parse(await data.text());
}

async function workspacePacksStatus(signal) {
  const names = [...new Set([...workspaceToolPacks.values()].flatMap(pack => pack.packages))];
  const reply = await workspaceProcess(['apk', 'list', '--quiet', '--installed', ...names], { signal });
  const present = new Set((await reply.text()).trim().split('\n'));
  return Array.from(workspaceToolPacks, ([id, { name, packages }]) => ({
    id, name, packages, installed: packages.every(packageName => present.has(packageName)),
  }));
}

function workspaceDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = name;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function installWorkspaceFiles() {
  const dialog = byId('workspace-files-dialog');
  const list = byId('workspace-files-list');
  const current = byId('workspace-files-path');
  const status = byId('workspace-files-status');
  const up = byId('workspace-files-up');
  const zip = byId('workspace-files-zip');
  let directory = [], controller;

  async function action(message, perform) {
    controller?.abort();
    const job = new AbortController();
    controller = job;
    status.textContent = message;
    for (const button of [up, zip, ...list.querySelectorAll('button')]) button.disabled = true;
    try {
      await perform(job.signal);
      if (!job.signal.aborted) status.textContent = '';
    } catch (error) {
      if (!job.signal.aborted) status.textContent = error.message;
    } finally {
      if (controller === job) {
        controller = undefined;
        up.disabled = !directory.length;
        zip.disabled = false;
        for (const button of list.querySelectorAll('button')) button.disabled = false;
      }
    }
  }

  function getDownload(path, isZip) {
    void action(isZip ? 'Creating ZIP…' : 'Reading file…', async signal => {
      const blob = await workspaceTool(isZip ? 'zip' : 'file', path, { limit: 133 * MiB, timeout: 120000, signal });
      const name = path.at(-1) || 'workspace';
      if (!signal.aborted) workspaceDownload(blob, isZip ? name + '.zip' : name);
    });
  }

  function listFolder(path, entriesFromAgent) {
    void action('Reading folder…', async signal => {
      const entries = entriesFromAgent ?? await workspaceFolderEntries(path, signal);
      signal.throwIfAborted();
      directory = path;
      current.textContent = ['/workspace', ...path].join('/');
      list.replaceChildren();
      entries.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name));
      if (!entries.length) {
        const item = document.createElement('li');
        item.textContent = 'Empty folder';
        list.append(item);
      }
      for (const entry of entries) {
        const item = document.createElement('li');
        const isFolder = entry.kind === 'folder';
        const actionable = isFolder || entry.kind === 'file';
        const name = document.createElement(actionable ? 'button' : 'span');
        name.textContent = entry.name;
        if (actionable) {
          name.type = 'button';
          name.setAttribute('aria-label', (isFolder ? 'Open ' : 'Download ') + entry.name);
          name.addEventListener('click', () => {
            const target = [...path, entry.name];
            if (isFolder) listFolder(target);
            else getDownload(target, false);
          });
        }
        const details = document.createElement('small');
        details.textContent = entry.kind === 'file'
          ? (entry.size >= 1024 ? (entry.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' KiB' : entry.size + ' B')
          : entry.kind;
        item.append(name, details);
        list.append(item);
      }
    });
  }

  function show(folder = directory, entries) {
    if (!dialog.open) dialog.showModal();
    listFolder(folder, entries);
  }
  byId('open-workspace-files').addEventListener('click', () => show());
  byId('workspace-files-refresh').addEventListener('click', () => listFolder(directory));
  byId('workspace-files-upload').addEventListener('click', () => byId('files').click());
  up.addEventListener('click', () => listFolder(directory.slice(0, -1)));
  zip.addEventListener('click', () => getDownload(directory, true));
  dialog.addEventListener('close', () => controller?.abort());
  return show;
}

function installWorkspacePacks() {
  const dialog = byId('workspace-packs-dialog');
  const log = byId('workspace-packs-log');
  let installing = '', revision = 0;
  const installed = new Set();
  function update() {
    for (const [id, pack] of workspaceToolPacks) {
      const button = byId('workspace-pack-' + id);
      button.disabled = busy || !!installing || installed.has(id);
      button.textContent = installed.has(id) ? 'Installed' : installing === id ? 'Installing…' : 'Install';
      button.setAttribute('aria-label', installed.has(id) ? pack.name + ' installed' : 'Install ' + pack.name);
    }
  }

  async function scan() {
    const request = ++revision;
    try {
      const packs = await workspacePacksStatus();
      if (revision !== request) return;
      for (const pack of packs) {
        if (pack.installed) installed.add(pack.id);
        else installed.delete(pack.id);
      }
    } catch (error) {
      if (revision === request) log.textContent = error.message;
    } finally {
      if (revision === request) update();
    }
  }

  for (const [id, pack] of workspaceToolPacks) {
    byId('workspace-pack-' + id).addEventListener('click', () => {
      if (installing || busy || installed.has(id)) return;
      if (!egress.connected) {
        log.textContent = 'Enable approved networking before installing a pack.';
        return;
      }
      installing = id;
      revision++;
      update();
      log.textContent = 'Checking workspace storage…';
      void operation('Installing ' + pack.name + '…', async () => {
        try {
          const room = await workspaceRoom();
          if (room < pack.space && !growthAllowed &&
              !await requestWorkspaceGrowth(pack.name + ' may need more space than the default workspace allowance.')) {
            log.textContent = 'Installation canceled';
            status('Installation canceled');
            return;
          }
          log.textContent = 'Installing ' + pack.name + '…\n';
          await workspaceProcess(['apk', 'add', '--no-cache', ...pack.packages], {
            limit: 4 * MiB, timeout: 420000,
            onOutput(text) {
              log.textContent = (log.textContent + text).slice(-6000);
              log.scrollTop = log.scrollHeight;
            },
          });
          installed.add(id);
          log.textContent += '\n' + pack.name + ' installed.';
          status(pack.name + ' installed');
        } catch (error) {
          log.textContent += '\n' + error.message;
          throw error;
        } finally { installing = ''; }
      }).then(update);
    });
  }
  function open() {
    if (!dialog.open) dialog.showModal();
    update();
    if (!installing && !busy) void scan();
  }
  byId('open-workspace-packs').addEventListener('click', open);
  // Manual saves and autosave can start while this dialog remains open.
  return { open, update };
}

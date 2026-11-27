const MiB = 1024 * 1024;
const maxArchive = 320 * MiB;
const maxFilesystem = 384 * MiB;
const format = 'pointblank-linux-filesystem';
const compatibility = 'alpine-3.24-aarch64-python3.13-rootfs-v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function openDatabase() {
  const request = indexedDB.open('pointblank-linux', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('snapshots');
    request.result.createObjectStore('agent');
  };
  const db = await idbRequest(request);
  db.onversionchange = () => db.close();
  return db;
}

async function transaction(db, store, mode, operation) {
  const tx = db.transaction(store, mode, { durability: 'strict' });
  const completed = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new DOMException('Save interrupted', 'AbortError'));
  });
  const request = idbRequest(operation(tx.objectStore(store)));
  const [, result] = await Promise.all([completed, request]);
  return result;
}

async function openStorage(db) {
  let directory;
  try {
    if (!globalThis.FileSystemFileHandle?.prototype.createWritable) throw Error('OPFS writes unavailable');
    directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(format, { create: true });
  } catch {
    if (!db) throw Error('OPFS and IndexedDB are unavailable');
    const run = (mode, action) => transaction(db, 'snapshots', mode, action);
    return {
      name: 'IndexedDB',
      get: (key) => run('readonly', (store) => store.get(key)),
      put: (key, value) => run('readwrite', (store) => store.put(value, key)),
      list: () => run('readonly', (store) => store.getAllKeys()),
      remove: (key) => run('readwrite', (store) => store.delete(key)),
    };
  }
  return {
    name: 'OPFS',
    async get(key) {
      try { return await (await directory.getFileHandle(key)).getFile(); }
      catch (error) { if (error.name !== 'NotFoundError') throw error; }
    },
    async put(key, value) {
      const file = await directory.getFileHandle(key, { create: true });
      const stream = await file.createWritable();
      try {
        await stream.write(value);
        await stream.close();
      } catch (error) {
        await stream.abort().catch(() => {});
        throw error;
      }
    },
    async list() {
      const names = [];
      for await (const key of directory.keys()) names.push(key);
      return names;
    },
    remove: (key) => directory.removeEntry(key),
  };
}

async function agentStorage(db) {
  const entries = new Map();
  const prefix = 'browser-agent.memory.v1.';
  const run = (mode, action) => transaction(db, 'agent', mode, action);
  if (db) {
    const [keys, values] = await Promise.all([
      run('readonly', (store) => store.getAllKeys()),
      run('readonly', (store) => store.getAll()),
    ]);
    keys.forEach((key, index) => entries.set(key, values[index]));
    try {
      for (const key of Object.keys(localStorage).filter((key) => key.startsWith(prefix))) {
        const value = localStorage.getItem(key);
        if (!entries.has(key)) {
          await run('readwrite', (store) => store.put(value, key));
          entries.set(key, value);
        }
        localStorage.removeItem(key);
      }
    } catch {}
  }
  return {
    get length() { return entries.size; },
    key: (index) => [...entries.keys()][index],
    getItem: (key) => entries.get(key),
    setItem(key, value) {
      entries.set(key, value);
      if (db) run('readwrite', (store) => store.put(value, key)).catch(console.warn);
    },
    removeItem(key) {
      entries.delete(key);
      if (db) run('readwrite', (store) => store.delete(key)).catch(console.warn);
    },
  };
}

function acquireWorkspace() {
  if (!navigator.locks) return Promise.resolve({ exclusive: false });
  return new Promise((resolve, reject) => {
    navigator.locks.request(format, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve({ exclusive: false, inUse: true });
        return;
      }
      return new Promise((release) => resolve({ exclusive: true, release }));
    }).catch(reject);
  });
}

const skipped = [
  './proc', './sys', './dev', './run', './tmp', './var/run', './var/log', './etc/resolv.conf',
  './etc/ssl/certs/workstation-proxy.pem', './usr/local/libexec/browser-agent', './usr/local/bin/agent', './usr/local/bin/network',
  './etc/apt/auth.conf', './etc/apt/auth.conf.d',
  '*/.ssh', '*/.gnupg', '*/.git-credentials', '*/.netrc', '*/.authinfo', '*/.authinfo.gpg',
  '*/.npmrc', '*/.pypirc', '*/.curlrc', '*/.wgetrc', '*/.bash_history', '*/.ash_history',
  '*/.config/gh', '*/.config/git/credentials', '*/.config/gcloud', '*/.aws', '*/.azure',
  '*/.docker/config.json', '*/.kube', '*/.password-store',
];

const credentialsPath = /(?:^|\/)(?:\.ssh|\.gnupg|\.git-credentials|\.netrc|\.authinfo(?:\.gpg)?|\.npmrc|\.pypirc|\.curlrc|\.wgetrc|\.bash_history|\.ash_history|\.aws|\.azure|\.kube|\.password-store)(?:\/|$)|(?:^|\/)\.config\/(?:gh|gcloud|git\/credentials)(?:\/|$)|(?:^|\/)\.docker\/config\.json(?:\/|$)|^etc\/apt\/(?:auth\.conf|auth\.conf\.d)(?:\/|$)/;
const runtimePath = /^(?:proc|sys|dev|run|tmp|var\/(?:run|log)|etc\/(?:resolv\.conf|ssl\/certs\/workstation-proxy\.pem)|usr\/local\/(?:libexec\/browser-agent|bin\/(?:agent|network)))(?:\/|$)/;
const credentialText = /(?:gh[pour]_[A-Za-z0-9]{30,}|ghs_[A-Za-z0-9_.-]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{16,})/;
const gitSecret = /(?:^|[\r\n])\s*(?:extraheader\s*=\s*authorization\s*:|password\s*=)|https?:\/\/[^\s\x00/@:]+:[^\s\x00/@]+@/i;
// Alpine's signed GnuTLS 3.8.14 aarch64 library embeds public self-test keys.
const gnutlsFixture = {
  path: 'usr/lib/libgnutls.so.30.43.0',
  size: 2109376,
  sha256: '7ae6940f675b5419d3bd6f7e73868ea4c97bbe9911f6a3df9b00b85cbb91b7bf',
};

function tarPath(value) {
  const path = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (!path || path === '.') return '.';
  if (path.includes('\\') || path.split('/').some((part) => !part || part === '..' || part === '.')) {
    throw Error('Snapshot contains an unsafe filesystem path');
  }
  return path;
}

function tarString(bytes) {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function tarNumber(bytes) {
  const value = tarString(bytes).trim();
  if (!/^[0-7]*$/.test(value)) throw Error('Unsupported tar numeric field');
  return value ? Number.parseInt(value, 8) : 0;
}

async function validateTar(blob, secrets = [], allowPrompt = false) {
  const reader = blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  let chunk = new Uint8Array();
  let offset = 0, total = 0;
  async function checkExpandedSize(size) {
    if (size <= maxFilesystem || growthAllowed) return;
    if (allowPrompt && await requestWorkspaceGrowth('This snapshot expands beyond the default workspace allowance.')) return;
    throw Error('Expanded snapshot exceeds ' + maxFilesystem / MiB + ' MiB');
  }
  async function take(size, consume = () => {}) {
    while (size > 0) {
      if (offset === chunk.length) {
        const item = await reader.read();
        if (item.done) throw Error('Snapshot archive ended early');
        chunk = item.value;
        offset = 0;
        total += chunk.length;
        if (total > maxFilesystem && !growthAllowed) await checkExpandedSize(total);
      }
      const length = Math.min(size, chunk.length - offset);
      consume(chunk.subarray(offset, offset + length));
      size -= length;
      offset += length;
    }
  }
  async function bytes(size) {
    const output = new Uint8Array(size);
    let written = 0;
    await take(size, (part) => { output.set(part, written); written += part.length; });
    return output;
  }

  const paths = new Map();
  let longName, longLink;
  try {
    while (true) {
      const header = await bytes(512);
      if (header.every((byte) => byte === 0)) {
        if (!(await bytes(512)).every((byte) => byte === 0) || longName || longLink) throw Error('Invalid tar ending');
        if (offset !== chunk.length && chunk.subarray(offset).some(Boolean)) throw Error('Data after tar archive');
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          total += item.value.length;
          if (item.value.some(Boolean)) throw Error('Data after tar archive');
          if (total > maxFilesystem && !growthAllowed) await checkExpandedSize(total);
        }
        break;
      }
      const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (checksum !== tarNumber(header.subarray(148, 156))) throw Error('Tar header checksum failed');
      const size = tarNumber(header.subarray(124, 136));
      const type = String.fromCharCode(header[156] || 48);
      if (size > maxFilesystem && !growthAllowed) await checkExpandedSize(size);
      if (paths.size > 150000) throw Error('Snapshot exceeds filesystem limits');
      if (type === 'L' || type === 'K') {
        if (size > 4096 || (type === 'L' ? longName : longLink)) throw Error('Invalid long tar path');
        const value = tarString(await bytes(size));
        if (type === 'L') longName = value;
        else longLink = value;
      } else {
        const prefix = tarString(header.subarray(345, 500));
        const path = tarPath(longName || (prefix ? prefix + '/' : '') + tarString(header.subarray(0, 100)));
        const link = longLink || tarString(header.subarray(157, 257));
        longName = longLink = undefined;
        if (!'0125'.includes(type) || (type !== '0' && size) || (path === '.' && type !== '5') || paths.has(path)) {
          throw Error('Unsupported or duplicate tar entry');
        }
        const parts = path.split('/');
        while (parts.length > 1) {
          parts.pop();
          if (paths.get(parts.join('/')) !== '5') throw Error('Snapshot path has an invalid parent');
        }
        if (credentialsPath.test(path) || runtimePath.test(path) || credentialText.test(path) || credentialText.test(link) ||
            secrets.some((secret) => path.includes(secret) || link.includes(secret))) {
          throw Error('Snapshot contains an excluded session file or credential');
        }
        if (type === '1' && paths.get(tarPath(link)) !== '0') throw Error('Invalid tar hard link');
        paths.set(path, type);
        if (type === '0' && path === gnutlsFixture.path && size === gnutlsFixture.size) {
          const contents = await bytes(size);
          const text = decoder.decode(contents);
          if (secrets.some((secret) => text.includes(secret)) ||
              (credentialText.test(text) && await digest(new Blob([contents])) !== gnutlsFixture.sha256)) {
            throw Error('Remove the credential from ' + path + ' before saving');
          }
        } else if (type === '0') {
          let tail = '';
          const isGitConfig = /(?:^|\/)(?:\.gitconfig|\.git\/config(?:\.worktree)?)$/.test(path);
          await take(size, (part) => {
            const text = tail + decoder.decode(part);
            if (credentialText.test(text) || (isGitConfig && gitSecret.test(text)) || secrets.some((secret) => text.includes(secret))) {
              throw Error('Remove the credential from ' + path + ' before saving');
            }
            tail = text.slice(-4096);
          });
        }
      }
      await take((512 - size % 512) % 512);
    }
    if (['workspace', 'root', 'etc', 'usr', 'usr/local', 'usr/local/bin', 'usr/local/libexec'].some((path) => paths.get(path) !== '5') ||
        paths.get('etc/alpine-release') !== '0' || paths.get('bin/busybox') !== '0') {
      throw Error('Snapshot is missing required Alpine files');
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function digest(blob) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function packageSnapshot(metadata, tar) {
  const header = encoder.encode(JSON.stringify(metadata));
  const prefix = new Uint8Array(8);
  prefix.set(encoder.encode('PBL1'));
  new DataView(prefix.buffer).setUint32(4, header.length);
  return new Blob([prefix, header, tar], { type: 'application/octet-stream' });
}

async function readSnapshot(file, { portable = false, headerOnly = false } = {}) {
  if (!(file instanceof Blob) || file.size < 9) throw Error('Invalid snapshot size');
  if (file.size > maxArchive + 8192 && !growthAllowed &&
      !(portable && await requestWorkspaceGrowth('This snapshot exceeds the default workspace allowance.'))) {
    throw Error('Snapshot exceeds the default storage allowance');
  }
  const prefix = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const length = new DataView(prefix.buffer).getUint32(4);
  if (decoder.decode(prefix.subarray(0, 4)) !== 'PBL1' || length < 2 || length > 8192 || 8 + length > file.size) {
    throw Error('Unrecognized snapshot format');
  }
  const metadata = JSON.parse(await file.slice(8, 8 + length).text());
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw Error('Invalid snapshot metadata');
  const known = ['format', 'version', 'compatibility', 'createdAt', 'name', 'offline', 'bytes', 'sha256'];
  if (!portable) known.push('generation', 'reset', 'publicNetworkSuspended');
  if (Object.keys(metadata).some((key) => !known.includes(key))) throw Error('Unrecognized snapshot metadata');
  const tar = file.slice(8 + length);
  const { generation } = metadata;
  if (metadata.format !== format || metadata.version !== 1 || metadata.compatibility !== compatibility) {
    throw Error('This snapshot requires a compatible Alpine workstation');
  }
  if (typeof metadata.name !== 'string' || !metadata.name || metadata.name.length > 80 || credentialText.test(metadata.name) ||
      !Number.isFinite(Date.parse(metadata.createdAt)) || typeof metadata.offline !== 'boolean' ||
      (metadata.publicNetworkSuspended !== undefined && typeof metadata.publicNetworkSuspended !== 'boolean') ||
      (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 1))) {
    throw Error('Invalid snapshot metadata');
  }
  if (metadata.reset === true && generation && !portable && !tar.size) return { metadata, tar };
  if (!tar.size || (!growthAllowed && tar.size > maxArchive) || tar.size !== metadata.bytes || !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
    throw Error('Invalid snapshot contents');
  }
  if (!headerOnly && await digest(tar) !== metadata.sha256) throw Error('Snapshot integrity check failed');
  if (portable) await validateTar(tar, [], true);
  return { metadata, tar };
}

function snapshotMetadata(name, offline) {
  return { format, version: 1, compatibility, createdAt: new Date().toISOString(), name, offline };
}

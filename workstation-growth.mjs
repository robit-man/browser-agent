const workspaceDiskTemplate = 'pointblank-workspace-disk';
const workspaceDiskPrefix = 'pointblank-live-';
const workspaceGrowthKey = 'pointblank-linux-workspace-growth';
const workspaceHeadroom = 16 * MiB;
let growthAllowed = false;
try { growthAllowed = localStorage.getItem(workspaceGrowthKey) === 'allow'; } catch {}
let growthRequest, spacePrompted = false;

async function workspaceDisks(legacy) {
  const disks = legacy ? [{ kind: 'data', template: 'bundled', name: 'browser-agent' }] : [];
  if (!workspaceLock?.exclusive || !embeddedPayloads.has(workspaceDiskTemplate) || !globalThis.indexedDB) return disks;
  // These disks are scratch space. Durable workspace state lives in the checkpoints.
  for (const { name } of await indexedDB.databases?.().catch(() => []) || []) {
    if (name?.startsWith('kwdisk:' + workspaceDiskPrefix)) indexedDB.deleteDatabase(name);
  }
  const template = new Uint8Array(await embeddedAsset(workspaceDiskTemplate).arrayBuffer());
  disks.push({ kind: 'data', template, name: workspaceDiskPrefix + crypto.randomUUID() });
  return disks;
}

async function workspaceRoom() {
  const result = await guestExec(runtime.vm, `df -Pk /tmp/docker | awk 'NR==2 {print $4}'`);
  const available = String(result).trim();
  if (!/^\d+$/.test(available)) throw Error('Workspace free space is unavailable');
  return Number(available) * 1024;
}

async function permitWorkspaceGrowth(vm) {
  await guestExec(vm, 'sh /mnt/oci/bin/docker allow-workspace-growth');
  growthAllowed = true;
  try { localStorage.setItem(workspaceGrowthKey, 'allow'); } catch {}
  byId('workspace-grow').disabled = true;
  byId('workspace-room').textContent = 'Workspace growth approved';
}

function requestWorkspaceGrowth(message) {
  if (growthAllowed) return Promise.resolve(true);
  if (growthRequest) return growthRequest;
  const dialog = byId('growth-dialog');
  byId('growth-message').textContent = message;
  dialog.returnValue = '';
  growthRequest = new Promise((resolve) => {
    dialog.addEventListener('close', async () => {
      let approved = false;
      if (dialog.returnValue === 'allow' && runtime?.vm) {
        try { await permitWorkspaceGrowth(runtime.vm); approved = true; }
        catch (error) {
          byId('workspace-room').textContent = error.message;
          byId('announcement').textContent = error.message;
        }
      }
      growthRequest = undefined;
      resolve(approved);
    }, { once: true });
    dialog.showModal();
  });
  return growthRequest;
}

async function gitDownloadAllowance() {
  if (growthAllowed) return Infinity;
  const room = await workspaceRoom().catch(() => Infinity);
  return Math.min(gitPackResponseBytes, Math.max(0, room - workspaceHeadroom));
}

function watchWorkspaceGrowth() {
  byId('workspace-grow').disabled = growthAllowed;
  if (growthAllowed) byId('workspace-room').textContent = 'Workspace growth approved';
  byId('workspace-grow').addEventListener('click', () => {
    byId('storage-dialog').close();
    void requestWorkspaceGrowth('Allow this workspace to use available browser storage as it grows.');
  });
  let checking = false;
  const timer = setInterval(async () => {
    if (growthAllowed) { clearInterval(timer); return; }
    if (checking || busy || document.hidden || growthRequest) return;
    checking = true;
    try {
      const room = await workspaceRoom();
      byId('workspace-room').textContent = Math.floor(room / MiB) + ' MiB before approval is required';
      if (room > workspaceHeadroom) spacePrompted = false;
      else if (!spacePrompted) {
        spacePrompted = true;
        void requestWorkspaceGrowth('This workspace is reaching its default storage allowance.');
      }
    } catch {} finally { checking = false; }
  }, 2200);
  window.addEventListener('pagehide', (event) => { if (!event.persisted) clearInterval(timer); });
}

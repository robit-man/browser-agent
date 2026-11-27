# Pointblank Linux

Pointblank Linux boots a client-side Alpine 3.24 aarch64 workspace with Bash, Python, and the existing browser agent. The workspace opens in `/workspace`. Type `agent` for the existing interactive agent or `exit` to reach the outer Linux shell and its Docker commands. Drop normal files on the terminal or use Ctrl+O to copy them to `/workspace/inbox`. Model weights are fetched separately when requested.

## Workspace storage

- **Save** checkpoints the Alpine root filesystem. Installed packages, Git trees and history, home directories, and supported system configuration are included.
- **Autosave** defaults to one minute. The menu also offers 30 seconds, three minutes, and off. Save explicitly before leaving when you need everything up to that point.
- **Snapshots** stores named checkpoints in the browser. It supports restore, export, and confirmed deletion. **Export** downloads the current workspace. **Import** verifies a local file and asks before replacing the workspace. **Reset** starts a fresh workspace and preserves named snapshots.
- **Protect storage** requests persistent browser storage. The usage display reports the browser's estimate for the entire origin. Browser settings and site-data deletion still control retention. Keep downloadable backups. [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) · [StorageManager.persist](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)
- OPFS is the primary checkpoint store and IndexedDB is the fallback. Web Locks allow one active workspace tab per origin. Where locking is unavailable, the page uses a temporary session. Agent memory is stored separately in IndexedDB and excluded from workspace exports. [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)

Each save freezes processes in the workspace cgroup while reading the Alpine filesystem. Browser-side compression and checks run before storage commits. Two alternating checkpoint slots retain the previous verified state. OPFS publishes a closed write atomically, and IndexedDB uses a strict-durability transaction. A failed or interrupted write leaves the previous checkpoint available. On reopening, the app verifies the newest candidate and falls back to the previous valid candidate. Changes to the Alpine filesystem made from the outer maintenance shell during the capture can race with the save. [FileSystemWritableFileStream](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemWritableFileStream)

## Browser and offline use

Use a secure origin with WebAssembly JSPI, Web Locks, and OPFS or IndexedDB. The project verifies browser engines listed in [the release results](test/RESULTS.md). Upstream unkernel publishes a broader JSPI support matrix. [unkernel browser support](https://github.com/pithings/unkernel#-try-it-in-the-browser)

The distributed `index.html` includes the pinned Linux kernel, Alpine/Python images, terminal, and application code. Serve that file or open a local copy on a compatible browser for offline Linux. Browser data is scoped to the profile and origin. Export and import to move a workspace between origins or computers. Optional model and speech downloads have their own availability requirements.

## Portable snapshot format

A `.pblinux` file has this binary layout.

| Field | Encoding |
| --- | --- |
| Magic | Four ASCII bytes `PBL1` |
| Header size | Unsigned 32-bit big-endian length, at most 8,192 bytes |
| Header | UTF-8 JSON |
| Payload | Gzip-compressed BusyBox-compatible tar of the Alpine filesystem |

The header contains `format` (`pointblank-linux-filesystem`), `version` (1), `compatibility` (`alpine-3.24-aarch64-python3.13-rootfs-v1`), `createdAt` (ISO 8601 UTC), `name`, `offline` (true), `bytes` (compressed payload length), and the lowercase hex `sha256` of the compressed payload. Automatic checkpoints additionally track a browser-local generation. Portability limits are 128 MiB compressed and 196 MiB expanded, subject to guest memory and browser quota.

Archive validation checks both tar headers and the compressed SHA-256, supported entry types, path confinement, and required Alpine files. The archive carries normal files, directories, symlinks, hard links, and tar ownership, permissions, and timestamps. Extended attributes, ACLs, special files, kernel mounts, logs, temporary files, outer Docker containers, and process state are outside this format. Restore performs a fresh boot into the archived filesystem. Import snapshots from sources you trust.

The application keeps its Worker key and repository credential in browser memory. It excludes well-known Git and shell credential files, service sessions, and the runtime proxy keys. It rejects common plaintext token and private-key formats, as well as credential-bearing Git config. A secret copied into ordinary application data, generated files, or encoded Git objects can be indistinguishable from user data. Keep additional credentials out of the Linux filesystem and Git history. Restored environments always start with networking off.

The bundled unkernel exposes `KernelInstance.snapshot()` and `createKernel({ restore })`. Execution-state restore requires matching kernel, devices, disk generations, and compatible CPU configuration. Pointblank uses the independent filesystem format above, so package and file recovery does not depend on that VM snapshot API. [unkernel snapshot API](https://github.com/pithings/unkernel#-use-it-from-javascript)

## Authorized native networking

Open **NETWORK: OFFLINE** or run `network on` in Alpine and enter the workspace egress key. For private Git or push, also enter a GitHub username and a fine-grained token restricted to the authorized repository and Contents permissions. A repository-specific GitHub App installation token also works. The repository must allow writes in the gateway policy. GitHub applies the token's permissions and branch rules. [GitHub token permissions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

Use `network status`, `network services`, `network test`, and `network logs` in Alpine. `network off` cancels requests and removes the local session. Sessions expire after one hour. Open the dialog and authorize again to renew. Rotate the gateway key to revoke outstanding sessions. [Network architecture and security](docs/NETWORK.md)

## Build and deployment

```sh
python3 tools/build-workstation.py --split-assets cloudflare/.release-assets
npx --yes wrangler@4.168.0 deploy --dry-run --config cloudflare/wrangler.toml
npx --yes wrangler@4.168.0 deploy --config cloudflare/wrangler.toml
npx --yes wrangler@4.168.0 secret put WORKSTATION_EGRESS_TOKEN --config cloudflare/wrangler.toml
npx --yes wrangler@4.168.0 deploy --config cloudflare/linux-host.toml
```

Production uses the existing `browser-agent` hosting Worker at `https://linux.pointblankllc.com` and a dedicated `pointblank-linux-network` Worker at `https://network.pointblankllc.com`. Preserve the app origin to preserve existing workspaces. The standalone HTML exceeds Cloudflare's 25 MiB per-asset limit. The host build splits the exact bytes into two assets and returns their concatenation as a single HTML response. The browser uses no separate kernel request. The optional `--kernel` argument verifies the pinned WASM when embedding a replacement. [Cloudflare asset limits](https://developers.cloudflare.com/workers/platform/limits/#static-assets)

Deploy the same build to a staging host with an isolated egress Worker first. The build's `--gateway` option sets the staging gateway in a separate output HTML. Set staging's `WORKSTATION_ORIGINS` and the diagnostics binding to the staging host. The [release results](test/RESULTS.md) list the tested deployments and commands.

For rollback, retain the prior host Worker version and its assets. Roll back the hosting Worker with Wrangler using the appropriate version ID in the release report, then verify the production HTML and terminal on the same origin. The independently deployed gateway can be rolled back or its key rotated separately. [Cloudflare rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)

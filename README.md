# Pointblank Linux

Pointblank Linux boots a client-side Alpine 3.24 aarch64 workspace with Bash, Python, and the existing browser agent. The workspace opens in `/workspace`. Type `agent` for the interactive agent. **Maintenance shell** in the workspace menu opens the outer Linux shell and its Docker commands. Drop files on the terminal or choose **Upload files** to copy them to `/workspace/inbox`. Ctrl+O opens the file picker when focus is outside the terminal. Model weights are fetched separately when requested.

## Development tools

Fresh and reset workspaces include Git, Node.js, npm, APT, curl, jq, ripgrep (`rg`), nano, make, patch, file, zip, btop, and cloudflared. These tools are available from a downloaded copy of the HTML. Saved and imported workspaces restore their own package set. In an older workspace, run `apk add curl jq ripgrep nano make patch file zip btop` to install the utilities available from the stable Alpine repositories.

The bundled cloudflared can validate local ingress rules. Running a Cloudflare Tunnel from the browser guest requires outbound TCP or UDP port 7844, which is outside the workspace's HTTP and HTTPS gateway. [Cloudflare Tunnel ports](https://developers.cloudflare.com/tunnel/configuration/#firewall-rules)

Use `apk add` for Alpine system packages and `npm install` for JavaScript dependencies. APT manages Debian packages. [Alpine packages](https://pkgs.alpinelinux.org/packages?branch=v3.24&arch=aarch64) · [Debian APT](https://wiki.debian.org/Apt/)

The **Workspace** menu includes **Files** for downloads and folder ZIPs, **Preview server** for static or server-rendered guest HTTP pages, and **Tool packs** for installing shell utilities or a native C/C++ toolchain. To try the preview, run `python3 -m http.server 8000 --bind 127.0.0.1` in the guest and open port 8000. [Workspace tools specification](docs/WORKSPACE-TOOLS.md)

## Terminals

Use **+** to open a shell and the upper-left chevron to show the session sidebar. Each Alpine terminal has its own shell and scrollback in the same running container. Drag a session or **+** onto a pane to dock it. Drag a divider or focus it and press an arrow key to resize. Click the pane title to adjust its text size. The fork button opens a shell in the pane's last reported working directory. Minimize keeps the shell running in the sidebar. Closing a session ends its shell after confirmation.

On touch devices the terminal key strip appears above the on-screen keyboard. It includes Ctrl, Shift, Alt, Escape, arrows, and function keys. Long-press or double-tap to select text and open clipboard controls. Two-finger scrolling works in the terminal, including in full-screen applications. Workspace saves capture the filesystem. Reloading opens a fresh shell.

Use a pane's share icon to create a one-time QR or link invite compatible with [Pointblank TTY](https://tty.pointblankllc.com/). Send the four-character PIN separately and approve the request after the peer verifies it. View-only access is the default. Enable Control to let that peer type into the selected shell. **Connect** accepts a TTY invite or scans its QR code. Either site can issue the invite. Disconnect a peer from the sharing dialog or close the source session to end access. [TTY reference source](https://github.com/robit-man/tty/tree/d11a699f2bf573725387ecb5fb08496cf37f1f8d)

Terminal sharing uses the TTY client's encrypted v2 session over its relay and requires relay connectivity. The live view can contain text shown on the shared terminal. Sharing grants only the selected terminal's approved capabilities. An exported filesystem snapshot is a separate feature.

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

The header contains `format` (`pointblank-linux-filesystem`), `version` (1), `compatibility` (`alpine-3.24-aarch64-python3.13-rootfs-v1`), `createdAt` (ISO 8601 UTC), `name`, `offline` (true), `bytes` (compressed payload length), and the lowercase hex `sha256` of the compressed payload. Automatic checkpoints additionally track a browser-local generation. The default allowances are 320 MiB compressed and 384 MiB expanded. Growth approval lifts these byte allowances, subject to browser quota and processing memory. Older releases have smaller restore limits.

Archive validation checks both tar headers and the compressed SHA-256, supported entry types, path confinement, and required Alpine files. The archive carries normal files, directories, symlinks, hard links, and tar ownership, permissions, and timestamps. Extended attributes, ACLs, special files, kernel mounts, logs, temporary files, outer Docker containers, and process state are outside this format. Restore performs a fresh boot into the archived filesystem. Import snapshots from sources you trust.

When private access is used, the application keeps its session and repository credential in browser memory. It excludes well-known Git and shell credential files, service sessions, and the runtime proxy keys. It rejects common plaintext token and private-key formats, as well as credential-bearing Git config. A secret copied into ordinary application data, generated files, or encoded Git objects can be indistinguishable from user data. Keep additional credentials out of the Linux filesystem and Git history. Imported snapshots and explicitly restored named snapshots start with networking off.

The bundled unkernel exposes `KernelInstance.snapshot()` and `createKernel({ restore })`. Execution-state restore requires matching kernel, devices, disk generations, and compatible CPU configuration. Pointblank uses the independent filesystem format above, so package and file recovery does not depend on that VM snapshot API. [unkernel snapshot API](https://github.com/pithings/unkernel#-use-it-from-javascript)

## Authorized native networking

[linux.pointblankllc.com](https://linux.pointblankllc.com/) connects to public networking before opening a fresh or ordinary saved shell. Use native Git for public GitHub repositories, curl for approved HTTP services, and APK and npm for approved package sources.

New workspaces include Git, Node.js, npm, and Alpine's native build of `apt` with `dpkg`. Use `apt install /path/to/package.deb` for local Debian packages compatible with the guest. Use `apk add` for Alpine system packages. Debian repositories are unconfigured by default. Existing workspaces can add APT with `apk add apt`.

The default workspace allowance is about 420 MiB, including the Alpine starter filesystem. Git clone and fetch pause for approval before a pack uses the remaining allowance or reaches 256 MiB. A dialog also appears when local writes leave less than 16 MiB available. If a local command has already hit its filesystem limit, retry it after approving. **Storage and autosave → Allow workspace growth** opens the same dialog.

Approval lifts the app's byte allowances and persists for this browser. The browser-backed ext4 disk is sparse and allocates space as written, up to browser quota and the 1 TiB virtual disk capacity. Browsers without a writable workspace disk use a RAM-backed filesystem and remain subject to guest RAM. The Git pack and checked-out files both count toward workspace use.

For private Git or push, open the status dot's **Networking** dialog and enter the workspace egress key, a GitHub username, and a fine-grained token scoped to the authorized repository and Contents permissions. A repository-specific GitHub App installation token also works. The repository must allow writes in the authenticated gateway policy. GitHub applies the token's permissions and branch rules. [GitHub token permissions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

Use `network status`, `network services`, `network test`, and `network logs` in Alpine. `network off` cancels requests for the current visit. Reloading reconnects an ordinary workspace automatically. Use `network on` to resume public access in place or approve networking for a restored checkpoint. Private sessions expire after one hour. Open the dialog and authorize again to renew. Rotate the private gateway key to revoke outstanding private sessions. [Network architecture and security](docs/NETWORK.md)

## Build and deployment

```sh
python3 tools/build-workstation.py --split-assets cloudflare/.release-assets
npx --yes wrangler@4.168.0 deploy --dry-run --config cloudflare/wrangler.toml
npx --yes wrangler@4.168.0 deploy --config cloudflare/wrangler.toml
npx --yes wrangler@4.168.0 secret put WORKSTATION_EGRESS_TOKEN --config cloudflare/wrangler.toml
npx --yes wrangler@4.168.0 versions upload --config cloudflare/linux-host.toml
# Verify the returned preview and its byte-for-byte hash before routing traffic.
npx --yes wrangler@4.168.0 versions deploy VERSION_ID@100% --yes --config cloudflare/linux-host.toml
```

Production uses the existing `browser-agent` hosting Worker at `https://linux.pointblankllc.com` and a dedicated `pointblank-linux-network` Worker at `https://network.pointblankllc.com`. Preserve the app origin to preserve existing workspaces. The host build splits the exact HTML bytes into pieces under Cloudflare's 25 MiB per-asset limit. It streams them as one fixed-length HTML response. The optional `--kernel` argument verifies the pinned WASM when embedding a replacement. [Cloudflare asset limits](https://developers.cloudflare.com/workers/platform/limits/#static-assets)

Ordinary builds reuse the embedded development layer. To refresh the layer, use Docker to resolve and verify packages from the Alpine 3.24 repositories for the guest architecture, then rebuild the HTML with the resulting archive. [Alpine aports](https://gitlab.alpinelinux.org/alpine/aports/-/tree/3.24-stable)

The layer builder verifies Cloudflare's pinned ARM64 release by SHA-256 and uses `llvm-strip` on the build host to remove debug symbols. [cloudflared releases](https://github.com/cloudflare/cloudflared/releases)

```sh
python3 tools/build-development-layer.py /tmp/pointblank-development.tar.gz
python3 tools/build-workstation.py --development-layer /tmp/pointblank-development.tar.gz --split-assets cloudflare/.release-assets
```

The standalone build reuses the embedded workspace disk template. To rebuild that template on a Linux host with e2fsprogs, run `python3 tools/build-workspace-disk.py /tmp/pointblank-disk.kwsparse.gz`, then pass `--workspace-disk /tmp/pointblank-disk.kwsparse.gz` to `tools/build-workstation.py`.

Deploy the same build to a staging host with an isolated egress Worker first. The build's `--gateway` option sets the staging gateway in a separate output HTML. Set staging's `WORKSTATION_ORIGINS` and the diagnostics binding to the staging host. The [release results](test/RESULTS.md) list the tested deployments and commands.

For rollback, retain the prior host Worker version and its assets. Roll back the hosting Worker with Wrangler using the appropriate version ID in the release report, then verify the production HTML and terminal on the same origin. The independently deployed gateway can be rolled back or its key rotated separately. [Cloudflare rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)

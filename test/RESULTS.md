# Workstation verification

Run on November 26, 2026 using desktop Chromium 156.0.8078.4 on Linux, the bundled unkernel build `0.2.0-261121-e69adda`, and Wrangler 4.168.0. Linux commands ran in the browser's Alpine terminal. The browser harness drove the actual terminal and toolbar, and an independent host Git process inspected and updated the test remote.

| Check | Result |
| --- | --- |
| Native APK | Installed curl, Git, wget, Node.js and npm from the live Alpine 3.24 package repositories. |
| Native HTTP and HTTPS | curl and wget downloaded the fixture script. The guest verified the SHA-256 and executed the script with the expected output and exit code. The Worker denied a disallowed path. A direct guest connection failed with the proxy bypassed. |
| Native Git writes | Cloned a controlled bare repository through the Worker protocol, checked out a branch, committed, and pushed with a fixture credential. The host independently checked the pushed commit and file, then created an external change. Native fetch and pull brought that exact commit and file into the guest. Push without the Git credential failed. |
| Live GitHub read | Native Git cloned the public `robit-man/POINTBLANK` repository through the locally running Cloudflare Worker. |
| Python and npm | Native pip installed `packaging==25.0` from live PyPI and Python imported it. Native npm installed `is-number@7.0.0` from the live registry and Node loaded it. |
| OPFS persistence | Installed packages, Git history and working tree, a home file, and an `/etc` file survived refresh and complete browser restart. A second tab was blocked until the writer closed. |
| Snapshot lifecycle | Created and named a snapshot, restored it, confirmed reset, and deleted the named copy. Reset preserved named snapshots. |
| Portable backup | Exported a workspace and imported it in a clean profile. The guest verified the repository contents and installed packages. A deliberately corrupted payload was rejected. Known credential files were absent and native network access required fresh authorization. |
| Interrupted save and quota | Interrupted a staged OPFS write by closing Chromium before commit. The prior state survived. An imposed 1 KiB Chromium quota then produced the storage-full state and preserved the prior checkpoint. |
| Subsequent application deployment | Restored the same saved state after serving a changed HTML build on the same test origin with the same snapshot compatibility identifier. |
| Autosave and IndexedDB fallback | An interval checkpoint saved a terminal-created file and recovered it on refresh with OPFS disabled. The named snapshot lifecycle also passed using IndexedDB. |
| Offline | The single-file embedded-kernel build booted and executed an Alpine shell command from a local file with Chromium offline. It used IndexedDB in that context. |
| Worker runtime | Wrangler dry run passed. Local workerd returned 204 for an authorized key check, 200 for an allowlisted live Alpine request, 401 without an egress key, and 403 for a denied destination. |

The original local controlled write test used real Git smart HTTP and `git http-backend` against a bare repository with a synthetic credential. The dedicated gateway release below also exercised a private GitHub repository with a live repository-scoped installation token.

## Reproduce the browser suite

From the repository root, run the fixture and then the browser runner in separate shells. Start a fresh fixture for each test run. The two processes use loopback. The optional package checks contact the configured public registries. Set `CHROMIUM_PATH` or `PLAYWRIGHT_MODULE` to use an existing browser or Playwright installation.

```sh
node test/fixture.mjs
npm install --no-save --no-package-lock playwright
npx playwright install chromium
EXTRA_PACKAGE_TESTS=1 node test/browser.mjs
```

## Dedicated gateway release

The host baseline was Git commit `6aea20b` and Cloudflare Worker version `a2fe5ef1-88b6-4e5a-bb81-10307375b987`. The backup branch is `backup/linux-production-20261126`. The working branch is `pointblank/linux-network-persistence`.

Staging uses [the Linux host](https://pointblank-linux-stage.pointblank-connect.workers.dev/) and [the gateway](https://pointblank-linux-network-stage.pointblank-connect.workers.dev/health). Production binds the separate gateway at [network.pointblankllc.com](https://network.pointblankllc.com/health) and keeps the existing app origin at [linux.pointblankllc.com](https://linux.pointblankllc.com/).

### Browser coverage

| Browser | Observed staging result |
| --- | --- |
| Chromium 156.0.8078.4 on Linux | Passed terminal, native network and workspace recovery. |
| Microsoft Edge 158.0.4370.45 on Linux | Passed native curl, wget, apk, GitHub clone, and network disable. |
| Firefox 157.0 on Linux | Booted the hosted Alpine shell and ran a guest command. OPFS was active. |
| Playwright WebKit 26.5 on Linux | Booted the hosted Alpine shell and ran a guest command with IndexedDB. Storage quota was unavailable in that test context. |
| Apple Safari on macOS and iOS | No Apple test host was available. WebKit results describe the Linux Playwright engine. |

### Measured on the same Linux machine

| Metric | Existing production | Staged upgrade |
| --- | --- | --- |
| Browser-visible HTML | 25,492,954 bytes | 31,180,216 bytes with the embedded Linux kernel |
| Cold terminal ready | 12.83 s | 10.08 s |
| Renderer RSS at terminal ready | 745 MiB | 681 MiB |
| Renderer JS heap and backing storage at terminal ready | 36 MiB and 182 MiB | 38 MiB and 52 MiB |
| Terminal command round trip | 111 ms | 126 ms |
| Native first and repeated diagnostic HTTP request | Guest egress unavailable in baseline | 407 ms and 412 ms |
| Native 1 MiB transfer | Guest egress unavailable in baseline | 2.09 MB/s |
| Cloudflare gateway CPU in sampled staged requests | No gateway | 0–2 ms |
| Browser gateway requests in one staged smoke | No gateway | 30 POST and 1 GET observed by Playwright, plus browser preflights managed by Cloudflare |

These are cold-context spot checks and timing includes browser, guest, and network work. Renderer RSS is Linux process RSS for renderer processes at readiness. Cloudflare dashboard metrics report gateway requests and upstream binding activity separately.

The deployed gateway test produced HTTP 401 for a missing session, 403 for the wrong origin, disallowed method and redirect, 400 for a private-target attempt, 413 for oversized input, 429 for the authentication rate limit, and 504 for a forced upstream timeout. The 1 MiB binary matched its expected SHA-256. Observed Cloudflare tail records matched the request IDs returned by the Worker.

A staging-only serving defect caused automatic edge compression to truncate some HTML responses. The host now emits a fixed-length, identity-encoded response. Five consecutive downloads advertising compression and the separate production preview all matched the generated artifacts byte-for-byte. No staged serving defect reached the existing production application.

```sh
node test/gateway.mjs
GATEWAY_URL=https://pointblank-linux-network-stage.pointblank-connect.workers.dev \\
  WORKSTATION_URL=https://pointblank-linux-stage.pointblank-connect.workers.dev \\
  WORKSTATION_KEY_FILE=/path/to/staging-key node test/gateway.mjs
WORKSTATION_URL=https://linux.pointblankllc.com \\
  WORKSTATION_KEY_FILE=/path/to/production-key WORKSTATION_VERIFY_SAVE=1 node test/deployed.mjs
```

### Production cutover

| Component | Cloudflare version |
| --- | --- |
| Linux host `browser-agent` | `b55f2a72-bf92-44d8-b09f-c663eacdbd08` at 100% |
| Egress `pointblank-linux-network` | `2a2ea440-798d-4848-9d22-3d1d4134bfd8` |
| Linux rollback baseline | `a2fe5ef1-88b6-4e5a-bb81-10307375b987` |

Production delivered SHA-256 `5a4815c3802d8917e167cb77bb4ac97c75e7176234760f4f3fbe9205b95ae711` on three consecutive downloads. Chromium reached the production terminal in 10.53 s. Native requests measured 425 ms then 440 ms, and native binary download throughput was 2.21 MB/s. The production browser checks passed for native curl, wget, apk, GitHub clone, a checksum-verified script, denied egress, timeout, and active session disable. A separate Chrome session saved a home-directory file, refreshed the live app, and read the restored file with networking offline. The production gateway also passed the separate API checks. The hostname presented a certificate valid for `network.pointblankllc.com`.

The hosted GitHub Actions runner was blocked by the account's billing settings. A one-job runner on the existing machine used GitHub's repository-scoped Actions installation credential. It proved authenticated GitHub push and pull on staging. The independently verified guest commit was `106baa217268f4174dbcb9d812bb14f2cd903f11`. The guest then fetched and pulled `33f635ef376cf4f9bfd7e145241c6e77df146f40`. [Staging workflow](https://github.com/robit-man/pointblank-workstation-smoke/actions/runs/45919887686)

Production repeated the private GitHub workflow successfully. The guest pushed `edb78661490b0a2168e50da7dbc5925eabf5d755`. A separate GitHub API client verified that revision and updated the file, then native Git fetched and pulled `5718a8ff9306e22343e001f41f6861c3982b6ffa` into the guest. The run observed 40 gateway POST requests and one GET. The temporary runner deregistered and the two one-off workflow secrets were deleted. [Production workflow](https://github.com/robit-man/pointblank-workstation-smoke/actions/runs/45920132664)

The staged Worker rejected a correctly signed expired session, revoked a live session after a real key rotation, and issued a new working session. The production key resides outside the repository in a user-only local file. No paid service was enabled.

To restore the previous Linux HTML, deploy the rollback version at 100% using the existing host configuration.

```sh
npx --yes wrangler@4.168.0 versions deploy a2fe5ef1-88b6-4e5a-bb81-10307375b987@100% --yes --config cloudflare/linux-host.toml
```

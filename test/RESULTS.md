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

Production delivered SHA-256 `5a4815c3802d8917e167cb77bb4ac97c75e7176234760f4f3fbe9205b95ae711` on three consecutive downloads. Chromium reached the production terminal in 10.53 s. Native requests measured 425 ms then 440 ms, and native binary download throughput was 2.21 MB/s. The production browser checks passed for native curl, wget, apk, GitHub clone, a checksum-verified script, denied egress, timeout, and active session disable. The production suite saved a home-directory file, installed packages, and a Git clone, refreshed the live app, and verified all three with networking offline. Separate production guest commands installed and imported the PyPI package `packaging==25.0` and installed and loaded npm package `is-number@7.0.0`. The production gateway also passed the separate API checks. The hostname presented a certificate valid for `network.pointblankllc.com`.

The hosted GitHub Actions runner was blocked by the account's billing settings. A one-job runner on the existing machine used GitHub's repository-scoped Actions installation credential. It proved authenticated GitHub push and pull on staging. The independently verified guest commit was `106baa217268f4174dbcb9d812bb14f2cd903f11`. The guest then fetched and pulled `33f635ef376cf4f9bfd7e145241c6e77df146f40`. [Staging workflow](https://github.com/robit-man/pointblank-workstation-smoke/actions/runs/45919887686)

Production repeated the private GitHub workflow successfully. The guest pushed `edb78661490b0a2168e50da7dbc5925eabf5d755`. A separate GitHub API client verified that revision and updated the file, then native Git fetched and pulled `5718a8ff9306e22343e001f41f6861c3982b6ffa` into the guest. The run observed 40 gateway POST requests and one GET. The temporary runner deregistered and the two one-off workflow secrets were deleted. [Production workflow](https://github.com/robit-man/pointblank-workstation-smoke/actions/runs/45920132664)

The staged Worker rejected a correctly signed expired session, revoked a live session after a real key rotation, and issued a new working session. The production key resides outside the repository in a user-only local file. No paid service was enabled.

To restore the previous Linux HTML, deploy the rollback version at 100% using the existing host configuration.

```sh
npx --yes wrangler@4.168.0 versions deploy a2fe5ef1-88b6-4e5a-bb81-10307375b987@100% --yes --config cloudflare/linux-host.toml
```

## Automatic public networking

Linux host version `207124c8-c10f-4779-8c09-47e0ae9563ce` was deployed at 100% on `https://linux.pointblankllc.com`. The live single-file HTML matched SHA-256 `af6e531eab6d2cc0c5f0e778899190582c87c12aba26d71cd29d337bc9e6481c`. The prior host version `b55f2a72-bf92-44d8-b09f-c663eacdbd08` is the rollback for this change.

A clean Chromium profile reached `NETWORK: ONLINE` without submitting credentials. Native guest tests installed Alpine packages, cloned a public GitHub repository, fetched npm metadata via curl, installed `is-number@7.0.0` with npm, and loaded it from Node. An unapproved hostname and Git receive-pack were blocked. Cross-origin requests and a request to the Worker preview hostname returned HTTP 403.

Offline preference survived reload. The guest's `network on` resumed public access. An imported filesystem snapshot waited for explicit enablement. The live network dialog still switched to the authenticated gateway and exposed its private service registry. Run `node test/public-gateway.mjs` for the public policy regression checks.

## TTY workspace interface

The UI and v2 sharing transport use commit `d11a699` of Pointblank TTY. [Reference repository](https://github.com/robit-man/tty/tree/d11a699f2bf573725387ecb5fb08496cf37f1f8d)

The Cloudflare preview for host version `0e99745a-20e9-42d5-bf57-daefac4718d5` served the same `31,640,827` bytes as the rebuilt standalone file. The SHA-256 was `5fe3027cd60aceea0dea97da5831e0061cbfd58d58298ec0da75574e2b89cadc`.

The Chromium suite drove the preview's actual controls and Alpine PTYs and used the running TTY site and its relay. Run the suite locally or set `WORKSTATION_TEST_ORIGIN` to a running release.

```sh
node test/fixture.mjs
# Run in a second shell
node test/terminals.mjs
# For a deployed release, set WORKSTATION_TEST_ORIGIN to its URL.
```

| Check | Observed result |
| --- | --- |
| Shared Alpine filesystem | One PTY created a file and another read it. An uploaded file appeared under `/workspace/inbox`. Forking a shell opened it in the source pane's working directory. |
| Desktop panes | Independent text sizes, keyboard-accessible divider resize, drag docking from the sidebar and toolbar, retained scrollback after minimizing, and cancel/confirm close passed. |
| Linux-issued invite | Live TTY opened a view-only session and lost access on revoke. A second approved control session ran an Alpine command from TTY and showed the result on both sites. |
| TTY-issued invite | The live TTY site created a QR/PIN invite. Linux offered its selected Alpine terminal and the TTY site displayed that terminal's existing output. |
| Linux guest viewer | A second Linux browser context opened a v2 invite URL, received a shared pane, and sent approved input to the source Alpine PTY. |
| Mobile interface | Chromium Pixel 7 emulation passed the compact sidebar, touch text sizing, a key strip anchored to the simulated keyboard viewport, sticky Ctrl, soft Enter, and long-press text selection. |
| Additional desktop engines | Playwright Firefox 157.0 booted and ran an Alpine command with OPFS. Playwright WebKit 26.5 booted and ran the command with IndexedDB fallback. |
| Offline artifact | Chromium booted the local HTML with browser networking offline, split the terminal, and read a file made in the other pane. |

Native Git writes and the complete persistence and recovery suite also passed with the revised menus on the local fixture. Physical mobile Safari, Android devices, Edge, and a TTY-hosted SSH terminal as the source of a Linux viewer were outside this release's browser runs. The live TTY tests used browser Alpine as the shared shell.

### Production cutover

Cloudflare deployed host version `0e99745a-20e9-42d5-bf57-daefac4718d5` to 100% of production traffic. The production HTML matched the preview byte for byte. Chromium reopened a workspace checkpoint created by the previous production release and read its file from inside Alpine. The pane, live TTY sharing, and mobile-emulation suite passed again against the production origin. [Production workstation](https://linux.pointblankllc.com/)

A clean profile enabled public egress at startup. Native APK installed Git and curl, Git cloned a public GitHub repository, curl read the approved npm registry, and npm installed `is-number@7.0.0`. Node loaded the installed module. Requests to an unapproved host and anonymous Git write discovery were denied. The offline preference survived a refresh. Importing a portable snapshot left egress off until the guest ran `network on`.

The previous host version is `207124c8-c10f-4779-8c09-47e0ae9563ce`. Restore it with the existing host configuration if rollback is needed.

```sh
npx --yes wrangler@4.168.0 versions deploy 207124c8-c10f-4779-8c09-47e0ae9563ce@100% --yes --config cloudflare/linux-host.toml
```

### Interface performance

Median of three fresh headless Chromium launches per production build at 1440 × 850. Startup ran from navigation to the boot indicator disappearing. Terminal round trip ran from clicking the terminal to observing a shell-printed marker. Memory is total renderer-process RSS at startup.

| Measure | Previous production | TTY workspace |
| --- | ---: | ---: |
| Standalone HTML | 31,184,257 bytes | 31,640,827 bytes |
| Startup | 9,931 ms | 10,030 ms |
| Renderer RSS | 681 MiB | 684 MiB |
| Terminal round trip | 100 ms | 105 ms |

## Standalone Strands module loading

The production release before this fix reproduced `Failed to resolve module specifier './engine-D1KTM5zF.js'` from `agent model verify strands` inside Alpine. The build now links lazy imports of embedded JavaScript chunks to the standalone dependency URLs.

`node test/agent-imports.mjs` passed locally, on the Cloudflare preview, and on production. The regression supplies a test adapter and intercepts the first Strands checkpoint request after the engine import, so the result covers module loading through checkpoint retrieval. Desktop pane, mobile-emulation, and local offline boot checks passed on the rebuilt artifact.

Cloudflare host version `169b3295-3b6d-4dde-af1e-1d3914654c16` serves the build at 100%. The HTML SHA-256 is `6cce9d6c3b9d382ddf056a875b5d034e7cae7fbe861f1c047809050030eb5ff9`. The previous host version `0e99745a-20e9-42d5-bf57-daefac4718d5` remains the rollback for this fix.

## Preloaded Alpine development tools

The starter image adds Git 2.54.1, Git templates, Node.js 24.22.3, npm 11.12.1, and their dependencies through Alpine's signed 3.24 aarch64 repositories. The resulting development layer is 30,723,931 bytes with SHA-256 `8de46346c46f5770e0d76b1f0a504b3ad3d3d046f8179bc15e50a6a0d903da2a`. APK remains the system package manager.

The standalone file grew from 31,639,670 to 72,608,343 bytes. The Cloudflare preview served it as one response assembled from three static assets. A download advertising compression matched the standalone HTML byte for byte. Its SHA-256 is `52d30ab22242c4ead4a42c6178c325bbcf72794980105f14856487ae19523ccb`.

The Chromium development-tools suite passed with the local HTML offline and on the preview. A new shell ran Git, Node.js, npm, and APK before any setup, initialized a project and Git history, ran an npm script, and saved and restored the workspace. The standalone Strands import regression passed on the preview. Desktop Firefox 157.0 and WebKit 26.5 booted and ran a shell command.

The authorized fixture suite passed native APK and npm installs, authenticated Git push, portable snapshot export and clean-profile import, corruption rejection, interrupted OPFS writes, quota exhaustion, and IndexedDB fallback. The preview build also restored the file and package set from a checkpoint created before the development layer existed.

Median across three fresh Chromium launches at 1440 × 850. The previous build was served by production and the new build by the preview.

| Measure | Previous build | Preloaded tools |
| --- | ---: | ---: |
| Startup | 10,318 ms | 11,766 ms |
| Total renderer RSS | 674 MiB | 920 MiB |
| Terminal round trip | 113 ms | 109 ms |

Run `node test/development-tools.mjs` with Chromium installed to repeat offline boot, project creation, and save/restore. Set `WORKSTATION_TEST_ORIGIN=https://linux.pointblankllc.com` and `WORKSTATION_PUBLIC_NETWORK=1` for the production package checks.

Cloudflare host version `c2b085c9-c538-4f93-bb41-61742e4b8138` serves production at 100%. The production HTML matched the preview and standalone artifact byte for byte. A clean profile used `apk add --no-cache jq`, `git clone` over HTTPS, and ordinary `npm install is-number@7.0.0`. Node loaded the installed package, and the project and Git history survived a save and reload. Production also reopened the older checkpoint with its original package set.

The previous host version `169b3295-3b6d-4dde-af1e-1d3914654c16` is the rollback for this release.

## Public networking at shell startup

The previous production build opened with `NETWORK: OFFLINE` when a browser retained the old disconnect preference. The public gateway check now begins during boot. When discovery is pending, the app waits for success or the existing timeout before exposing the first shell.

The browser suite proved that a normal workspace saved during a disconnected visit reconnects on reload. Imported snapshots remained offline across reload until explicit approval, and subsequent visits retained that approval. A simulated gateway failure opened a usable offline shell and recovered when the browser reported connectivity. The bundled file still booted offline. The first production shell reached Alpine mirrors, GitHub, and npm with the old disconnect preference present and without opening Networking.

Host version `946cac27-fa3f-44a4-88fa-66bb529b5742` serves production at 100%. The deployed bytes matched the staged HTML and local artifact with SHA-256 `2924b3e28095a463473e4d1bbf5e4f2561d6fb2364353f4221fee115514b6101`. The rollback version is `c2b085c9-c538-4f93-bb41-61742e4b8138`.

Run `node test/public-startup.mjs` for the browser regression suite. Set `WORKSTATION_STARTUP_SMOKE=1` to run the initial connection check only.

## Mobile space key and workspace growth

On the previous build, an emulated phone sequence that sent a space keypress and then inserted a space after keyup produced two spaces in Alpine. The browser regression covers that sequence, space insertion during the keypress, and a separate input-only space. Each intended press now adds one space. The mobile testing used emulated keyboard events.

The previous Git path applied a 64 MiB response cap to pack streams. The fresh workspace also had about 80 MiB available on its 220 MiB filesystem. The fixture now streams real Git HTTP responses and can seed a repository with four incompressible 26 MiB files. Native Git cloned and checked out its pack, which exceeded 104 MiB. The checksums matched across save and reload.

The growth test filled most of a default workspace first. Its Git clone paused at the growth dialog, resumed in place after approval, and verified the files. The workspace then grew beyond 512 MiB and saved and restored the larger checkout and filler file. Choosing **Keep limit** canceled the clone and preserved the existing files. A separate test of the Cloudflare preview reached the allowance with local terminal writes, approved growth, and wrote more data in the same shell.

The scratch filesystem uses a sparse IndexedDB-backed ext4 disk where available. It begins with an approximately 420 MiB allowance and releases its reserved blocks on approval. The virtual capacity is 1 TiB. Browser quota and the browser's ability to process and store snapshots still apply. Saved checkpoints use the existing workspace storage format.

The production Linux host serves version `291fa722-1a73-41f2-8797-bfa188c57359` at 100%. The private gateway serves version `56b0f5b7-d72c-4516-8dfc-ab9b64b9d617` at 100%. The production HTML matched the staged and committed artifact byte for byte with SHA-256 `9c4bedef3372855fd32ef354a735b76141e5a06269a67296673e03e900effa9f`. On production, local writes opened the growth dialog and approval allowed writes in the same shell. The terminal tests passed mobile space input and the desktop pane workflow. The first shell reached Alpine mirrors, GitHub, and npm without opening the networking settings.

Firefox 157.0 and WebKit 26.5 booted the production Alpine guest and ran a shell command. The Chromium fixture suite passed native Git write operations and pull, regular persistence and snapshots, interruption and browser quota recovery, and IndexedDB fallback. The standalone HTML booted offline with Git, Node.js, npm, and APK and saved and restored a project. The Worker tests streamed a 257 MiB Git pack and confirmed that ordinary responses still stop at 64 MiB.

The production growth release cloned and checked out `https://github.com/curl/curl.git` with native Git. The pack was 133,816,185 bytes. Git reported 3.36 MiB/s during transfer and resolved 244,702 deltas. The verified checkout completed about four minutes after page navigation in Chromium.

The rollback versions for the growth release are Linux host `7e5de842-874d-4919-8486-e454ab30d1ac` and private gateway `52cc1465-487d-4f9c-9be4-ec8b23708734`. Export any workspace above the intermediate release's snapshot limits before rolling back.

```sh
LARGE_GIT_FIXTURE=1 BROWSER_TEST_PORT=18735 node test/fixture.mjs
# Run in another shell
node test/large-git.mjs
WORKSTATION_TEST_GROWTH=1 node test/large-git.mjs
WORKSTATION_TEST_GROWTH=cancel node test/large-git.mjs
```

## iPhone space and text edits

The previous production build sent two spaces to Alpine when an iPhone-style space key with key code 229 was followed by a text insertion. The older regression exercised key code 32. The TTY Shift+letter fix was already present in Browser Agent. The new mobile handler sends edits through a single path based on the textarea value.

In the regression, the previous production build printed `<a  b>` for the single-space sequence in both WebKit and Chromium. The new build printed `<a b>`. The suite also covers intentional consecutive spaces, Shift+letter, composition followed by space, deletion, and text replacement. It uses iPhone emulation and replayed events.

Run `node test/mobile-input.mjs` after starting `test/fixture.mjs`. Set `WORKSTATION_TEST_ENGINE=webkit` to run with WebKit or `WORKSTATION_TEST_ORIGIN` to target a deployed build.

The production host serves version `4f7da3d2-3ef0-40e2-919a-6362e8d5b906` at 100%. The production HTML matched the tested preview and rebuilt standalone file with SHA-256 `343f36b5345cdbdc140716b453f4478df4b3d589b12e5baa1917043aab63a496`. The rollback host version is `291fa722-1a73-41f2-8797-bfa188c57359`.

## Preloaded APT

The Alpine starter image includes APT 3.2.1 and dpkg 1.23.7 from signed Alpine 3.24 aarch64 packages. Debian repository lists start empty. The refreshed development layer is 39,058,995 bytes with SHA-256 `128b9878c840925e715c9bb9f74d5aca02292b17698bd071109755d8a55b73cf`. The standalone HTML is 86,103,183 bytes.

The offline Chromium test built a local `.deb`, installed it with `apt install`, verified the dpkg record and installed file, and recovered them after save and reload. The test also verified that APT authentication files were excluded. Snapshot validation accepted the exact signed GnuTLS library, rejected a same-size modified copy, and rejected an archive containing an APT authentication file. A Chromium guest on the previous production release also installed APT through `apk add --no-cache apt`.

The Chromium development tools suite passed on the Cloudflare preview. Host version `b64cdfdf-4229-486e-9e16-2bdbc3042622` serves production at 100%. The production HTML matched the preview and standalone file byte for byte with SHA-256 `1fd3b44589a7ca514bf389f31e4540f0158f953be233f9640c8d265a9b0da8e7`. The rollback host version is `4f7da3d2-3ef0-40e2-919a-6362e8d5b906`.

Production Chromium passed the same local package and persistence tests, plus native `apk add`, HTTPS Git clone, and `npm install`. The production WebKit iPhone-emulation input suite also passed.

## Current directory in the shell prompt

The Alpine prompt now shows the working directory and Bash's privilege marker. The Chromium preview tests verified `/workspace #`, the update after `cd`, independent directories in split panes, and the inherited directory in a forked pane. Mobile Chromium also verified changing directory with the on-screen Enter control. iPhone-emulated WebKit verified a directory containing a space.

Host version `f88d4559-db8f-47c1-916a-30bade311c78` serves production at 100%. The tested HTML has SHA-256 `c43d34c2b113156016e24e60c30cdfd0750776440d6cdfe5fb9cf89f65f3a224`. The rollback host version is `b64cdfdf-4229-486e-9e16-2bdbc3042622`.

## Portable workstation tools

The starter includes curl, jq, ripgrep, nano, make, patch, file, zip, and btop 1.4.6 from signed Alpine 3.24 packages. It also includes Cloudflare's ARM64 cloudflared 2026.11.2 with debug symbols stripped. The development layer is 51,786,785 bytes and the standalone HTML is 103,074,595 bytes.

The browser suite exercises JSON processing, patching, a Make target, file identification and ZIP round trips. Its interactive checks open the btop process list and save a file in nano using Ctrl+O. It also checks local cloudflared ingress validation and exclusion of credentials from workspace saves. Actual Cloudflare Tunnel connections require port 7844 egress.

The suite passed on the Cloudflare preview. A snapshot with the verified cloudflared binary passed validation. Modifying that binary without changing its size, or adding a cloudflared credential file, caused validation to reject the archive.

Host version `be03d733-4b97-49f3-87dc-7bd5cf81f569` serves production at 100%. The tested HTML has SHA-256 `ce49b94b00b1b2deb153741d42a9dd1f25044e105c4bdfd51d6b661199b5f148`. The rollback host version is `f88d4559-db8f-47c1-916a-30bade311c78`.

## Workspace files, previews, and tool packs

The [specification](../docs/WORKSPACE-TOOLS.md) describes the three controls in the Workspace menu. Chromium verified the downloaded file and ZIP contents, nested navigation, symlinks and special entries. The preview tests exercised CSS, images, local links, refresh, JSON, HTTP errors, and rejection of external redirects. Guest scripts and remote assets were excluded. The file and preview tests passed on the hosted preview, from the standalone HTML, and in Chromium mobile emulation.

The authorized browser fixture installed both packs, compiled and ran a C program, and saved the workspace. The standalone HTML is 103,106,881 bytes.

Host version `109debb2-aeaf-48e7-b6b0-b9223bf09881` serves production at 100%. Production and the preview matched the standalone HTML with SHA-256 `7c001501a55c5cb69323c94bb4ef78339919ad5f193152dadbf4113923651b87`. The rollback host version is `be03d733-4b97-49f3-87dc-7bd5cf81f569`.

Production Chromium passed the file and preview suites. It installed both packs through approved public networking, exercised the binaries, compiled and ran a C program, saved, and verified the binaries and installed-state labels after reload.

## WebGPU agent tools and model catalog

The standalone catalog grew from 7 to 25 profiles. The 18 added downloads use pinned Hugging Face revisions. Each reported its expected total size and returned browser CORS headers on a range request. The bundled GGUF parser validated the complete tensor directory and the expected model architecture for each, and the corresponding tokenizer encoded a test chat prompt.

Chromium tested the terminal's `agent tools`, `agent models`, and alias and numeric model selection. A browser test supplied controlled model replies to the normal agent runner. Real calls entered Alpine, listed a guest directory, opened Files and Tool Packs, rendered a guest HTTP page, and rejected workspace traversal and the internal gateway port. The standalone Strands import smoke test reached the checkpoint request from the guest.

Chromium's SwiftShader WebGPU adapter generated real model tokens from Qwen3 0.6B, Gemma 3 1B, Llama 3.2 1B, and Qwen2.5-Coder 1.5B. The guest verification commands took about 157, 187, 298, and 387 seconds respectively on software WebGPU, including the first download and model loading. A shader check reproduced SwiftShader returning `NaN` for large `tanh` inputs and confirmed finite results after bounding the argument in the Gemma GELU kernel. Larger profiles received header, tensor-layout, and tokenizer checks. Qwen3.8 27B remains experimental and pages weights within the adapter's 16 GiB budget.

Run `node test/agent-workstation.mjs` against the fixture or set `WORKSTATION_TEST_ORIGIN` to a hosted build. For real token generation, set `WORKSTATION_TEST_WEBGPU=1` and optionally `WORKSTATION_TEST_MODEL` to a catalog alias. The inference test downloads the model if absent from browser storage.

Cloudflare host version `423fb6d0-e530-41cc-a747-6759195c754f` serves production at 100%. The standalone HTML is 103,119,471 bytes, 12,590 bytes larger than the previous version. Production, the final preview, and a repeated local build matched SHA-256 `52e9a5e82c56da021daeffd97148303ac1a5645d49df5fec4f0d1b4c038e44d4`. The rollback host version is `109debb2-aeaf-48e7-b6b0-b9223bf09881`.

Production Chromium passed tool discovery, the model list and selection, and all three workspace tool calls. The first live shell reached the Alpine diagnostics endpoint, GitHub through native Git, and npm without opening networking settings.

## Bash history across reloads

Bash records commands as each prompt returns and loads its history from browser storage when a pane starts. Chromium verified Up Arrow and Ctrl+R after a reload with autosave disabled, merged history from two panes, multiline entries, duplicate suppression, and omission of a space-prefixed command and a credential-bearing URL. `history-clear` removed persisted history across another reload. The same history checks passed on the fixture, the Cloudflare preview, and production.

The iPhone input replay suite passed in Chromium. The first live shell contained `/usr/bin/git` and connected to GitHub and npm using default networking.

Host version `8d9703dd-2565-4aa2-910c-6ddbeaba10c9` serves production at 100%. The standalone HTML, preview, production response, and repeat build matched SHA-256 `2023e7f7671b0d4689477290bf23c243cdf55d7ca61807b83416ff01811b48a5`. Rollback host version `423fb6d0-e530-41cc-a747-6759195c754f` restores the previous release.

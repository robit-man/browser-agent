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

The controlled write test uses the real Git smart HTTP protocol and `git http-backend`, with a local bare repository and synthetic credential. The production route at `linux.pointblankllc.com` still serves its prior build. A push to a private GitHub repository through the deployed Worker remains a production acceptance test.

The local Playwright Firefox binary had a mismatched automation protocol, and the matching WebKit binary was unavailable. Chromium is the project-tested browser. See upstream for the WebAssembly JSPI support matrix. [unkernel browser support](https://github.com/pithings/unkernel#-try-it-in-the-browser)

## Reproduce the browser suite

From the repository root, run the fixture and then the browser runner in separate shells. Start a fresh fixture for each test run. The two processes use loopback. The optional package checks contact the configured public registries. Set `CHROMIUM_PATH` or `PLAYWRIGHT_MODULE` to use an existing browser or Playwright installation.

```sh
node test/fixture.mjs
npm install --no-save --no-package-lock playwright
npx playwright install chromium
EXTRA_PACKAGE_TESTS=1 node test/browser.mjs
```

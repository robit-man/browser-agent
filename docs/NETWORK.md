# Pointblank Linux networking

The app runs Alpine in unkernel `0.2.0-261121-e69adda`, pinned to a SHA-256 in the build. The shipped terminal uses an unkernel host command over the guest's vsock boundary. The old direct networking mode provided browser fetch and an optional Wisp relay. Its direct path could not carry native Git POST requests. The new path uses native applications and keeps the original browser kernel and OCI layers.

| Upstream evaluated | Finding |
| --- | --- |
| [container2wasm](https://github.com/container2wasm/container2wasm) | Its CLI converts OCI images to a different emulation package and its browser networking examples introduce a separate packet stack. Switching would change this deployment's boot path and snapshots. |
| [gvisor-tap-vsock](https://github.com/containers/gvisor-tap-vsock) | Provides a userspace network stack and transports. Its raw or virtual networking interfaces do not enforce the HTTP service authorization required here. |
| [v86](https://github.com/copy/v86) | Runs x86 images. The installed Alpine/Python guest is aarch64, so using it would require a different guest image and runtime. |
| [vscode-container-wasm](https://github.com/ktock/vscode-container-wasm) | Integrates a container runtime with a VS Code workspace. The editor and runtime integration are separate from the existing standalone xterm and unkernel app. |

## Request path

A native application connects to a loopback HTTP proxy in Alpine. For HTTPS CONNECT the proxy accepts port 443 and signs a lease-local TLS certificate for an approved hostname from the gateway registry. The session CA private key stays in browser memory. The public CA and temporary leaf key are under the guest's RAM-backed `/run`. The browser bridge sends the service identifier, relative path, permitted headers, and body to the network Worker through HTTPS. The gateway verifies upstream HTTPS independently. Approved guest HTTP URLs are upgraded on the gateway's upstream leg.

The Worker receives and verifies the signed session. It resolves a fixed server-side service ID to its upstream origin and enforces method, path, repository, timeout and size policy before fetching. It rejects arbitrary targets and redirects outside the registry. The diagnostics service uses an explicit Cloudflare service binding to the matching Linux host. Git credentials are forwarded only to the permitted GitHub smart HTTP operation. The UI accepts GitHub's current stateless installation tokens as opaque credentials. [GitHub token format](https://github.blog/changelog/2026-10-02-stateless-github-app-installation-tokens-rolled-out/) Cookies and arbitrary guest authorization headers are excluded. Direct external sockets, SSH, LFS and clients that pin upstream certificates are outside the supported transport.

| Route | Behavior |
| --- | --- |
| `GET /health` | Public readiness response |
| `GET /v1/capabilities` | Transport and limits, limited to the configured app origin |
| `POST /v1/session` | Exchanges the workspace key for a one-hour signed bearer session |
| `GET /v1/session` | Reports the authenticated session ID and expiration |
| `GET /v1/services` | Returns the configured request registry |
| `POST /v1/services/{id}` | Carries the guest method, relative target path, filtered headers, and request bytes |

Cross-origin authenticated endpoints require the exact configured app origin. Preflight allows only the headers used by the gateway, and the response exposes the request ID and selected upstream headers. The bearer key and the optional GitHub credential remain in browser memory. The shared workspace key is only used to obtain a signed session. Reload and import require fresh authorization. Replacing the Worker signing secret invalidates all previously issued sessions when the new version takes traffic.

Requests are capped at 16 MiB and streamed responses at 64 MiB, with lower per-service limits where configured. The global service limiter is 240 requests per minute per Cloudflare location. Authentication uses a separate 12-per-minute per-client limiter at each location. Cloudflare's own request and CPU quotas still apply. [Cloudflare rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) · [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

## Public access on the Linux site

`https://linux.pointblankllc.com` automatically attaches the guest proxy to its same-origin `/api/workstation/public` endpoint. The HTML contains the endpoint configuration. Public access uses no shared credential. The host verifies the exact request origin and browser fetch metadata and publishes no CORS allowance for the endpoint. A nonbrowser client can imitate browser headers, so the endpoint's security boundary is its read-only upstream policy and rate limits.

The gateway permits anonymous GitHub smart HTTP clone and fetch, plus read operations for the Alpine, npm, and PyPI package services. It rejects Git receive-pack, package writes, credentials, and arbitrary origins. Public Git requests have a 2 MiB request-body limit. Public traffic is limited to 90 requests per client and 180 total requests per minute at each Cloudflare location. Public requests emit independent `workstation_public_egress` audit records.

The network dialog can switch to the authenticated gateway for scoped private access. Manual disconnect persists across reloads. Portable snapshot imports require an explicit `network on` after restore.

## Audit and operations

The Worker logs request ID, UTC time, verified session ID, authorized service and destination, method, status, request length, declared response length when present, duration to upstream headers, decision, and failure reason. Authentication failures are also logged. Worker invocation logging is disabled in favor of these redacted records. The local `network logs` command reports the last 30 proxied requests seen by the tab. Inspect Workers Logs for `workstation_egress` events. [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)

A workstation deployment requires no remote guest disk, execution service, R2 bucket, or dedicated server. Hosted artifacts and gateway releases use the existing Cloudflare account. The Worker registry is the sole authority for permitted egress services.

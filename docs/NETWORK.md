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

Requests are capped at 16 MiB and ordinary streamed responses at 64 MiB, with lower per-service limits where configured. Authorized GitHub upload-pack responses stay streamed while data is available. The client pauses the pack for growth approval before it reaches 256 MiB or exhausts the workspace's remaining allowance. Git response headers have a three-minute upstream deadline and the client times out stalled reads. If an ordinary stream crosses its limit after headers are sent, the Worker cancels it and writes an audit record with the same request ID. The global service limiter is 240 requests per minute per Cloudflare location. Authentication uses a separate 12-per-minute per-client limiter at each location. Cloudflare's own request and CPU quotas still apply. [Cloudflare rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) · [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

## Public access on the Linux site

`https://linux.pointblankllc.com` automatically attaches the guest proxy to its same-origin `/api/workstation/public` endpoint. The HTML contains the endpoint configuration. Public access uses no shared credential. The host verifies the exact request origin and browser fetch metadata and publishes no CORS allowance for the endpoint. A nonbrowser client can imitate browser headers, so the endpoint's security boundary is its read-only upstream policy and rate limits.

The gateway permits anonymous GitHub smart HTTP clone and fetch, plus read operations for the Alpine, npm, and PyPI package services. It rejects Git receive-pack, package writes, credentials, and arbitrary origins. Public Git requests have a 2 MiB request-body limit. Public traffic is limited to 90 requests per client and 180 total requests per minute at each Cloudflare location. Public requests emit independent `workstation_public_egress` audit records.

The network dialog can switch to the authenticated gateway for scoped private access. Disconnect and `network off` pause the current visit. An ordinary reload opens with public access. If the public gateway is unavailable, the shell opens offline and the app retries when the browser reports that connectivity has returned.

Portable imports and named restores require explicit approval before public access. This also applies to checkpoints marked offline by older releases, which used the same marker for disconnects and explicit restores. Run `network on` to approve such a checkpoint.

## Audit and operations

The Worker logs request ID, UTC time, verified session ID, authorized service and destination, method, status, request length, declared response length when present, duration to upstream headers, decision, and failure reason. Authentication failures are also logged. Worker invocation logging is disabled in favor of these redacted records. The local `network logs` command reports the last 30 proxied requests seen by the tab. Inspect Workers Logs for `workstation_egress` events. [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)

A workstation deployment requires no remote guest disk, execution service, R2 bucket, or dedicated server. Hosted artifacts and gateway releases use the existing Cloudflare account. The Worker registry is the sole authority for permitted egress services.

## Guest HTTP publication

The `publish PORT` shell command opens a WebSocket from the authorized workstation browser to the publication Worker. The Worker checks the existing gateway session through its service binding. The browser forwards requests through the runtime's loopback connection to the selected Alpine port. The visitor never connects directly to the VM. This keeps the app and its files in the browser and supports an Alpine reverse proxy forwarding to other guest services.

Use the link printed by the command. It establishes a short-lived, host-only visitor cookie on the publication Worker and redirects to the site's root. Absolute asset paths, query strings, guest redirects and normal HTTP methods work at that root. The link acts as a credential for the publication. The Worker strips its own cookie before forwarding a request and keeps published app content on a separate origin from the workstation. Service-worker registration is blocked on the publication origin.

The deployment has one live publication slot, eight concurrent requests or WebSockets, a 1 MiB request limit, a 16 MiB streamed response limit, and a 30-second HTTP response idle timeout. WebSocket messages may be up to 65,535 bytes with a 32 MiB total transfer per connection. Closing the publisher tab, disconnecting networking, stopping the publication, or reaching the publisher's session expiry ends the link. Publication sessions and in-flight relay buffers are outside workspace snapshots. Worker logs record activity and byte counts without logging link credentials or payloads.

The publication worker uses a SQLite-backed Durable Object for socket coordination. Deploy it before the standalone host so the `publish` command can reach its service. No change to the standalone host's DNS or the private networking Worker's routes is required.

```sh
npx --yes wrangler@4.168.0 deploy --config cloudflare/publish.toml
```

## Native Cloudflare Tunnel

Stock `cloudflared` needs DNS for Quick Tunnel provisioning and a direct tunnel connection to Cloudflare's edge on port 7844. Its HTTP/2 transport uses TCP and its QUIC transport uses UDP. The workstation's guest proxy handles approved HTTP requests, so it cannot carry those socket connections. [Cloudflare Tunnel firewall requirements](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)

The browser can reach a WebSocket relay over HTTPS on port 443. The relay would need permission to dial the tunnel edge on TCP 7844 and preserve the guest's end-to-end TLS session. The Worker at `network.pointblankllc.com` cannot serve as that relay because Workers block outbound TCP sockets to Cloudflare IP ranges. A live Worker probe confirmed the block, and a direct TLS probe confirmed that the tunnel identity verifies on 7844 while 443 presents a certificate for a different service. [Workers TCP socket restrictions](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations)
